import { z } from "zod";
import type { AppContext } from "../context";
import type { App } from "../types";
import { ApplicationsService } from "../services/applications.service";
import { DeploymentsService } from "../services/deployments.service";
import { requireAuth, requirePermission, getAuthUser } from "../middleware/auth";
import { errors } from "../lib/errors";
import { parseCreatedAtCursor, parsePageQuery, pid } from "../lib/http";

const createAppSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  projectId: z.string().optional(),
  serverId: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().default("main"),
  provider: z.enum(["Github", "Gitlab", "Bitbucket", "Gitea", "Docker", "Git", "Drop"]).optional(),
  triggerType: z.enum(["MANUAL", "ON_PUSH", "SCHEDULE"]).optional(),
  deploymentMethod: z.enum(["DOCKERFILE", "COMPOSE"]),
  dockerfilePath: z.string().default("Dockerfile"),
  buildContext: z.string().default("."),
  composePath: z.string().default("docker-compose.yml"),
  port: z.number().int().min(1).max(65535).optional(),
  startCommand: z.string().optional(),
  autodeploy: z.boolean().optional(),
  healthcheck: z.object({
    type: z.enum(["http", "tcp"]),
    path: z.string().optional(),
    port: z.number().int().optional(),
    intervalSeconds: z.number().optional(),
    timeoutSeconds: z.number().optional(),
    retries: z.number().optional(),
  }).nullable().optional(),
  restartPolicy: z.enum(["no", "always", "on-failure", "unless-stopped"]).default("unless-stopped"),
  cpuLimit: z.number().optional(),
  memoryLimitBytes: z.number().optional(),
  memoryReservationBytes: z.number().optional(),
  pidsLimit: z.number().optional(),
  volumeName: z.string().optional(),
  volumeMountPath: z.string().optional(),
  registry: z.string().optional(),
  registryUsername: z.string().optional(),
  registryPassword: z.string().optional(),
  environment: z.array(z.object({ key: z.string(), value: z.string(), isSecret: z.boolean().optional() })).optional(),
});

const deploySchema = z.object({ branch: z.string().optional(), commit: z.string().optional() });
const rollbackSchema = z.object({ deploymentId: z.string().min(1) });
const envSchema = z.object({ key: z.string().min(1), value: z.string(), isSecret: z.boolean().optional() });
const domainSchema = z.object({ hostname: z.string().min(1), isPrimary: z.boolean().optional(), sslEnabled: z.boolean().optional() });

export function registerApplicationRoutes(app: App, ctx: AppContext): void {
  const apps = new ApplicationsService(ctx.db, ctx);
  const deployments = new DeploymentsService(ctx.db, ctx);

  /* ── applications ───────────────────────────────────────────── */

  app.get("/api/v1/applications", requireAuth, requirePermission("application.read"), async (c) => {
    const page = parsePageQuery(c);
    const result = await apps.list({
      limit: page.limit,
      cursor: parseCreatedAtCursor(page.cursor) ?? undefined,
      projectId: c.req.query("projectId") || undefined,
      serverId: c.req.query("serverId") || undefined,
    });
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/applications", requireAuth, requirePermission("application.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createAppSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const app = await apps.create(parsed.data);
    return c.json({ success: true, application: app });
  });

  app.get("/api/v1/applications/:id", requireAuth, requirePermission("application.read"), async (c) => {
    const id = pid(c);
    const row = await apps.get(id);
    const application = await apps.getPublic(id);
    const [deploymentsList, environment, domains, server] = await Promise.all([
      ctx.db.all(`SELECT * FROM application_deployments WHERE application_id = ? ORDER BY created_at DESC LIMIT 25`, [id]),
      apps.listEnvVars(id),
      apps.listDomains(id),
      ctx.db.get(`SELECT * FROM servers WHERE id = ?`, [row.server_id]),
    ]);
    return c.json({ success: true, application, deployments: deploymentsList, environment, domains, server });
  });

  app.patch("/api/v1/applications/:id", requireAuth, requirePermission("application.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createAppSchema.partial().safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const app = await apps.update(pid(c), parsed.data);
    await ctx.audit({ action: "application.update", resourceType: "application", resourceId: app.id, resourceName: app.name, serverId: app.serverId });
    return c.json({ success: true, application: app });
  });

  app.delete("/api/v1/applications/:id", requireAuth, requirePermission("application.delete"), async (c) => {
    const destroy = c.req.query("destroy") === "true";
    await apps.remove(pid(c), { destroyResources: destroy });
    return c.json({ success: true });
  });

  app.post("/api/v1/applications/:id/deploy", requireAuth, requirePermission("application.deploy"), async (c) => {
    const user = getAuthUser(c)!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = deploySchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await apps.deploy(pid(c), { ...parsed.data, userId: user.id, userName: user.name });
    return c.json({ success: true, deploymentId: result.deploymentId });
  });

  app.post("/api/v1/applications/:id/rollback", requireAuth, requirePermission("deployment.rollback"), async (c) => {
    const user = getAuthUser(c)!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = rollbackSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await apps.rollback(pid(c), parsed.data.deploymentId, user.id, user.name);
    return c.json({ success: true, deploymentId: result.deploymentId });
  });

  app.post("/api/v1/applications/:id/restart", requireAuth, requirePermission("application.deploy"), async (c) => {
    const app = await apps.getPublic(pid(c));
    if (!app.currentContainerId) throw errors.conflict("No container is running for this application");
    const hub = ctx.hub;
    if (!hub.isOnline(app.serverId)) throw errors.serverOffline();
    await hub.request(app.serverId, "container.restart", { id: app.currentContainerId });
    await ctx.audit({ action: "application.restart", resourceType: "application", resourceId: app.id, resourceName: app.name, serverId: app.serverId });
    return c.json({ success: true });
  });

  app.post("/api/v1/applications/:id/stop", requireAuth, requirePermission("application.deploy"), async (c) => {
    const app = await apps.getPublic(pid(c));
    if (!app.currentContainerId) throw errors.conflict("No container is running for this application");
    const hub = ctx.hub;
    if (!hub.isOnline(app.serverId)) throw errors.serverOffline();
    await hub.request(app.serverId, "container.stop", { id: app.currentContainerId, timeoutSeconds: 15 });
    await ctx.db.run(`UPDATE applications SET status = 'STOPPED', updated_at = ? WHERE id = ?`, [new Date().toISOString(), app.id]);
    await ctx.audit({ action: "application.stop", resourceType: "application", resourceId: app.id, resourceName: app.name, serverId: app.serverId });
    return c.json({ success: true });
  });

  app.post("/api/v1/applications/:id/start", requireAuth, requirePermission("application.deploy"), async (c) => {
    const app = await apps.getPublic(pid(c));
    if (!app.currentContainerId) throw errors.conflict("No container is running for this application");
    const hub = ctx.hub;
    if (!hub.isOnline(app.serverId)) throw errors.serverOffline();
    await hub.request(app.serverId, "container.start", { id: app.currentContainerId });
    await ctx.db.run(`UPDATE applications SET status = 'RUNNING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), app.id]);
    await ctx.audit({ action: "application.start", resourceType: "application", resourceId: app.id, resourceName: app.name, serverId: app.serverId });
    return c.json({ success: true });
  });

  app.post("/api/v1/applications/:id/rebuild", requireAuth, requirePermission("application.deploy"), async (c) => {
    const app = await apps.getPublic(pid(c));
    const result = await apps.deploy(app.id, { branch: app.branch, userName: "system" });
    await ctx.audit({ action: "application.rebuild", resourceType: "application", resourceId: app.id, resourceName: app.name, serverId: app.serverId });
    return c.json({ success: true, deploymentId: result.deploymentId });
  });

  app.post("/api/v1/applications/:id/exec", requireAuth, requirePermission("application.deploy"), async (c) => {
    const app = await apps.getPublic(pid(c));
    if (!app.currentContainerId) throw errors.conflict("No container is running for this application");
    const hub = ctx.hub;
    if (!hub.isOnline(app.serverId)) throw errors.serverOffline();
    const body = await c.req.json().catch(() => ({}));
    const cmd = Array.isArray(body.cmd) ? (body.cmd as unknown[]).map(String).filter(Boolean) : [];
    if (cmd.length === 0) throw errors.validation({ cmd: "cmd is required" });
    const result = await hub.request(app.serverId, "container.exec", {
      id: app.currentContainerId,
      cmd,
      timeoutMs: 30000,
    }) as { output: string; exitCode: number };
    await ctx.audit({ action: "application.exec", resourceType: "application", resourceId: app.id, resourceName: app.name, serverId: app.serverId, metadata: { cmd } });
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/applications/:id/clean-cache", requireAuth, requirePermission("application.deploy"), async (c) => {
    const app = await apps.getPublic(pid(c));
    if (!app.currentContainerId) throw errors.conflict("No container is running for this application");
    const hub = ctx.hub;
    if (!hub.isOnline(app.serverId)) throw errors.serverOffline();
    const result = await hub.request(app.serverId, "container.exec", {
      id: app.currentContainerId,
      cmd: ["php", "artisan", "cache:clear"],
      timeoutMs: 30000,
    }) as { output: string; exitCode: number };
    if (result.exitCode !== 0) throw errors.conflict("Cache clear failed — is this a PHP/Laravel application?");
    await ctx.audit({ action: "application.clean-cache", resourceType: "application", resourceId: app.id, resourceName: app.name, serverId: app.serverId });
    return c.json({ success: true, output: result.output });
  });

  /* ── environment variables ──────────────────────────────────── */

  app.get("/api/v1/applications/:id/environment", requireAuth, requirePermission("application.read"), async (c) => {
    const env = await apps.listEnvVars(pid(c));
    return c.json({ success: true, items: env });
  });

  app.put("/api/v1/applications/:id/environment", requireAuth, requirePermission("application.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ variables: z.array(z.object({ key: z.string().min(1), value: z.string(), isSecret: z.boolean().optional() })) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const variables = await apps.syncEnvVars(pid(c), parsed.data.variables);
    return c.json({ success: true, variables });
  });

  app.post("/api/v1/applications/:id/environment", requireAuth, requirePermission("application.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = envSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const env = await apps.upsertEnvVar(pid(c), parsed.data.key, parsed.data.value, parsed.data.isSecret ?? false);
    return c.json({ success: true, item: env });
  });

  app.delete("/api/v1/applications/:id/environment/:envId", requireAuth, requirePermission("application.write"), async (c) => {
    await apps.deleteEnvVar(pid(c), pid(c, "envId"));
    return c.json({ success: true });
  });

  app.post("/api/v1/applications/:id/environment/:envId/reveal", requireAuth, requirePermission("application.read"), async (c) => {
    const result = await apps.revealEnvValue(pid(c), pid(c, "envId"));
    await ctx.audit({ action: "environment.reveal", resourceType: "application", resourceId: pid(c), resourceName: pid(c, "envId") });
    return c.json({ success: true, ...result });
  });

  /* ── domains ────────────────────────────────────────────────── */

  app.get("/api/v1/applications/:id/domains", requireAuth, requirePermission("application.read"), async (c) => {
    const domains = await apps.listDomains(pid(c));
    return c.json({ success: true, items: domains });
  });

  app.post("/api/v1/applications/:id/domains", requireAuth, requirePermission("application.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = domainSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const domain = await apps.addDomain(pid(c), parsed.data.hostname, parsed.data.sslEnabled ?? false, parsed.data.isPrimary ?? false);
    return c.json({ success: true, domain });
  });

  app.delete("/api/v1/applications/:id/domains/:domainId", requireAuth, requirePermission("application.write"), async (c) => {
    await apps.removeDomain(pid(c), pid(c, "domainId"));
    return c.json({ success: true });
  });

  /* ── deployments ────────────────────────────────────────────── */

  app.get("/api/v1/applications/:id/deployments", requireAuth, requirePermission("deployment.read"), async (c) => {
    const page = parsePageQuery(c);
    const result = await deployments.list({
      applicationId: pid(c),
      limit: page.limit,
      cursor: parseCreatedAtCursor(page.cursor) ?? undefined,
    });
    return c.json({ success: true, ...result });
  });

  app.get("/api/v1/deployments", requireAuth, requirePermission("deployment.read"), async (c) => {
    const page = parsePageQuery(c);
    const result = await deployments.list({
      limit: page.limit,
      cursor: parseCreatedAtCursor(page.cursor) ?? undefined,
      status: c.req.query("status") || undefined,
      serverId: c.req.query("serverId") || undefined,
    });
    return c.json({ success: true, ...result });
  });

  app.get("/api/v1/deployments/:id", requireAuth, requirePermission("deployment.read"), async (c) => {
    const dep = await deployments.getPublic(pid(c));
    const logs = await deployments.getLogs(dep.id);
    return c.json({ success: true, deployment: dep, logs });
  });

  app.get("/api/v1/deployments/:id/logs", requireAuth, requirePermission("deployment.read"), async (c) => {
    const logs = await deployments.getLogs(pid(c), c.req.query("sinceId") || undefined);
    return c.json({ success: true, logs });
  });

  app.post("/api/v1/deployments/:id/cancel", requireAuth, requirePermission("deployment.cancel"), async (c) => {
    const dep = await deployments.cancel(pid(c));
    return c.json({ success: true, deployment: dep });
  });

  /* ── volume backups ─────────────────────────────────────────── */

  app.post("/api/v1/applications/:id/backup", requireAuth, requirePermission("backup.create"), async (c) => {
    const backup = await apps.createBackup(pid(c));
    return c.json({ success: true, backup });
  });

  const updateBackupScheduleSchema = z.object({
    enabled: z.boolean(),
    cron: z.string().optional(),
    retention: z.number().int().min(1).max(365).optional(),
  });

  app.put("/api/v1/applications/:id/backup-schedule", requireAuth, requirePermission("application.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = updateBackupScheduleSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const application = await apps.updateBackupSchedule(pid(c), parsed.data);
    return c.json({ success: true, application });
  });

  app.get("/api/v1/applications/:id/backups", requireAuth, requirePermission("backup.create"), async (c) => {
    const backups = await apps.listBackups(pid(c));
    return c.json({ success: true, items: backups });
  });

  /* ── app logs (container) ───────────────────────────────────── */

  app.get("/api/v1/applications/:id/logs", requireAuth, requirePermission("application.read"), async (c) => {
    const app = await apps.get(pid(c));
    if (!app.current_container_id) return c.json({ success: true, logs: "" });
    const { InfraService } = await import("../services/infra.service");
    const infra = new InfraService(ctx.db, ctx);
    const logs = await infra.containerLogs(app.server_id, app.current_container_id, parseInt(c.req.query("tail") ?? "200", 10));
    return c.json({ success: true, logs });
  });
}
