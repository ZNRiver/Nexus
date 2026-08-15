import { z } from "zod";
import type { AppContext } from "../context";
import type { App } from "../types";
import { InfraService } from "../services/infra.service";
import { requireAuth, requirePermission } from "../middleware/auth";
import { errors } from "../lib/errors";
import { pid } from "../lib/http";

export function registerInfraRoutes(app: App, ctx: AppContext): void {
  const infra = new InfraService(ctx.db, ctx);

  /* ── containers ─────────────────────────────────────────────── */

  app.get("/api/v1/containers", requireAuth, requirePermission("infra.read"), async (c) => {
    const results = await infra.containers(c.req.query("serverId") || undefined);
    return c.json({ success: true, items: results });
  });

  app.post("/api/v1/containers/:id/:action", requireAuth, requirePermission("infra.write"), async (c) => {
    const action = pid(c, "action");
    const valid = ["start", "stop", "restart", "pause", "unpause", "remove"];
    if (!valid.includes(action)) throw errors.badRequest(`Unsupported container action: ${action}`);
    const serverId = c.req.query("serverId");
    if (!serverId) throw errors.validation({ serverId: "serverId query param is required" });
    const body = await c.req.json().catch(() => ({})) as { force?: boolean; volumes?: boolean };
    const result = await infra.containerAction(serverId, pid(c), action as never, { force: body.force, volumes: body.volumes });
    return c.json({ success: true, ...result });
  });

  app.get("/api/v1/containers/:id/logs", requireAuth, requirePermission("infra.read"), async (c) => {
    const serverId = c.req.query("serverId");
    if (!serverId) throw errors.validation({ serverId: "serverId query param is required" });
    const logs = await infra.containerLogs(serverId, pid(c), parseInt(c.req.query("tail") ?? "200", 10));
    return c.json({ success: true, logs });
  });

  app.get("/api/v1/containers/:id/inspect", requireAuth, requirePermission("infra.read"), async (c) => {
    const serverId = c.req.query("serverId");
    if (!serverId) throw errors.validation({ serverId: "serverId query param is required" });
    const data = await infra.containerInspect(serverId, pid(c));
    return c.json({ success: true, data });
  });

  app.post("/api/v1/containers/:id/exec", requireAuth, requirePermission("infra.write"), async (c) => {
    const serverId = c.req.query("serverId");
    if (!serverId) throw errors.validation({ serverId: "serverId query param is required" });
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ cmd: z.array(z.string()).min(1) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await infra.containerExec(serverId, pid(c), parsed.data.cmd);
    return c.json({ success: true, ...result });
  });

  /* ── images ─────────────────────────────────────────────────── */

  app.get("/api/v1/images", requireAuth, requirePermission("infra.read"), async (c) => {
    const results = await infra.images(c.req.query("serverId") || undefined);
    return c.json({ success: true, items: results });
  });

  app.post("/api/v1/images/pull", requireAuth, requirePermission("infra.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ serverId: z.string(), image: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await infra.pullImage(parsed.data.serverId, parsed.data.image);
    return c.json({ success: true, ...result });
  });

  app.delete("/api/v1/images", requireAuth, requirePermission("infra.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ serverId: z.string(), image: z.string().min(1), force: z.boolean().optional() }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    await infra.removeImage(parsed.data.serverId, parsed.data.image, parsed.data.force);
    return c.json({ success: true });
  });

  /* ── volumes ────────────────────────────────────────────────── */

  app.get("/api/v1/volumes", requireAuth, requirePermission("infra.read"), async (c) => {
    const results = await infra.volumes(c.req.query("serverId") || undefined);
    return c.json({ success: true, items: results });
  });

  app.post("/api/v1/volumes", requireAuth, requirePermission("infra.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ serverId: z.string(), name: z.string().min(1), driver: z.string().optional() }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await infra.createVolume(parsed.data.serverId, parsed.data.name, parsed.data.driver);
    return c.json({ success: true, ...result });
  });

  app.delete("/api/v1/volumes/:name", requireAuth, requirePermission("infra.delete"), async (c) => {
    const serverId = c.req.query("serverId");
    const force = c.req.query("force") === "true";
    if (!serverId) throw errors.validation({ serverId: "serverId query param is required" });
    await infra.removeVolume(serverId, pid(c, "name"), force);
    return c.json({ success: true });
  });

  /* ── networks ───────────────────────────────────────────────── */

  app.get("/api/v1/networks", requireAuth, requirePermission("infra.read"), async (c) => {
    const results = await infra.networks(c.req.query("serverId") || undefined);
    return c.json({ success: true, items: results });
  });

  app.post("/api/v1/networks", requireAuth, requirePermission("infra.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ serverId: z.string(), name: z.string().min(1), driver: z.string().optional(), subnet: z.string().optional() }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await infra.createNetwork(parsed.data.serverId, parsed.data.name, parsed.data.driver, parsed.data.subnet);
    return c.json({ success: true, ...result });
  });

  app.delete("/api/v1/networks/:name", requireAuth, requirePermission("infra.delete"), async (c) => {
    const serverId = c.req.query("serverId");
    if (!serverId) throw errors.validation({ serverId: "serverId query param is required" });
    await infra.removeNetwork(serverId, pid(c, "name"));
    return c.json({ success: true });
  });
}
