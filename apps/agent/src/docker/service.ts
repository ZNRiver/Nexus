import { spawn } from "node:child_process";
import { createLogger } from "@nexus/logger";
import type {
  ContainerInfo,
  ContainerPort,
  ImageInfo,
  NetworkInfo,
  VolumeInfo,
} from "@nexus/types";

const log = createLogger("agent:docker");

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface StreamOptions {
  cwd?: string;
  env?: Record<string, string>;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

function dockerBin(): string {
  return process.platform === "win32" ? "docker" : "docker";
}

export class DockerService {
  constructor(private readonly dockerHost: string | null = null) {}

  private baseArgs(): string[] {
    return this.dockerHost ? ["--host", this.dockerHost] : [];
  }

  /** Run a docker command capturing output. */
  async run(args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<RunResult> {
    const full = [...this.baseArgs(), ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(dockerBin(), full, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`docker ${args[0] ?? ""} timed out after ${opts.timeoutMs ?? 60000}ms`));
      }, opts.timeoutMs ?? 60000);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? -1 });
      });
    });
  }

  /** Run a docker command streaming its combined output line by line. */
  stream(args: string[], opts: StreamOptions = {}): Promise<number> {
    const full = [...this.baseArgs(), ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(dockerBin(), full, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        windowsHide: true,
      });
      const onData = (d: Buffer) => {
        const text = d.toString();
        if (opts.onLine) {
          for (const line of text.split("\n")) {
            const trimmed = line.replace(/\r$/, "");
            if (trimmed.trim().length > 0) opts.onLine!(trimmed);
          }
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (err) => reject(err));
      opts.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
      child.on("close", (code) => resolve(code ?? -1));
    });
  }

  private async parseLines<T>(args: string[], timeoutMs?: number): Promise<T[]> {
    const res = await this.run(args, { timeoutMs });
    if (res.code !== 0) {
      throw new Error(`docker ${args[0] ?? ""} failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const items: T[] = [];
    for (const line of res.stdout.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        items.push(JSON.parse(t) as T);
      } catch {
        /* skip non-JSON output */
      }
    }
    return items;
  }

  private async requireDocker(): Promise<void> {
    const res = await this.run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10000 });
    if (res.code !== 0) {
      throw Object.assign(new Error("Docker is not available on this server"), { code: "DOCKER_UNAVAILABLE" });
    }
  }

  async available(): Promise<boolean> {
    try {
      const res = await this.run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 8000 });
      return res.code === 0 && res.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /* ── containers ──────────────────────────────────────────────── */

  async ps(): Promise<ContainerInfo[]> {
    await this.requireDocker();
    const raw = await this.parseLines<Record<string, unknown>>(
      ["ps", "-a", "--no-trunc", "--format", "{{json .}}"],
      30000,
    );
    return raw.map((r) => this.toContainerInfo(r)).filter(Boolean) as ContainerInfo[];
  }

  private toContainerInfo(r: Record<string, unknown>): ContainerInfo | null {
    const id = String(r.ID ?? "");
    if (!id) return null;
    const names = (r.Names as string) ?? "";
    const name = names.replace(/^\//, "");
    const ports: ContainerPort[] = [];
    const portStr = String(r.Ports ?? "");
    // "0.0.0.0:3000->3000/tcp, 443/tcp"
    for (const part of portStr.split(",")) {
      const p = part.trim();
      if (!p) continue;
      const m = p.match(/(?:([\d.]+):)?(\d+)->(\d+)\/(tcp|udp|sctp)/);
      if (m) {
        ports.push({ ip: m[1] || undefined, publicPort: parseInt(m[2]!, 10), privatePort: parseInt(m[3]!, 10), type: m[4] as ContainerPort["type"] });
      } else {
        const m2 = p.match(/^(\d+)\/(tcp|udp|sctp)$/);
        if (m2) ports.push({ privatePort: parseInt(m2[1]!, 10), type: m2[2] as ContainerPort["type"] });
      }
    }
    return {
      id,
      name,
      image: String(r.Image ?? ""),
      state: (String(r.State ?? "unknown") as ContainerInfo["state"]),
      status: String(r.Status ?? ""),
      created: String(r.CreatedAt ?? new Date().toISOString()),
      ports,
      networks: [],
      volumes: [],
      labels: {},
      restartCount: 0,
      exitCode: null,
    };
  }

  async inspect(id: string): Promise<Record<string, unknown>> {
    await this.requireDocker();
    const res = await this.run(["inspect", id], { timeoutMs: 20000 });
    if (res.code !== 0) throw new Error(`inspect ${id} failed: ${res.stderr.trim()}`);
    try {
      const parsed = JSON.parse(res.stdout) as Record<string, unknown>[];
      return parsed[0] ?? {};
    } catch {
      return { raw: res.stdout };
    }
  }

  async start(id: string): Promise<void> {
    await this.run(["start", id], { timeoutMs: 20000 });
  }
  async stop(id: string, timeoutSeconds = 15): Promise<void> {
    await this.run(["stop", "-t", String(timeoutSeconds), id], { timeoutMs: 30000 });
  }
  async restart(id: string): Promise<void> {
    await this.run(["restart", "-t", "10", id], { timeoutMs: 40000 });
  }
  async pause(id: string): Promise<void> {
    await this.run(["pause", id], { timeoutMs: 20000 });
  }
  async unpause(id: string): Promise<void> {
    await this.run(["unpause", id], { timeoutMs: 20000 });
  }
  async remove(id: string, opts: { force?: boolean; volumes?: boolean } = {}): Promise<void> {
    const args = ["rm"];
    if (opts.force) args.push("-f");
    if (opts.volumes) args.push("-v");
    args.push(id);
    await this.run(args, { timeoutMs: 30000 });
  }

  async logs(id: string, tail = 200): Promise<string> {
    const res = await this.run(["logs", "--tail", String(tail), id], { timeoutMs: 20000 });
    return res.stdout + res.stderr;
  }

  async statsAll(): Promise<Record<string, { cpuPercent: number; memoryUsageBytes: number; memoryLimitBytes: number; networkRxBytes: number; networkTxBytes: number }>> {
    const res = await this.run(["stats", "--no-stream", "--format", "{{json .}}"], { timeoutMs: 30000 });
    const out: Record<string, { cpuPercent: number; memoryUsageBytes: number; memoryLimitBytes: number; networkRxBytes: number; networkTxBytes: number }> = {};
    if (res.code !== 0) return out;
    for (const line of res.stdout.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const s = JSON.parse(t) as { Name?: string; CPUPerc?: string; MemUsage?: string; NetIO?: string };
        if (!s.Name) continue;
        const mem = parseMemUsage(s.MemUsage ?? "");
        const net = parseNetIO(s.NetIO ?? "");
        out[s.Name] = {
          cpuPercent: parseFloat((s.CPUPerc ?? "0").replace("%", "")),
          memoryUsageBytes: mem.used,
          memoryLimitBytes: mem.limit,
          networkRxBytes: net.rx,
          networkTxBytes: net.tx,
        };
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async exec(id: string, cmd: string[], opts: { stdin?: string | Uint8Array; timeoutMs?: number } = {}): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const full = [...this.baseArgs(), "exec", "-i", id, ...cmd];
      const child = spawn(dockerBin(), full, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`docker exec timed out`));
      }, opts.timeoutMs ?? 60000);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ output: stdout + stderr, exitCode: code ?? -1 });
      });
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
      child.stdin.end();
    });
  }

  /* ── images ──────────────────────────────────────────────────── */

  async images(): Promise<ImageInfo[]> {
    await this.requireDocker();
    const raw = await this.parseLines<Record<string, unknown>>(
      ["images", "--no-trunc", "--format", "{{json .}}"],
      30000,
    );
    return raw.map((r) => ({
      id: String(r.ID ?? ""),
      repository: String(r.Repository ?? "<none>"),
      tag: String(r.Tag ?? "latest"),
      sizeBytes: parseHumanSize(String(r.Size ?? "0")),
      created: String(r.CreatedSince ?? ""),
      containers: 0,
    }));
  }

  async pull(image: string, onLine?: (line: string) => void): Promise<void> {
    const code = await this.stream(["pull", image], { onLine });
    if (code !== 0) throw new Error(`docker pull ${image} failed with code ${code}`);
  }

  async build(opts: {
    tag: string;
    dockerfile: string;
    context: string;
    env?: Record<string, string>;
    onLine?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const args = ["build", "-t", opts.tag, "-f", opts.dockerfile, opts.context];
    const code = await this.stream(args, { env: opts.env, onLine: opts.onLine, signal: opts.signal });
    if (code !== 0) throw new Error(`docker build failed with code ${code}`);
  }

  async removeImage(id: string, force = false): Promise<void> {
    const args = ["rmi"];
    if (force) args.push("-f");
    args.push(id);
    const res = await this.run(args, { timeoutMs: 30000 });
    if (res.code !== 0) throw new Error(res.stderr.trim() || `docker rmi ${id} failed`);
  }

  /* ── volumes ─────────────────────────────────────────────────── */

  async volumes(): Promise<VolumeInfo[]> {
    await this.requireDocker();
    const raw = await this.parseLines<Record<string, unknown>>(
      ["volume", "ls", "--format", "{{json .}}"],
      20000,
    );
    return raw.map((r) => ({
      name: String(r.Name ?? ""),
      driver: String(r.Driver ?? "local"),
      mountpoint: "",
      labels: {},
      sizeBytes: null,
      usedBy: [],
    }));
  }

  async volumeInspect(name: string): Promise<VolumeInfo> {
    const res = await this.run(["volume", "inspect", name], { timeoutMs: 20000 });
    if (res.code !== 0) throw new Error(res.stderr.trim());
    const v = JSON.parse(res.stdout)[0] as Record<string, unknown>;
    return {
      name: String(v.Name ?? name),
      driver: String(v.Driver ?? "local"),
      mountpoint: String(v.Mountpoint ?? ""),
      labels: (v.Labels as Record<string, string>) ?? {},
      sizeBytes: null,
      usedBy: [],
    };
  }

  async volumeCreate(name: string, driver?: string): Promise<void> {
    const args = ["volume", "create"];
    if (driver) args.push("--driver", driver);
    args.push(name);
    const res = await this.run(args, { timeoutMs: 20000 });
    if (res.code !== 0 && !res.stderr.includes("already exists")) throw new Error(res.stderr.trim());
  }

  async volumeRemove(name: string, force = false): Promise<void> {
    const args = ["volume", "rm"];
    if (force) args.push("-f");
    args.push(name);
    const res = await this.run(args, { timeoutMs: 20000 });
    if (res.code !== 0) throw new Error(res.stderr.trim() || `volume rm ${name} failed`);
  }

  /* ── networks ────────────────────────────────────────────────── */

  async networks(): Promise<NetworkInfo[]> {
    await this.requireDocker();
    const raw = await this.parseLines<Record<string, unknown>>(
      ["network", "ls", "--format", "{{json .}}"],
      20000,
    );
    return raw.map((r) => ({
      id: String(r.ID ?? ""),
      name: String(r.Name ?? ""),
      driver: String(r.Driver ?? "bridge"),
      scope: String(r.Scope ?? "local"),
      subnet: null,
      gateway: null,
      internal: false,
      containers: [],
    }));
  }

  async networkInspect(name: string): Promise<NetworkInfo> {
    const res = await this.run(["network", "inspect", name], { timeoutMs: 20000 });
    if (res.code !== 0) throw new Error(res.stderr.trim());
    const n = JSON.parse(res.stdout)[0] as {
      Name?: string;
      Driver?: string;
      Scope?: string;
      Internal?: boolean;
      IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
      Containers?: Record<string, { Name?: string }>;
    };
    const containers = Object.entries(n.Containers ?? {}).map(([id, c]) => ({ id, name: c?.Name ?? id }));
    return {
      id: String(n.Name ?? name),
      name: String(n.Name ?? name),
      driver: String(n.Driver ?? "bridge"),
      scope: String(n.Scope ?? "local"),
      subnet: n.IPAM?.Config?.[0]?.Subnet ?? null,
      gateway: n.IPAM?.Config?.[0]?.Gateway ?? null,
      internal: !!n.Internal,
      containers,
    };
  }

  async networkCreate(name: string, driver = "bridge", subnet?: string): Promise<void> {
    const args = ["network", "create"];
    if (driver) args.push("--driver", driver);
    if (subnet) args.push("--subnet", subnet);
    args.push(name);
    const res = await this.run(args, { timeoutMs: 20000 });
    if (res.code !== 0 && !res.stderr.includes("already exists")) throw new Error(res.stderr.trim());
  }

  async networkRemove(name: string): Promise<void> {
    const res = await this.run(["network", "rm", name], { timeoutMs: 20000 });
    if (res.code !== 0) throw new Error(res.stderr.trim() || `network rm ${name} failed`);
  }

  /* ── compose ─────────────────────────────────────────────────── */

  async compose(opts: {
    projectName: string;
    file: string;
    cwd: string;
    env?: Record<string, string>;
    action: "config" | "pull" | "build" | "up" | "down" | "restart" | "ps";
    extraArgs?: string[];
    onLine?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<{ code: number; stdout: string }> {
    const args = ["compose", "-p", opts.projectName, "-f", opts.file, opts.action, ...(opts.extraArgs ?? [])];
    const code = await this.stream(args, {
      cwd: opts.cwd,
      env: opts.env,
      onLine: opts.onLine,
      signal: opts.signal,
    });
    return { code, stdout: "" };
  }

  async composePs(opts: { projectName: string; file: string; cwd: string }): Promise<string[]> {
    const res = await this.run(["compose", "-p", opts.projectName, "-f", opts.file, "ps", "--format", "{{.Name}}"], {
      cwd: opts.cwd,
      timeoutMs: 30000,
    });
    if (res.code !== 0) return [];
    return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }
}

/* ── helpers ─────────────────────────────────────────────────────── */

export function parseHumanSize(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([KMGTP]?i?B)?$/i);
  if (!m) return 0;
  const value = parseFloat(m[1]!);
  const unit = (m[2] ?? "B").toUpperCase();
  const mult: Record<string, number> = {
    B: 1,
    KB: 1024,
    KIB: 1024,
    MB: 1024 ** 2,
    MIB: 1024 ** 2,
    GB: 1024 ** 3,
    GIB: 1024 ** 3,
    TB: 1024 ** 4,
    TIB: 1024 ** 4,
  };
  return Math.round(value * (mult[unit] ?? 1));
}

function parseMemUsage(s: string): { used: number; limit: number } {
  const m = s.match(/^([\d.]+[KMGTP]?i?B)\s*\/\s*([\d.]+[KMGTP]?i?B)$/i);
  if (!m) return { used: 0, limit: 0 };
  return { used: parseHumanSize(m[1]!), limit: parseHumanSize(m[2]!) };
}

function parseNetIO(s: string): { rx: number; tx: number } {
  const m = s.match(/^([\d.]+[KMGTP]?i?B)\s*\/\s*([\d.]+[KMGTP]?i?B)$/i);
  if (!m) return { rx: 0, tx: 0 };
  return { rx: parseHumanSize(m[1]!), tx: parseHumanSize(m[2]!) };
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}
