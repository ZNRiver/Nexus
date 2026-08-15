import type { Context, Next } from "hono";
import type { UserRow, DbConnection } from "@nexus/database";
import { hashToken } from "../lib/crypto";
import { errors } from "../lib/errors";
import type { Role } from "@nexus/types";
import { roleHasPermission, type Permission } from "../lib/permissions";
import type { AppVariables } from "../types";

export const SESSION_COOKIE = "nexus_session";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

type AuthContext = Context<{ Variables: AppVariables }>;

/** Loads the session user from the cookie; throws UNAUTHORIZED if absent. */
export async function requireAuth(c: AuthContext, next: Next): Promise<void> {
  const user = await loadUser(c);
  if (!user) throw errors.unauthorized();
  c.set("user", user);
  await next();
}

export async function optionalAuth(c: AuthContext, next: Next): Promise<void> {
  const user = await loadUser(c);
  if (user) c.set("user", user);
  await next();
}

export function getAuthUser(c: AuthContext): AuthUser | undefined {
  return c.get("user") as AuthUser | undefined;
}

export function requirePermission(permission: Permission) {
  return async (c: AuthContext, next: Next): Promise<void> => {
    const user = getAuthUser(c);
    if (!user) throw errors.unauthorized();
    if (!roleHasPermission(user.role, permission)) {
      throw errors.forbidden(`Missing permission: ${permission}`);
    }
    await next();
  };
}

async function loadUser(c: AuthContext): Promise<AuthUser | null> {
  const db = c.get("db");
  const cookie = c.req.header("cookie") ?? "";
  const raw = cookie
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const token = raw.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;

  const session = await db.get<{ user_id: string; token_hash: string; expires_at: string }>(
    `SELECT user_id, token_hash, expires_at FROM sessions WHERE token_hash = ?`,
    [hashToken(token)],
  );
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await db.run(`DELETE FROM sessions WHERE token_hash = ?`, [session.token_hash]);
    return null;
  }

  const user = await db.get<UserRow>(`SELECT * FROM users WHERE id = ?`, [session.user_id]);
  if (!user) return null;

  try {
    await db.run(`UPDATE sessions SET last_used_at = ? WHERE token_hash = ?`, [new Date().toISOString(), session.token_hash]);
  } catch {
    /* best effort */
  }

  return { id: user.id, name: user.name, email: user.email, role: user.role };
}
