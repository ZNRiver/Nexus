import type { DbConnection } from "@nexus/database";
import type { ResourceLogEntry } from "@nexus/types";
import { eventHub } from "../lib/events";

export type ResourceLogType = "database" | "application" | "backup";

/**
 * Appends a progress log line for a resource operation and streams it to the
 * dashboard via WebSocket. Used by both the API services (create/deploy/
 * backup/restore lifecycle) and the agent events (via the hub).
 */
export async function appendResourceLog(
  db: DbConnection,
  resourceType: ResourceLogType,
  resourceId: string,
  message: string,
  stream: "stdout" | "stderr" | "system" = "stdout",
): Promise<ResourceLogEntry> {
  if (!resourceId || !message) throw new Error("resource log requires resourceId and message");
  const id = `rlog_${Math.random().toString(36).slice(2, 14)}`;
  const timestamp = new Date().toISOString();
  const entry: ResourceLogEntry = { id, resourceType, resourceId, stream, message, timestamp };
  await db.run(
    `INSERT INTO resource_logs (id, resource_type, resource_id, stream, message, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, resourceType, resourceId, stream, message, timestamp],
  );
  eventHub.emit({ type: "resource.log", resourceType, resourceId, entry });
  return entry;
}

export async function listResourceLogs(
  db: DbConnection,
  resourceType: ResourceLogType,
  resourceId: string,
  limit = 1000,
): Promise<ResourceLogEntry[]> {
  const rows = await db.all<{
    id: string;
    stream: string;
    message: string;
    timestamp: string;
  }>(
    `SELECT id, stream, message, timestamp FROM resource_logs WHERE resource_type = ? AND resource_id = ? ORDER BY timestamp ASC, rowid ASC LIMIT ?`,
    [resourceType, resourceId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    resourceType,
    resourceId,
    stream: r.stream as ResourceLogEntry["stream"],
    message: r.message,
    timestamp: r.timestamp,
  }));
}
