import type { AuditLogRow, DbConnection } from "@nexus/database";
import { newId } from "../lib/crypto";
import { eventHub } from "../lib/events";

export interface AuditInput {
  userId?: string | null;
  userName?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  resourceName?: string | null;
  serverId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  requestId?: string | null;
}

export class AuditService {
  constructor(private readonly db: DbConnection) {}

  async log(input: AuditInput): Promise<void> {
    const entry: AuditLogRow = {
      id: newId("aud"),
      user_id: input.userId ?? null,
      user_name: input.userName ?? null,
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId ?? null,
      resource_name: input.resourceName ?? null,
      server_id: input.serverId ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      ip: input.ip ?? null,
      request_id: input.requestId ?? null,
      created_at: new Date().toISOString(),
    };
    await this.db.run(
      `INSERT INTO audit_logs (id, user_id, user_name, action, resource_type, resource_id, resource_name, server_id, metadata, ip, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.user_id, entry.user_name, entry.action, entry.resource_type, entry.resource_id, entry.resource_name, entry.server_id, entry.metadata, entry.ip, entry.request_id, entry.created_at],
    );
    eventHub.emit({
      type: "audit",
      entry: {
        id: entry.id,
        userId: entry.user_id,
        userName: entry.user_name,
        action: entry.action,
        resourceType: entry.resource_type,
        resourceId: entry.resource_id,
        resourceName: entry.resource_name,
        serverId: entry.server_id,
        metadata: input.metadata ?? null,
        ip: entry.ip,
        requestId: entry.request_id,
        createdAt: entry.created_at,
      },
    });
  }

  async list(opts: { limit: number; cursor?: string; action?: string; resourceType?: string; serverId?: string; userId?: string }): Promise<{ items: AuditLogRow[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.cursor) {
      where.push("created_at <= ?");
      params.push(opts.cursor);
    }
    if (opts.action) {
      where.push("action = ?");
      params.push(opts.action);
    }
    if (opts.resourceType) {
      where.push("resource_type = ?");
      params.push(opts.resourceType);
    }
    if (opts.serverId) {
      where.push("server_id = ?");
      params.push(opts.serverId);
    }
    if (opts.userId) {
      where.push("user_id = ?");
      params.push(opts.userId);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await this.db.all<AuditLogRow>(
      `SELECT * FROM audit_logs ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, opts.limit + 1],
    );
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]?.created_at ?? null : null };
  }

  async prune(olderThanIso: string): Promise<number> {
    const res = await this.db.run(`DELETE FROM audit_logs WHERE created_at < ?`, [olderThanIso]);
    return res.changes;
  }
}
