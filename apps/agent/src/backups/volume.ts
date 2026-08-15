import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { createLogger } from "@nexus/logger";
import type { VolumeBackupPayload, VolumeRestorePayload } from "@nexus/types";
import { DockerService } from "../docker/service";

const log = createLogger("agent:volume-backup");

const BACKUP_DIR = process.env.AGENT_DATA_DIR ? `${process.env.AGENT_DATA_DIR}/backups` : "data/agent/backups";

/**
 * Snapshot a Docker named volume into a tar.gz stored in the agent backups
 * dir. Uses an alpine helper container that mounts the volume read-only and
 * tars it up — no app container downtime, no host shell access to the data.
 */
export async function createVolumeBackup(
  docker: DockerService,
  payload: VolumeBackupPayload,
  onLog?: (msg: string) => void,
): Promise<{ path: string; sizeBytes: number }> {
  const logLine = onLog ?? (() => {});
  const filePath = join(BACKUP_DIR, payload.fileName);
  mkdirSync(BACKUP_DIR, { recursive: true });
  logLine(`Snapshotting volume ${payload.volumeName} → ${filePath}`);

  const res = await docker.run(
    [
      "run", "--rm",
      "-v", `${payload.volumeName}:/data:ro`,
      "-v", `${BACKUP_DIR}:/backup`,
      "alpine:3.20",
      "sh", "-c",
      `tar czf /backup/${payload.fileName} -C /data .`,
    ],
    { timeoutMs: 15 * 60 * 1000 },
  );
  if (res.code !== 0) {
    throw new Error(`volume backup failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const size = existsSync(filePath) ? statSync(filePath).size : 0;
  logLine(`Volume backup complete (${size} bytes)`);
  return { path: filePath, sizeBytes: size };
}

/**
 * Restore a volume snapshot into a named volume. The backup file is mounted
 * read-only and extracted into the volume. The volume is created if missing.
 */
export async function restoreVolumeBackup(
  docker: DockerService,
  payload: VolumeRestorePayload,
  onLog?: (msg: string) => void,
): Promise<{ restored: boolean }> {
  const logLine = onLog ?? (() => {});
  const filePath = normalize(payload.filePath);
  if (!existsSync(filePath)) throw new Error(`Backup file not found: ${filePath}`);
  const dir = dirname(filePath);
  const file = basename(filePath);
  logLine(`Restoring volume ${payload.volumeName} from ${file}`);

  // Ensure the volume exists (restore may target a fresh app).
  await docker.volumeCreate(payload.volumeName);

  const res = await docker.run(
    [
      "run", "--rm",
      "-v", `${payload.volumeName}:/data`,
      "-v", `${dir}:/backup:ro`,
      "alpine:3.20",
      "sh", "-c",
      `tar xzf /backup/${file} -C /data`,
    ],
    { timeoutMs: 15 * 60 * 1000 },
  );
  if (res.code !== 0) {
    throw new Error(`volume restore failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  logLine("Volume restore complete");
  return { restored: true };
}
