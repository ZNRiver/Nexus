import os from "node:os";
import { statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ContainerMetric, ServerSystemInfo, SystemMetrics } from "@nexus/types";

/** CPU sample (user+nice+sys+idle ticks) used to compute deltas. */
let prevCpu = os.cpus().map((c) => c.times);

function cpuPercent(): number {
  const cpus = os.cpus();
  if (cpus.length !== prevCpu.length) prevCpu = cpus.map((c) => c.times);
  let idle = 0;
  let total = 0;
  for (let i = 0; i < cpus.length; i++) {
    const prev = prevCpu[i]!;
    const cur = cpus[i]!.times;
    const dIdle = cur.idle - prev.idle;
    const dTotal =
      (cur.user - prev.user) + (cur.nice - prev.nice) + (cur.sys - prev.sys) + dIdle + (cur.irq - prev.irq);
    idle += dIdle;
    total += dTotal;
  }
  prevCpu = cpus.map((c) => c.times);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
}

interface DiskUsage {
  usedBytes: number;
  totalBytes: number;
}

function diskUsage(): DiskUsage {
  const root = process.platform === "win32" ? process.cwd().split(/[\\/]/)[0] + "\\" : "/";
  try {
    const s = statfsSync(root);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return { usedBytes: Math.max(0, total - free), totalBytes: total };
  } catch {
    return { usedBytes: 0, totalBytes: 0 };
  }
}

interface NetCounters {
  rxBytes: number;
  txBytes: number;
}

let prevNet: NetCounters | null = null;

function networkCounters(): NetCounters {
  if (process.platform === "linux") {
    try {
      const text = spawnSync("cat", ["/proc/net/dev"], { encoding: "utf8" }).stdout as string;
      let rx = 0;
      let tx = 0;
      for (const line of text.split("\n").slice(2)) {
        const m = line.match(/^\s*([^:]+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
        if (m) {
          rx += parseInt(m[2]!, 10);
          tx += parseInt(m[3]!, 10);
        }
      }
      return { rxBytes: rx, txBytes: tx };
    } catch {
      /* fall through */
    }
  }
  return { rxBytes: 0, txBytes: 0 };
}

function loadAverages(): [number, number, number] {
  if (process.platform === "linux") {
    try {
      const text = spawnSync("cat", ["/proc/loadavg"], { encoding: "utf8" }).stdout as string;
      const parts = text.trim().split(/\s+/);
      return [parseFloat(parts[0] ?? "0"), parseFloat(parts[1] ?? "0"), parseFloat(parts[2] ?? "0")];
    } catch {
      /* fall through */
    }
  }
  const load = os.loadavg();
  return [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0];
}

function dockerVersion(): string | null {
  try {
    const res = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      timeout: 8000,
    });
    if (res.status !== 0) return null;
    return (res.stdout as string).trim() || null;
  } catch {
    return null;
  }
}

export function collectSystemInfo(): ServerSystemInfo {
  const mem = os.totalmem();
  const disk = diskUsage();
  const cpus = os.cpus();
  const dockerVer = dockerVersion();
  return {
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: os.arch(),
    cpuModel: cpus[0]?.model,
    cpuCores: cpus.length,
    cpuSpeedMhz: cpus[0]?.speed,
    memoryTotalBytes: mem,
    memoryFreeBytes: os.freemem(),
    diskTotalBytes: disk.totalBytes,
    diskFreeBytes: disk.totalBytes - disk.usedBytes,
    dockerVersion: dockerVer,
    dockerAvailable: dockerVer !== null,
    kernel: os.release(),
    uptimeSeconds: Math.floor(os.uptime()),
  };
}

export interface MetricsCollectorDeps {
  dockerPs: () => Promise<{ running: number; total: number; stats: ContainerMetric[] }>;
}

export async function collectMetrics(deps: MetricsCollectorDeps): Promise<SystemMetrics> {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  const disk = diskUsage();
  const [l1, l5, l15] = loadAverages();
  const net = networkCounters();
  const netDelta: NetCounters = prevNet
    ? { rxBytes: Math.max(0, net.rxBytes - prevNet.rxBytes), txBytes: Math.max(0, net.txBytes - prevNet.txBytes) }
    : { rxBytes: 0, txBytes: 0 };
  prevNet = net;

  let containers = { running: 0, total: 0, stats: [] as ContainerMetric[] };
  try {
    containers = await deps.dockerPs();
  } catch {
    /* docker unavailable — metrics still report system numbers */
  }

  return {
    cpuPercent: cpuPercent(),
    memoryUsedBytes: memUsed,
    memoryTotalBytes: memTotal,
    memoryPercent: memTotal > 0 ? (memUsed / memTotal) * 100 : 0,
    diskUsedBytes: disk.usedBytes,
    diskTotalBytes: disk.totalBytes,
    diskPercent: disk.totalBytes > 0 ? (disk.usedBytes / disk.totalBytes) * 100 : 0,
    loadAvg1: l1,
    loadAvg5: l5,
    loadAvg15: l15,
    uptimeSeconds: Math.floor(os.uptime()),
    networkRxBytes: netDelta.rxBytes,
    networkTxBytes: netDelta.txBytes,
    containersRunning: containers.running,
    containersTotal: containers.total,
    containerStats: containers.stats,
  };
}
