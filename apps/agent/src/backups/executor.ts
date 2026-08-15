import { writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { createLogger } from "@nexus/logger";
import type { DbBackupPayload, DbRestorePayload } from "@nexus/types";
import { DockerService } from "../docker/service";

const log = createLogger("agent:backup");

const BACKUP_DIR = process.env.AGENT_DATA_DIR ? `${process.env.AGENT_DATA_DIR}/backups` : "data/agent/backups";

export function backupDir(): string {
  return BACKUP_DIR;
}

/** Quote a string for use inside a `sh -c` command (single-quote escaping). */
function shquote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function createBackup(
  docker: DockerService,
  payload: DbBackupPayload,
  onLog?: (msg: string) => void,
): Promise<{ path: string; sizeBytes: number }> {
  const { backupId, type, containerId, name, username, password, port } = payload;
  const filePath = `${BACKUP_DIR}/${payload.fileName}`;
  const logLine = onLog ?? (() => {});

  // The backups dir may not exist on freshly provisioned hosts.
  mkdirSync(BACKUP_DIR, { recursive: true });
  logLine(`Backing up ${name} (${type}) to ${filePath}`);
  const user = username ?? "root";
  const env = { ...process.env, PGPASSWORD: password ?? "" } as Record<string, string>;

  switch (type) {
    case "POSTGRESQL": {
      // pg_dump -F c produces a BINARY custom-format dump — piping it through
      // stdout as text corrupts the TOC. Dump inside the container, then copy
      // the file out verbatim with docker cp.
      const dump = await docker.exec(containerId, ["sh", "-c", `pg_dump -U ${shquote(user)} -d ${shquote(name)} -F c -Z 6 > /tmp/nexus-backup.dump`], { timeoutMs: 300000 });
      if (dump.exitCode !== 0) throw new Error(`backup failed (exit ${dump.exitCode}): ${dump.output.slice(0, 300)}`);
      const cp = await docker.run(["cp", `${containerId}:/tmp/nexus-backup.dump`, filePath], { timeoutMs: 60000 });
      if (cp.code !== 0) throw new Error(`postgres backup copy failed: ${cp.stderr.trim()}`);
      const size = existsSync(filePath) ? statSync(filePath).size : 0;
      logLine(`Backup complete (${size} bytes)`);
      return { path: filePath, sizeBytes: size };
    }
    case "MYSQL":
    case "MARIADB": {
      const dumpBin = type === "MARIADB" ? "mariadb-dump" : "mysqldump";
      const exec = await docker.exec(containerId, [dumpBin, "-u", user, `-p${password ?? ""}`, "--single-transaction", name], { timeoutMs: 300000 });
      if (exec.exitCode !== 0 && exec.output.trim().length === 0) {
        throw new Error(`backup failed (exit ${exec.exitCode})`);
      }
      writeFileSync(filePath, exec.output);
      const size = existsSync(filePath) ? statSync(filePath).size : 0;
      logLine(`Backup complete (${size} bytes)`);
      return { path: filePath, sizeBytes: size };
    }
    case "MONGODB": {
      // mongodump writes an archive inside the container — copy it out.
      const exec = await docker.exec(containerId, ["mongodump", `--username=${user}`, `--password=${password ?? ""}`, "--authenticationDatabase=admin", "--archive=/tmp/nexus-backup.archive"], { timeoutMs: 300000 });
      if (exec.exitCode !== 0) throw new Error(`backup failed (exit ${exec.exitCode}): ${exec.output.slice(0, 300)}`);
      const cp = await docker.run(["cp", `${containerId}:/tmp/nexus-backup.archive`, filePath], { timeoutMs: 60000 });
      if (cp.code !== 0) throw new Error(`mongodump copy failed: ${cp.stderr.trim()}`);
      const size = existsSync(filePath) ? statSync(filePath).size : 0;
      logLine(`Backup complete (${size} bytes)`);
      return { path: filePath, sizeBytes: size };
    }
    case "REDIS": {
      // Save RDB then copy it out via docker cp (two steps).
      await docker.run(["exec", containerId, "redis-cli", "SAVE"], { timeoutMs: 30000 });
      const cp = await docker.run(["cp", `${containerId}:/data/dump.rdb`, filePath], { timeoutMs: 60000 });
      if (cp.code !== 0) throw new Error(`redis backup failed: ${cp.stderr.trim()}`);
      const size = existsSync(filePath) ? statSync(filePath).size : 0;
      logLine(`Backup complete (${size} bytes)`);
      return { path: filePath, sizeBytes: size };
    }
    default:
      throw new Error(`Unsupported database type for backup: ${type}`);
  }
}

export async function restoreBackup(
  docker: DockerService,
  payload: DbRestorePayload,
  onLog?: (msg: string) => void,
): Promise<{ restored: boolean }> {
  const { backupId, type, containerId, name, username, password } = payload;
  const filePath = payload.filePath;
  const logLine = onLog ?? (() => {});
  const user = username ?? "root";

  if (!existsSync(filePath)) throw new Error(`Backup file not found: ${filePath}`);
  const data = readFileSync(filePath);
  logLine(`Restoring ${name} (${type}) from ${filePath}`);

  switch (type) {
    case "POSTGRESQL": {
      // The backup is a custom-format dump (pg_dump -F c) — psql cannot read
      // it; it must be restored with pg_restore.
      const res = await docker.exec(containerId, ["pg_restore", "-U", user, "-d", name, "--clean", "--if-exists", "--no-owner"], {
        stdin: data,
        timeoutMs: 300000,
      });
      if (res.exitCode !== 0) throw new Error(`restore failed: ${res.output.slice(0, 500)}`);
      break;
    }
    case "MYSQL":
    case "MARIADB": {
      const bin = type === "MARIADB" ? "mariadb" : "mysql";
      const res = await docker.exec(containerId, [bin, "-u", user, `-p${password ?? ""}`, name], {
        stdin: data.toString(),
        timeoutMs: 300000,
      });
      if (res.exitCode !== 0) throw new Error(`restore failed: ${res.output.slice(0, 500)}`);
      break;
    }
    case "MONGODB": {
      const tmp = `/tmp/nexus-restore.archive`;
      await docker.run(["cp", filePath, `${containerId}:${tmp}`], { timeoutMs: 60000 });
      const res = await docker.exec(containerId, ["mongorestore", `--username=${user}`, `--password=${password ?? ""}`, "--authenticationDatabase=admin", "--archive=" + tmp], { timeoutMs: 300000 });
      if (res.exitCode !== 0) throw new Error(`restore failed: ${res.output.slice(0, 500)}`);
      break;
    }
    case "REDIS": {
      await docker.run(["cp", filePath, `${containerId}:/data/dump.rdb`], { timeoutMs: 60000 });
      await docker.restart(containerId);
      break;
    }
    default:
      throw new Error(`Unsupported database type for restore: ${type}`);
  }

  logLine("Restore complete");
  return { restored: true };
}
