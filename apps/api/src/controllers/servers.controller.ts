import { z } from "zod";
import type { AppContext } from "../context";
import type { App } from "../types";
import { ServersService } from "../services/servers.service";
import { requireAuth, requirePermission, getAuthUser } from "../middleware/auth";
import { errors } from "../lib/errors";
import { parsePageQuery, pid } from "../lib/http";

const createServerSchema = z.object({
  name: z.string().min(2),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).default("root"),
  authMethod: z.enum(["password", "privateKey"]),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  agentApiUrl: z.string().url().optional().or(z.literal("")),
});

export function registerServerRoutes(app: App, ctx: AppContext): void {
  const servers = new ServersService(ctx.db, ctx);

  app.get("/api/v1/servers", requireAuth, requirePermission("server.read"), async (c) => {
    return c.json({ success: true, items: await servers.list() });
  });

  app.post("/api/v1/servers", requireAuth, requirePermission("server.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createServerSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const server = await servers.create(parsed.data);
    await ctx.audit({ action: "server.create", resourceType: "server", resourceId: server.id, resourceName: server.name });
    return c.json({ success: true, server });
  });

  app.get("/api/v1/servers/:id", requireAuth, requirePermission("server.read"), async (c) => {
    const server = await servers.get(pid(c));
    const hub = ctx.hub;
    let system = null;
    let metrics = null;
    let containers: unknown[] = [];
    try {
      if (hub.isOnline(server.id)) {
        const [sys, ctrs] = await Promise.all([
          hub.request(server.id, "system.info", {}).catch(() => null),
          hub.request(server.id, "docker.ps", {}).catch(() => []),
        ]);
        system = sys;
        containers = ctrs as unknown[];
      }
    } catch {
      /* offline */
    }
    const { MonitoringService } = await import("../services/monitoring.service");
    metrics = await new MonitoringService(ctx.db, ctx).latest(server.id);
    const recentDeployments = await ctx.db.all(
      `SELECT d.*, a.name as app_name FROM application_deployments d LEFT JOIN applications a ON a.id = d.application_id WHERE d.server_id = ? ORDER BY d.created_at DESC LIMIT 10`,
      [server.id],
    );
    const recentActivity = await ctx.db.all(`SELECT * FROM audit_logs WHERE server_id = ? ORDER BY created_at DESC LIMIT 10`, [server.id]);
    return c.json({ success: true, server, system, metrics, containers, recentDeployments, recentActivity });
  });

  app.patch("/api/v1/servers/:id", requireAuth, requirePermission("server.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({
      name: z.string().min(2).optional(),
      port: z.number().int().optional(),
      username: z.string().optional(),
      agentApiUrl: z.string().url().optional().or(z.literal("")),
    }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const server = await servers.update(pid(c), parsed.data);
    await ctx.audit({ action: "server.update", resourceType: "server", resourceId: server.id, resourceName: server.name });
    return c.json({ success: true, server });
  });

  app.delete("/api/v1/servers/:id", requireAuth, requirePermission("server.delete"), async (c) => {
    const uninstall = c.req.query("uninstall") === "true";
    await servers.remove(pid(c), { uninstallAgent: uninstall });
    await ctx.audit({ action: "server.delete", resourceType: "server", resourceId: pid(c), metadata: { uninstallAgent: uninstall } });
    return c.json({ success: true });
  });

  app.post("/api/v1/servers/:id/test", requireAuth, requirePermission("server.write"), async (c) => {
    const id = pid(c);
    const result = await servers.testConnection({ id } as never);
    await ctx.audit({ action: "server.test", resourceType: "server", resourceId: id, metadata: { ok: result.ok } });
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/servers/test", requireAuth, requirePermission("server.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createServerSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await servers.testConnection(parsed.data as never);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/servers/:id/install-agent", requireAuth, requirePermission("server.write"), async (c) => {
    const id = pid(c);
    const user = getAuthUser(c)!;
    await ctx.db.run(`UPDATE servers SET status = 'INSTALLING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    await ctx.audit({ action: "server.install-agent", resourceType: "server", resourceId: id, serverId: id, metadata: { by: user.email } });
    // Derive the API URL the remote agent should connect back to. The config
    // default (http://localhost:8080) is wrong for remote hosts — the agent
    // would try to reach the API on its own localhost. Prefer the URL the
    // dashboard used to reach us, falling back to the configured value.
    const proto = c.req.header("x-forwarded-proto") ?? "http";
    const host = c.req.header("host");
    const apiUrl = host ? `${proto}://${host}` : ctx.config.apiUrl;
    // Run in background — installing takes time and the dashboard polls status.
    void (async () => {
      try {
        await servers.installAgent(id, apiUrl);
      } catch (err) {
        ctx.logger.error("agent install failed", { serverId: id, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return c.json({ success: true, message: "Agent installation started" });
  });

  app.post("/api/v1/servers/:id/reconnect", requireAuth, requirePermission("server.write"), async (c) => {
    const id = pid(c);
    const proto = c.req.header("x-forwarded-proto") ?? "http";
    const host = c.req.header("host");
    const apiUrl = host ? `${proto}://${host}` : ctx.config.apiUrl;
    const result = await servers.reconnect(id, apiUrl);
    await ctx.audit({ action: "server.reconnect", resourceType: "server", resourceId: id, serverId: id });
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/servers/:id/revoke-agent", requireAuth, requirePermission("server.write"), async (c) => {
    const id = pid(c);
    const { SetupService } = await import("../services/setup.service");
    await new SetupService(ctx.db).revokeAgent(id);
    await ctx.db.run(`UPDATE servers SET status = 'OFFLINE', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    await ctx.audit({ action: "server.revoke-agent", resourceType: "server", resourceId: id, serverId: id });
    return c.json({ success: true });
  });

  app.get("/api/v1/servers/:id/metrics", requireAuth, requirePermission("server.read"), async (c) => {
    const { MonitoringService } = await import("../services/monitoring.service");
    const monitoring = new MonitoringService(ctx.db, ctx);
    const hours = parseInt(c.req.query("hours") ?? "24", 10);
    const points = await monitoring.series(pid(c), { hours });
    return c.json({ success: true, serverId: pid(c), points });
  });

  app.get("/api/v1/servers/:id/containers", requireAuth, requirePermission("server.read"), async (c) => {
    const { InfraService } = await import("../services/infra.service");
    const infra = new InfraService(ctx.db, ctx);
    const result = await infra.containers(pid(c));
    return c.json({ success: true, items: result[0]?.containers ?? [] });
  });

  app.get("/api/v1/servers/:id/system", requireAuth, requirePermission("server.read"), async (c) => {
    const id = pid(c);
    if (!ctx.hub.isOnline(id)) throw errors.serverOffline();
    const system = await ctx.hub.request(id, "system.info", {});
    return c.json({ success: true, system });
  });

  app.get("/api/v1/search", requireAuth, async (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    if (!q) return c.json({ success: true, servers: [], applications: [], databases: [], containers: [], deployments: [] });
    const [servers, apps, dbs, deployments] = await Promise.all([
      ctx.db.all(`SELECT * FROM servers WHERE LOWER(name) LIKE ? OR LOWER(host) LIKE ? LIMIT 5`, [`%${q}%`, `%${q}%`]),
      ctx.db.all(`SELECT * FROM applications WHERE LOWER(name) LIKE ? OR LOWER(repository) LIKE ? LIMIT 5`, [`%${q}%`, `%${q}%`]),
      ctx.db.all(`SELECT * FROM databases WHERE LOWER(name) LIKE ? LIMIT 5`, [`%${q}%`]),
      ctx.db.all(`SELECT * FROM application_deployments WHERE id LIKE ? LIMIT 5`, [`%${q}%`]),
    ]);
    return c.json({
      success: true,
      servers,
      applications: apps,
      databases: dbs,
      containers: [],
      deployments,
    });
  });
}
