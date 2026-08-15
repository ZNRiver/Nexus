/**
 * Database console — run queries and inspect schema from inside the database
 * container using its native CLI. Supports PostgreSQL (psql) and
 * MySQL/MariaDB (mysql). Used by the "Console" tab in the dashboard so you can
 * browse tables and run SQL directly against each database.
 */
import { createLogger } from "@nexus/logger";
import type { DbObjectsPayload, DbQueryPayload, DbSchemaPayload, DbTableInfoPayload } from "@nexus/types";
import { DockerService } from "../docker/service";

const log = createLogger("agent:db-console");

/** Quote a string for use inside a `sh -c` command (single-quote escaping). */
function shquote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface QueryResult {
  columns: string[];
  rows: string[][];
  truncated: boolean;
  message?: string;
}

export interface SchemaTable {
  name: string;
  columns: { name: string; type: string }[];
}

export interface SchemaResult {
  tables: SchemaTable[];
  message?: string;
}

/** Parse CSV output (first row = headers, rest = rows). */
function parseCsv(out: string): { columns: string[]; rows: string[][] } {
  const lines = out.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (ch === "," && !inQ) {
        cells.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  };
  const columns = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);
  return { columns, rows };
}

/** Parse mysql batch output (tab-separated, first row = headers). */
function parseTsv(out: string): { columns: string[]; rows: string[][] } {
  const lines = out.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };
  const split = (l: string) => l.split("\t");
  return { columns: split(lines[0]), rows: lines.slice(1).map(split) };
}

/** Detect a non-SELECT statement (command tag) from CLI output. */
function messageFromOut(out: string): string | undefined {
  const t = out.trim();
  if (!t) return undefined;
  // psql command tags: "INSERT 0 1", "CREATE TABLE", "UPDATE 5"…
  if (/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i.test(t)) {
    return t.split("\n")[0];
  }
  return undefined;
}

export async function runDbQuery(
  docker: DockerService,
  payload: DbQueryPayload,
): Promise<QueryResult> {
  const { type, containerId, name, username, password } = payload;
  const sql = String(payload.sql ?? "").trim();
  if (!sql) throw new Error("sql is required");
  const user = username ?? "root";

  switch (type) {
    case "POSTGRESQL": {
      // psql \copy wraps the query and emits real CSV (proper quoting).
      const safeSql = sql.replace(/;\s*$/, "");
      const res = await docker.exec(containerId, [
        "sh", "-c",
        `PGPASSWORD=${shquote(password ?? "")} psql -U ${shquote(user)} -d ${shquote(name)} -X -q -P pager=off -c ${shquote(`\\copy (${safeSql}) TO STDOUT WITH (FORMAT csv, HEADER true)`)}`,
      ], { timeoutMs: 60000 });
      if (res.exitCode !== 0 && /ERROR/i.test(res.output)) {
        throw new Error(res.output.trim().split("\n").filter((l) => /ERROR|LINE|HINT|DETAIL/i.test(l)).join("\n") || `psql failed (exit ${res.exitCode})`);
      }
      const msg = messageFromOut(res.output);
      if (msg && !res.output.includes(",")) {
        return { columns: [], rows: [], truncated: false, message: msg };
      }
      const parsed = parseCsv(res.output);
      return { ...parsed, truncated: parsed.rows.length > 500, message: undefined };
    }
    case "MYSQL":
    case "MARIADB": {
      const res = await docker.exec(containerId, [
        "sh", "-c",
        `mysql -u ${shquote(user)} -p${shquote(password ?? "")} -h 127.0.0.1 ${shquote(name)} --batch --raw -e ${shquote(sql)}`,
      ], { timeoutMs: 60000 });
      if (res.exitCode !== 0 && /ERROR/i.test(res.output)) {
        throw new Error(res.output.trim().split("\n").filter((l) => /ERROR/i.test(l)).join("\n") || `mysql failed (exit ${res.exitCode})`);
      }
      const msg = messageFromOut(res.output);
      if (msg && !res.output.includes("\t")) {
        return { columns: [], rows: [], truncated: false, message: msg };
      }
      const parsed = parseTsv(res.output);
      return { ...parsed, truncated: parsed.rows.length > 500, message: undefined };
    }
    default:
      throw new Error(`SQL console is not available for ${type} — supported: PostgreSQL, MySQL, MariaDB`);
  }
}

export async function getDbSchema(
  docker: DockerService,
  payload: DbSchemaPayload,
): Promise<SchemaResult> {
  const { type, containerId, name, username, password } = payload;
  const user = username ?? "root";

  switch (type) {
    case "POSTGRESQL": {
      const tablesSql = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
      const colsSql = `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`;
      const [tRes, cRes] = await Promise.all([
        docker.exec(containerId, ["sh", "-c", `PGPASSWORD=${shquote(password ?? "")} psql -U ${shquote(user)} -d ${shquote(name)} -X -q -A -t -F ',' -c ${shquote(tablesSql)}`], { timeoutMs: 60000 }),
        docker.exec(containerId, ["sh", "-c", `PGPASSWORD=${shquote(password ?? "")} psql -U ${shquote(user)} -d ${shquote(name)} -X -q -A -t -F ',' -c ${shquote(colsSql)}`], { timeoutMs: 60000 }),
      ]);
      const tables = tRes.output.split("\n").map((l) => l.trim()).filter(Boolean);
      const colMap = new Map<string, { name: string; type: string }[]>();
      for (const line of cRes.output.split("\n")) {
        const [t, c, ty] = line.split(",").map((s) => s.trim());
        if (!t || !c) continue;
        if (!colMap.has(t)) colMap.set(t, []);
        colMap.get(t)!.push({ name: c, type: ty ?? "unknown" });
      }
      return {
        tables: tables.map((t) => ({ name: t, columns: colMap.get(t) ?? [] })),
      };
    }
    case "MYSQL":
    case "MARIADB": {
      const tablesSql = `SHOW TABLES`;
      const colsSql = `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`;
      const [tRes, cRes] = await Promise.all([
        docker.exec(containerId, ["sh", "-c", `mysql -u ${shquote(user)} -p${shquote(password ?? "")} -h 127.0.0.1 ${shquote(name)} --batch --raw -e ${shquote(tablesSql)}`], { timeoutMs: 60000 }),
        docker.exec(containerId, ["sh", "-c", `mysql -u ${shquote(user)} -p${shquote(password ?? "")} -h 127.0.0.1 ${shquote(name)} --batch --raw -e ${shquote(colsSql)}`], { timeoutMs: 60000 }),
      ]);
      const tables = tRes.output.split("\n").map((l) => l.trim()).filter(Boolean);
      const colMap = new Map<string, { name: string; type: string }[]>();
      for (const line of cRes.output.split("\n")) {
        const [t, c, ty] = line.split("\t").map((s) => s.trim());
        if (!t || !c) continue;
        if (!colMap.has(t)) colMap.set(t, []);
        colMap.get(t)!.push({ name: c, type: ty ?? "unknown" });
      }
      return {
        tables: tables.map((t) => ({ name: t, columns: colMap.get(t) ?? [] })),
      };
    }
    default:
      return { tables: [], message: `Schema browser is not available for ${type} — supported: PostgreSQL, MySQL, MariaDB` };
  }
}

/** Run psql with `-A -t` (unaligned tuples only) and return raw output. */
async function psqlTuples(
  docker: DockerService,
  containerId: string,
  user: string,
  password: string | undefined,
  db: string,
  sql: string,
): Promise<string> {
  const res = await docker.exec(containerId, [
    "sh", "-c",
    `PGPASSWORD=${shquote(password ?? "")} psql -U ${shquote(user)} -d ${shquote(db)} -X -q -A -t -F '\t' -c ${shquote(sql)}`,
  ], { timeoutMs: 60000 });
  if (res.exitCode !== 0) {
    throw new Error(res.output.trim().split("\n").filter((l) => /ERROR|LINE|HINT|DETAIL/i.test(l)).join("\n") || `psql failed (exit ${res.exitCode})`);
  }
  return res.output;
}

/** Run mysql with `--batch --raw` and return raw output. */
async function mysqlBatch(
  docker: DockerService,
  containerId: string,
  user: string,
  password: string | undefined,
  db: string,
  sql: string,
): Promise<string> {
  const res = await docker.exec(containerId, [
    "sh", "-c",
    `mysql -u ${shquote(user)} -p${shquote(password ?? "")} -h 127.0.0.1 ${shquote(db)} --batch --raw -e ${shquote(sql)}`,
  ], { timeoutMs: 60000 });
  if (res.exitCode !== 0) {
    throw new Error(res.output.trim().split("\n").filter((l) => /ERROR/i.test(l)).join("\n") || `mysql failed (exit ${res.exitCode})`);
  }
  return res.output;
}

function splitLines(out: string): string[] {
  return out.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
}

function splitTab(line: string): string[] {
  return line.split("\t");
}

export interface DbObjectsResult {
  databases: string[];
  tables: { name: string; size?: string }[];
  views: string[];
  indexes: string[];
  procedures: string[];
  sequences: string[];
  triggers: string[];
  events: string[];
  roles: string[];
  version?: string;
  message?: string;
}

export async function getDbObjects(
  docker: DockerService,
  payload: DbObjectsPayload,
): Promise<DbObjectsResult> {
  const { type, containerId, name, username, password } = payload;
  const user = username ?? "root";
  const empty = { databases: [], tables: [], views: [], indexes: [], procedures: [], sequences: [], triggers: [], events: [], roles: [] };

  switch (type) {
    case "POSTGRESQL": {
      const [dbsRaw, tablesRaw, viewsRaw, indexesRaw, procsRaw, seqsRaw, trgRaw, verRaw, rolesRaw] = await Promise.all([
        psqlTuples(docker, containerId, user, password, name, `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`),
        psqlTuples(docker, containerId, user, password, name, `SELECT c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`),
        psqlTuples(docker, containerId, user, password, name, `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'v' ORDER BY c.relname`),
        psqlTuples(docker, containerId, user, password, name, `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`),
        psqlTuples(docker, containerId, user, password, name, `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind IN ('f','p') ORDER BY p.proname`),
        psqlTuples(docker, containerId, user, password, name, `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY c.relname`),
        psqlTuples(docker, containerId, user, password, name, `SELECT DISTINCT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY t.tgname`),
        psqlTuples(docker, containerId, user, password, name, `SELECT version()`),
        psqlTuples(docker, containerId, user, password, name, `SELECT rolname FROM pg_roles ORDER BY rolname`),
      ]);
      const databases = splitLines(dbsRaw ?? "");
      const tables = (splitLines(tablesRaw ?? "")).map((l) => {
        const [t, sz] = splitTab(l);
        return { name: t ?? "", size: sz || undefined };
      });
      const version = (verRaw ?? "").split(/\s+/).slice(0, 3).join(" ") || undefined;
      return {
        ...empty,
        databases,
        tables,
        views: splitLines(viewsRaw ?? ""),
        indexes: splitLines(indexesRaw ?? ""),
        procedures: splitLines(procsRaw ?? ""),
        sequences: splitLines(seqsRaw ?? ""),
        triggers: splitLines(trgRaw ?? ""),
        roles: splitLines(rolesRaw ?? ""),
        version,
      };
    }
    case "MYSQL":
    case "MARIADB": {
      const [dbsRaw, tablesRaw, viewsRaw, indexesRaw, procsRaw, trgRaw, evtRaw, verRaw, rolesRaw] = await Promise.all([
        mysqlBatch(docker, containerId, user, password, name, `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT TABLE_NAME, ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY INDEX_NAME`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_NAME`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY TRIGGER_NAME`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT VERSION()`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT DISTINCT User FROM mysql.user ORDER BY User`),
      ]);
      const databases = splitLines(dbsRaw ?? "").filter((d) => !/^(information_schema|performance_schema|mysql|sys)$/.test(d));
      const tables = (splitLines(tablesRaw ?? "")).map((l) => {
        const [t, sz] = splitTab(l);
        const kb = Number(sz);
        return { name: t ?? "", size: Number.isFinite(kb) && kb > 0 ? `${Math.round(kb)}K` : undefined };
      });
      const version = (verRaw ?? "").split(/\s+/).slice(0, 2).join(" ") || undefined;
      return {
        ...empty,
        databases,
        tables,
        views: splitLines(viewsRaw ?? ""),
        indexes: splitLines(indexesRaw ?? ""),
        procedures: splitLines(procsRaw ?? ""),
        sequences: [],
        triggers: splitLines(trgRaw ?? ""),
        events: splitLines(evtRaw ?? ""),
        roles: splitLines(rolesRaw ?? ""),
        version,
      };
    }
    default:
      return { ...empty, message: `Object browser is not available for ${type} — supported: PostgreSQL, MySQL, MariaDB` };
  }
}

export interface DbTableInfoResult {
  columns: { name: string; type: string; nullable: boolean; key: string; defaultValue?: string | null }[];
  constraints: { name: string; type: string; definition?: string }[];
  foreignKeys: { name: string; columns: string; references: string }[];
  triggers: { name: string; event: string; timing: string }[];
  indexes: { name: string; columns: string; unique: boolean }[];
  message?: string;
}

export async function getDbTableInfo(
  docker: DockerService,
  payload: DbTableInfoPayload,
): Promise<DbTableInfoResult> {
  const { type, containerId, name, username, password, table } = payload;
  const user = username ?? "root";
  const empty = { columns: [], constraints: [], foreignKeys: [], triggers: [], indexes: [] };

  switch (type) {
    case "POSTGRESQL": {
      const t = table.replace(/'/g, "''");
      const [colsRaw, consRaw, trgRaw, idxRaw] = await Promise.all([
        psqlTuples(docker, containerId, user, password, name, `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${t}' ORDER BY ordinal_position`),
        psqlTuples(docker, containerId, user, password, name, `SELECT conname, contype, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.${t}'::regclass ORDER BY conname`),
        psqlTuples(docker, containerId, user, password, name, `SELECT t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = '${t}' AND NOT t.tgisinternal ORDER BY t.tgname`),
        psqlTuples(docker, containerId, user, password, name, `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = '${t}' ORDER BY indexname`),
      ]);
      const columns = splitLines(colsRaw ?? "").map((l) => {
        const [c, ty, nul, def] = splitTab(l);
        return { name: c ?? "", type: ty ?? "", nullable: (nul ?? "") === "YES", key: "", defaultValue: def || null };
      });
      const constraints = splitLines(consRaw ?? "").map((l) => {
        const [cn, ct, def] = splitTab(l);
        const typeMap: Record<string, string> = { p: "PRIMARY KEY", f: "FOREIGN KEY", u: "UNIQUE", c: "CHECK", x: "EXCLUSION" };
        return { name: cn ?? "", type: typeMap[ct ?? ""] ?? (ct ?? "").toUpperCase(), definition: def ?? "" };
      });
      const foreignKeys = constraints
        .filter((c) => c.type === "FOREIGN KEY")
        .map((c) => {
          const m = c.definition?.match(/\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)(?:\(([^)]+)\))?/i);
          return { name: c.name, columns: m?.[1] ?? "", references: m ? `${m[2]}${m[3] ? `(${m[3]})` : ""}` : c.definition ?? "" };
        });
      const triggers = splitLines(trgRaw ?? "").map((l) => {
        const [tn, def] = splitTab(l);
        const ev = def?.match(/BEFORE|AFTER|INSTEAD OF\s+(\w+)/i);
        return { name: tn ?? "", event: ev?.[1] ?? "", timing: def ?? "" };
      });
      const indexes = splitLines(idxRaw ?? "").map((l) => {
        const [in_, def] = splitTab(l);
        const m = def?.match(/\(([^)]+)\)/);
        return { name: in_ ?? "", columns: m?.[1] ?? "", unique: /UNIQUE/i.test(def ?? "") };
      });
      return { ...empty, columns, constraints, foreignKeys, triggers, indexes };
    }
    case "MYSQL":
    case "MARIADB": {
      const t = table.replace(/`/g, "``").replace(/'/g, "''");
      const [colsRaw, consRaw, fkRaw, trgRaw, idxRaw] = await Promise.all([
        mysqlBatch(docker, containerId, user, password, name, `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${t}' ORDER BY ORDINAL_POSITION`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${t}'`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${t}' AND REFERENCED_TABLE_NAME IS NOT NULL`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = '${t}'`),
        mysqlBatch(docker, containerId, user, password, name, `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX), NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${t}' GROUP BY INDEX_NAME, NON_UNIQUE`),
      ]);
      const columns = splitLines(colsRaw ?? "").map((l) => {
        const [c, ty, nul, key, def] = splitTab(l);
        return { name: c ?? "", type: ty ?? "", nullable: (nul ?? "") === "YES", key: key ?? "", defaultValue: def || null };
      });
      const constraints = splitLines(consRaw ?? "").map((l) => {
        const [cn, ct] = splitTab(l);
        return { name: cn ?? "", type: ct ?? "" };
      });
      const fkMap = new Map<string, { columns: string[]; references: string }>();
      for (const l of splitLines(fkRaw ?? "")) {
        const [cn, col, refT, refC] = splitTab(l);
        if (!cn) continue;
        const cur = fkMap.get(cn) ?? { columns: [], references: "" };
        cur.columns.push(col ?? "");
        cur.references = `${refT ?? ""}${refC ? `(${refC})` : ""}`;
        fkMap.set(cn, cur);
      }
      const foreignKeys = [...fkMap.entries()].map(([name, v]) => ({ name, columns: v.columns.join(", "), references: v.references }));
      const triggers = splitLines(trgRaw ?? "").map((l) => {
        const [tn, ev, ti] = splitTab(l);
        return { name: tn ?? "", event: ev ?? "", timing: ti ?? "" };
      });
      const indexes = splitLines(idxRaw ?? "").map((l) => {
        const [in_, cols, nu] = splitTab(l);
        return { name: in_ ?? "", columns: cols ?? "", unique: (nu ?? "1") === "0" };
      });
      return { ...empty, columns, constraints, foreignKeys, triggers, indexes };
    }
    default:
      return { ...empty, message: `Table info is not available for ${type} — supported: PostgreSQL, MySQL, MariaDB` };
  }
}

