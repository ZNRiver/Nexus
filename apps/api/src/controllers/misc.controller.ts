import { z } from "zod";
import type { Next } from "hono";
import type { AppContext } from "../context";
import type { App } from "../types";
import { ProjectsService } from "../services/projects.service";
import { GameServersService, type GameUserPerm } from "../services/games.service";
import { MonitoringService } from "../services/monitoring.service";
import { NotificationsService } from "../services/notifications.service";
import { AuditService } from "../services/audit.service";
import { SettingsService } from "../services/settings.service";
import { JobQueue } from "../jobs/queue";
import { OverviewService } from "../services/overview.service";
import { listResourceLogs } from "../services/resource-logs.service";
import { requireAuth, requirePermission, getAuthUser, type AuthContext } from "../middleware/auth";
import { errors } from "../lib/errors";
import { parseCreatedAtCursor, parsePageQuery, pid } from "../lib/http";

const projectSchema = z.object({ name: z.string().min(2), description: z.string().optional() });
const gameSchema = z.object({
  name: z.string().min(2),
  serverId: z.string().min(1),
  projectId: z.string().optional(),
  game: z.enum(["MINECRAFT"]).default("MINECRAFT"),
  version: z.string().optional(),
  flavor: z.enum(["VANILLA", "PAPER", "PURPUR", "FABRIC", "FORGE"]).optional(),
  image: z.string().optional(),
  port: z.number().int().optional(),
  memoryBytes: z.number().optional(),
  cpuLimit: z.number().optional(),
  storageBytes: z.number().optional(),
  environment: z.record(z.string()).optional(),
});

export function registerMiscRoutes(app: App, ctx: AppContext): void {
  const projects = new ProjectsService(ctx.db, ctx);
  const games = new GameServersService(ctx.db, ctx);
  const monitoring = new MonitoringService(ctx.db, ctx);
  const notifications = new NotificationsService(ctx.db);
  const audit = new AuditService(ctx.db);
  const settings = new SettingsService(ctx.db);
  const overview = new OverviewService(ctx.db, ctx);

  /**
   * Sub-user gate for game server routes. Owner/admin always pass; other roles
   * need a grant row for this server (access) and, when `perm` is given, that
   * feature permission. `resolveGameId` maps routes whose :id is NOT the game
   * server id (schedules, backups) back to the owning server.
   */
  function requireGamePerm(perm?: GameUserPerm, resolveGameId?: (c: AuthContext) => Promise<string>) {
    return async (c: AuthContext, next: Next): Promise<void> => {
      const user = getAuthUser(c);
      if (!user) throw errors.unauthorized();
      if (user.role === "owner" || user.role === "admin") {
        await next();
        return;
      }
      const gameId = resolveGameId ? await resolveGameId(c) : pid(c);
      const ok = await games.userHasGamePerm(gameId, user.id, perm);
      if (!ok) {
        throw errors.forbidden(perm ? `Missing permission: ${perm}` : "You don't have access to this game server");
      }
      await next();
    };
  }
  const gameIdFromSchedule = async (c: AuthContext): Promise<string> => {
    const row = await ctx.db.get<{ game_server_id: string }>(`SELECT game_server_id FROM game_schedules WHERE id = ?`, [pid(c, "scheduleId")]);
    if (!row) throw errors.notFound("Schedule not found");
    return row.game_server_id;
  };
  const gameIdFromBackup = async (c: AuthContext): Promise<string> => {
    const row = await ctx.db.get<{ game_server_id: string | null }>(`SELECT game_server_id FROM backups WHERE id = ?`, [pid(c)]);
    if (!row || !row.game_server_id) throw errors.notFound("Backup not found");
    return row.game_server_id;
  };
  const gameIdFromAllocation = async (c: AuthContext): Promise<string> => {
    const row = await ctx.db.get<{ game_server_id: string }>(`SELECT game_server_id FROM game_allocations WHERE id = ?`, [pid(c, "allocationId")]);
    if (!row) throw errors.notFound("Allocation not found");
    return row.game_server_id;
  };

  /* ── overview ───────────────────────────────────────────────── */

  app.get("/api/v1/overview", requireAuth, async (c) => {
    const user = getAuthUser(c)!;
    const data = await overview.get(user.id);
    return c.json({ success: true, ...data });
  });

  /* ── projects ───────────────────────────────────────────────── */

  app.get("/api/v1/projects", requireAuth, async (c) => {
    const items = await projects.list();
    return c.json({ success: true, items });
  });

  app.post("/api/v1/projects", requireAuth, requirePermission("project.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = projectSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const project = await projects.create(parsed.data);
    return c.json({ success: true, project });
  });

  app.delete("/api/v1/projects/:id", requireAuth, requirePermission("project.delete"), async (c) => {
    await projects.remove(pid(c));
    return c.json({ success: true });
  });

  /* ── game servers ───────────────────────────────────────────── */

  app.get("/api/v1/game-servers", requireAuth, async (c) => {
    const user = getAuthUser(c)!;
    const page = parsePageQuery(c);
    const result = await games.list({
      limit: page.limit,
      cursor: parseCreatedAtCursor(page.cursor) ?? undefined,
      serverId: c.req.query("serverId") || undefined,
      // Non-admins only see servers they were granted access to.
      userId: user.role === "owner" || user.role === "admin" ? undefined : user.id,
    });
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers", requireAuth, requirePermission("game.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = gameSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const game = await games.create(parsed.data);
    return c.json({ success: true, gameServer: game });
  });

  app.get("/api/v1/game-servers/:id", requireAuth, requireGamePerm(), async (c) => {
    const game = await games.getPublic(pid(c));
    const server = await ctx.db.get(`SELECT * FROM servers WHERE id = ?`, [game.serverId]);
    const system = await monitoring.latest(game.serverId);
    return c.json({ success: true, gameServer: game, server, system });
  });

  app.post("/api/v1/game-servers/:id/start", requireAuth, requireGamePerm("startstop"), async (c) => {
    const game = await games.start(pid(c));
    return c.json({ success: true, gameServer: game });
  });

  app.post("/api/v1/game-servers/:id/stop", requireAuth, requireGamePerm("startstop"), async (c) => {
    const game = await games.stop(pid(c));
    return c.json({ success: true, gameServer: game });
  });

  app.post("/api/v1/game-servers/:id/restart", requireAuth, requireGamePerm("startstop"), async (c) => {
    const result = await games.restart(pid(c));
    return c.json({ success: true, result });
  });

  app.post("/api/v1/game-servers/:id/exec", requireAuth, requireGamePerm("console"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ cmd: z.array(z.string().min(1)).min(1) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.exec(pid(c), parsed.data.cmd);
    return c.json({ success: true, ...result });
  });

  app.get("/api/v1/game-servers/:id/logs", requireAuth, requireGamePerm(), async (c) => {
    const tail = parseInt(c.req.query("tail") ?? "200", 10);
    const logs = await games.logs(pid(c), Math.min(500, Math.max(20, tail)));
    return c.json({ success: true, logs });
  });

  app.get("/api/v1/game-servers/:id/stats", requireAuth, requireGamePerm(), async (c) => {
    const stats = await games.stats(pid(c));
    return c.json({ success: true, ...stats });
  });

  app.patch("/api/v1/game-servers/:id", requireAuth, requireGamePerm(), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ name: z.string().min(2).optional() }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const gameServer = await games.update(pid(c), parsed.data);
    return c.json({ success: true, gameServer });
  });

  app.post("/api/v1/game-servers/:id/reinstall", requireAuth, requireGamePerm("startstop"), async (c) => {
    // Async — enqueues a job; the panel streams progress via resource logs.
    const { jobId } = await games.reinstall(pid(c));
    return c.json({ success: true, jobId });
  });

  app.delete("/api/v1/game-servers/:id", requireAuth, requirePermission("game.delete"), async (c) => {
    const destroy = c.req.query("destroy") === "true";
    await games.remove(pid(c), { destroyData: destroy });
    return c.json({ success: true });
  });

  /* ── game server: file manager ──────────────────────────────── */

  app.get("/api/v1/game-servers/:id/files", requireAuth, requireGamePerm(), async (c) => {
    const path = c.req.query("path") || "/";
    const result = await games.listFiles(pid(c), path);
    return c.json({ success: true, ...result });
  });

  app.get("/api/v1/game-servers/:id/files/content", requireAuth, requireGamePerm(), async (c) => {
    const path = c.req.query("path") || "";
    if (!path) throw errors.validation({ path: "path is required" });
    const result = await games.readFile(pid(c), path);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/files/write", requireAuth, requireGamePerm("files"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ path: z.string().min(1), content: z.string() }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.writeFile(pid(c), parsed.data.path, parsed.data.content);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/files/mkdir", requireAuth, requireGamePerm("files"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ path: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.mkdirFile(pid(c), parsed.data.path);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/files/delete", requireAuth, requireGamePerm("files"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ path: z.string().min(1), recursive: z.boolean().optional() }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.deleteFile(pid(c), parsed.data.path, parsed.data.recursive ?? false);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/files/rename", requireAuth, requireGamePerm("files"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ path: z.string().min(1), newName: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.renameFile(pid(c), parsed.data.path, parsed.data.newName);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/files/copy", requireAuth, requireGamePerm("files"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ path: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.copyFile(pid(c), parsed.data.path);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/files/upload", requireAuth, requireGamePerm("files"), async (c) => {
    const path = c.req.query("path") || "";
    if (!path) throw errors.validation({ path: "path is required" });
    const result = await games.uploadFile(pid(c), path, c.req.raw.body);
    return c.json({ success: true, ...result });
  });

  app.get("/api/v1/game-servers/:id/files/archive", requireAuth, requireGamePerm(), async (c) => {
    const path = c.req.query("path") || "";
    if (!path) throw errors.validation({ path: "path is required" });
    // Tar the path on the agent host, then stream it down in base64 chunks.
    const archived = await games.archiveDir(pid(c), path);
    const row = await ctx.db.get<{ server_id: string; name: string }>(`SELECT server_id, name FROM game_servers WHERE id = ?`, [pid(c)]);
    if (!row) throw errors.notFound("Game server not found");
    const hub = ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    const CHUNK = 256 * 1024;
    let offset = 0;
    let total: number | null = null;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const res = await hub.request(row.server_id, "file.read", {
            path: archived.path,
            offset,
            length: CHUNK,
          } as never, { timeoutMs: 60_000 }) as { data: string; length: number; total: number };
          if (total === null) total = res.total;
          if (res.length === 0 || offset >= total) {
            controller.close();
            // Clean up the temp archive on the agent host.
            await hub.request(row.server_id, "file.remove", { path: archived.path }).catch(() => {});
            return;
          }
          controller.enqueue(Buffer.from(res.data, "base64"));
          offset += res.length;
          if (offset >= total) {
            controller.close();
            await hub.request(row.server_id, "file.remove", { path: archived.path }).catch(() => {});
          }
        } catch (err) {
          controller.error(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
    const fileName = `${row.name.replace(/[^a-zA-Z0-9-_]/g, "_")}-${path.split("/").filter(Boolean).pop() ?? "files"}.tar.gz`;
    return new Response(stream as unknown as ReadableStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  /* ── game server: schedules ─────────────────────────────────── */

  const scheduleSchema = z.object({
    name: z.string().min(1),
    cron: z.string().min(5),
    command: z.string().optional().default(""),
    enabled: z.boolean().optional(),
    onlyOnline: z.boolean().optional(),
  });

  app.get("/api/v1/game-servers/:id/schedules", requireAuth, requireGamePerm(), async (c) => {
    const items = await games.listSchedules(pid(c));
    return c.json({ success: true, items });
  });

  app.post("/api/v1/game-servers/:id/schedules", requireAuth, requireGamePerm("schedules"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = scheduleSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const schedule = await games.createSchedule(pid(c), parsed.data);
    return c.json({ success: true, schedule });
  });

  app.patch("/api/v1/game-schedules/:scheduleId", requireAuth, requireGamePerm("schedules", gameIdFromSchedule), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = scheduleSchema.partial().safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const schedule = await games.updateSchedule(pid(c, "scheduleId"), parsed.data);
    return c.json({ success: true, schedule });
  });

  app.delete("/api/v1/game-schedules/:scheduleId", requireAuth, requireGamePerm("schedules", gameIdFromSchedule), async (c) => {
    await games.deleteSchedule(pid(c, "scheduleId"));
    return c.json({ success: true });
  });

  app.post("/api/v1/game-schedules/:scheduleId/run", requireAuth, requireGamePerm("schedules", gameIdFromSchedule), async (c) => {
    const result = await games.runScheduleNow(pid(c, "scheduleId"));
    return c.json({ success: true, ...result });
  });

  /* ── game server: backups ───────────────────────────────────── */

  app.post("/api/v1/game-servers/:id/backup", requireAuth, requireGamePerm("backups"), async (c) => {
    const backup = await games.createBackup(pid(c));
    return c.json({ success: true, backup });
  });

  app.get("/api/v1/game-servers/:id/backups", requireAuth, requireGamePerm("backups"), async (c) => {
    const items = await games.listBackups(pid(c));
    return c.json({ success: true, items });
  });

  app.put("/api/v1/backups/:id/lock", requireAuth, requireGamePerm("backups", gameIdFromBackup), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const locked = body.locked === true;
    const backup = await games.setBackupLocked(pid(c), locked);
    return c.json({ success: true, backup });
  });

  app.delete("/api/v1/game-backups/:id", requireAuth, requireGamePerm("backups", gameIdFromBackup), async (c) => {
    await games.deleteBackup(pid(c));
    return c.json({ success: true });
  });

  /* ── game server: network allocations ───────────────────────── */

  app.get("/api/v1/game-servers/:id/allocations", requireAuth, requireGamePerm(), async (c) => {
    const items = await games.listAllocations(pid(c));
    return c.json({ success: true, items });
  });

  app.post("/api/v1/game-servers/:id/allocations", requireAuth, requireGamePerm("network"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ ip: z.string().min(1), port: z.number().int().min(1).max(65535), notes: z.string().optional() }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const items = await games.createAllocation(pid(c), parsed.data);
    return c.json({ success: true, items });
  });

  app.delete("/api/v1/game-allocations/:allocationId", requireAuth, requireGamePerm("network", gameIdFromAllocation), async (c) => {
    const items = await games.removeAllocation(pid(c, "allocationId"));
    return c.json({ success: true, items });
  });

  app.patch("/api/v1/game-allocations/:allocationId", requireAuth, requireGamePerm("network", gameIdFromAllocation), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({
      ip: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      notes: z.string().nullable().optional(),
    }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const items = await games.updateAllocation(pid(c, "allocationId"), parsed.data);
    return c.json({ success: true, items });
  });

  app.post("/api/v1/game-servers/:id/allocations/:allocationId/primary", requireAuth, requireGamePerm("network"), async (c) => {
    const items = await games.setPrimaryAllocation(pid(c), pid(c, "allocationId"));
    return c.json({ success: true, items });
  });

  /* ── game server: domains (hostnames) ──────────────────────── */

  app.get("/api/v1/game-servers/:id/domains", requireAuth, requireGamePerm(), async (c) => {
    const items = await games.listDomains(pid(c));
    return c.json({ success: true, items });
  });

  app.post("/api/v1/game-servers/:id/domains", requireAuth, requireGamePerm("startup"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ hostname: z.string().min(1), isPrimary: z.boolean().optional(), sslEnabled: z.boolean().optional() }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const domain = await games.addDomain(pid(c), parsed.data.hostname, parsed.data.sslEnabled ?? false, parsed.data.isPrimary ?? false);
    return c.json({ success: true, domain });
  });

  app.delete("/api/v1/game-servers/:id/domains/:domainId", requireAuth, requireGamePerm("startup"), async (c) => {
    await games.removeDomain(pid(c), pid(c, "domainId"));
    return c.json({ success: true });
  });

  /* ── game server: startup ───────────────────────────────────── */

  app.get("/api/v1/game-servers/:id/startup", requireAuth, requireGamePerm(), async (c) => {
    const result = await games.getStartup(pid(c));
    return c.json({ success: true, ...result });
  });

  app.put("/api/v1/game-servers/:id/startup", requireAuth, requireGamePerm("startup"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({
      image: z.string().optional(),
      environment: z.record(z.string()).optional(),
      rawText: z.string().optional(),
    }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.updateStartup(pid(c), parsed.data);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/environment/:key/reveal", requireAuth, requireGamePerm(), async (c) => {
    const result = await games.revealEnvValue(pid(c), pid(c, "key"));
    return c.json({ success: true, ...result });
  });

  /* ── game server: sub-users ─────────────────────────────────── */

  const gameUserSchema = z.object({
    userId: z.string().min(1),
    permissions: z.array(z.string()).optional().default([]),
  });

  app.get("/api/v1/game-servers/:id/users", requireAuth, requireGamePerm(), async (c) => {
    const result = await games.listUsers(pid(c));
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/users", requireAuth, requirePermission("game.write"), async (c) => {
    const user = getAuthUser(c)!;
    if (user.role !== "owner" && user.role !== "admin") throw errors.forbidden("Only admins can manage game server users");
    const body = await c.req.json().catch(() => ({}));
    const parsed = gameUserSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const grant = await games.grantUser(pid(c), parsed.data.userId, parsed.data.permissions);
    return c.json({ success: true, grant });
  });

  app.patch("/api/v1/game-server-users/:grantId", requireAuth, requirePermission("game.write"), async (c) => {
    const user = getAuthUser(c)!;
    if (user.role !== "owner" && user.role !== "admin") throw errors.forbidden("Only admins can manage game server users");
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ permissions: z.array(z.string()).optional().default([]) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const grant = await games.updateUserPermissions(pid(c, "grantId"), parsed.data.permissions);
    return c.json({ success: true, grant });
  });

  app.delete("/api/v1/game-servers/:id/users/:userId", requireAuth, requirePermission("game.write"), async (c) => {
    const user = getAuthUser(c)!;
    if (user.role !== "owner" && user.role !== "admin") throw errors.forbidden("Only admins can manage game server users");
    await games.revokeUser(pid(c), pid(c, "userId"));
    return c.json({ success: true });
  });

  /* ── monitoring ─────────────────────────────────────────────── */

  app.get("/api/v1/monitoring/servers/:serverId", requireAuth, requirePermission("server.read"), async (c) => {
    const hours = parseInt(c.req.query("hours") ?? "24", 10);
    const bucketSeconds = parseInt(c.req.query("bucket") ?? "60", 10);
    const points = await monitoring.series(pid(c, "serverId"), { hours, bucketSeconds });
    return c.json({ success: true, points });
  });

  /* ── notifications ──────────────────────────────────────────── */

  app.get("/api/v1/notifications", requireAuth, requirePermission("notification.read"), async (c) => {
    const user = getAuthUser(c)!;
    const items = await notifications.listForUser(user.id, parseInt(c.req.query("limit") ?? "50", 10));
    const unread = await notifications.unreadCount(user.id);
    return c.json({
      success: true,
      items: items.map((n) => ({ id: n.id, userId: n.user_id, type: n.type, title: n.title, message: n.message, read: !!n.read, createdAt: n.created_at })),
      unread,
    });
  });

  app.post("/api/v1/notifications/:id/read", requireAuth, async (c) => {
    const user = getAuthUser(c)!;
    await notifications.markRead(user.id, pid(c));
    return c.json({ success: true });
  });

  app.post("/api/v1/notifications/read-all", requireAuth, async (c) => {
    const user = getAuthUser(c)!;
    await notifications.markAllRead(user.id);
    return c.json({ success: true });
  });

  /* ── audit ──────────────────────────────────────────────────── */

  app.get("/api/v1/audit", requireAuth, requirePermission("audit.read"), async (c) => {
    const page = parsePageQuery(c);
    const result = await audit.list({
      limit: page.limit,
      cursor: parseCreatedAtCursor(page.cursor) ?? undefined,
      action: c.req.query("action") || undefined,
      resourceType: c.req.query("resourceType") || undefined,
      serverId: c.req.query("serverId") || undefined,
    });
    return c.json({
      success: true,
      items: result.items.map((r) => ({
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        resourceName: r.resource_name,
        serverId: r.server_id,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        ip: r.ip,
        requestId: r.request_id,
        createdAt: r.created_at,
      })),
      nextCursor: result.nextCursor,
    });
  });

  /* ── settings ───────────────────────────────────────────────── */

  app.get("/api/v1/settings", requireAuth, requirePermission("settings.read"), async (c) => {
    const value = await settings.get();
    return c.json({ success: true, settings: value });
  });

  app.post("/api/v1/settings/test-notification", requireAuth, requirePermission("settings.write"), async (c) => {
    const notifier = new (await import("../services/notifier.service")).NotifierService(ctx.db, settings);
    const result = await notifier.sendTestEvent();
    if (!result.webhook && !result.email) {
      throw errors.validation({ notifications: "No channel configured — set a webhook URL or enable email first" });
    }
    await ctx.audit({ action: "settings.test-notification", resourceType: "settings" });
    return c.json({ success: true, delivered: result });
  });

  app.patch("/api/v1/settings", requireAuth, requirePermission("settings.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({
      instanceName: z.string().optional(),
      retention: z.object({ deployments: z.number().optional(), deploymentLogDays: z.number().optional(), metricsHours: z.number().optional(), auditLogDays: z.number().optional() }).optional(),
      monitoring: z.object({ intervalSeconds: z.number().optional() }).optional(),
      security: z.object({ sessionTtlHours: z.number().optional(), maxFailedLogins: z.number().optional(), lockoutMinutes: z.number().optional() }).optional(),
      notifications: z.object({
        backupEventsEnabled: z.boolean().optional(),
        webhookUrl: z.string().optional(),
        emailEnabled: z.boolean().optional(),
        smtpHost: z.string().optional(),
        smtpPort: z.number().optional(),
        smtpSecure: z.boolean().optional(),
        smtpUser: z.string().optional(),
        smtpPass: z.string().optional(),
        emailFrom: z.string().optional(),
        emailTo: z.string().optional(),
      }).optional(),
    }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const value = await settings.update(parsed.data as never);
    await ctx.audit({ action: "settings.update", resourceType: "settings", metadata: { fields: Object.keys(parsed.data) } });
    return c.json({ success: true, settings: value });
  });

  /* ── jobs ───────────────────────────────────────────────────── */

  app.get("/api/v1/jobs", requireAuth, async (c) => {
    const page = parsePageQuery(c);
    const queue = new JobQueue(ctx.db);
    const result = await queue.list({
      limit: page.limit,
      cursor: parseCreatedAtCursor(page.cursor) ?? undefined,
      type: c.req.query("type") || undefined,
      status: c.req.query("status") || undefined,
    });
    return c.json({
      success: true,
      items: result.items.map((j) => ({
        id: j.id,
        type: j.type,
        status: j.status,
        attempts: j.attempts,
        maxAttempts: j.max_attempts,
        payload: JSON.parse(j.payload),
        error: j.error,
        createdAt: j.created_at,
        startedAt: j.started_at,
        finishedAt: j.finished_at,
      })),
      nextCursor: result.nextCursor,
    });
  });

  /* ── resource operation logs (progress for create/deploy/backup) ── */

  app.get("/api/v1/resources/:type/:id/logs", requireAuth, async (c) => {
    const type = c.req.param("type");
    const id = c.req.param("id");
    if (!type || !id || !["database", "application", "backup", "game"].includes(type)) {
      return c.json({ error: { code: "VALIDATION", message: "Unsupported resource type" } }, 422);
    }
    const items = await listResourceLogs(ctx.db, type as "database" | "application" | "backup" | "game", id);
    return c.json({ success: true, items });
  });

  /* ── health ─────────────────────────────────────────────────── */

  app.get("/api/health", async (c) => {
    return c.json({ status: "ok", uptime: process.uptime() });
  });
}
