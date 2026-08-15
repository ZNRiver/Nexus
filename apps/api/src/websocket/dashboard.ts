import { createLogger } from "@nexus/logger";
import type { DbConnection, UserRow } from "@nexus/database";
import type { DashboardEvent } from "@nexus/types";
import { eventHub } from "../lib/events";
import { hashToken } from "../lib/crypto";
import { SESSION_COOKIE } from "../middleware/auth";

const log = createLogger("api:ws:dashboard");

interface DashboardSocket {
  ws: WebSocket;
  userId: string;
  unsubscribe: () => void;
}

const sockets = new Set<DashboardSocket>();

export function dashboardSocketCount(): number {
  return sockets.size;
}

/** Authenticate a dashboard WS upgrade from the session cookie. */
export async function authenticateDashboard(db: DbConnection, url: URL, cookie: string): Promise<UserRow | null> {
  const raw = cookie.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const token = raw.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;
  const session = await db.get<{ user_id: string; expires_at: string }>(
    `SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`,
    [hashToken(token)],
  );
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  return db.get<UserRow>(`SELECT * FROM users WHERE id = ?`, [session.user_id]);
}

export function handleDashboardSocket(ws: WebSocket, user: UserRow): void {
  const unsubscribe = eventHub.subscribe((event: DashboardEvent) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  });
  const socket: DashboardSocket = { ws, userId: user.id, unsubscribe };
  sockets.add(socket);
  ws.send(JSON.stringify({ type: "hello", userId: user.id, online: sockets.size }));

  ws.onclose = () => {
    socket.unsubscribe();
    sockets.delete(socket);
  };
  ws.onerror = () => {
    socket.unsubscribe();
    sockets.delete(socket);
  };
}
