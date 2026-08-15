import { z } from "zod";
import type { AppContext } from "../context";
import type { App } from "../types";
import { ProjectsService } from "../services/projects.service";
import { GameServersService } from "../services/games.service";
import { MonitoringService } from "../services/monitoring.service";
import { NotificationsService } from "../services/notifications.service";
import { AuditService } from "../services/audit.service";
import { SettingsService } from "../services/settings.service";
import { JobQueue } from "../jobs/queue";
import { OverviewService } from "../services/overview.service";
import { listResourceLogs } from "../services/resource-logs.service";
import { requireAuth, requirePermission, getAuthUser } from "../middleware/auth";
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

  app.get("/api/v1/game-servers", requireAuth, requirePermission("game.read"), async (c) => {
    const page = parsePageQuery(c);
    const result = await games.list({ limit: page.limit, cursor: parseCreatedAtCursor(page.cursor) ?? undefined, serverId: c.req.query("serverId") || undefined });
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers", requireAuth, requirePermission("game.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = gameSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const game = await games.create(parsed.data);
    return c.json({ success: true, gameServer: game });
  });

  app.get("/api/v1/game-servers/:id", requireAuth, requirePermission("game.read"), async (c) => {
    const game = await games.getPublic(pid(c));
    const server = await ctx.db.get(`SELECT * FROM servers WHERE id = ?`, [game.serverId]);
    const system = await monitoring.latest(game.serverId);
    return c.json({ success: true, gameServer: game, server, system });
  });

  app.post("/api/v1/game-servers/:id/start", requireAuth, requirePermission("game.write"), async (c) => {
    const game = await games.start(pid(c));
    return c.json({ success: true, gameServer: game });
  });

  app.post("/api/v1/game-servers/:id/stop", requireAuth, requirePermission("game.write"), async (c) => {
    const game = await games.stop(pid(c));
    return c.json({ success: true, gameServer: game });
  });

  app.post("/api/v1/game-servers/:id/restart", requireAuth, requirePermission("game.write"), async (c) => {
    const result = await games.restart(pid(c));
    return c.json({ success: true, result });
  });

  app.post("/api/v1/game-servers/:id/exec", requireAuth, requirePermission("game.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ cmd: z.array(z.string().min(1)).min(1) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.exec(pid(c), parsed.data.cmd);
    return c.json({ success: true, ...result });
  });

  app.get("/api/v1/game-servers/:id/logs", requireAuth, requirePermission("game.read"), async (c) => {
    const tail = parseInt(c.req.query("tail") ?? "200", 10);
    const logs = await games.logs(pid(c), Math.min(500, Math.max(20, tail)));
    return c.json({ success: true, logs });
  });

  app.get("/api/v1/game-servers/:id/stats", requireAuth, requirePermission("game.read"), async (c) => {
    const stats = await games.stats(pid(c));
    return c.json({ success: true, ...stats });
  });

  app.delete("/api/v1/game-servers/:id", requireAuth, requirePermission("game.delete"), async (c) => {
    const destroy = c.req.query("destroy") === "true";
    await games.remove(pid(c), { destroyData: destroy });
    return c.json({ success: true });
  });

  /* ── game server: file manager ──────────────────────────────── */

  app.get("/api/v1/game-servers/:id/files", requireAuth, requirePermission("game.read"), async (c) => {
    const path = c.req.query("path") || "/";
    const result = await games.listFiles(pid(c), path);
    return c.json({ success: true, ...result });
  });

  app.get("/api/v1/game-servers/:id/files/content", requireAuth, requirePermission("game.read"), async (c) => {
    const path = c.req.query("path") || "";
    if (!path) throw errors.validation({ path: "path is required" });
    const result = await games.readFile(pid(c), path);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/files/write", requireAuth, requirePermission("game.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ path: z.string().min(1), content: z.string() }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.writeFile(pid(c), parsed.data.path, parsed.data.content);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/files/mkdir", requireAuth, requirePermission("game.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ path: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.mkdirFile(pid(c), parsed.data.path);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/files/delete", requireAuth, requirePermission("game.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ path: z.string().min(1), recursive: z.boolean().optional() }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.deleteFile(pid(c), parsed.data.path, parsed.data.recursive ?? false);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/game-servers/:id/files/rename", requireAuth, requirePermission("game.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ path: z.string().min(1), newName: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.renameFile(pid(c), parsed.data.path, parsed.data.newName);
    return c.json({ success: true, ...result });
  });

  /* ── game server: schedules ─────────────────────────────────── */

  const scheduleSchema = z.object({
    name: z.string().min(1),
    cron: z.string().min(5),
    command: z.string().optional().default(""),
    enabled: z.boolean().optional(),
    onlyOnline: z.boolean().optional(),
  });

  app.get("/api/v1/game-servers/:id/schedules", requireAuth, requirePermission("game.read"), async (c) => {
    const items = await games.listSchedules(pid(c));
    return c.json({ success: true, items });
  });

  app.post("/api/v1/game-servers/:id/schedules", requireAuth, requirePermission("game.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = scheduleSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const schedule = await games.createSchedule(pid(c), parsed.data);
    return c.json({ success: true, schedule });
  });

  app.patch("/api/v1/game-schedules/:scheduleId", requireAuth, requirePermission("game.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = scheduleSchema.partial().safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const schedule = await games.updateSchedule(pid(c, "scheduleId"), parsed.data);
    return c.json({ success: true, schedule });
  });

  app.delete("/api/v1/game-schedules/:scheduleId", requireAuth, requirePermission("game.write"), async (c) => {
    await games.deleteSchedule(pid(c, "scheduleId"));
    return c.json({ success: true });
  });

  app.post("/api/v1/game-schedules/:scheduleId/run", requireAuth, requirePermission("game.write"), async (c) => {
    const result = await games.runScheduleNow(pid(c, "scheduleId"));
    return c.json({ success: true, ...result });
  });

  /* ── game server: backups ───────────────────────────────────── */

  app.post("/api/v1/game-servers/:id/backup", requireAuth, requirePermission("backup.create"), async (c) => {
    const backup = await games.createBackup(pid(c));
    return c.json({ success: true, backup });
  });

  app.get("/api/v1/game-servers/:id/backups", requireAuth, requirePermission("backup.create"), async (c) => {
    const items = await games.listBackups(pid(c));
    return c.json({ success: true, items });
  });

  app.put("/api/v1/backups/:id/lock", requireAuth, requirePermission("backup.create"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const locked = body.locked === true;
    const backup = await games.setBackupLocked(pid(c), locked);
    return c.json({ success: true, backup });
  });

  app.delete("/api/v1/game-backups/:id", requireAuth, requirePermission("backup.delete"), async (c) => {
    await games.deleteBackup(pid(c));
    return c.json({ success: true });
  });

  /* ── game server: network allocations ───────────────────────── */

  app.get("/api/v1/game-servers/:id/allocations", requireAuth, requirePermission("game.read"), async (c) => {
    const items = await games.listAllocations(pid(c));
    return c.json({ success: true, items });
  });

  app.patch("/api/v1/game-allocations/:allocationId", requireAuth, requirePermission("game.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const notes = typeof body.notes === "string" ? body.notes : "";
    const allocation = await games.updateAllocationNotes(pid(c, "allocationId"), notes);
    return c.json({ success: true, allocation });
  });

  app.post("/api/v1/game-servers/:id/allocations/:allocationId/primary", requireAuth, requirePermission("game.write"), async (c) => {
    const items = await games.setPrimaryAllocation(pid(c), pid(c, "allocationId"));
    return c.json({ success: true, items });
  });

  /* ── game server: startup ───────────────────────────────────── */

  app.get("/api/v1/game-servers/:id/startup", requireAuth, requirePermission("game.read"), async (c) => {
    const result = await games.getStartup(pid(c));
    return c.json({ success: true, ...result });
  });

  app.put("/api/v1/game-servers/:id/startup", requireAuth, requirePermission("game.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({
      image: z.string().optional(),
      environment: z.record(z.string()).optional(),
    }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await games.updateStartup(pid(c), parsed.data);
    return c.json({ success: true, ...result });
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
    if (!type || !id || !["database", "application", "backup"].includes(type)) {
      return c.json({ error: { code: "VALIDATION", message: "Unsupported resource type" } }, 422);
    }
    const items = await listResourceLogs(ctx.db, type as "database" | "application" | "backup", id);
    return c.json({ success: true, items });
  });

  /* ── health ─────────────────────────────────────────────────── */

  app.get("/api/health", async (c) => {
    return c.json({ status: "ok", uptime: process.uptime() });
  });
}
