import { z } from "zod";
import type { AppContext } from "../context";
import type { App } from "../types";
import { DatabasesService } from "../services/databases.service";
import { requireAuth, requirePermission } from "../middleware/auth";
import { errors } from "../lib/errors";
import { newId } from "../lib/crypto";
import { parseCreatedAtCursor, parsePageQuery, pid } from "../lib/http";

const createDbSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  serverId: z.string().min(1),
  type: z.enum(["POSTGRESQL", "MYSQL", "MARIADB", "REDIS", "MONGODB", "INFLUXDB"]),
  version: z.string().optional(),
  dbName: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  storageLimitBytes: z.number().optional(),
  maxConnections: z.number().optional(),
  cpuLimit: z.number().optional(),
  memoryLimitBytes: z.number().optional(),
  projectId: z.string().optional(),
});

export function registerDatabaseRoutes(app: App, ctx: AppContext): void {
  const dbs = new DatabasesService(ctx.db, ctx);

  app.get("/api/v1/databases", requireAuth, requirePermission("database.read"), async (c) => {
    const page = parsePageQuery(c);
    const result = await dbs.list({
      limit: page.limit,
      cursor: parseCreatedAtCursor(page.cursor) ?? undefined,
      serverId: c.req.query("serverId") || undefined,
      projectId: c.req.query("projectId") || undefined,
    });
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/databases", requireAuth, requirePermission("database.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createDbSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const db = await dbs.create(parsed.data);
    return c.json({ success: true, database: db });
  });

  app.get("/api/v1/databases/:id", requireAuth, requirePermission("database.read"), async (c) => {
    const id = pid(c);
    const db = await dbs.getPublic(id);
    const connection = await dbs.connectionInfo(id).catch(() => null);
    const credentials = await dbs.credentials(id);
    const backups = await dbs.listBackups(id);
    const server = await ctx.db.get(`SELECT * FROM servers WHERE id = ?`, [db.serverId]);
    return c.json({
      success: true,
      database: db,
      connection,
      credentials: credentials.map((r) => ({ id: r.id, databaseId: r.database_id, username: r.username, passwordMasked: "••••••••" })),
      backups,
      server,
    });
  });

  app.delete("/api/v1/databases/:id", requireAuth, requirePermission("database.delete"), async (c) => {
    const destroy = c.req.query("destroy") === "true";
    await dbs.remove(pid(c), { destroyData: destroy });
    return c.json({ success: true });
  });

  app.post("/api/v1/databases/:id/connection/reveal", requireAuth, requirePermission("database.read"), async (c) => {
    const info = await dbs.connectionInfo(pid(c), { revealPassword: true });
    await ctx.audit({ action: "database.credentials.reveal", resourceType: "database", resourceId: pid(c), resourceName: info.database });
    return c.json({ success: true, ...info });
  });

  /* ── lifecycle actions ──────────────────────────────────────── */

  app.post("/api/v1/databases/:id/deploy", requireAuth, requirePermission("database.write"), async (c) => {
    const db = await dbs.deploy(pid(c));
    return c.json({ success: true, database: db });
  });

  app.post("/api/v1/databases/:id/restart", requireAuth, requirePermission("database.write"), async (c) => {
    const result = await dbs.restart(pid(c));
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/databases/:id/start", requireAuth, requirePermission("database.write"), async (c) => {
    const result = await dbs.start(pid(c));
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/databases/:id/exec", requireAuth, requirePermission("database.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cmd = Array.isArray(body.cmd) ? (body.cmd as unknown[]).map(String).filter(Boolean) : [];
    if (cmd.length === 0) throw errors.validation({ cmd: "cmd is required" });
    const result = await dbs.exec(pid(c), cmd);
    return c.json({ success: true, ...result });
  });

  /* ── console (SQL / schema) ──────────────────────────────────── */

  app.post("/api/v1/databases/:id/query", requireAuth, requirePermission("database.read"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sql = typeof body.sql === "string" ? body.sql.trim() : "";
    if (!sql) throw errors.validation({ sql: "sql is required" });
    const result = await dbs.query(pid(c), sql);
    return c.json({ success: true, ...result });
  });

  app.get("/api/v1/databases/:id/schema", requireAuth, requirePermission("database.read"), async (c) => {
    const result = await dbs.schema(pid(c));
    return c.json({ success: true, ...result });
  });

  app.get("/api/v1/databases/:id/objects", requireAuth, requirePermission("database.read"), async (c) => {
    const result = await dbs.objects(pid(c));
    return c.json({ success: true, ...result });
  });

  app.get("/api/v1/databases/:id/table-info", requireAuth, requirePermission("database.read"), async (c) => {
    const table = (c.req.query("table") || "").trim();
    if (!table) throw errors.validation({ table: "table is required" });
    const result = await dbs.tableInfo(pid(c), table);
    return c.json({ success: true, ...result });
  });

  const dbWriteSchema = z.object({
    table: z.string().min(1),
    operation: z.enum(["insert", "update", "delete"]),
    data: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional().default({}),
    where: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
  });

  app.post("/api/v1/databases/:id/write", requireAuth, requirePermission("database.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = dbWriteSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await dbs.write(pid(c), parsed.data);
    return c.json({ success: true, ...result });
  });

  app.post("/api/v1/databases/:id/exec-sql", requireAuth, requirePermission("database.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sql = typeof body.sql === "string" ? body.sql.trim() : "";
    if (!sql) throw errors.validation({ sql: "sql is required" });
    const result = await dbs.execSql(pid(c), sql);
    return c.json({ success: true, ...result });
  });

  /* ── runtime info ───────────────────────────────────────────── */

  app.get("/api/v1/databases/:id/logs", requireAuth, requirePermission("database.read"), async (c) => {
    const logs = await dbs.logs(pid(c), parseInt(c.req.query("tail") ?? "200", 10));
    return c.json({ success: true, logs });
  });

  app.get("/api/v1/databases/:id/env", requireAuth, requirePermission("database.read"), async (c) => {
    const env = await dbs.env(pid(c));
    return c.json({ success: true, env });
  });

  /* ── scheduled backups ────────────────────────────────────────── */

  const updateBackupScheduleSchema = z.object({
    enabled: z.boolean(),
    cron: z.string().optional(),
    retention: z.number().int().min(1).max(365).optional(),
  });

  app.put("/api/v1/databases/:id/backup-schedule", requireAuth, requirePermission("database.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = updateBackupScheduleSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const database = await dbs.updateBackupSchedule(pid(c), parsed.data);
    return c.json({ success: true, database });
  });

  app.post("/api/v1/databases/:id/backup-schedule/run-now", requireAuth, requirePermission("backup.create"), async (c) => {
    const backup = await dbs.createBackup(pid(c));
    return c.json({ success: true, backup });
  });

  app.get("/api/v1/databases/:id/stats", requireAuth, requirePermission("database.read"), async (c) => {
    const stats = await dbs.stats(pid(c));
    return c.json({ success: true, ...stats });
  });

  /* ── backups ────────────────────────────────────────────────── */

  app.post("/api/v1/databases/:id/backup", requireAuth, requirePermission("backup.create"), async (c) => {
    const backup = await dbs.createBackup(pid(c));
    return c.json({ success: true, backup });
  });

  app.get("/api/v1/databases/:id/backups", requireAuth, requirePermission("backup.create"), async (c) => {
    const backups = await dbs.listBackups(pid(c));
    return c.json({ success: true, items: backups });
  });

  app.post("/api/v1/backups/:id/restore", requireAuth, requirePermission("backup.restore"), async (c) => {
    const backupId = pid(c);
    const row = await ctx.db.get<{ application_id: string | null; game_server_id: string | null }>(`SELECT application_id, game_server_id FROM backups WHERE id = ?`, [backupId]);
    if (row?.game_server_id) {
      const { GameServersService } = await import("../services/games.service");
      await new GameServersService(ctx.db, ctx).restoreBackup(backupId);
    } else if (row?.application_id) {
      const { ApplicationsService } = await import("../services/applications.service");
      await new ApplicationsService(ctx.db, ctx).restoreBackup(backupId);
    } else {
      await dbs.restoreBackup(backupId);
    }
    return c.json({ success: true });
  });

  app.delete("/api/v1/backups/:id", requireAuth, requirePermission("backup.delete"), async (c) => {
    await dbs.deleteBackup(pid(c));
    return c.json({ success: true });
  });

  /* ── backup file upload (browser → agent host) ────────────────── */

  app.post("/api/v1/backups/upload", requireAuth, requirePermission("backup.create"), async (c) => {
    const serverId = c.req.query("serverId") || "";
    const kind = c.req.query("kind") || "";
    const databaseId = c.req.query("databaseId") || undefined;
    const applicationId = c.req.query("applicationId") || undefined;
    if (!serverId) throw errors.validation({ serverId: "serverId is required" });
    if (kind !== "DATABASE" && kind !== "VOLUME") throw errors.validation({ kind: "kind must be DATABASE or VOLUME" });
    const hub = ctx.hub;
    if (!hub.isOnline(serverId)) throw errors.serverOffline();

    let resourceName = "";
    if (kind === "DATABASE") {
      if (!databaseId) throw errors.validation({ databaseId: "required for DATABASE uploads" });
      const dbRow = await ctx.db.get<{ name: string; server_id: string }>(`SELECT name, server_id FROM databases WHERE id = ?`, [databaseId]);
      if (!dbRow) throw errors.notFound("Database not found");
      if (dbRow.server_id !== serverId) throw errors.conflict("Database is not on the selected server");
      resourceName = dbRow.name;
    } else {
      if (!applicationId) throw errors.validation({ applicationId: "required for VOLUME uploads" });
      const appRow = await ctx.db.get<{ name: string; server_id: string }>(`SELECT name, server_id FROM applications WHERE id = ?`, [applicationId]);
      if (!appRow) throw errors.notFound("Application not found");
      if (appRow.server_id !== serverId) throw errors.conflict("Application is not on the selected server");
      resourceName = appRow.name;
    }

    const ext = kind === "DATABASE" ? ".dump" : ".tar.gz";
    const fileName = `upload_${kind === "DATABASE" ? databaseId : applicationId}_${new Date().toISOString().replace(/[:.]/g, "-")}${ext}`;

    // Stream the raw request body to the agent in base64 chunks. WS payloads
    // are capped at ~1 MB, so keep each chunk well below that.
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw errors.badRequest("Empty upload body");
    const CHUNK = 128 * 1024; // raw bytes per WS chunk (~171 KB base64)
    let offset = 0;
    let path = "";
    let buffer = Buffer.alloc(0);
    const write = async (data: Buffer, at: number): Promise<number> => {
      const res = await hub.request(serverId, "file.upload", {
        fileName,
        data: data.toString("base64"),
        offset: at,
      } as never, { timeoutMs: 60_000 }) as { path: string; written: number; total: number };
      path = res.path;
      return res.written;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          buffer = Buffer.concat([buffer, Buffer.from(value)]);
          while (buffer.length >= CHUNK) {
            const piece = buffer.subarray(0, CHUNK);
            buffer = buffer.subarray(CHUNK);
            offset += await write(piece, offset);
          }
        }
      }
      // Flush the tail (and create the file when the body was empty).
      offset += await write(buffer, offset);
    } finally {
      reader.releaseLock();
    }
    if (offset === 0) throw errors.badRequest("No data received");

    const backupId = newId("bak");
    const now = new Date().toISOString();
    await ctx.db.run(
      `INSERT INTO backups (id, database_id, application_id, server_id, type, status, size_bytes, path, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?, ?, ?, ?, ?)`,
      [backupId, kind === "DATABASE" ? databaseId : null, kind === "VOLUME" ? applicationId : null, serverId, kind, offset, path, now, now, now],
    );
    await ctx.audit({ action: "backup.upload", resourceType: "backup", resourceId: backupId, resourceName, serverId, metadata: { fileName, kind, sizeBytes: offset } });
    return c.json({
      success: true,
      backup: { id: backupId, databaseId: kind === "DATABASE" ? databaseId : null, applicationId: kind === "VOLUME" ? applicationId : null, serverId, type: kind, status: "SUCCESS", sizeBytes: offset, path, createdAt: now },
    });
  });

  /* ── backup file download (streamed from the agent host) ──────── */

  app.get("/api/v1/backups/:id/download", requireAuth, requirePermission("backup.create"), async (c) => {
    const backupId = pid(c);
    const row = await ctx.db.get<{ server_id: string | null; path: string | null }>(
      `SELECT server_id, path FROM backups WHERE id = ?`,
      [backupId],
    );
    if (!row) throw errors.notFound("Backup not found");
    if (!row.server_id || !row.path) throw errors.conflict("Backup has no file on disk");
    const hub = ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();

    // Stream the file from the agent in base64 chunks and pipe it to the
    // browser. Chunk size stays well under the WS payload limit (1 MB). The
    // pull() closure keeps state (offset/total) across chunk reads.
    const CHUNK = 256 * 1024;
    let offset = 0;
    let total: number | null = null;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const res = await hub.request(row.server_id!, "file.read", {
            path: row.path,
            offset,
            length: CHUNK,
          } as never, { timeoutMs: 60_000 }) as { data: string; length: number; total: number };
          if (total === null) total = res.total;
          if (res.length === 0 || offset >= total) {
            controller.close();
            return;
          }
          controller.enqueue(Buffer.from(res.data, "base64"));
          offset += res.length;
          if (offset >= total) controller.close();
        } catch (err) {
          controller.error(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });

    const fileName = row.path.split("/").pop() ?? `backup-${backupId}`;
    return new Response(stream as unknown as ReadableStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
