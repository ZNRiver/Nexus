import type { DbConnection, JobRow } from "@nexus/database";
import { newId } from "../lib/crypto";
import type { JobType } from "@nexus/types";

/**
 * Persistence-backed job queue. Jobs live in PostgreSQL/SQLite — the same
 * store as everything else — so a restart never loses queued work, dev and
 * production behave identically, and multiple API instances could share the
 * table. (Redis remains in the stack for rate limiting/caching in production.)
 */
export class JobQueue {
  constructor(private readonly db: DbConnection) {}

  async enqueue(type: JobType, payload: Record<string, unknown>, opts: { maxAttempts?: number } = {}): Promise<string> {
    const id = newId("job");
    await this.db.run(
      `INSERT INTO jobs (id, type, status, attempts, max_attempts, payload, created_at) VALUES (?, ?, 'PENDING', 0, ?, ?, ?)`,
      [id, type, opts.maxAttempts ?? 3, JSON.stringify(payload), new Date().toISOString()],
    );
    return id;
  }

  /** Atomically claim the next pending job. */
  async claimNext(): Promise<JobRow | null> {
    const candidate = await this.db.get<JobRow>(
      `SELECT * FROM jobs WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 1`,
    );
    if (!candidate) return null;
    const claimed = await this.db.get<JobRow>(
      `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, started_at = ? WHERE id = ? AND status = 'PENDING' RETURNING *`,
      [new Date().toISOString(), candidate.id],
    );
    return claimed ?? null;
  }

  async complete(id: string): Promise<void> {
    await this.db.run(
      `UPDATE jobs SET status = 'SUCCESS', finished_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    );
  }

  async fail(id: string, error: string, opts: { retryable?: boolean; maxAttempts?: number; attempts?: number } = {}): Promise<void> {
    if (opts.retryable && (opts.attempts ?? 1) < (opts.maxAttempts ?? 3)) {
      await this.db.run(
        `UPDATE jobs SET status = 'PENDING', error = ?, finished_at = NULL WHERE id = ?`,
        [error, id],
      );
    } else {
      await this.db.run(
        `UPDATE jobs SET status = 'FAILED', error = ?, finished_at = ? WHERE id = ?`,
        [error, new Date().toISOString(), id],
      );
    }
  }

  async list(opts: { limit: number; cursor?: string; type?: string; status?: string }): Promise<{ items: JobRow[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.type) {
      where.push("type = ?");
      params.push(opts.type);
    }
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.cursor) {
      where.push("created_at <= ?");
      params.push(opts.cursor);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await this.db.all<JobRow>(
      `SELECT * FROM jobs ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, opts.limit + 1],
    );
    const hasMore = rows.length > opts.limit;
    return { items: hasMore ? rows.slice(0, opts.limit) : rows, nextCursor: hasMore ? rows[opts.limit - 1]?.created_at ?? null : null };
  }

  async pendingCount(): Promise<number> {
    const row = await this.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM jobs WHERE status IN ('PENDING', 'RUNNING')`);
    return Number(row?.c ?? 0);
  }
}
