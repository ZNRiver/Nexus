import type { DbConnection, SessionRow, UserRow } from "@nexus/database";
import { hashToken, newId, newToken } from "../lib/crypto";
import { errors } from "../lib/errors";
import type { Role } from "@nexus/types";
import { SettingsService } from "./settings.service";

export interface AuthResult {
  user: UserRow;
  token: string;
  sessionId: string;
  expiresAt: string;
}

export class AuthService {
  constructor(private readonly db: DbConnection) {}

  async register(input: { name: string; email: string; password: string; role?: Role }): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw errors.validation({ email: "Invalid email address" });
    if (input.password.length < 8) throw errors.validation({ password: "Password must be at least 8 characters" });
    if (input.name.trim().length < 2) throw errors.validation({ name: "Name must be at least 2 characters" });

    const existing = await this.db.get<UserRow>(`SELECT id FROM users WHERE email = ?`, [email]);
    if (existing) throw errors.conflict("An account with this email already exists");

    const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
    const now = new Date().toISOString();
    const user: UserRow = {
      id: newId("usr"),
      name: input.name.trim(),
      email,
      password_hash: passwordHash,
      role: input.role ?? "developer",
      created_at: now,
      updated_at: now,
    };
    await this.db.run(
      `INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [user.id, user.name, user.email, user.password_hash, user.role, user.created_at, user.updated_at],
    );
    return this.createSession(user.id);
  }

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    const user = await this.db.get<UserRow>(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!user) throw errors.unauthorized("Invalid email or password");
    const ok = await Bun.password.verify(input.password, user.password_hash);
    if (!ok) throw errors.unauthorized("Invalid email or password");
    return this.createSession(user.id);
  }

  async createSession(userId: string): Promise<AuthResult> {
    const settings = new SettingsService(this.db);
    const ttlHours = (await settings.get()).security.sessionTtlHours;
    const token = newToken(32);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString();
    const session: SessionRow = {
      id: newId("ses"),
      user_id: userId,
      token_hash: hashToken(token),
      expires_at: expiresAt,
      last_used_at: now.toISOString(),
      user_agent: null,
      ip: null,
      created_at: now.toISOString(),
    };
    await this.db.run(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, last_used_at, user_agent, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [session.id, session.user_id, session.token_hash, session.expires_at, session.last_used_at, session.user_agent, session.ip, session.created_at],
    );
    const user = await this.db.get<UserRow>(`SELECT * FROM users WHERE id = ?`, [userId]);
    if (!user) throw errors.notFound("User not found");
    return { user, token, sessionId: session.id, expiresAt };
  }

  async logout(token: string): Promise<void> {
    await this.db.run(`DELETE FROM sessions WHERE token_hash = ?`, [hashToken(token)]);
  }

  async listSessions(userId: string): Promise<SessionRow[]> {
    return this.db.all<SessionRow>(`SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.db.run(`DELETE FROM sessions WHERE id = ? AND user_id = ?`, [sessionId, userId]);
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
    if (exceptSessionId) {
      await this.db.run(`DELETE FROM sessions WHERE user_id = ? AND id != ?`, [userId, exceptSessionId]);
    } else {
      await this.db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
    }
  }

  async me(token: string): Promise<UserRow | null> {
    const session = await this.db.get<SessionRow>(`SELECT * FROM sessions WHERE token_hash = ?`, [hashToken(token)]);
    if (!session) return null;
    if (new Date(session.expires_at).getTime() < Date.now()) return null;
    return this.db.get<UserRow>(`SELECT * FROM users WHERE id = ?`, [session.user_id]);
  }
}
