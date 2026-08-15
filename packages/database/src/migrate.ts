import { readdirSync } from "node:fs";
import { createLogger } from "@nexus/logger";
import type { DbConnection } from "./client";

const log = createLogger("db:migrate");

/**
 * Applies pending migrations (packages/database/migrations/*.sqlite.sql /
 * *.postgres.sql) and records them in schema_migrations. Idempotent: each
 * migration is applied at most once per database.
 */
export async function migrate(db: DbConnection): Promise<void> {
  const dialect = db.dialect;
  const dir = import.meta.dir + "/../migrations";
  const suffix = dialect === "sqlite" ? ".sqlite.sql" : ".postgres.sql";

  const entries = readdirSync(dir).filter((f) => f.endsWith(suffix)).sort();
  if (entries.length === 0) {
    log.warn("no migrations found", { dir, suffix });
    return;
  }

  await db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );

  for (const file of entries) {
    const version = file.replace(/\.(sqlite|postgres)\.sql$/, "");
    const existing = await db.get<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = ?`,
      [version],
    );
    if (existing) {
      log.debug("migration already applied", { version });
      continue;
    }

    const filePath = `${dir}/${file}`;
    const sqlText = (await Bun.file(filePath).text()).toString();
    const statements = splitStatements(sqlText);

    log.info("applying migration", { version, statements: statements.length });
    await db.transaction(async (tx) => {
      for (const stmt of statements) {
        await tx.run(stmt);
      }
      await tx.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, [
        version,
        new Date().toISOString(),
      ]);
    });
    log.info("migration applied", { version });
  }
}

function splitStatements(sqlText: string): string[] {
  const noComments = sqlText
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return noComments
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
