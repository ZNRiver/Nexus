/**
 * File manager for game server containers — lists, reads, writes, creates,
 * deletes and renames files inside the container's game volume (mounted at
 * /data). Every path is validated to stay inside /data so the manager cannot
 * touch the rest of the container filesystem.
 */
import type {
  GameFileDeletePayload,
  GameFileListPayload,
  GameFileMkdirPayload,
  GameFileReadPayload,
  GameFileRenamePayload,
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
  const cmd = payload.recursive ? `rm -rf ${shquote(file)}` : `rm -f ${shquote(file)}; [ -d ${shquote(file)} ] && rm -rf ${shquote(file)}`;
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
