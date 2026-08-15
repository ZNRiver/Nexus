import { getConfig } from "@nexus/config";
import { createDb, migrate } from "@nexus/database";
import { createLogger } from "@nexus/logger";
import type { ServerRow } from "@nexus/database";
import type { NexusSettings } from "@nexus/types";

const config = getConfig();
const log = createLogger("api", { pretty: true });

const db = createDb(config.databaseUrl);
await migrate(db);

const { AgentHub } = await import("./agents/hub");
const hub = new AgentHub(db);

import { AuditService } from "./services/audit.service";
import { NotificationsService } from "./services/notifications.service";
import { SettingsService } from "./services/settings.service";
import { getRequestContext, runWithContext } from "./lib/request-context";
import type { AppContext } from "./context";
import { eventHub } from "./lib/events";

const settingsService = new SettingsService(db);
const auditService = new AuditService(db);
const notificationsService = new NotificationsService(db);

const ctx: AppContext = {
  config,
  db,
  logger: log,
  hub,
  settings: () => settingsService.get(),
  audit: async (entry) => {
    const rc = getRequestContext();
    await auditService.log({
      userId: rc.userId ?? null,
      userName: rc.userName ?? null,
      ip: rc.ip ?? null,
      requestId: rc.requestId ?? null,
      ...entry,
    });
  },
  notify: async (type, title, message) => {
    const rc = getRequestContext();
    const userId = rc.userId;
    if (userId) {
      await notificationsService.create(userId, type as never, title, message);
    } else {
      const owner = await db.get<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`);
      if (owner) await notificationsService.create(owner.id, type as never, title, message);
    }
  },
};

const { Hono } = await import("hono");
const app = new Hono<{ Variables: AppVariables }>();

app.use(async (c, next) => {
  c.set("db", db);
  c.set("logger", log);
  c.set("requestId", crypto.randomUUID().slice(0, 8));
  await runWithContext({ requestId: c.get("requestId") }, async () => {
    await next();
  });
});

app.use(async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

// CORS for the Vite dev server (cookie credentials).
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  const allowed = config.publicUrl;
  if (origin && (origin === allowed || allowed === "*")) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Vary", "Origin");
  }
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return c.body(null, 204);
  }
  await next();
});

// Hono v4 handles route errors at the dispatch level via app.onError — a wrapping
// middleware never sees them. Route errors (AppError) are converted to structured
// JSON responses here.
const { sendError } = await import("./lib/errors");
app.onError((err, c) => sendError(c, err));


const { registerAuthRoutes } = await import("./controllers/auth.controller");
const { registerServerRoutes } = await import("./controllers/servers.controller");
const { registerApplicationRoutes } = await import("./controllers/applications.controller");
const { registerDatabaseRoutes } = await import("./controllers/databases.controller");
const { registerInfraRoutes } = await import("./controllers/infra.controller");
const { registerMiscRoutes } = await import("./controllers/misc.controller");

registerAuthRoutes(app, ctx);
registerServerRoutes(app, ctx);
registerApplicationRoutes(app, ctx);
registerDatabaseRoutes(app, ctx);
registerInfraRoutes(app, ctx);
registerMiscRoutes(app, ctx);

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404));

/* ── Worker ──────────────────────────────────────────────────────── */
const { Worker } = await import("./jobs/worker");
const worker = new Worker(ctx);

const { ApplicationsService } = await import("./services/applications.service");
const { DeploymentsService } = await import("./services/deployments.service");
const { DatabasesService } = await import("./services/databases.service");
const { GameServersService } = await import("./services/games.service");
const applicationsService = new ApplicationsService(db, ctx);
const deploymentsService = new DeploymentsService(db, ctx);
const databasesService = new DatabasesService(db, ctx);
const gamesService = new GameServersService(db, ctx);

worker.register("deployment", (job) => deploymentsService.runDeployment(job));
worker.register("database-create", (job) => databasesService.runDatabaseCreate(job));
worker.register("database-backup", (job) => databasesService.runBackup(job));
worker.register("application-backup", (job) => applicationsService.runBackup(job));
worker.register("game-server-create", (job) => gamesService.runCreate(job));
worker.start();

/* ── WebSocket: agents + dashboard ───────────────────────────────── */
import { authenticateDashboard, handleDashboardSocket } from "./websocket/dashboard";
import { hashToken } from "./lib/crypto";
import type { AppVariables } from "./types";

async function authenticateAgent(url: URL): Promise<{ serverId: string; agentId: string; version: string } | null> {
  const token = url.searchParams.get("token");
  const serverId = url.searchParams.get("serverId");
  if (!token || !serverId) return null;
  const agent = await db.get<{ agent_id: string; token_hash: string; revoked_at: string | null; version: string | null }>(
    `SELECT agent_id, token_hash, revoked_at, version FROM server_agents WHERE server_id = ?`,
    [serverId],
  );
  if (!agent || agent.revoked_at) return null;
  if (agent.token_hash !== hashToken(token)) return null;
  return { serverId, agentId: agent.agent_id, version: agent.version ?? "0.1.0" };
}

type WsData =
  | { kind: "agent"; url: URL }
  | { kind: "dashboard"; url: URL; cookie: string }
  | { kind: "agent"; serverId: string; agentId: string; version: string };

const server = Bun.serve<WsData>({
  port: config.port,
  fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws/agent") {
      if (srv.upgrade(req, { data: { kind: "agent", url } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/ws/dashboard") {
      if (srv.upgrade(req, { data: { kind: "dashboard", url, cookie: req.headers.get("cookie") ?? "" } })) return;
      return new Response("upgrade failed", { status: 400 });
    }

    // Static dashboard (production build), then API.
    if (url.pathname.startsWith("/api") || url.pathname === "/api/health") {
      return app.fetch(req, srv);
    }
    return serveDashboard(req);
  },
  websocket: {
    async open(ws) {
      const data = ws.data;
      try {
        if (data.kind === "agent" && "url" in data) {
          const auth = await authenticateAgent(data.url);
          if (!auth) {
            ws.close(4401, "unauthorized");
            return;
          }
          ws.data = { kind: "agent", serverId: auth.serverId, agentId: auth.agentId, version: auth.version };
          await hub.register(auth.serverId, auth.agentId, auth.version, ws as unknown as WebSocket);
        } else if (data.kind === "dashboard" && "cookie" in data) {
          const user = await authenticateDashboard(db, data.url, data.cookie);
          if (!user) {
            ws.close(4401, "unauthorized");
            return;
          }
          handleDashboardSocket(ws as unknown as WebSocket, user);
        }
      } catch (err) {
        log.error("ws open failed", { error: err instanceof Error ? err.message : String(err) });
        ws.close(4401, "error");
      }
    },
    async message(ws, raw) {
      const data = ws.data;
      if (data.kind === "agent" && "serverId" in data) {
        await hub.handleMessage(data.serverId, raw.toString());
      }
    },
    close(ws) {
      const data = ws.data;
      if (data.kind === "agent" && "serverId" in data) {
        hub.unregister(data.serverId);
      }
    },
  },
});

log.info("NEXUS API listening", { port: config.port, env: config.env });

/* ── Local agent ─────────────────────────────────────────────────── */
const { LocalAgentLauncher } = await import("./agents/local");
const localAgent = new LocalAgentLauncher(db, config);
await localAgent.start();

/* ── Backup scheduler: enqueue due scheduled backups ────────────── */
setInterval(() => {
  void (async () => {
    const [dbStarted, appStarted] = await Promise.all([
      databasesService.runDueBackups(),
      applicationsService.runDueBackups(),
    ]);
    const total = dbStarted + appStarted;
    if (total > 0) log.info("scheduled backups started", { count: total, databases: dbStarted, applications: appStarted });
  })().catch((err) => log.error("backup scheduler failed", { error: err instanceof Error ? err.message : String(err) }));
}, 30_000);

/* ── Watchdog: heartbeat staleness + retention cleanup ──────────── */
setInterval(() => {
  void (async () => {
    const staleCutoff = new Date(Date.now() - 45_000).toISOString();
    const stale = await db.all<ServerRow>(
      `SELECT id, name, status, last_heartbeat_at FROM servers WHERE status = 'ONLINE' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)`,
      [staleCutoff],
    );
    for (const s of stale) {
      await db.run(`UPDATE servers SET status = 'OFFLINE', updated_at = ? WHERE id = ?`, [new Date().toISOString(), s.id]);
      await db.run(`UPDATE server_agents SET connected = 0 WHERE server_id = ?`, [s.id]);
      eventHub.emit({ type: "server.status", serverId: s.id, status: "OFFLINE" });
      log.warn("server marked offline (stale heartbeat)", { serverId: s.id, name: s.name });
      const owner = await db.get<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`);
      if (owner) {
        await notificationsService.create(owner.id, "server.offline", "Server offline", `${s.name} stopped sending heartbeats`);
      }
    }
    // Servers stuck in INSTALLING for too long (agent never connected back).
    // The background install task may have died (API restart) or the agent
    // cannot reach the API — surface it as an ERROR instead of waiting forever.
    const installingCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const stuckInstalling = await db.all<ServerRow>(
      `SELECT id, name, updated_at FROM servers WHERE status = 'INSTALLING' AND updated_at < ?`,
      [installingCutoff],
    );
    for (const s of stuckInstalling) {
      const msg = "Agent installation timed out — the agent did not connect back to the API. Check that the API URL is reachable from this host.";
      await db.run(`UPDATE servers SET status = 'ERROR', last_error = ?, updated_at = ? WHERE id = ?`, [msg, new Date().toISOString(), s.id]);
      await eventHub.emit({ type: "server.status", serverId: s.id, status: "ERROR" });
      log.warn("server marked ERROR (stuck installing)", { serverId: s.id, name: s.name });
      const owner = await db.get<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`);
      if (owner) {
        await notificationsService.create(owner.id, "server.install-failed", "Agent install timed out", `${s.name} did not connect back to the API`);
      }
    }
    // Retention
    const settings = await settingsService.get();
    await auditService.prune(new Date(Date.now() - settings.retention.auditLogDays * 86400_000).toISOString());
    const { MonitoringService } = await import("./services/monitoring.service");
    await new MonitoringService(db, ctx).prune(settings.retention.metricsHours);
    const logCutoff = new Date(Date.now() - settings.retention.deploymentLogDays * 86400_000).toISOString();
    await db.run(`DELETE FROM deployment_logs WHERE timestamp < ?`, [logCutoff]);
  })().catch((err) => log.error("watchdog failed", { error: err instanceof Error ? err.message : String(err) }));
}, 15_000);

/* ── Static dashboard (production) ───────────────────────────────── */
async function serveDashboard(req: Request): Promise<Response> {
  const dist = `${import.meta.dir}/../../dashboard/dist`;
  const url = new URL(req.url);
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = await Bun.file(`${dist}${path}`).exists().catch(() => false);
  if (file) {
    return new Response(await Bun.file(`${dist}${path}`).arrayBuffer(), {
      headers: { "Content-Type": mimeType(path) },
    });
  }
  // SPA fallback
  const index = await Bun.file(`${dist}/index.html`).exists().catch(() => false);
  if (index) {
    return new Response(await Bun.file(`${dist}/index.html`).arrayBuffer(), {
      headers: { "Content-Type": "text/html" },
    });
  }
  return new Response("NEXUS API — dashboard not built. Run `bun run --cwd apps/dashboard build`.", { status: 200 });
}

function mimeType(path: string): string {
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".woff2")) return "font/woff2";
  return "text/plain";
}

const shutdown = async () => {
  log.info("shutting down");
  worker.stop();
  localAgent.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
