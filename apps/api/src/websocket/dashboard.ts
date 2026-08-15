import { createLogger } from "@nexus/logger";
import type { DbConnection, UserRow } from "@nexus/database";
import type { DashboardEvent } from "@nexus/types";
import { eventHub } from "../lib/events";
import { hashToken } from "../lib/crypto";
import { SESSION_COOKIE } from "../middleware/auth";

const log = createLogger("api:ws:dashboard");

export interface DashboardSocket {
  ws: WebSocket;
  userId: string;
  /** log streams this socket is subscribed to (streamId → live log lines) */
  subscribed: Set<string>;
  unsubscribe: () => void;
}

const sockets = new Set<DashboardSocket>();

export function dashboardSocketCount(): number {
  return sockets.size;
}

/** Look up a connected dashboard socket by its raw WebSocket. */
export function getDashboardSocket(ws: WebSocket): DashboardSocket | null {
  for (const s of sockets) if (s.ws === ws) return s;
  return null;
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
  const socket: DashboardSocket = {
    ws,
    userId: user.id,
    subscribed: new Set(),
    unsubscribe: () => void 0,
  };
  const unsubscribe = eventHub.subscribe((event: DashboardEvent) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Live container logs are routed only to sockets subscribed to the stream
    // (keeps every open dashboard from receiving every log line).
    if (event.type === "container.log" && !socket.subscribed.has(event.streamId)) return;
    ws.send(JSON.stringify(event));
  });
  socket.unsubscribe = unsubscribe;
  sockets.add(socket);
  ws.send(JSON.stringify({ type: "hello", userId: user.id, online: sockets.size }));

  const cleanup = () => {
    socket.unsubscribe();
    sockets.delete(socket);
  };
  ws.onclose = cleanup;
  ws.onerror = cleanup;
}
