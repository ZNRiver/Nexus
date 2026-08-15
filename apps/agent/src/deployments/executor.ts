import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createLogger } from "@nexus/logger";
import type {
  AgentEventType,
  ComposeDeployResult,
  DeploymentExecutePayload,
  DockerfileDeployResult,
} from "@nexus/types";
import { DockerService } from "../docker/service";

const log = createLogger("agent:deploy");

export interface DeploymentEventSink {
  (eventType: AgentEventType, resourceId: string, data: Record<string, unknown>): void;
}

const AGENT_DATA_DIR = process.env.AGENT_DATA_DIR ?? "data/agent";

/** Set of deployment ids that have been asked to cancel. */
const cancelled = new Set<string>();

export function requestCancel(deploymentId: string): boolean {
  cancelled.add(deploymentId);
  return true;
}

export function isCancelled(deploymentId: string): boolean {
  return cancelled.has(deploymentId);
}

function gitRun(args: string[], cwd: string, auth?: { token: string } | null): Promise<{ code: number; stdout: string; stderr: string }> {
  // Authenticated clones use `-c http.extraHeader` so the token is never
  // written into the repository's .git/config (unlike credentials baked into
  // the remote URL). The header is per-invocation only.
  const fullArgs = auth
    ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`oauth2:${auth.token}`).toString("base64")}`, ...args]
    : args;
  return new Promise((resolve) => {
    const child = spawn("git", fullArgs, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export interface CloneResult {
  workDir: string;
  commit: string | null;
}

async function cloneRepository(repo: string, branch: string, dest: string, onLog: (msg: string) => void, auth?: { token: string } | null): Promise<CloneResult> {
  if (existsSync(dest)) {
    onLog("Repository directory exists — updating…");
    const pull = await gitRun(["fetch", "--depth", "1", "origin", branch], dest, auth);
    if (pull.code !== 0) {
      onLog(`git fetch failed: ${pull.stderr.trim() || pull.stdout.trim()}`);
      // Fresh clone fallback
      rmSync(dest, { recursive: true, force: true });
    } else {
      const checkout = await gitRun(["checkout", "-B", branch, `origin/${branch}`], dest, auth);
      if (checkout.code !== 0) onLog(`git checkout warning: ${checkout.stderr.trim()}`);
    }
  }
  if (!existsSync(dest)) {
    onLog(`Cloning ${repo} (branch ${branch})…`);
    const clone = await gitRun(["clone", "--depth", "1", "--branch", branch, repo, dest], process.cwd(), auth);
    if (clone.code !== 0) {
      throw new Error(`git clone failed: ${clone.stderr.trim() || clone.stdout.trim()}`);
    }
    onLog("Repository cloned");
  }
  const rev = await gitRun(["rev-parse", "--short", "HEAD"], dest, auth);
  return { workDir: dest, commit: rev.code === 0 ? rev.stdout.trim() || null : null };
}

export async function executeDeployment(
  docker: DockerService,
  payload: DeploymentExecutePayload,
  emit: DeploymentEventSink,
): Promise<DockerfileDeployResult | ComposeDeployResult> {
  const { deploymentId, applicationId } = payload;
  const onLog = (message: string) => emit("deployment.log", deploymentId, { message });

  const workRoot = `${AGENT_DATA_DIR}/work`;
  const workDir = `${workRoot}/${applicationId}`;
  const repoDir = `${workDir}/repo`;

  try {
    // Rollback: reuse an already-built image — no clone, no build.
    if (payload.prebuiltImage) {
      onLog(`Rolling back to prebuilt image ${payload.prebuiltImage}`);
      emit("deployment.status", deploymentId, { status: "STARTING" });
      const containerId = await runApplicationContainer(docker, payload, emit);
      if (payload.healthcheck) {
        emit("deployment.status", deploymentId, { status: "HEALTH_CHECK" });
        await runHealthCheck(payload, emit);
        onLog("Health check passed");
      }
      onLog("Rollback deployment successful");
      return { image: payload.prebuiltImage, containerId, commit: null };
    }

    const clone = await cloneRepository(payload.repository, payload.branch, repoDir, onLog, payload.gitAuth ?? null);
    onLog(`Checked out ${clone.commit ?? payload.branch}`);

    if (payload.method === "DOCKERFILE") {
      return await deployDockerfile(docker, payload, repoDir, clone.commit, emit);
    }
    return await deployCompose(docker, payload, repoDir, clone.commit, emit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("deployment failed", { deploymentId, error: message });
    throw err;
  }
}

async function deployDockerfile(
  docker: DockerService,
  payload: DeploymentExecutePayload,
  repoDir: string,
  commit: string | null,
  emit: DeploymentEventSink,
): Promise<DockerfileDeployResult> {
  const { deploymentId, applicationId } = payload;
  const onLog = (message: string) => emit("deployment.log", deploymentId, { message });

  const dockerfile = `${repoDir}/${payload.dockerfilePath}`;
  if (!existsSync(dockerfile)) {
    throw new Error(`Dockerfile not found at ${payload.dockerfilePath}`);
  }
  onLog(`Dockerfile detected (${payload.dockerfilePath})`);

  // Private registry auth, if configured.
  const registryEnv: Record<string, string> = {};
  if (payload.registry && payload.registryUsername && payload.registryPassword) {
    onLog(`Logging in to ${payload.registry}…`);
    const login = await docker.run(
      ["login", payload.registry, "-u", payload.registryUsername, "--password-stdin"],
      { env: { ...registryEnv }, timeoutMs: 30000 },
    );
    void login;
  }

  emit("deployment.status", deploymentId, { status: "BUILDING" });
  onLog(`Building image ${payload.imageName}…`);
  try {
    await docker.build({
      tag: payload.imageName,
      dockerfile,
      context: `${repoDir}/${payload.buildContext}`,
      env: registryEnv,
      onLine: (line) => emit("deployment.log", deploymentId, { message: line }),
      signal: makeAbortSignal(deploymentId),
    });
  } catch (err) {
    onLog(`Build failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  onLog(`Image built: ${payload.imageName}`);

  emit("deployment.status", deploymentId, { status: "STARTING" });
  const containerId = await runApplicationContainer(docker, payload, emit);

  // Health check
  if (payload.healthcheck) {
    emit("deployment.status", deploymentId, { status: "HEALTH_CHECK" });
    onLog(`Health check (${payload.healthcheck.type})…`);
    await runHealthCheck(payload, emit);
    onLog("Health check passed");
  } else {
    onLog("No health check configured");
  }

  onLog("Deployment successful");
  return { image: payload.imageName, containerId, commit };
}

async function runApplicationContainer(
  docker: DockerService,
  payload: DeploymentExecutePayload,
  emit: DeploymentEventSink,
): Promise<string> {
  const { deploymentId, applicationId } = payload;
  const onLog = (message: string) => emit("deployment.log", deploymentId, { message });
  const labels = [
    `nexus.application=${applicationId}`,
    `nexus.deployment=${deploymentId}`,
    `nexus.managed=true`,
    `nexus.type=application`,
  ];

  // Remove the previous container for this application (idempotent deploy).
  const existing = await findContainerByLabel(docker, `nexus.application=${applicationId}`);
  if (existing) {
    onLog(`Removing previous container ${existing}…`);
    try {
      await docker.stop(existing, 10);
    } catch {
      /* already stopped */
    }
    await docker.remove(existing, { force: true });
  }

  // Network
  const networkName = payload.networkName;
  onLog(`Ensuring network ${networkName}…`);
  await docker.networkCreate(networkName, "bridge");

  // Volume
  const volumeMounts: string[] = [];
  if (payload.volumeName && payload.mountPath) {
    onLog(`Creating volume ${payload.volumeName}…`);
    await docker.volumeCreate(payload.volumeName);
    volumeMounts.push(`${payload.volumeName}:${payload.mountPath}`);
  }

  const portMapping: string[] = [];
  if (payload.port) {
    portMapping.push(`${payload.port}:${payload.port}`);
    onLog(`Publishing port ${payload.port}`);
  }

  const runArgs = [
    "run",
    "-d",
    "--name", payload.containerName,
    "--network", networkName,
    ...labels.flatMap((l) => ["-l", l]),
    ...portMapping.flatMap((p) => ["-p", p]),
    ...volumeMounts.flatMap((v) => ["-v", v]),
    "--restart", payload.restartPolicy,
  ];
  if (payload.cpuLimit) runArgs.push("--cpus", String(payload.cpuLimit));
  if (payload.memoryLimitBytes) runArgs.push("--memory", `${payload.memoryLimitBytes}b`);
  if (payload.memoryReservationBytes) runArgs.push("--memory-reservation", `${payload.memoryReservationBytes}b`);
  if (payload.pidsLimit) runArgs.push("--pids-limit", String(payload.pidsLimit));

  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(payload.env)) {
    envArgs.push("-e", `${key}=${value}`);
  }
  runArgs.push(...envArgs);

  if (payload.startCommand) {
    runArgs.push(payload.imageName, "sh", "-c", payload.startCommand);
  } else {
    runArgs.push(payload.imageName);
  }

  onLog("Starting container…");
  const res = await docker.run(runArgs, { timeoutMs: 60000 });
  if (res.code !== 0) {
    throw new Error(`docker run failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const containerId = res.stdout.trim();
  emit("container.status", applicationId, { id: containerId, name: payload.containerName, state: "running" });
  onLog(`Container started (${payload.containerName})`);
  return containerId;
}

async function deployCompose(
  docker: DockerService,
  payload: DeploymentExecutePayload,
  repoDir: string,
  commit: string | null,
  emit: DeploymentEventSink,
): Promise<ComposeDeployResult> {
  const { deploymentId } = payload;
  const onLog = (message: string) => emit("deployment.log", deploymentId, { message });
  const composeFile = `${repoDir}/${payload.composePath}`;
  if (!existsSync(composeFile)) {
    throw new Error(`Compose file not found at ${payload.composePath}`);
  }
  onLog(`Compose file detected (${payload.composePath})`);

  const env: Record<string, string> = { ...payload.env };

  // Validate configuration
  emit("deployment.status", deploymentId, { status: "DEPLOYING" });
  onLog("Validating compose configuration…");
  const valid = await docker.compose({
    projectName: payload.composeProjectName,
    file: composeFile,
    cwd: repoDir,
    env,
    action: "config",
    onLine: (line) => emit("deployment.log", deploymentId, { message: line }),
  });
  if (valid.code !== 0) {
    throw new Error("docker compose config failed — invalid compose file");
  }
  onLog("Configuration valid");

  // Keep the last output lines so a failure surfaces the real docker error.
  const recent: string[] = [];
  const track = (line: string) => {
    emit("deployment.log", deploymentId, { message: line });
    recent.push(line);
    if (recent.length > 20) recent.shift();
  };
  const tail = () => (recent.length ? `\n${recent.join("\n")}` : "");

  onLog("Pulling images…");
  const pull = await docker.compose({
    projectName: payload.composeProjectName,
    file: composeFile,
    cwd: repoDir,
    env,
    action: "pull",
    onLine: track,
  });
  if (pull.code !== 0) onLog("Pull reported warnings — continuing");

  emit("deployment.status", deploymentId, { status: "BUILDING" });
  onLog("Building images…");
  const build = await docker.compose({
    projectName: payload.composeProjectName,
    file: composeFile,
    cwd: repoDir,
    env,
    action: "build",
    onLine: track,
    signal: makeAbortSignal(deploymentId),
  });
  if (build.code !== 0) throw new Error(`docker compose build failed:${tail()}`);

  onLog("Starting stack…");
  const up = await docker.compose({
    projectName: payload.composeProjectName,
    file: composeFile,
    cwd: repoDir,
    env,
    action: "up",
    extraArgs: ["-d"],
    onLine: track,
    signal: makeAbortSignal(deploymentId),
  });
  if (up.code !== 0) throw new Error(`docker compose up failed:${tail()}`);

  emit("deployment.status", deploymentId, { status: "STARTING" });
  const containers = await docker.composePs({ projectName: payload.composeProjectName, file: composeFile, cwd: repoDir });
  onLog(`Stack running (${containers.length} container${containers.length === 1 ? "" : "s"}): ${containers.join(", ")}`);

  if (payload.healthcheck) {
    emit("deployment.status", deploymentId, { status: "HEALTH_CHECK" });
    onLog("Running health check…");
    await runHealthCheck(payload, emit);
    onLog("Health check passed");
  }

  onLog("Deployment successful");
  return { projectName: payload.composeProjectName, containers, commit };
}

async function runHealthCheck(payload: DeploymentExecutePayload, emit: DeploymentEventSink): Promise<void> {
  const { deploymentId } = payload;
  const hc = payload.healthcheck;
  if (!hc) return;
  const interval = (hc.intervalSeconds ?? 10) * 1000;
  const timeout = (hc.timeoutSeconds ?? 5) * 1000;
  const retries = hc.retries ?? 3;
  const port = hc.port ?? payload.port ?? 80;
  const url = `http://localhost:${port}${hc.path ?? "/"}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (isCancelled(deploymentId)) throw new Error("deployment cancelled during health check");
    emit("deployment.log", deploymentId, {
      message: `Health check attempt ${attempt}/${retries} (${hc.type === "http" ? url : `tcp ${port}`})…`,
    });
    const ok = await probe(hc.type, url, port, timeout);
    if (ok) return;
    if (attempt < retries) await sleep(interval);
  }
  throw new Error("Health check failed after retries");
}

async function probe(type: "http" | "tcp", url: string, port: number, timeoutMs: number): Promise<boolean> {
  if (type === "http") {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok || res.status < 500;
    } catch {
      return false;
    }
  }
  // TCP probe
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: {} });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

async function findContainerByLabel(docker: DockerService, label: string): Promise<string | null> {
  const res = await docker.run(["ps", "-aq", "--filter", `label=${label}`], { timeoutMs: 20000 });
  const id = res.stdout.trim();
  return id || null;
}

function makeAbortSignal(deploymentId: string): AbortSignal {
  const controller = new AbortController();
  const check = setInterval(() => {
    if (isCancelled(deploymentId)) controller.abort();
  }, 500);
  // The signal isn't GC-safe with a long-lived interval; caller cancels via
  // `requestCancel`, and the interval stops itself after abort.
  controller.signal.addEventListener(
    "abort",
    () => clearInterval(check),
    { once: true },
  );
  return controller.signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
