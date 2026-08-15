/**
 * NEXUS — database client.
 *
 * A thin, typed SQL layer that works on both SQLite (local dev, `bun:sqlite`)
 * and PostgreSQL (production, `pg`). Queries are written once using `?`
 * placeholders; each connection adapts them to its dialect.
 *
 * Row timestamps are stored as ISO-8601 text everywhere so queries behave
 * identically on both backends. IDs are always generated app-side (prefixed),
 * so there is no AUTOINCREMENT dependency.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import pg from "pg";

export type Dialect = "sqlite" | "postgres";

export interface DbConnection {
  readonly dialect: Dialect;
  /** Returns rows (all). Use for SELECT. */
  all<T = Record<string, unknown>>(sqlText: string, params?: unknown[]): Promise<T[]>;
  /** Returns the first row or null. */
  get<T = Record<string, unknown>>(sqlText: string, params?: unknown[]): Promise<T | null>;
  /** Executes a write/DDL statement; returns lastInsertRowid-ish value. */
  run(sqlText: string, params?: unknown[]): Promise<{ changes: number }>;
  transaction<T>(fn: (tx: DbConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/* ── SQLite ──────────────────────────────────────────────────────── */

function createSqlite(url: string): DbConnection {
  const path = url.replace(/^sqlite:/, "");
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* already exists */
  }
  const raw = new Database(path, { create: true });
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA busy_timeout = 5000;");

  return {
    dialect: "sqlite",
    async all<T>(sqlText: string, params: unknown[] = []): Promise<T[]> {
      const stmt = raw.prepare(sqlText);
      return stmt.all(...(params as never[])) as T[];
    },
    async get<T>(sqlText: string, params: unknown[] = []): Promise<T | null> {
      const stmt = raw.prepare(sqlText);
      return (stmt.get(...(params as never[])) as T | null) ?? null;
    },
    async run(sqlText: string, params: unknown[] = []): Promise<{ changes: number }> {
      const stmt = raw.prepare(sqlText);
      const info = stmt.run(...(params as never[]));
      return { changes: Number(info.changes) };
    },
    async transaction<T>(fn: (tx: DbConnection) => Promise<T>): Promise<T> {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this);
        raw.exec("COMMIT");
        return result;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
    async close(): Promise<void> {
      raw.close();
    },
  };
}

/* ── PostgreSQL ──────────────────────────────────────────────────── */

function toPgSql(sqlText: string): string {
  let n = 0;
  return sqlText.replace(/\?/g, () => `$${++n}`);
}

function createPostgres(url: string): DbConnection {
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  pool.on("error", () => {
    /* connection errors are handled by callers */
  });

  return {
    dialect: "postgres",
    async all<T>(sqlText: string, params: unknown[] = []): Promise<T[]> {
      const res = await pool.query(toPgSql(sqlText), params);
      return res.rows as T[];
    },
    async get<T>(sqlText: string, params: unknown[] = []): Promise<T | null> {
      const res = await pool.query(toPgSql(sqlText), params);
      return (res.rows[0] as T | undefined) ?? null;
    },
    async run(sqlText: string, params: unknown[] = []): Promise<{ changes: number }> {
      const res = await pool.query(toPgSql(sqlText), params);
      return { changes: res.rowCount ?? 0 };
    },
    async transaction<T>(fn: (tx: DbConnection) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const txConn: DbConnection = {
          dialect: "postgres",
          async all<T2>(sqlText: string, params: unknown[] = []) {
            const r = await client.query(toPgSql(sqlText), params);
            return r.rows as T2[];
          },
          async get<T2>(sqlText: string, params: unknown[] = []) {
            const r = await client.query(toPgSql(sqlText), params);
            return (r.rows[0] as T2 | undefined) ?? null;
          },
          async run(sqlText: string, params: unknown[] = []) {
            const r = await client.query(toPgSql(sqlText), params);
            return { changes: r.rowCount ?? 0 };
          },
          transaction: () => {
            throw new Error("nested transactions are not supported");
          },
          close: async () => {},
        };
        const result = await fn(txConn);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/* ── Factory ─────────────────────────────────────────────────────── */

export function createDb(databaseUrl: string): DbConnection {
  if (databaseUrl.startsWith("sqlite:")) return createSqlite(databaseUrl);
  if (databaseUrl.startsWith("postgres") || databaseUrl.startsWith("postgresql")) return createPostgres(databaseUrl);
  throw new Error(`Unsupported DATABASE_URL: ${databaseUrl}`);
}

export type Db = DbConnection;
