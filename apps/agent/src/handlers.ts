import { createLogger } from "@nexus/logger";
import type { AgentAction, ApiAgentRequest } from "@nexus/types";
import { DockerService } from "./docker/service";
import { executeDeployment, requestCancel } from "./deployments/executor";
import { createBackup, restoreBackup, backupDir } from "./backups/executor";
import { createVolumeBackup, restoreVolumeBackup } from "./backups/volume";
import { mkdirSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, normalize } from "node:path";
import { createGameContainer, removeGame, startGame, stopGame } from "./games/executor";

const log = createLogger("agent:handlers");

/**
 * Reject command arguments containing control characters / null bytes. The
 * real shell-injection guard is that non-shell exec passes args verbatim (no
 * shell), but this blocks the remaining pathological input. Pure — exported for
 * unit tests.
 */
export function assertSafeCmdArgs(cmd: string[]): void {
  for (const c of cmd) {
    if (/[\u0000-\u001f\u007f]/.test(c)) throw new Error(`invalid command argument: ${JSON.stringify(c)}`);
  }
}

export type HandlerContext = {
  docker: DockerService;
  emitEvent: (eventType: string, resourceId: string | undefined, data: Record<string, unknown>) => void;
  sendResult: (requestId: string, result: unknown) => void;
  sendError: (requestId: string, code: string, message: string) => void;
};

/** Whitelist of actions — anything else is rejected before touching Docker. */
const ALLOWED_ACTIONS = new Set<AgentAction>([
  "system.info",
  "docker.ps",
  "docker.images",
  "docker.volumes",
  "docker.networks",
  "docker.inspect",
  "container.start",
  "container.stop",
  "container.restart",
  "container.pause",
  "container.unpause",
  "container.remove",
  "container.logs",
  "container.logs.follow",
  "container.logs.stop",
  "container.stats",
  "container.exec",
  "image.pull",
  "image.remove",
  "volume.create",
  "volume.remove",
  "volume.inspect",
  "network.create",
  "network.remove",
  "network.inspect",
  "deployment.execute",
  "deployment.cancel",
  "database.create",
  "db.backup",
  "db.restore",
  "db.query",
  "db.schema",
  "db.objects",
  "db.tableInfo",
  "db.write",
  "db.exec",
  "volume.backup",
  "volume.restore",
  "file.remove",
  "file.read",
  "file.upload",
  "game.create",
  "game.start",
  "game.stop",
  "game.remove",
  "game.files.list",
  "game.files.read",
  "game.files.write",
  "game.files.mkdir",
  "game.files.delete",
  "game.files.rename",
  "game.files.copy",
  "game.files.archive",
  "game.files.upload",
]);

const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1 MB

export function validateRequest(msg: unknown): ApiAgentRequest | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "request") return null;
  if (typeof m.requestId !== "string" || m.requestId.length > 128) return null;
  if (typeof m.action !== "string" || !ALLOWED_ACTIONS.has(m.action as AgentAction)) return null;
  const payload = (m.payload ?? {}) as Record<string, unknown>;
  if (typeof payload !== "object" || payload === null) return null;
  if (JSON.stringify(payload).length > MAX_PAYLOAD_SIZE) return null;
  return m as unknown as ApiAgentRequest;
}

export async function dispatch(req: ApiAgentRequest, ctx: HandlerContext): Promise<void> {
  const { docker, emitEvent } = ctx;
  const { requestId, action, payload } = req;

  const guard = (id: string): string => {
    // Container/volume/network ids must be plain ids (no shell metacharacters).
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(id)) {
      throw new Error(`invalid id: ${id}`);
    }
    return id;
  };

  try {
    switch (action) {
      case "system.info": {
        const { collectSystemInfo } = await import("./system/info");
        ctx.sendResult(requestId, collectSystemInfo());
        return;
      }

      case "docker.ps": {
        ctx.sendResult(requestId, await docker.ps());
        return;
      }
      case "docker.images": {
        ctx.sendResult(requestId, await docker.images());
        return;
      }
      case "docker.volumes": {
        ctx.sendResult(requestId, await docker.volumes());
        return;
      }
      case "docker.networks": {
        ctx.sendResult(requestId, await docker.networks());
        return;
      }
      case "docker.inspect": {
        const id = guard(String(payload.id ?? ""));
        ctx.sendResult(requestId, await docker.inspect(id));
        return;
      }

      case "container.start": {
        const id = guard(String(payload.id ?? ""));
        await docker.start(id);
        ctx.sendResult(requestId, { id });
        return;
      }
      case "container.stop": {
        const id = guard(String(payload.id ?? ""));
        await docker.stop(id, Number(payload.timeoutSeconds ?? 15));
        ctx.sendResult(requestId, { id });
        return;
      }
      case "container.restart": {
        const id = guard(String(payload.id ?? ""));
        await docker.restart(id);
        ctx.sendResult(requestId, { id });
        return;
      }
      case "container.pause": {
        const id = guard(String(payload.id ?? ""));
        await docker.pause(id);
        ctx.sendResult(requestId, { id });
        return;
      }
      case "container.unpause": {
        const id = guard(String(payload.id ?? ""));
        await docker.unpause(id);
        ctx.sendResult(requestId, { id });
        return;
      }
      case "container.remove": {
        const id = guard(String(payload.id ?? ""));
        await docker.remove(id, { force: !!payload.force, volumes: !!payload.volumes });
        ctx.sendResult(requestId, { id });
        return;
      }
      case "container.logs": {
        const id = guard(String(payload.id ?? ""));
        const logs = await docker.logs(id, Number(payload.tail ?? 200));
        ctx.sendResult(requestId, { logs });
        return;
      }
      case "container.logs.follow": {
        const id = guard(String(payload.id ?? ""));
        const streamId = String(payload.streamId ?? "");
        if (!streamId) throw new Error("container.logs.follow requires a streamId");
        const { startContainerLogFollow } = await import("./docker/follow");
        startContainerLogFollow(
          docker,
          { id, streamId, tail: Number(payload.tail ?? 200) },
          (sid, line) => emitEvent("container.log", sid, { containerId: id, line }),
          (sid) => emitEvent("container.log", sid, { containerId: id, ended: true }),
        );
        ctx.sendResult(requestId, { streamId });
        return;
      }
      case "container.logs.stop": {
        const streamId = String(payload.streamId ?? "");
        const { stopContainerLogFollow } = await import("./docker/follow");
        stopContainerLogFollow(streamId);
        ctx.sendResult(requestId, { streamId });
        return;
      }
      case "container.stats": {
        const name = String(payload.name ?? "");
        const stats = await docker.statsAll();
        const s = stats[name] ?? stats[String(payload.id ?? "")] ?? { cpuPercent: 0, memoryUsageBytes: 0, memoryLimitBytes: 0 };
        ctx.sendResult(requestId, s);
        return;
      }
      case "container.exec": {
        const id = guard(String(payload.id ?? ""));
        const cmd = Array.isArray(payload.cmd) ? (payload.cmd as string[]).map((c) => String(c)) : [];
        if (cmd.length === 0) throw new Error("container.exec requires a cmd array");
        // Command arguments are NOT ids — they can contain flags, paths, etc.
        // Only reject control characters / null bytes (shell injection guard
        // lives in docker.exec, which passes args without a shell).
        assertSafeCmdArgs(cmd);
        const res = await docker.exec(id, cmd, {
          stdin: typeof payload.stdin === "string" ? payload.stdin : undefined,
          timeoutMs: Number(payload.timeoutMs ?? 30000),
          shell: payload.shell === true,
        });
        ctx.sendResult(requestId, res);
        return;
      }

      case "image.pull": {
        const image = String(payload.image ?? "");
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._\/:@-]*$/.test(image)) throw new Error(`invalid image: ${image}`);
        await docker.pull(image, (line) => emitEvent("job.progress", undefined, { message: line }));
        ctx.sendResult(requestId, { image });
        return;
      }
      case "image.remove": {
        const image = guard(String(payload.image ?? ""));
        await docker.removeImage(image, !!payload.force);
        ctx.sendResult(requestId, { image });
        return;
      }

      case "volume.create": {
        const name = guard(String(payload.name ?? ""));
        await docker.volumeCreate(name, typeof payload.driver === "string" ? payload.driver : undefined);
        ctx.sendResult(requestId, { name });
        return;
      }
      case "volume.remove": {
        const name = guard(String(payload.name ?? ""));
        await docker.volumeRemove(name, !!payload.force);
        ctx.sendResult(requestId, { name });
        return;
      }
      case "volume.inspect": {
        const name = guard(String(payload.name ?? ""));
        ctx.sendResult(requestId, await docker.volumeInspect(name));
        return;
      }

      case "network.create": {
        const name = guard(String(payload.name ?? ""));
        await docker.networkCreate(name, typeof payload.driver === "string" ? payload.driver : "bridge", typeof payload.subnet === "string" ? payload.subnet : undefined);
        ctx.sendResult(requestId, { name });
        return;
      }
      case "network.remove": {
        const name = guard(String(payload.name ?? ""));
        await docker.networkRemove(name);
        ctx.sendResult(requestId, { name });
        return;
      }
      case "network.inspect": {
        const name = guard(String(payload.name ?? ""));
        ctx.sendResult(requestId, await docker.networkInspect(name));
        return;
      }

      case "deployment.execute": {
        const emit = (eventType: string, resourceId: string | undefined, data: Record<string, unknown>) =>
          emitEvent(eventType, resourceId, data);
        const result = await executeDeployment(docker, payload as never, emit as never);
        ctx.sendResult(requestId, result);
        return;
      }
      case "deployment.cancel": {
        const deploymentId = String(payload.deploymentId ?? "");
        const cancelled = requestCancel(deploymentId);
        ctx.sendResult(requestId, { cancelled });
        return;
      }

      case "database.create": {
        const { createDatabaseContainer } = await import("./databases/executor");
        const result = await createDatabaseContainer(docker, payload as never, (msg) => emitEvent("resource.log", String(payload.databaseId ?? ""), { resourceType: "database", message: msg }));
        ctx.sendResult(requestId, result);
        return;
      }

      case "db.backup": {
        const result = await createBackup(docker, payload as never, (msg) => emitEvent("resource.log", String(payload.backupId ?? ""), { resourceType: "backup", message: msg }));
        ctx.sendResult(requestId, result);
        return;
      }
      case "db.restore": {
        const result = await restoreBackup(docker, payload as never, (msg) => emitEvent("resource.log", String(payload.backupId ?? ""), { resourceType: "backup", message: msg }));
        ctx.sendResult(requestId, result);
        return;
      }

      case "db.query": {
        const { runDbQuery } = await import("./databases/console");
        const result = await runDbQuery(docker, payload as never);
        ctx.sendResult(requestId, result);
        return;
      }
      case "db.schema": {
        const { getDbSchema } = await import("./databases/console");
        const result = await getDbSchema(docker, payload as never);
        ctx.sendResult(requestId, result);
        return;
      }
      case "db.objects": {
        const { getDbObjects } = await import("./databases/console");
        const result = await getDbObjects(docker, payload as never);
        ctx.sendResult(requestId, result);
        return;
      }
      case "db.tableInfo": {
        const { getDbTableInfo } = await import("./databases/console");
        const result = await getDbTableInfo(docker, payload as never);
        ctx.sendResult(requestId, result);
        return;
      }
      case "db.write": {
        const { runDbWrite } = await import("./databases/console");
        const result = await runDbWrite(docker, payload as never);
        ctx.sendResult(requestId, result);
        return;
      }
      case "db.exec": {
        const { runDbExec } = await import("./databases/console");
        const result = await runDbExec(docker, payload as never);
        ctx.sendResult(requestId, result);
        return;
      }

      case "volume.backup": {
        const result = await createVolumeBackup(docker, payload as never, (msg) => emitEvent("resource.log", String(payload.backupId ?? ""), { resourceType: "backup", message: msg }));
        ctx.sendResult(requestId, result);
        return;
      }
      case "volume.restore": {
        const result = await restoreVolumeBackup(docker, payload as never, (msg) => emitEvent("resource.log", String(payload.backupId ?? ""), { resourceType: "backup", message: msg }));
        ctx.sendResult(requestId, result);
        return;
      }

      case "file.remove": {
        // Retention cleanup — only allow deleting files inside the backups dir.
        const path = String(payload.path ?? "");
        const base = normalize(backupDir());
        const resolved = normalize(path);
        if (!resolved.startsWith(base)) throw new Error("refusing to remove file outside backups dir");
        try {
          rmSync(resolved, { force: true });
          ctx.sendResult(requestId, { removed: true });
        } catch (err) {
          throw new Error(`failed to remove backup file: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      case "file.read": {
        // Streaming download — read a slice of a backup file (base64). The
        // API pulls consecutive chunks and pipes them to the HTTP response.
        const path = String(payload.path ?? "");
        const base = normalize(backupDir());
        const resolved = normalize(path);
        if (!resolved.startsWith(base)) throw new Error("refusing to read file outside backups dir");
        const offset = Math.max(0, Number(payload.offset ?? 0));
        const length = Math.max(1, Math.min(Number(payload.length ?? 256 * 1024), 1024 * 1024));
        const f = Bun.file(resolved);
        if (!(await f.exists())) throw new Error("backup file not found on the agent host");
        const total = f.size;
        const end = Math.min(offset + length, total);
        const buf = Buffer.from(await f.slice(offset, end).arrayBuffer());
        ctx.sendResult(requestId, { data: buf.toString("base64"), offset, length: buf.length, total });
        return;
      }

      case "file.upload": {
        // Streaming upload — write a base64 chunk at `offset`. The API sends
        // consecutive chunks to rebuild the file inside the backups dir.
        const fileName = String(payload.fileName ?? "");
        if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
          throw new Error("invalid backup file name");
        }
        const base = normalize(backupDir());
        const resolved = normalize(join(base, fileName));
        if (!resolved.startsWith(base)) throw new Error("refusing to write file outside backups dir");
        const data = Buffer.from(String(payload.data ?? ""), "base64");
        const offset = Math.max(0, Number(payload.offset ?? 0));
        mkdirSync(base, { recursive: true });
        const fh = await open(resolved, offset === 0 ? "w" : "r+");
        try {
          if (offset === 0 && data.length === 0) {
            // Create/truncate the file with no data (first empty chunk).
          } else {
            await fh.write(data, 0, data.length, offset);
          }
        } finally {
          await fh.close();
        }
        const total = (await Bun.file(resolved).stat()).size;
        ctx.sendResult(requestId, { path: resolved, written: data.length, total });
        return;
      }

      case "game.create": {
        const gameId = String(payload.gameServerId ?? "");
        const result = await createGameContainer(docker, payload as never, (msg) => {
          emitEvent("job.progress", gameId, { message: msg });
          emitEvent("resource.log", gameId, { resourceType: "game", message: msg });
        });
        ctx.sendResult(requestId, result);
        return;
      }
      case "game.start": {
        const id = guard(String(payload.containerId ?? ""));
        await startGame(docker, id);
        ctx.sendResult(requestId, { id });
        return;
      }
      case "game.stop": {
        const id = guard(String(payload.containerId ?? ""));
        await stopGame(docker, id);
        ctx.sendResult(requestId, { id });
        return;
      }
      case "game.remove": {
        const id = guard(String(payload.containerId ?? ""));
        await removeGame(docker, id);
        ctx.sendResult(requestId, { id });
        return;
      }

      case "game.files.list": {
        const { listGameFiles } = await import("./games/files");
        ctx.sendResult(requestId, await listGameFiles(docker, payload as never));
        return;
      }
      case "game.files.read": {
        const { readGameFile } = await import("./games/files");
        ctx.sendResult(requestId, await readGameFile(docker, payload as never));
        return;
      }
      case "game.files.write": {
        const { writeGameFile } = await import("./games/files");
        ctx.sendResult(requestId, await writeGameFile(docker, payload as never));
        return;
      }
      case "game.files.mkdir": {
        const { mkdirGameFile } = await import("./games/files");
        ctx.sendResult(requestId, await mkdirGameFile(docker, payload as never));
        return;
      }
      case "game.files.delete": {
        const { deleteGameFile } = await import("./games/files");
        ctx.sendResult(requestId, await deleteGameFile(docker, payload as never));
        return;
      }
      case "game.files.rename": {
        const { renameGameFile } = await import("./games/files");
        ctx.sendResult(requestId, await renameGameFile(docker, payload as never));
        return;
      }
      case "game.files.copy": {
        const { copyGameFile } = await import("./games/files");
        ctx.sendResult(requestId, await copyGameFile(docker, payload as never));
        return;
      }
      case "game.files.archive": {
        const { archiveGamePath } = await import("./games/files");
        ctx.sendResult(requestId, await archiveGamePath(docker, payload as never));
        return;
      }
      case "game.files.upload": {
        const { uploadGameFile } = await import("./games/files");
        ctx.sendResult(requestId, await uploadGameFile(docker, payload as never));
        return;
      }

      default: {
        ctx.sendError(requestId, "UNKNOWN_ACTION", `Unsupported action: ${String(action)}`);
      }
    }
  } catch (err) {
    log.error("action failed", { action, error: err instanceof Error ? err.message : String(err) });
    ctx.sendError(requestId, (err as { code?: string })?.code ?? "ACTION_FAILED", err instanceof Error ? err.message : String(err));
  }
}
