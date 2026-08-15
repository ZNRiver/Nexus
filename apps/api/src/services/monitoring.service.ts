import type { DbConnection, MetricsRow, ServerRow } from "@nexus/database";
import type { MetricsPoint, SystemMetrics } from "@nexus/types";
import { errors } from "../lib/errors";
import type { AppContext } from "../context";

export class MonitoringService {
  constructor(
    private readonly db: DbConnection,
    private readonly ctx: AppContext,
  ) {}

  /** Latest persisted metrics for a server (from the last heartbeat). */
  async latest(serverId: string): Promise<SystemMetrics | null> {
    const server = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [serverId]);
    if (!server) throw errors.notFound("Server not found");
    const row = await this.db.get<MetricsRow>(`SELECT * FROM monitoring_metrics WHERE server_id = ? ORDER BY ts DESC LIMIT 1`, [serverId]);
    if (!row) return null;
    try {
      return JSON.parse(row.payload ?? "null") as SystemMetrics;
    } catch {
      return null;
    }
  }

  /** Aggregated time series for a server (downsampled to bucket seconds). */
  async series(serverId: string, opts: { hours?: number; bucketSeconds?: number } = {}): Promise<MetricsPoint[]> {
    await this.db.get<ServerRow>(`SELECT id FROM servers WHERE id = ?`, [serverId]);
    const hours = Math.min(168, Math.max(1, opts.hours ?? 24));
    const bucket = Math.max(10, opts.bucketSeconds ?? 60);
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const rows = await this.db.all<MetricsRow>(
      `SELECT * FROM monitoring_metrics WHERE server_id = ? AND ts >= ? ORDER BY ts ASC`,
      [serverId, cutoff],
    );
    // Downsample in memory (dev volumes are small; production prunes hourly).
    const buckets = new Map<number, { sumCpu: number; sumMem: number; sumDisk: number; sumCtr: number; count: number; ts: string }>();
    for (const r of rows) {
      const key = Math.floor(new Date(r.ts).getTime() / 1000 / bucket);
      const existing = buckets.get(key);
      const point = { sumCpu: r.cpu_percent, sumMem: r.memory_percent, sumDisk: r.disk_percent, sumCtr: r.containers_running, count: 1, ts: r.ts };
      if (existing) {
        existing.sumCpu += r.cpu_percent;
        existing.sumMem += r.memory_percent;
        existing.sumDisk += r.disk_percent;
        existing.sumCtr += r.containers_running;
        existing.count += 1;
      } else {
        buckets.set(key, point);
      }
    }
    return [...buckets.values()]
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((b) => ({
        ts: b.ts,
        cpuPercent: +(b.sumCpu / b.count).toFixed(1),
        memoryPercent: +(b.sumMem / b.count).toFixed(1),
        diskPercent: +(b.sumDisk / b.count).toFixed(1),
        containersRunning: Math.round(b.sumCtr / b.count),
      }));
  }

  /** Prune metrics older than the retention window (called periodically). */
  async prune(hours: number): Promise<number> {
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const res = await this.db.run(`DELETE FROM monitoring_metrics WHERE ts < ?`, [cutoff]);
    return res.changes;
  }
}
