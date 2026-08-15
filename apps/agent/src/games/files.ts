/**
 * File manager for game server containers — lists, reads, writes, creates,
 * deletes and renames files inside the container's game volume (mounted at
 * /data). Every path is validated to stay inside /data so the manager cannot
 * touch the rest of the container filesystem.
 */
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type {
  GameFileArchivePayload,
  GameFileCopyPayload,
  GameFileDeletePayload,
  GameFileListPayload,
  GameFileMkdirPayload,
  GameFileReadPayload,
  GameFileRenamePayload,
  GameFileUploadPayload,
  GameFileWritePayload,
} from "@nexus/types";
import { normalize, posix } from "node:path";
import { DockerService } from "../docker/service";

const ROOT = "/data";

/** Resolve a user-supplied path to a safe absolute path inside /data. */
function resolvePath(raw: string): string {
  const p = String(raw ?? "").trim();
  if (!p) throw new Error("path is required");
  const abs = p.startsWith("/") ? p : `${ROOT}/${p}`;
  const norm = posix.normalize(abs);
  if (norm !== ROOT && !norm.startsWith(`${ROOT}/`)) {
    throw new Error("path must stay inside the game volume (/data)");
  }
  return norm;
}

function shquote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface GameFileEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
}

export async function listGameFiles(
  docker: DockerService,
  payload: GameFileListPayload,
): Promise<{ path: string; entries: GameFileEntry[] }> {
  const dir = resolvePath(payload.path);
  const script =
    `cd ${shquote(dir)} && ls -1A | while IFS= read -r f; do ` +
    `if [ -d "$f" ]; then echo "d|$f|0|$(stat -c %Y "$f" 2>/dev/null || echo 0)"; ` +
    `else echo "f|$f|$(stat -c %s "$f" 2>/dev/null || echo 0)|$(stat -c %Y "$f" 2>/dev/null || echo 0)"; fi; done`;
  const res = await docker.exec(payload.containerId, ["sh", "-c", script], { timeoutMs: 30000 });
  if (res.exitCode !== 0) {
    throw new Error(res.output.trim().slice(0, 400) || `failed to list ${dir} (exit ${res.exitCode})`);
  }
  const entries: GameFileEntry[] = [];
  for (const line of res.output.replace(/\r/g, "").split("\n")) {
    if (!line.trim()) continue;
    const [t, name, sizeRaw, mtimeRaw] = line.split("|");
    if (!name) continue;
    entries.push({
      name,
      type: t === "d" ? "dir" : "file",
      size: Number(sizeRaw) || 0,
      mtime: Number(mtimeRaw) || 0,
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: dir, entries };
}

export async function readGameFile(
  docker: DockerService,
  payload: GameFileReadPayload,
): Promise<{ path: string; content: string; bytes: number }> {
  const file = resolvePath(payload.path);
  const res = await docker.exec(payload.containerId, ["sh", "-c", `cat ${shquote(file)}`], { timeoutMs: 30000 });
  if (res.exitCode !== 0) {
    throw new Error(res.output.trim().slice(0, 400) || `failed to read ${file} (exit ${res.exitCode})`);
  }
  // Cap at ~1 MB so a misclicked binary file can't blow up the WS payload.
  const content = res.output.slice(0, 1024 * 1024);
  return { path: file, content, bytes: Buffer.byteLength(content) };
}

export async function writeGameFile(
  docker: DockerService,
  payload: GameFileWritePayload,
): Promise<{ path: string; bytes: number }> {
  const file = resolvePath(payload.path);
  const content = String(payload.content ?? "");
  if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error("file is too large to write through the panel (max 4 MB)");
  const res = await docker.exec(payload.containerId, ["sh", "-c", `cat > ${shquote(file)}`], { stdin: content, timeoutMs: 30000 });
  if (res.exitCode !== 0) {
    throw new Error(res.output.trim().slice(0, 400) || `failed to write ${file} (exit ${res.exitCode})`);
  }
  return { path: file, bytes: Buffer.byteLength(content) };
}

export async function mkdirGameFile(
  docker: DockerService,
  payload: GameFileMkdirPayload,
): Promise<{ path: string }> {
  const dir = resolvePath(payload.path);
  const res = await docker.exec(payload.containerId, ["sh", "-c", `mkdir -p ${shquote(dir)}`], { timeoutMs: 30000 });
  if (res.exitCode !== 0) {
    throw new Error(res.output.trim().slice(0, 400) || `failed to create ${dir} (exit ${res.exitCode})`);
  }
  return { path: dir };
}

export async function deleteGameFile(
  docker: DockerService,
  payload: GameFileDeletePayload,
): Promise<{ path: string }> {
  const file = resolvePath(payload.path);
  if (file === ROOT) throw new Error("refusing to delete the volume root");
  // Files and directories need different flags; use `if -d` so a plain file
  // delete doesn't leave a non-zero exit (which the API would report as 500).
  const cmd = payload.recursive
    ? `rm -rf ${shquote(file)}`
    : `if [ -d ${shquote(file)} ]; then rm -rf ${shquote(file)}; else rm -f ${shquote(file)}; fi`;
  const res = await docker.exec(payload.containerId, ["sh", "-c", cmd], { timeoutMs: 30000 });
  if (res.exitCode !== 0) {
    throw new Error(res.output.trim().slice(0, 400) || `failed to delete ${file} (exit ${res.exitCode})`);
  }
  return { path: file };
}

export async function renameGameFile(
  docker: DockerService,
  payload: GameFileRenamePayload,
): Promise<{ from: string; to: string }> {
  const from = resolvePath(payload.path);
  const newName = String(payload.newName ?? "").trim();
  if (!newName || newName.includes("/") || newName === "." || newName === "..") {
    throw new Error("invalid file name");
  }
  const to = resolvePath(posix.join(posix.dirname(from), newName));
  const res = await docker.exec(payload.containerId, ["sh", "-c", `mv ${shquote(from)} ${shquote(to)}`], { timeoutMs: 30000 });
  if (res.exitCode !== 0) {
    throw new Error(res.output.trim().slice(0, 400) || `failed to rename ${from} (exit ${res.exitCode})`);
  }
  return { from, to };
}

/** Copy a file/directory — Pterodactyl-style "name copy.ext" in the same dir. */
export async function copyGameFile(
  docker: DockerService,
  payload: GameFileCopyPayload,
): Promise<{ from: string; to: string }> {
  const from = resolvePath(payload.path);
  const ext = posix.extname(from);
  const base = posix.basename(from, ext);
  let to = posix.join(posix.dirname(from), `${base} copy${ext}`);
  let i = 1;
  // Avoid clobbering an existing "name copy.ext" — bump to "name copy 2.ext"…
  for (;;) {
    const probe = await docker.exec(payload.containerId, ["sh", "-c", `[ -e ${shquote(to)} ] && echo yes || echo no`], { timeoutMs: 15000 });
    if (probe.output.trim() !== "yes") break;
    i += 1;
    to = posix.join(posix.dirname(from), `${base} copy ${i}${ext}`);
  }
  const res = await docker.exec(payload.containerId, ["sh", "-c", `cp -r ${shquote(from)} ${shquote(to)}`], { timeoutMs: 120000 });
  if (res.exitCode !== 0) {
    throw new Error(res.output.trim().slice(0, 400) || `failed to copy ${from} (exit ${res.exitCode})`);
  }
  return { from, to };
}

const BACKUP_DIR = process.env.AGENT_DATA_DIR ? `${process.env.AGENT_DATA_DIR}/backups` : "data/agent/backups";
const UPLOAD_TMP = process.env.AGENT_DATA_DIR ? `${process.env.AGENT_DATA_DIR}/uploads` : "data/agent/uploads";

/**
 * Tar a single directory (or file) of the game volume into the agent backups
 * dir — powers the Pterodactyl-style "Download" of directories. Uses the same
 * alpine helper pattern as volume backups so nothing touches the container.
 */
export async function archiveGamePath(
  docker: DockerService,
  payload: GameFileArchivePayload,
): Promise<{ path: string; sizeBytes: number }> {
  const target = resolvePath(payload.path);
  const rel = target === ROOT ? "." : target.slice(ROOT.length + 1);
  mkdirSync(BACKUP_DIR, { recursive: true });
  const filePath = join(BACKUP_DIR, payload.fileName);

  const res = await docker.run(
    [
      "run", "--rm",
      "-v", `${payload.volumeName}:/data:ro`,
      "-v", `${BACKUP_DIR}:/backup`,
      "alpine:3.20",
      "sh", "-c",
      `tar czf /backup/${payload.fileName} -C /data ${shquote(rel)}`,
    ],
    { timeoutMs: 15 * 60 * 1000 },
  );
  if (res.code !== 0) {
    throw new Error(`archive failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const size = existsSync(filePath) ? statSync(filePath).size : 0;
  return { path: filePath, sizeBytes: size };
}

/**
 * Chunked upload for the file manager — the API streams the request body in
 * base64 chunks; each chunk is appended to a temp file on the agent host. The
 * final chunk copies the temp file into the game volume via `docker cp`
 * (binary-safe, works for large files) and removes the temp.
 */
export async function uploadGameFile(
  docker: DockerService,
  payload: GameFileUploadPayload,
): Promise<{ written: number; total: number }> {
  const target = resolvePath(payload.path);
  const fileName = String(payload.fileName ?? "");
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
    throw new Error("invalid upload temp file name");
  }
  mkdirSync(UPLOAD_TMP, { recursive: true });
  const tmpFile = join(UPLOAD_TMP, fileName);

  const data = Buffer.from(String(payload.data ?? ""), "base64");
  const offset = Math.max(0, Number(payload.offset ?? 0));
  const fh = await open(tmpFile, offset === 0 ? "w" : "r+");
  try {
    if (data.length > 0) {
      await fh.write(data, 0, data.length, offset);
    }
  } finally {
    await fh.close();
  }
  const total = existsSync(tmpFile) ? statSync(tmpFile).size : 0;

  if (payload.final === true) {
    const res = await docker.run(
      ["cp", tmpFile, `${payload.containerId}:${target}`],
      { timeoutMs: 10 * 60 * 1000 },
    );
    rmSync(tmpFile, { force: true });
    if (res.code !== 0) {
      throw new Error(`upload failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
  }
  return { written: data.length, total };
}
