import { existsSync } from "node:fs";
import type { Client } from "ssh2";
import { createLogger } from "@nexus/logger";
import type { ServerSystemInfo } from "@nexus/types";
import { SSHService, quote, systemdEnvValue } from "./ssh";
import { errors } from "../lib/errors";

const log = createLogger("api:provision");

export interface ProvisionStep {
  step: string;
  ok: boolean;
  message: string;
}

export interface ProvisionInput {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  agentToken: string;
  serverId: string;
  apiUrl: string;
  agentVersion: string;
}

const AGENT_DIR = "/opt/nexus/agent";

export async function provisionRemoteServer(input: ProvisionInput): Promise<{ steps: ProvisionStep[]; system: ServerSystemInfo }> {
  const ssh = new SSHService();
  const steps: ProvisionStep[] = [];
  const note = (step: string, ok: boolean, message: string) => steps.push({ step, ok, message });

  const client = await ssh.connect({
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password,
    privateKey: input.privateKey,
    timeoutMs: 15000,
  });

  try {
    // 1. OS check
    const uname = await ssh.execute(client, `uname -s 2>/dev/null; uname -m 2>/dev/null; uname -r 2>/dev/null; cat /etc/os-release 2>/dev/null | head -2 | tr '\\n' ';'`);
    const lines = uname.stdout.trim().split("\n");
    const kernelName = lines[0]?.trim() ?? "";
    const arch = lines[1]?.trim() ?? "unknown";
    const kernel = lines[2]?.trim() ?? "";
    if (kernelName !== "Linux") {
      note("os", false, `Remote host is not Linux (${kernelName || "unknown"})`);
      throw errors.badRequest("NEXUS Agent requires a Linux host");
    }
    note("os", true, `Linux ${arch} detected`);

    // OS family for package management (used by Docker install below).
    const osRelease = uname.stdout.trim();
    const osLower = osRelease.toLowerCase();
    const osFamily = osLower.includes("alpine") ? "alpine" : osLower.includes("arch") ? "arch" : osLower.includes("centos") || osLower.includes("rocky") || osLower.includes("almalinux") || osLower.includes("fedora") || osLower.includes("rhel") ? "rhel" : "debian";

    // 2. Resources
    const nproc = await ssh.execute(client, `nproc 2>/dev/null || echo 1`);
    const mem = await ssh.execute(client, `grep MemTotal /proc/meminfo | awk '{print $2}'`);
    const memKb = parseInt(mem.stdout.trim() || "0", 10);
    const disk = await ssh.execute(client, `df -P / | tail -1 | awk '{print $2}'`);
    const diskKb = parseInt(disk.stdout.trim() || "0", 10);
    const cpuModel = await ssh.execute(client, `grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs`);
    const hostname = await ssh.execute(client, `hostname`);
    const cpuCores = parseInt(nproc.stdout.trim() || "1", 10);

    // 3. Docker — installed automatically if missing
    const dockerRes = await ssh.execute(client, `docker version --format '{{.Server.Version}}' 2>/dev/null`);
    if (dockerRes.code !== 0) {
      note("docker", false, "Docker not found — installing Docker Engine…");
      const installed = await installDocker(ssh, client, osFamily, (msg, ok) => note("docker", ok, msg));
      if (!installed.ok) {
        note("docker", false, `Docker installation failed: ${installed.message}`);
        throw errors.badRequest(`Docker installation failed: ${installed.message}`);
      }
    }
    // Verify the daemon is reachable (a fresh install may need a few seconds).
    const verify = await ssh.execute(client, `for i in $(seq 1 15); do V=$(docker version --format '{{.Server.Version}}' 2>/dev/null) && [ -n "$V" ] && echo "$V" && exit 0; sleep 2; done; exit 1`, 90000);
    if (verify.code !== 0) {
      note("docker", false, "Docker daemon is not responding after installation");
      throw errors.badRequest("Docker daemon is not responding after installation");
    }
    const dockerVersion = verify.stdout.trim();
    note("docker", true, `Docker ${dockerVersion}`);

    // 4. Bun — resolve the real bun binary path. bun.sh installs to
    // $HOME/.bun/bin/bun, which for root is /root/.bun — NOT /home/root/.bun
    // (the old hardcoded path broke the systemd service for root users).
    const bunRes = await ssh.execute(client, `BP=$(command -v bun || echo $HOME/.bun/bin/bun); if [ -x "$BP" ]; then echo "$BP"; else echo MISSING; fi`);
    const bunPath = bunRes.stdout.trim();
    let bunInstalled = bunRes.code === 0 && bunPath && bunPath !== "MISSING";
    if (!bunInstalled) {
      note("bun", false, "Bun not found — installing…");
      const install = await ssh.execute(client, `curl -fsSL https://bun.sh/install | bash`, 180000);
      if (install.code !== 0) {
        note("bun", false, `Bun installation failed: ${install.stderr.trim().slice(0, 200)}`);
        throw errors.badRequest("Could not install Bun on the remote server");
      }
      bunInstalled = true;
    }
    // Re-resolve the absolute bun path (systemd does not expand $HOME in ExecStart).
    const bunResolved = await ssh.execute(client, `BP=$(command -v bun || echo $HOME/.bun/bin/bun); if [ -x "$BP" ]; then echo "$BP"; else echo MISSING; fi`);
    const bunBinary = bunResolved.code === 0 && bunResolved.stdout.trim() && bunResolved.stdout.trim() !== "MISSING" ? bunResolved.stdout.trim() : `${AGENT_DIR}/bun`;
    if (bunBinary === `${AGENT_DIR}/bun`) {
      // Last resort: copy the resolved bun into the agent dir so the service always starts.
      await ssh.execute(client, `BP=$(command -v bun || echo $HOME/.bun/bin/bun); cp "$BP" ${AGENT_DIR}/bun && chmod +x ${AGENT_DIR}/bun`, 30000).catch(() => {});
    }
    note("bun", true, "Bun ready");

    // 5. Upload agent bundle (built single-file bundle)
    const bundle = await loadAgentBundle();
    if (!bundle) {
      note("agent", false, "Agent bundle not built locally — run `bun run --cwd apps/agent build:bundle`");
      throw errors.serverError("Agent bundle missing on the NEXUS host");
    }
    note("agent", false, "Uploading NEXUS Agent…");
    await ssh.upload(client, `${AGENT_DIR}/agent.js`, bundle);
    note("agent", true, `Agent uploaded (${bundle.length} bytes)`);

    // 6. Environment file
    const envFile = [
      `AGENT_API_URL=${systemdEnvValue(input.apiUrl)}`,
      `AGENT_TOKEN=${systemdEnvValue(input.agentToken)}`,
      `AGENT_SERVER_ID=${systemdEnvValue(input.serverId)}`,
      `AGENT_VERSION=${systemdEnvValue(input.agentVersion)}`,
      `AGENT_DATA_DIR=${AGENT_DIR}/data`,
      "",
    ].join("\n");
    await ssh.upload(client, `${AGENT_DIR}/.env`, Buffer.from(envFile, "utf8"));
    note("agent", true, "Agent configuration written");

    // 7. systemd service
    const unit = [
      "[Unit]",
      "Description=NEXUS Agent",
      "After=docker.service network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "EnvironmentFile=" + AGENT_DIR + "/.env",
      `ExecStart=${bunBinary} ${AGENT_DIR}/agent.js`,
      "Restart=always",
      "RestartSec=5",
      "WorkingDirectory=" + AGENT_DIR,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");
    await ssh.upload(client, `${AGENT_DIR}/nexus-agent.service`, Buffer.from(unit, "utf8"));

    // `systemctl enable --now` does NOT restart an already-active service — if
    // a previous agent (with an older .env/token) is still running, the new
    // configuration would never be loaded. Always force a restart so the
    // freshly uploaded bundle and .env take effect.
    const installService = await ssh.execute(
      client,
      `cp ${AGENT_DIR}/nexus-agent.service /etc/systemd/system/nexus-agent.service && systemctl daemon-reload && systemctl enable nexus-agent && systemctl restart nexus-agent`,
      60000,
    );
    if (installService.code !== 0) {
      note("service", false, `systemd failed: ${installService.stderr.trim().slice(0, 300)}`);
      throw errors.serverError("Could not start the NEXUS Agent service on the remote server");
    }
    note("service", true, "NEXUS Agent service started");

    const system: ServerSystemInfo = {
      hostname: hostname.stdout.trim() || input.host,
      os: kernelName,
      platform: "linux",
      arch,
      cpuModel: cpuModel.stdout.trim() || undefined,
      cpuCores,
      memoryTotalBytes: memKb * 1024,
      diskTotalBytes: diskKb * 1024,
      dockerVersion,
      dockerAvailable: true,
      kernel,
      uptimeSeconds: 0,
    };

    note("done", true, "NEXUS Agent installed and connected");
    return { steps, system };
  } finally {
    ssh.close(client).catch(() => {});
  }
}

/**
 * Install Docker Engine on the remote host. Uses the official get.docker.com
 * script for Debian/RHEL families, with native fallbacks for Alpine and Arch.
 * Runs as the provisioning SSH user (must be root or have passwordless sudo).
 */
async function installDocker(
  ssh: SSHService,
  client: Client,
  osFamily: string,
  note: (message: string, ok: boolean) => void,
): Promise<{ ok: boolean; message: string }> {
  try {
    // Ensure curl/wget exists for the official script path.
    const needFetch = osFamily === "debian" || osFamily === "rhel";
    if (needFetch) {
      const curl = await ssh.execute(client, `command -v curl || command -v wget`, 20000);
      if (curl.code !== 0) {
        const pkg = osFamily === "rhel" ? "yum install -y curl" : "apt-get update && apt-get install -y curl";
        const install = await ssh.execute(client, pkg, 180000);
        if (install.code !== 0) {
          return { ok: false, message: "curl/wget missing and could not be installed" };
        }
      }
    }

    if (osFamily === "alpine") {
      note("Installing docker via apk…", false);
      const res = await ssh.execute(client, `apk add --no-cache docker docker-cli-compose && rc-update add docker default && rc-service docker start`, 240000);
      if (res.code !== 0) return { ok: false, message: res.stderr.trim().slice(0, 300) };
      return { ok: true, message: "Docker installed via apk" };
    }

    if (osFamily === "arch") {
      note("Installing docker via pacman…", false);
      const res = await ssh.execute(client, `pacman -Sy --noconfirm docker docker-compose-plugin && systemctl enable --now docker`, 300000);
      if (res.code !== 0) return { ok: false, message: res.stderr.trim().slice(0, 300) };
      return { ok: true, message: "Docker installed via pacman" };
    }

    // Debian / RHEL families: official convenience script.
    note("Running official Docker install script…", false);
    const fetchCmd = `(command -v curl >/dev/null 2>&1 && curl -fsSL https://get.docker.com) || (command -v wget >/dev/null 2>&1 && wget -qO- https://get.docker.com)`;
    const res = await ssh.execute(client, `sh -c '${fetchCmd}' | sh`, 600000);
    if (res.code !== 0) {
      return { ok: false, message: res.stderr.trim().slice(0, 300) || "get.docker.com script failed" };
    }
    await ssh.execute(client, `systemctl enable --now docker 2>/dev/null || true`, 60000).catch(() => {});
    return { ok: true, message: "Docker installed via official script" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

let cachedBundle: Buffer | null = null;
let cachedSha256: string | null = null;

/** Load (or build on demand) the single-file agent bundle shipped to servers. */
export async function loadAgentBundle(): Promise<Buffer | null> {
  if (cachedBundle) return cachedBundle;
  const rel = `${import.meta.dir}/../../../../apps/agent/dist/agent.js`;
  if (existsSync(rel)) {
    cachedBundle = await Bun.file(rel).arrayBuffer().then((b) => Buffer.from(b));
    return cachedBundle;
  }
  // Build on demand
  try {
    const proc = Bun.spawn(["bun", "build", "src/index.ts", "--target=bun", "--outfile=dist/agent.js"], {
      cwd: `${import.meta.dir}/../../../../apps/agent`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      log.error("agent bundle build failed", { stderr: (await new Response(proc.stderr).text()).slice(0, 500) });
      return null;
    }
    cachedBundle = await Bun.file(rel).arrayBuffer().then((b) => Buffer.from(b));
    return cachedBundle;
  } catch (err) {
    log.error("agent bundle build error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** SHA-256 of the current agent bundle — the agent compares this for self-updates. */
export async function agentBundleSha256(): Promise<string | null> {
  if (cachedSha256) return cachedSha256;
  const bundle = await loadAgentBundle();
  if (!bundle) return null;
  const { createHash } = await import("node:crypto");
  cachedSha256 = createHash("sha256").update(bundle).digest("hex");
  return cachedSha256;
}
