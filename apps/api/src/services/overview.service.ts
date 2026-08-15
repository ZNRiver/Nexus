import type { DbConnection } from "@nexus/database";
import type { DashboardOverview, DeploymentStatus, ServerStatus } from "@nexus/types";
import type { AppContext } from "../context";
import { JobQueue } from "../jobs/queue";
import { MonitoringService } from "./monitoring.service";

export class OverviewService {
  constructor(
    private readonly db: DbConnection,
    private readonly ctx: AppContext,
  ) {}

  async get(userId: string): Promise<DashboardOverview> {
    const db = this.db;
    const last24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    const [servers, apps, dbs, games, containers, deploys, jobs, unread] = await Promise.all([
      db.all<{ id: string; name: string; status: string }>(`SELECT * FROM servers`),
      db.all<{ id: string; status: string }>(`SELECT * FROM applications`),
      db.all<{ id: string; status: string }>(`SELECT * FROM databases`),
      db.all<{ id: string; status: string }>(`SELECT * FROM game_servers`),
      db.all<{ c: number }>(`SELECT COUNT(*) as c FROM containers`),
      db.all<{ status: string; c: number }>(`SELECT status, COUNT(*) as c FROM application_deployments GROUP BY status`),
      new JobQueue(db).pendingCount(),
      db.get<{ c: number }>(`SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0`, [userId]),
    ]);

    const onlineServers = servers.filter((s) => s.status === "ONLINE");
    const runningApps = apps.filter((a) => a.status === "RUNNING");
    const runningDbs = dbs.filter((d) => d.status === "RUNNING");
    const runningGames = games.filter((g) => g.status === "RUNNING");
    const runningContainers = containers[0]?.c ?? 0;
    const failedDeployments = deploys.find((d) => d.status === "FAILED")?.c ?? 0;
    const totalDeployments = deploys.reduce((acc, d) => acc + Number(d.c), 0);
    void runningApps; void runningDbs; void runningGames;

    const recentDeployments = await db.all(
      `SELECT d.*, a.name as app_name FROM application_deployments d LEFT JOIN applications a ON a.id = d.application_id ORDER BY d.created_at DESC LIMIT 8`,
    );

    const recentActivity = await db.all(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 10`);

    const monitoring = new MonitoringService(db, this.ctx);
    const serverHealth = await Promise.all(
      servers.map(async (s) => {
        const latest = await monitoring.latest(s.id);
        return {
          serverId: s.id,
          name: s.name,
          status: s.status as ServerStatus,
          cpuPercent: latest?.cpuPercent ?? null,
          memoryPercent: latest?.memoryPercent ?? null,
          diskPercent: latest?.diskPercent ?? null,
        };
      }),
    );

    const resourceUsage = await Promise.all(
      onlineServers.map(async (s) => {
        const points = await monitoring.series(s.id, { hours: 6, bucketSeconds: 300 });
        return { serverId: s.id, name: s.name, metrics: points };
      }),
    );

    return {
      servers: {
        total: servers.length,
        online: onlineServers.length,
        offline: servers.filter((s) => s.status === "OFFLINE").length,
        error: servers.filter((s) => s.status === "ERROR").length,
      },
      applications: { total: apps.length, running: runningApps.length, unhealthy: apps.filter((a) => a.status === "UNHEALTHY").length },
      databases: { total: dbs.length, running: runningDbs.length },
      gameServers: { total: games.length, running: runningGames.length },
      containers: { total: Number(containers[0]?.c ?? 0), running: runningContainers },
      deployments: { total: totalDeployments, failed: failedDeployments, last24h: deploys.filter((d) => d.status === "SUCCESS").length },
      recentDeployments: recentDeployments.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        applicationId: String(r.application_id),
        appName: r.app_name as string | null,
        serverId: String(r.server_id),
        status: String(r.status) as DeploymentStatus,
        branch: String(r.branch),
        commit: r.commit_sha as string | null,
        createdAt: String(r.created_at),
        durationMs: r.duration_ms as number | null,
      })),
      recentActivity: recentActivity.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        userId: r.user_id as string | null,
        userName: r.user_name as string | null,
        action: String(r.action),
        resourceType: String(r.resource_type),
        resourceId: r.resource_id as string | null,
        resourceName: r.resource_name as string | null,
        serverId: r.server_id as string | null,
        createdAt: String(r.created_at),
      })),
      serverHealth,
      resourceUsage,
      pendingJobs: jobs,
      unreadNotifications: Number(unread?.c ?? 0),
    };
  }
}
