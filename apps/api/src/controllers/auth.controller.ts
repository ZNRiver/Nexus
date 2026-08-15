import type { Context } from "hono";
import { z } from "zod";
import type { AppContext } from "../context";
import type { App } from "../types";
import { AuthService } from "../services/auth.service";
import { SetupService } from "../services/setup.service";
import { SESSION_COOKIE, requireAuth, getAuthUser } from "../middleware/auth";
import { errors } from "../lib/errors";
import { clientIp, pid } from "../lib/http";
import { createIpLimiter } from "../lib/ratelimit";

const authLimiter = createIpLimiter(10, 60_000);

const cookieOpts = (ctx: AppContext) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: ctx.config.cookieSecure,
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const registerSchema = z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8) });
const setupSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  system: z.object({
    hostname: z.string().optional(),
    os: z.string().optional(),
    platform: z.string().optional(),
    arch: z.string().optional(),
    cpuModel: z.string().optional(),
    cpuCores: z.number().optional(),
    cpuSpeedMhz: z.number().optional(),
    memoryTotalBytes: z.number().optional(),
    memoryFreeBytes: z.number().optional(),
    diskTotalBytes: z.number().optional(),
    diskFreeBytes: z.number().optional(),
    dockerVersion: z.string().nullable().optional(),
    dockerAvailable: z.boolean().optional(),
    kernel: z.string().optional(),
    uptimeSeconds: z.number().optional(),
  }),
});

function readToken(c: Context): string {
  const cookie = c.req.header("cookie") ?? "";
  const raw = cookie.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  return raw ? raw.slice(SESSION_COOKIE.length + 1) : "";
}

export function registerAuthRoutes(app: App, ctx: AppContext): void {
  const auth = new AuthService(ctx.db);
  const setup = new SetupService(ctx.db);

  app.get("/api/v1/setup", async (c) => {
    return c.json({ setup: await setup.state() });
  });

  app.post("/api/v1/setup", async (c) => {
    const limit = await authLimiter.check(`setup:${clientIp(c)}`);
    if (!limit.ok) throw errors.rateLimited();
    const body = await c.req.json().catch(() => ({}));
    const parsed = setupSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const { user, server, agentToken } = await setup.createAdminAndLocalServer({
      name: parsed.data.name,
      email: parsed.data.email,
      password: parsed.data.password,
      system: parsed.data.system as never,
    });
    const session = await auth.createSession(user.id);
    c.header("Set-Cookie", `${SESSION_COOKIE}=${session.token}; ${cookieParams(ctx)}`);
    // Spawn the local NEXUS Agent now that a Local Server exists.
    try {
      const { LocalAgentLauncher } = await import("../agents/local");
      await new LocalAgentLauncher(ctx.db, ctx.config).start();
    } catch (err) {
      ctx.logger.warn("local agent spawn failed", { error: err instanceof Error ? err.message : String(err) });
    }
    return c.json({ success: true, user: publicUser(user), server: { id: server.id, name: server.name, type: server.type, status: server.status } });
  });

  app.post("/api/v1/auth/register", async (c) => {
    const limit = await authLimiter.check(`register:${clientIp(c)}`);
    if (!limit.ok) throw errors.rateLimited();
    const body = await c.req.json().catch(() => ({}));
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    // Only allow registration when setup is complete (single-owner instance).
    const state = await setup.state();
    if (!state.adminCreated) throw errors.forbidden("Complete the setup wizard first");
    const session = await auth.register(parsed.data);
    c.header("Set-Cookie", `${SESSION_COOKIE}=${session.token}; ${cookieParams(ctx)}`);
    return c.json({ success: true, user: publicUser(session.user) });
  });

  app.post("/api/v1/auth/login", async (c) => {
    const limit = await authLimiter.check(`login:${clientIp(c)}`);
    if (!limit.ok) throw errors.rateLimited();
    const body = await c.req.json().catch(() => ({}));
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const session = await auth.login(parsed.data);
    c.header("Set-Cookie", `${SESSION_COOKIE}=${session.token}; ${cookieParams(ctx)}`);
    return c.json({ success: true, user: publicUser(session.user) });
  });

  app.post("/api/v1/auth/logout", async (c) => {
    const token = readToken(c);
    if (token) await auth.logout(token).catch(() => {});
    c.header("Set-Cookie", `${SESSION_COOKIE}=; ${cookieParams(ctx)}; Max-Age=0`);
    return c.json({ success: true });
  });

  app.get("/api/v1/auth/me", async (c) => {
    const token = readToken(c);
    if (!token) {
      return c.json({ user: null, setup: await setup.state() });
    }
    const user = await auth.me(token);
    return c.json({ user: user ? publicUser(user) : null, setup: await setup.state() });
  });

  app.get("/api/v1/auth/sessions", requireAuth, async (c) => {
    const user = getAuthUser(c)!;
    const sessions = await auth.listSessions(user.id);
    return c.json({ success: true, sessions: sessions.map((s) => ({ id: s.id, createdAt: s.created_at, expiresAt: s.expires_at, lastUsedAt: s.last_used_at, userAgent: s.user_agent, ip: s.ip })) });
  });

  app.delete("/api/v1/auth/sessions/:id", requireAuth, async (c) => {
    const user = getAuthUser(c)!;
    await auth.revokeSession(user.id, pid(c));
    return c.json({ success: true });
  });

  app.post("/api/v1/auth/sessions/revoke-all", requireAuth, async (c) => {
    const user = getAuthUser(c)!;
    await auth.revokeAllSessions(user.id);
    return c.json({ success: true });
  });

  app.post("/api/v1/auth/change-password", requireAuth, async (c) => {
    const user = getAuthUser(c)!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const row = await ctx.db.get<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = ?`, [user.id]);
    if (!row) throw errors.unauthorized();
    const ok = await Bun.password.verify(parsed.data.currentPassword, row.password_hash);
    if (!ok) throw errors.unauthorized("Current password is incorrect");
    const hash = await Bun.password.hash(parsed.data.newPassword, { algorithm: "argon2id" });
    await ctx.db.run(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [hash, new Date().toISOString(), user.id]);
    return c.json({ success: true });
  });
}

function publicUser(user: { id: string; name: string; email: string; role: string; created_at: string; updated_at: string }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.created_at, updatedAt: user.updated_at };
}

function cookieParams(ctx: AppContext): string {
  const parts = ["HttpOnly", "SameSite=Lax", "Path=/"];
  if (ctx.config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}
