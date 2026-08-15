import type { DbConnection } from "@nexus/database";
import type { AgentHub } from "../agents/hub";
import { eventHub } from "../lib/events";
import { getDashboardSocket, type DashboardSocket } from "./dashboard";

export type LogStreamKind = "game" | "database" | "application";

interface LogStream {
  streamId: string;
  kind: LogStreamKind;
  id: string;
  serverId: string;
  containerId: string;
  sockets: Set<DashboardSocket>;
  started: boolean;
}

const streams = new Map<string, LogStream>();

async function resolveContainer(
  db: DbConnection,
  kind: LogStreamKind,
  id: string,
): Promise<{ serverId: string; containerId: string } | null> {
  if (kind === "game") {
    const row = await db.get<{ server_id: string; container_id: string | null }>(
      `SELECT server_id, container_id FROM game_servers WHERE id = ?`,
      [id],
    );
    return row?.container_id ? { serverId: row.server_id, containerId: row.container_id } : null;
  }
  if (kind === "database") {
    const row = await db.get<{ server_id: string; container_id: string | null }>(
      `SELECT server_id, container_id FROM databases WHERE id = ?`,
      [id],
    );
    return row?.container_id ? { serverId: row.server_id, containerId: row.container_id } : null;
  }
  if (kind === "application") {
    const row = await db.get<{ server_id: string; current_container_id: string | null }>(
      `SELECT server_id, current_container_id FROM applications WHERE id = ?`,
      [id],
    );
    return row?.current_container_id ? { serverId: row.server_id, containerId: row.current_container_id } : null;
  }
  return null;
}

async function ensureStarted(db: DbConnection, hub: AgentHub, stream: LogStream): Promise<void> {
  if (stream.started) return;
  // Container may have been removed — re-resolve before starting.
  const resolved = await resolveContainer(db, stream.kind, stream.id);
  if (!resolved) return;
  stream.containerId = resolved.containerId;
  stream.serverId = resolved.serverId;
  if (!hub.isOnline(stream.serverId)) return;
  stream.started = true;
  try {
    await hub.request(
      stream.serverId,
      "container.logs.follow",
      { id: stream.containerId, streamId: stream.streamId, tail: 200 },
      { timeoutMs: 10000 },
    );
  } catch {
    stream.started = false;
  }
}

async function maybeStop(hub: AgentHub, stream: LogStream): Promise<void> {
  if (stream.sockets.size > 0) return;
  streams.delete(stream.streamId);
  if (!stream.started) return;
  stream.started = false;
  try {
    await hub.request(stream.serverId, "container.logs.stop", { streamId: stream.streamId }, { timeoutMs: 10000 });
  } catch {
    /* agent offline — follow already died with it */
  }
}

export async function handleLogSubscribe(
  db: DbConnection,
  hub: AgentHub,
  socket: DashboardSocket,
  msg: { streamId?: string; kind?: string; id?: string; tail?: number },
): Promise<void> {
  const streamId = msg.streamId;
  const kind = msg.kind as LogStreamKind | undefined;
  const id = msg.id;
  if (!streamId || !kind || !id || !["game", "database", "application"].includes(kind)) return;

  let stream = streams.get(streamId);
  if (!stream) {
    const resolved = await resolveContainer(db, kind, id);
    if (!resolved) return;
    stream = { streamId, kind, id, ...resolved, sockets: new Set(), started: false };
    streams.set(streamId, stream);
  }
  stream.sockets.add(socket);
  socket.subscribed.add(streamId);
  await ensureStarted(db, hub, stream);
}

export async function handleLogUnsubscribe(
  db: DbConnection,
  hub: AgentHub,
  socket: DashboardSocket,
  streamId: string,
): Promise<void> {
  socket.subscribed.delete(streamId);
  const stream = streams.get(streamId);
  if (!stream) return;
  stream.sockets.delete(socket);
  await maybeStop(hub, stream);
}

/** Route an inbound dashboard WS frame (subscribe / unsubscribe). */
export async function handleDashboardMessage(
  db: DbConnection,
  hub: AgentHub,
  ws: WebSocket,
  raw: string,
): Promise<void> {
  const socket = getDashboardSocket(ws);
  if (!socket) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (msg.type === "subscribe") {
    await handleLogSubscribe(db, hub, socket, msg as { streamId?: string; kind?: string; id?: string; tail?: number });
  } else if (msg.type === "unsubscribe") {
    await handleLogUnsubscribe(db, hub, socket, String(msg.streamId ?? ""));
  }
}

/** Called when a dashboard socket closes — release every stream it held. */
export async function handleSocketClosed(hub: AgentHub, socket: DashboardSocket): Promise<void> {
  for (const streamId of [...socket.subscribed]) {
    const stream = streams.get(streamId);
    if (!stream) continue;
    stream.sockets.delete(socket);
    await maybeStop(hub, stream);
  }
  socket.subscribed.clear();
}

/** Called by the hub when an agent connection drops — kill streams of that server. */
export function handleAgentDisconnect(serverId: string): void {
  for (const [streamId, stream] of streams) {
    if (stream.serverId !== serverId) continue;
    stream.started = false;
    eventHub.emit({
      type: "container.log",
      streamId,
      containerId: stream.containerId,
      line: "",
      ended: true,
    });
  }
}
