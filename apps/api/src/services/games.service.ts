import type { BackupRow, DbConnection, GameAllocationRow, GameScheduleRow, GameServerRow, JobRow, ServerRow } from "@nexus/database";
import { newId } from "../lib/crypto";
import { errors } from "../lib/errors";
import type { Backup, CreateGameServerInput, GameAllocation, GameSchedule, GameServer, GameServerStatus, MinecraftFlavor } from "@nexus/types";
import type { AppContext } from "../context";
import { JobQueue } from "../jobs/queue";
import { eventHub } from "../lib/events";
import { nextRun, parseCron } from "../lib/cron";
import { appendResourceLog } from "./resource-logs.service";
import { newToken } from "../lib/crypto";

/**
 * RCON lets the panel send real server commands to the console (the itzg
 * images run the server in the foreground, so plain `docker exec` can't reach
 * the console — `rcon-cli` inside the container is the supported channel).
 */
function rconDefaults(): Record<string, string> {
  return {
    ENABLE_RCON: "TRUE",
    RCON_PASSWORD: newToken(8),
    RCON_PORT: "25575",
  };
}

function parseEnv(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Ensure RCON is enabled (used for servers created before RCON support). */
function ensureRcon(env: Record<string, string>): Record<string, string> {
  if (env.ENABLE_RCON === "TRUE" && env.RCON_PASSWORD) return env;
  return { ...rconDefaults(), ...env };
}

/**
 * Decide how a console command should be executed on a game server container.
 *
 * - Commands with shell metacharacters (`&&`, `|`, `;`, `$`, `>`, `<`, backtick)
 *   or that start with a known system binary are treated as system commands and
 *   run through the real container shell (`/bin/sh -c`).
 * - Everything else is a game command → sent via `rcon-cli` when RCON is
 *   configured, so the command actually reaches the Minecraft server.
 *
 * Pure function — exported for unit tests.
 */
export function routeGameExec(
  cmd: string[],
  env: Record<string, string>,
): { execCmd: string[]; shell: boolean } {
  const rconPw = env.RCON_PASSWORD;
  const line = cmd.join(" ");
  const looksLikeShell =
    /[&|;<>$`]/.test(line) || /^(cd|ls|cat|pwd|echo|find|grep|tail|head|rm|cp|mv|mkdir|touch|ps|top|free|df|du|env|which|whoami|id|uname|docker)\b/.test(line.trim());
  const execCmd = rconPw && !looksLikeShell
    ? ["rcon-cli", "--host", "127.0.0.1", "--port", env.RCON_PORT ?? "25575", "--password", rconPw, ...cmd]
    : cmd;
  return { execCmd, shell: looksLikeShell };
}

const GAME_IMAGES: Record<string, { default: string; versions: string[] }> = {
  MINECRAFT: {
    default: "itzg/minecraft-server:latest",
    versions: ["latest", "1.21.4", "1.21.1", "1.20.4", "1.19.4"],
  },
};

const FLAVOR_ENV: Record<MinecraftFlavor, string> = {
  VANILLA: "VANILLA",
  PAPER: "PAPER",
  PURPUR: "PURPUR",
  FABRIC: "FABRIC",
  FORGE: "FORGE",
};

/** Feature permissions a sub-user can be granted on a game server. */
export const GAME_USER_PERMS = ["console", "startstop", "files", "backups", "schedules", "network", "startup", "activity"] as const;
export type GameUserPerm = (typeof GAME_USER_PERMS)[number];

function normalizeGamePerms(input: string[] | undefined | null): string[] {
  const seen = new Set<string>();
  for (const p of input ?? []) {
    if (GAME_USER_PERMS.includes(p as GameUserPerm)) seen.add(p);
  }
  return [...seen];
}

function safeGamePerms(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    /* fall through */
  }
  return [];
}

export function toGameServer(row: GameServerRow): GameServer {
  let environment: Record<string, string> = {};
  if (row.environment) {
    try {
      environment = JSON.parse(row.environment) as Record<string, string>;
    } catch {
      environment = {};
    }
  }
  return {
    id: row.id,
    serverId: row.server_id,
    projectId: row.project_id,
    name: row.name,
    game: row.game as GameServer["game"],
    version: row.version,
    flavor: row.flavor as MinecraftFlavor | null,
    image: row.image,
    port: row.port,
    memoryBytes: row.memory_bytes,
    cpuLimit: row.cpu_limit,
    storageBytes: row.storage_bytes,
    environment,
    status: row.status as GameServerStatus,
    containerId: row.container_id,
    volumeName: row.volume_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GameServersService {
  constructor(
    private readonly db: DbConnection,
    private readonly ctx: AppContext,
  ) {}

  async list(opts: { serverId?: string; limit: number; cursor?: string; userId?: string }): Promise<{ items: GameServer[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.serverId) {
      where.push("server_id = ?");
      params.push(opts.serverId);
    }
    if (opts.userId) {
      // Non-admin users only see game servers they were granted access to.
      where.push("id IN (SELECT game_server_id FROM game_server_users WHERE user_id = ?)");
      params.push(opts.userId);
    }
    if (opts.cursor) {
      where.push("created_at <= ?");
      params.push(opts.cursor);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await this.db.all<GameServerRow>(`SELECT * FROM game_servers ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, opts.limit + 1]);
    const hasMore = rows.length > opts.limit;
    const items = rows.slice(0, opts.limit).map(toGameServer);
    return { items, nextCursor: hasMore ? items[items.length - 1]?.createdAt ?? null : null };
  }

  async get(id: string): Promise<GameServerRow> {
    const row = await this.db.get<GameServerRow>(`SELECT * FROM game_servers WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Game server not found");
    return row;
  }

  async getPublic(id: string): Promise<GameServer> {
    return toGameServer(await this.get(id));
  }

  async create(input: CreateGameServerInput): Promise<GameServer> {
    const server = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [input.serverId]);
    if (!server) throw errors.notFound("Server not found");
    const game = input.game ?? "MINECRAFT";
    const def = GAME_IMAGES[game];
    if (!def) throw errors.validation({ game: "Unsupported game" });

    const name = input.name.trim();
    if (name.length < 2) throw errors.validation({ name: "Name must be at least 2 characters" });

    const version = input.version ?? "latest";
    const flavor = input.flavor ?? (game === "MINECRAFT" ? "PAPER" : null);
    const image = input.image?.trim() || def.default;
    const port = input.port ?? 25565;
    const memoryBytes = input.memoryBytes ?? 4 * 1024 ** 3;
    const cpuLimit = input.cpuLimit ?? null;
    const storageBytes = input.storageBytes ?? 20 * 1024 ** 3;
    const environment = {
      EULA: "TRUE",
      TYPE: flavor ? FLAVOR_ENV[flavor] : "VANILLA",
      VERSION: version === "latest" ? "LATEST" : version,
      MEMORY: `${Math.round(memoryBytes / 1024 ** 2)}M`,
      ...rconDefaults(),
      ...(input.environment ?? {}),
    };

    const id = newId("gme");
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO game_servers (id, server_id, project_id, name, game, version, flavor, image, port, memory_bytes, cpu_limit, storage_bytes, environment, status, container_id, volume_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', NULL, ?, ?, ?)`,
      [id, input.serverId, input.projectId ?? null, name, game, version, flavor, image, port, memoryBytes, cpuLimit, storageBytes, JSON.stringify(environment), `nexus-game-${id.replace("gme_", "")}`, now, now],
    );
    // Primary network allocation (server host + game port).
    const allocationIp = server.type === "local" ? "localhost" : server.host;
    await this.db.run(
      `INSERT INTO game_allocations (id, game_server_id, ip, port, notes, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
      [newId("gma"), id, allocationIp, port, now, now],
    );
    const queue = new JobQueue(this.db);
    await queue.enqueue("game-server-create", { gameServerId: id });
    await this.ctx.audit({ action: "game.create", resourceType: "game-server", resourceId: id, resourceName: name, serverId: input.serverId });
    await this.ctx.notify("game.created", "Game server created", `${name} (${flavor ?? game}) was created — starting the container…`);
    return this.getPublic(id);
  }

  async runCreate(job: JobRow): Promise<void> {
    const payload = job.payload as unknown as { gameServerId: string };
    const row = await this.get(payload.gameServerId);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw Object.assign(new Error("Server offline — game server creation will retry"), { retryable: true });

    const environment = ensureRcon(parseEnv(row.environment));
    try {
      const result = await hub.request(row.server_id, "game.create", {
        gameServerId: row.id,
        image: row.image,
        containerName: `nexus-game-${row.id.replace("gme_", "")}`,
        port: row.port,
        memoryBytes: row.memory_bytes,
        cpuLimit: row.cpu_limit,
        env: environment,
        volumeName: row.volume_name ?? `nexus-game-${row.id.replace("gme_", "")}`,
        restartPolicy: "unless-stopped",
        labels: {},
      } as never, { timeoutMs: 10 * 60 * 1000 }) as { containerId: string };

      await this.db.run(`UPDATE game_servers SET container_id = ?, status = 'RUNNING', updated_at = ? WHERE id = ?`, [result.containerId, new Date().toISOString(), row.id]);
    } catch (err) {
      await this.db.run(`UPDATE game_servers SET status = 'FAILED', updated_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
      throw err;
    }
    eventHub.emit({ type: "game.status", gameServer: await this.getPublic(row.id) });
  }

  async start(id: string): Promise<GameServer> {
    const row = await this.get(id);
    if (!row.container_id) throw errors.conflict("Game server has no container yet");
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    await hub.request(row.server_id, "game.start", { containerId: row.container_id });
    await this.db.run(`UPDATE game_servers SET status = 'RUNNING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    await this.ctx.audit({ action: "game.start", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id });
    return this.getPublic(id);
  }

  async stop(id: string): Promise<GameServer> {
    const row = await this.get(id);
    if (!row.container_id) throw errors.conflict("Game server has no container yet");
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    await hub.request(row.server_id, "game.stop", { containerId: row.container_id });
    await this.db.run(`UPDATE game_servers SET status = 'STOPPED', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    await this.ctx.audit({ action: "game.stop", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id });
    return this.getPublic(id);
  }

  /** Restart the container (Reload). */
  async restart(id: string): Promise<{ id: string }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.container_id) throw errors.conflict("Game server container is not running — deploy it first");
    const result = await hub.request(row.server_id, "container.restart", { id: row.container_id }) as { id: string };
    await this.ctx.audit({ action: "game.restart", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id });
    return result;
  }

  /** Run a command inside the game server container (console).
   *
   * The itzg images run the game in the foreground, so `docker exec` can't
   * deliver console commands — when RCON is enabled we go through `rcon-cli`
   * (bundled in the image) so commands actually reach the server.
   */
  async exec(id: string, cmd: string[]): Promise<{ output: string; exitCode: number }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.container_id) throw errors.conflict("Game server container is not running");
    const env = parseEnv(row.environment);
    const { execCmd, shell } = routeGameExec(cmd, env);
    const result = await hub.request(row.server_id, "container.exec", {
      id: row.container_id,
      cmd: execCmd,
      timeoutMs: 30000,
      shell,
    }) as { output: string; exitCode: number };
    await this.ctx.audit({ action: "game.exec", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { cmd } });
    return result;
  }

  /** Container logs (console output). */
  async logs(id: string, tail = 200): Promise<string> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.container_id) throw errors.conflict("Game server container is not running");
    const result = await hub.request(row.server_id, "container.logs", { id: row.container_id, tail }) as { logs: string };
    return result.logs;
  }

  /** Real-time container stats (CPU / memory / network). */
  async stats(id: string): Promise<{ cpuPercent: number; memoryUsageBytes: number; memoryLimitBytes: number; networkRxBytes: number; networkTxBytes: number }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.container_id) throw errors.conflict("Game server container is not running");
    const name = `nexus-game-${row.id.replace("gme_", "")}`;
    return await hub.request(row.server_id, "container.stats", { id: row.container_id, name }) as {
      cpuPercent: number;
      memoryUsageBytes: number;
      memoryLimitBytes: number;
      networkRxBytes: number;
      networkTxBytes: number;
    };
  }

  /** Rename the game server (Pterodactyl-style settings). */
  async update(id: string, input: { name?: string }): Promise<GameServer> {
    const row = await this.get(id);
    const name = input.name?.trim();
    if (name !== undefined) {
      if (name.length < 2) throw errors.validation({ name: "Name must be at least 2 characters" });
      await this.db.run(`UPDATE game_servers SET name = ?, updated_at = ? WHERE id = ?`, [name, new Date().toISOString(), id]);
      await this.ctx.audit({ action: "game.update", resourceType: "game-server", resourceId: id, resourceName: name, serverId: row.server_id, metadata: { field: "name" } });
    }
    return this.getPublic(id);
  }

  /**
   * Reinstall — removes the container and re-creates it from the saved
   * settings (same volume, same port). For itzg images this re-runs the
   * entrypoint install (jar download), like Pterodactyl's reinstall.
   *
   * Runs as an async job (`game-server-reinstall`) so the panel can stream
   * progress via resource logs while the container is being re-created.
   */
  async reinstall(id: string): Promise<{ jobId: string }> {
    const row = await this.get(id);
    const queue = new JobQueue(this.db);
    const jobId = await queue.enqueue("game-server-reinstall", { gameServerId: id });
    await this.db.run(`UPDATE game_servers SET status = 'STARTING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    appendResourceLog(this.db, "game", id, `Starting reinstall of ${row.name}…`, "system");
    await this.ctx.audit({ action: "game.reinstall", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { jobId } });
    return { jobId };
  }

  /** Job handler for game-server-reinstall — the actual container swap. */
  async runReinstall(job: JobRow): Promise<void> {
    const payload = job.payload as unknown as { gameServerId: string };
    const row = await this.get(payload.gameServerId);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw Object.assign(new Error("Server offline — reinstall will retry"), { retryable: true });
    const id = row.id;
    const log = (msg: string, stream: "stdout" | "stderr" | "system" = "stdout") =>
      void appendResourceLog(this.db, "game", id, msg, stream);

    const containerName = `nexus-game-${row.id.replace("gme_", "")}`;
    if (row.container_id) {
      log("Removing the old container (volume preserved)…");
      await hub.request(row.server_id, "container.remove", { id: row.container_id, force: true, volumes: false }).catch(() => {});
    }
    try {
      log(`Creating container ${containerName} (${row.image})…`);
      // game.create streams image pull + boot progress as resource.log lines.
      const result = await hub.request(row.server_id, "game.create", {
        gameServerId: row.id,
        image: row.image,
        containerName,
        port: row.port,
        memoryBytes: row.memory_bytes,
        cpuLimit: row.cpu_limit,
        env: ensureRcon(parseEnv(row.environment)),
        volumeName: row.volume_name ?? containerName,
        restartPolicy: "unless-stopped",
        labels: {},
      } as never, { timeoutMs: 10 * 60 * 1000 }) as { containerId: string };
      await this.db.run(`UPDATE game_servers SET container_id = ?, status = 'RUNNING', updated_at = ? WHERE id = ?`, [result.containerId, new Date().toISOString(), id]);
      log(`Reinstall complete — container ${result.containerId.slice(0, 12)} running.`, "system");
    } catch (err) {
      await this.db.run(`UPDATE game_servers SET status = 'FAILED', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
      log(`Reinstall failed: ${err instanceof Error ? err.message : String(err)}`, "stderr");
      throw err;
    }
    eventHub.emit({ type: "game.status", gameServer: await this.getPublic(id) });
  }

  async remove(id: string, opts: { destroyData?: boolean } = {}): Promise<void> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (hub.isOnline(row.server_id)) {
      const containers = await hub.request(row.server_id, "docker.ps", {}).catch(() => []) as { id: string; labels: Record<string, string> }[];
      const mine = row.container_id ? { id: row.container_id } : containers.find((c) => c.labels?.["nexus.game"] === row.id);
      if (mine) await hub.request(row.server_id, "game.remove", { containerId: mine.id }).catch(() => {});
      if (opts.destroyData && row.volume_name) {
        await hub.request(row.server_id, "volume.remove", { name: row.volume_name, force: true }).catch(() => {});
      }
    }
    await this.db.run(`DELETE FROM game_schedules WHERE game_server_id = ?`, [id]);
    await this.db.run(`DELETE FROM game_allocations WHERE game_server_id = ?`, [id]);
    await this.db.run(`DELETE FROM backups WHERE game_server_id = ?`, [id]);
    await this.db.run(`DELETE FROM game_servers WHERE id = ?`, [id]);
    await this.ctx.audit({ action: "game.delete", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id });
  }

  /* ── File manager ────────────────────────────────────────────── */

  private async withContainer(row: GameServerRow) {
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.container_id) throw errors.conflict("Game server container is not running — start it first");
    return { hub, containerId: row.container_id };
  }

  async listFiles(id: string, path: string): Promise<{ path: string; entries: { name: string; type: "dir" | "file"; size: number; mtime: number }[] }> {
    const row = await this.get(id);
    const { hub, containerId } = await this.withContainer(row);
    const result = await hub.request(row.server_id, "game.files.list", { containerId, path } as never, { timeoutMs: 60_000 }) as {
      path: string; entries: { name: string; type: "dir" | "file"; size: number; mtime: number }[];
    };
    await this.ctx.audit({ action: "game.files.list", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { path } });
    return result;
  }

  async readFile(id: string, path: string): Promise<{ path: string; content: string; bytes: number }> {
    const row = await this.get(id);
    const { hub, containerId } = await this.withContainer(row);
    const result = await hub.request(row.server_id, "game.files.read", { containerId, path } as never, { timeoutMs: 60_000 }) as {
      path: string; content: string; bytes: number;
    };
    await this.ctx.audit({ action: "game.files.read", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { path } });
    return result;
  }

  async writeFile(id: string, path: string, content: string): Promise<{ path: string; bytes: number }> {
    const row = await this.get(id);
    const { hub, containerId } = await this.withContainer(row);
    const result = await hub.request(row.server_id, "game.files.write", { containerId, path, content } as never, { timeoutMs: 60_000 }) as {
      path: string; bytes: number;
    };
    await this.ctx.audit({ action: "game.files.write", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { path } });
    return result;
  }

  async mkdirFile(id: string, path: string): Promise<{ path: string }> {
    const row = await this.get(id);
    const { hub, containerId } = await this.withContainer(row);
    const result = await hub.request(row.server_id, "game.files.mkdir", { containerId, path } as never, { timeoutMs: 60_000 }) as { path: string };
    await this.ctx.audit({ action: "game.files.mkdir", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { path } });
    return result;
  }

  async deleteFile(id: string, path: string, recursive = false): Promise<{ path: string }> {
    const row = await this.get(id);
    const { hub, containerId } = await this.withContainer(row);
    const result = await hub.request(row.server_id, "game.files.delete", { containerId, path, recursive } as never, { timeoutMs: 60_000 }) as { path: string };
    await this.ctx.audit({ action: "game.files.delete", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { path, recursive } });
    return result;
  }

  async copyFile(id: string, path: string): Promise<{ from: string; to: string }> {
    const row = await this.get(id);
    const { hub, containerId } = await this.withContainer(row);
    const result = await hub.request(row.server_id, "game.files.copy", { containerId, path }) as { from: string; to: string };
    await this.ctx.audit({ action: "game.file.copy", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { path, to: result.to } });
    return result;
  }

  /** Tar a volume path into the agent backups dir (Pterodactyl-style directory download). */
  async archiveDir(id: string, path: string): Promise<{ path: string; sizeBytes: number }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.volume_name) throw errors.conflict("Game server has no volume to archive");
    const fileName = `${row.id}_dir_${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`;
    const result = await hub.request(row.server_id, "game.files.archive", {
      volumeName: row.volume_name,
      path,
      fileName,
    } as never, { timeoutMs: 15 * 60 * 1000 }) as { path: string; sizeBytes: number };
    await this.ctx.audit({ action: "game.file.archive", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { path } });
    return result;
  }

  /**
   * Stream an upload body into the game volume in base64 chunks. Returns the
   * final byte count once the agent has copied the assembled file in place.
   */
  async uploadFile(id: string, path: string, body: ReadableStream<Uint8Array> | null): Promise<{ path: string; bytes: number }> {
    const row = await this.get(id);
    const { hub, containerId } = await this.withContainer(row);
    if (!body) throw errors.badRequest("Empty upload body");
    const reader = body.getReader();
    const fileName = `upload_${row.id.replace("gme_", "")}_${new Date().toISOString().replace(/[:.]/g, "-")}.part`;
    const CHUNK = 128 * 1024; // raw bytes per WS chunk (~171 KB base64)
    let offset = 0;
    let buffer = Buffer.alloc(0);
    let total = 0;
    const send = async (data: Buffer, at: number, final: boolean): Promise<number> => {
      const res = await hub.request(row.server_id, "game.files.upload", {
        containerId,
        path,
        fileName,
        data: data.toString("base64"),
        offset: at,
        final,
      } as never, { timeoutMs: 120_000 }) as { written: number; total: number };
      return res.total;
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
            offset += piece.length;
            total = await send(piece, offset - piece.length, false);
          }
        }
      }
      // Flush the tail (and the final chunk — copies the file into the volume).
      total = await send(buffer, offset, true);
      offset += buffer.length;
    } finally {
      reader.releaseLock();
    }
    if (total === 0) throw errors.badRequest("No data received");
    await this.ctx.audit({ action: "game.file.upload", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { path, bytes: total } });
    return { path, bytes: total };
  }

  async renameFile(id: string, path: string, newName: string): Promise<{ from: string; to: string }> {
    const row = await this.get(id);
    const { hub, containerId } = await this.withContainer(row);
    const result = await hub.request(row.server_id, "game.files.rename", { containerId, path, newName } as never, { timeoutMs: 60_000 }) as { from: string; to: string };
    await this.ctx.audit({ action: "game.files.rename", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { from: result.from, to: result.to } });
    return result;
  }

  /* ── Schedules (cron tasks) ──────────────────────────────────── */

  private toSchedule(row: GameScheduleRow): GameSchedule {
    return {
      id: row.id,
      gameServerId: row.game_server_id,
      name: row.name,
      cron: row.cron,
      command: row.command,
      enabled: !!row.enabled,
      onlyOnline: !!row.only_online,
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listSchedules(gameServerId: string): Promise<GameSchedule[]> {
    await this.get(gameServerId);
    const rows = await this.db.all<GameScheduleRow>(`SELECT * FROM game_schedules WHERE game_server_id = ? ORDER BY created_at DESC`, [gameServerId]);
    return rows.map((r) => this.toSchedule(r));
  }

  async createSchedule(gameServerId: string, input: { name: string; cron: string; command: string; enabled?: boolean; onlyOnline?: boolean }): Promise<GameSchedule> {
    const row = await this.get(gameServerId);
    const parsed = parseCron(input.cron);
    if (!parsed) throw errors.validation({ cron: "Invalid cron expression — expected 5 fields (minute hour day month weekday)" });
    const id = newId("gsc");
    const now = new Date().toISOString();
    const enabled = input.enabled ?? true;
    const next = enabled ? nextRun(parsed, new Date()) : null;
    await this.db.run(
      `INSERT INTO game_schedules (id, game_server_id, name, cron, command, enabled, only_online, last_run_at, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [id, gameServerId, input.name.trim(), input.cron.trim(), input.command.trim(), enabled ? 1 : 0, input.onlyOnline ? 1 : 0, next ? next.toISOString() : null, now, now],
    );
    await this.ctx.audit({ action: "game.schedule.create", resourceType: "game-server", resourceId: gameServerId, resourceName: row.name, serverId: row.server_id, metadata: { scheduleId: id, cron: input.cron } });
    return this.toSchedule((await this.db.get<GameScheduleRow>(`SELECT * FROM game_schedules WHERE id = ?`, [id]))!);
  }

  async updateSchedule(scheduleId: string, input: { name?: string; cron?: string; command?: string; enabled?: boolean; onlyOnline?: boolean }): Promise<GameSchedule> {
    const sched = await this.db.get<GameScheduleRow>(`SELECT * FROM game_schedules WHERE id = ?`, [scheduleId]);
    if (!sched) throw errors.notFound("Schedule not found");
    const game = await this.get(sched.game_server_id);
    const cron = (input.cron ?? sched.cron).trim();
    const parsed = parseCron(cron);
    if (!parsed) throw errors.validation({ cron: "Invalid cron expression — expected 5 fields (minute hour day month weekday)" });
    const enabled = input.enabled ?? !!sched.enabled;
    const next = enabled ? nextRun(parsed, new Date()) : null;
    await this.db.run(
      `UPDATE game_schedules SET name = ?, cron = ?, command = ?, enabled = ?, only_online = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      [(input.name ?? sched.name).trim(), cron, (input.command ?? sched.command).trim(), enabled ? 1 : 0, (input.onlyOnline ?? !!sched.only_online) ? 1 : 0, next ? next.toISOString() : null, new Date().toISOString(), scheduleId],
    );
    await this.ctx.audit({ action: "game.schedule.update", resourceType: "game-server", resourceId: sched.game_server_id, resourceName: game.name, serverId: game.server_id, metadata: { scheduleId } });
    return this.toSchedule((await this.db.get<GameScheduleRow>(`SELECT * FROM game_schedules WHERE id = ?`, [scheduleId]))!);
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    const sched = await this.db.get<GameScheduleRow>(`SELECT * FROM game_schedules WHERE id = ?`, [scheduleId]);
    if (!sched) throw errors.notFound("Schedule not found");
    const game = await this.get(sched.game_server_id);
    await this.db.run(`DELETE FROM game_schedules WHERE id = ?`, [scheduleId]);
    await this.ctx.audit({ action: "game.schedule.delete", resourceType: "game-server", resourceId: sched.game_server_id, resourceName: game.name, serverId: game.server_id, metadata: { scheduleId } });
  }

  /** Run a schedule's command immediately (console/shell command in the container). */
  async runScheduleNow(scheduleId: string): Promise<{ ran: boolean; message: string }> {
    const sched = await this.db.get<GameScheduleRow>(`SELECT * FROM game_schedules WHERE id = ?`, [scheduleId]);
    if (!sched) throw errors.notFound("Schedule not found");
    const game = await this.get(sched.game_server_id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(game.server_id)) throw errors.serverOffline();
    const now = new Date().toISOString();
    const running = game.status === "RUNNING" && !!game.container_id;
    if (!running && sched.only_online) {
      throw errors.conflict("Schedule only runs when the server is online — start the server first");
    }
    let message = "";
    if (running && sched.command) {
      try {
        const res = await hub.request(game.server_id, "container.exec", {
          id: game.container_id,
          cmd: ["sh", "-c", sched.command],
          timeoutMs: 30000,
        }) as { output: string; exitCode: number };
        message = res.exitCode === 0 ? "executed" : `exit ${res.exitCode}: ${res.output.slice(0, 200)}`;
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
    } else {
      message = "server offline — command skipped";
    }
    const parsed = parseCron(sched.cron);
    const next = parsed ? nextRun(parsed, new Date()) : null;
    await this.db.run(`UPDATE game_schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`, [now, next ? next.toISOString() : null, now, scheduleId]);
    await this.ctx.audit({ action: "game.schedule.run", resourceType: "game-server", resourceId: sched.game_server_id, resourceName: game.name, serverId: game.server_id, metadata: { scheduleId, message } });
    return { ran: running && !!sched.command, message };
  }

  /** Scheduler tick — fire due schedules. Returns the number of schedules run. */
  async runDueSchedules(): Promise<number> {
    const now = new Date();
    const rows = await this.db.all<GameScheduleRow>(
      `SELECT * FROM game_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
      [now.toISOString()],
    );
    let ran = 0;
    for (const sched of rows) {
      try {
        await this.runScheduleNow(sched.id);
        ran++;
      } catch {
        // Keep the schedule enabled; next tick will retry.
        const parsed = parseCron(sched.cron);
        const next = parsed ? nextRun(parsed, new Date()) : null;
        await this.db.run(`UPDATE game_schedules SET next_run_at = ?, updated_at = ? WHERE id = ?`, [next ? next.toISOString() : null, new Date().toISOString(), sched.id]);
      }
    }
    return ran;
  }

  /* ── Backups (volume snapshots) ──────────────────────────────── */

  private toBackup(r: BackupRow): Backup {
    return {
      id: r.id,
      databaseId: r.database_id,
      applicationId: r.application_id,
      gameServerId: r.game_server_id,
      serverId: r.server_id,
      type: r.type as Backup["type"],
      status: r.status as Backup["status"],
      sizeBytes: r.size_bytes,
      path: r.path,
      error: r.error,
      sha1: r.sha1,
      locked: !!r.locked,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      createdAt: r.created_at,
    };
  }

  async createBackup(gameServerId: string): Promise<Backup> {
    const row = await this.get(gameServerId);
    if (!row.volume_name) throw errors.conflict("This game server has no persistent volume — nothing to back up");
    const id = newId("bak");
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO backups (id, database_id, application_id, game_server_id, server_id, type, status, created_at) VALUES (?, NULL, NULL, ?, ?, 'VOLUME', 'PENDING', ?)`,
      [id, gameServerId, row.server_id, now],
    );
    const queue = new JobQueue(this.db);
    await queue.enqueue("game-backup", { backupId: id, gameServerId });
    await this.ctx.audit({ action: "backup.create", resourceType: "backup", resourceId: id, resourceName: row.name, serverId: row.server_id });
    await this.ctx.notify("database.backup.started", "Backup started", `Backing up the volume of ${row.name}…`);
    return this.getBackup(id);
  }

  /** Job handler — snapshots the game server's volume via the agent. */
  async runBackup(job: { payload: unknown }): Promise<void> {
    const payload = job.payload as { backupId: string; gameServerId: string };
    const backup = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [payload.backupId]);
    if (!backup) return;
    const game = await this.get(payload.gameServerId);
    if (!game.volume_name) throw new Error("Game server has no volume to back up");
    const hub = this.ctx.hub;
    if (!hub.isOnline(game.server_id)) throw Object.assign(new Error("Server offline — backup will retry"), { retryable: true });

    await this.db.run(`UPDATE backups SET status = 'RUNNING', started_at = ? WHERE id = ?`, [new Date().toISOString(), backup.id]);
    try {
      const fileName = `${game.id}_${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`;
      const result = await hub.request(game.server_id, "volume.backup", {
        backupId: backup.id,
        applicationId: game.id,
        volumeName: game.volume_name,
        fileName,
      } as never, { timeoutMs: 15 * 60 * 1000 }) as { path: string; sizeBytes: number; sha1?: string };
      await this.db.run(
        `UPDATE backups SET status = 'SUCCESS', path = ?, size_bytes = ?, sha1 = ?, finished_at = ? WHERE id = ?`,
        [result.path, result.sizeBytes, result.sha1 ?? null, new Date().toISOString(), backup.id],
      );
      const owner = await this.db.get<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`);
      if (owner) {
        const { NotificationsService } = await import("./notifications.service");
        await new NotificationsService(this.db).create(owner.id, "database.backup.completed", "Backup completed", `Volume backup for ${game.name} completed (${Math.round(result.sizeBytes / 1024)} KB)`);
      }
    } catch (err) {
      await this.db.run(`UPDATE backups SET status = 'FAILED', error = ?, finished_at = ? WHERE id = ?`, [
        err instanceof Error ? err.message : String(err),
        new Date().toISOString(),
        backup.id,
      ]);
      throw err;
    }
  }

  /** Restore a volume snapshot — container is stopped and restarted around it. */
  async restoreBackup(backupId: string): Promise<void> {
    const backup = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [backupId]);
    if (!backup) throw errors.notFound("Backup not found");
    if (backup.status !== "SUCCESS" || !backup.path) throw errors.conflict("Only completed backups can be restored");
    if (!backup.game_server_id) throw errors.conflict("This backup is not attached to a game server");
    const game = await this.get(backup.game_server_id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(game.server_id)) throw errors.serverOffline();

    const wasRunning = !!game.container_id && game.status === "RUNNING";
    try {
      if (wasRunning && game.container_id) {
        await hub.request(game.server_id, "container.stop", { id: game.container_id, timeoutSeconds: 15 });
        await this.db.run(`UPDATE game_servers SET status = 'STOPPED', updated_at = ? WHERE id = ?`, [new Date().toISOString(), game.id]);
      }
      await hub.request(game.server_id, "volume.restore", {
        backupId: backup.id,
        applicationId: game.id,
        volumeName: game.volume_name ?? `nexus-game-${game.id.replace("gme_", "")}`,
        filePath: backup.path,
      } as never, { timeoutMs: 15 * 60 * 1000 });
      if (wasRunning && game.container_id) {
        await hub.request(game.server_id, "container.start", { id: game.container_id });
        await this.db.run(`UPDATE game_servers SET status = 'RUNNING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), game.id]);
      }
    } catch (err) {
      if (wasRunning && game.container_id) {
        await hub.request(game.server_id, "container.start", { id: game.container_id }).catch(() => {});
        await this.db.run(`UPDATE game_servers SET status = 'RUNNING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), game.id]).catch(() => {});
      }
      throw err;
    }

    await this.ctx.audit({ action: "backup.restore", resourceType: "backup", resourceId: backupId, resourceName: game.name, serverId: game.server_id, metadata: { stoppedAndRestarted: wasRunning } });
    await this.ctx.notify("backup.restored", "Backup restored", `${game.name} was restored from backup ${backupId.slice(-8)}.`);
  }

  async listBackups(gameServerId: string): Promise<Backup[]> {
    await this.get(gameServerId);
    const rows = await this.db.all<BackupRow>(`SELECT * FROM backups WHERE game_server_id = ? ORDER BY created_at DESC`, [gameServerId]);
    return rows.map((r) => this.toBackup(r));
  }

  async getBackup(id: string): Promise<Backup> {
    const row = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Backup not found");
    return this.toBackup(row);
  }

  async deleteBackup(backupId: string): Promise<void> {
    const row = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [backupId]);
    if (!row) throw errors.notFound("Backup not found");
    if (row.locked) throw errors.conflict("Backup is locked — unlock it before deleting");
    if (row.path && row.server_id) {
      const hub = this.ctx.hub;
      if (hub.isOnline(row.server_id)) {
        await hub.request(row.server_id, "file.remove", { path: row.path }).catch(() => {});
      }
    }
    await this.db.run(`DELETE FROM backups WHERE id = ?`, [backupId]);
    await this.ctx.audit({ action: "backup.delete", resourceType: "backup", resourceId: backupId, serverId: row.server_id });
  }

  async setBackupLocked(backupId: string, locked: boolean): Promise<Backup> {
    const row = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [backupId]);
    if (!row) throw errors.notFound("Backup not found");
    await this.db.run(`UPDATE backups SET locked = ? WHERE id = ?`, [locked ? 1 : 0, backupId]);
    await this.ctx.audit({ action: locked ? "backup.lock" : "backup.unlock", resourceType: "backup", resourceId: backupId, serverId: row.server_id });
    return this.getBackup(backupId);
  }

  /* ── Network allocations ─────────────────────────────────────── */

  private toAllocation(row: GameAllocationRow): GameAllocation {
    return {
      id: row.id,
      gameServerId: row.game_server_id,
      ip: row.ip,
      port: row.port,
      notes: row.notes,
      isPrimary: !!row.is_primary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listAllocations(gameServerId: string): Promise<GameAllocation[]> {
    await this.get(gameServerId);
    const rows = await this.db.all<GameAllocationRow>(`SELECT * FROM game_allocations WHERE game_server_id = ? ORDER BY is_primary DESC, created_at ASC`, [gameServerId]);
    return rows.map((r) => this.toAllocation(r));
  }

  /** Create a new allocation (IP + port) for the game server. */
  async createAllocation(gameServerId: string, input: { ip: string; port: number; notes?: string }): Promise<GameAllocation[]> {
    const game = await this.get(gameServerId);
    const ip = input.ip.trim();
    const port = Math.floor(input.port);
    if (!ip) throw errors.validation({ ip: "IP address is required" });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw errors.validation({ port: "Port must be between 1 and 65535" });
    const existing = await this.db.get<GameAllocationRow>(
      `SELECT id FROM game_allocations WHERE game_server_id = ? AND ip = ? AND port = ?`,
      [gameServerId, ip, port],
    );
    if (existing) throw errors.conflict(`Allocation ${ip}:${port} already exists`);

    const now = new Date().toISOString();
    const isFirst = !(await this.db.get(`SELECT id FROM game_allocations WHERE game_server_id = ? LIMIT 1`, [gameServerId]));
    const id = newId("gma");
    await this.db.run(
      `INSERT INTO game_allocations (id, game_server_id, ip, port, notes, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, gameServerId, ip, port, input.notes?.trim() || null, isFirst ? 1 : 0, now, now],
    );
    await this.ctx.audit({ action: "game.allocation.create", resourceType: "game-server", resourceId: gameServerId, resourceName: game.name, serverId: game.server_id, metadata: { allocationId: id, ip, port, isFirst } });
    return this.listAllocations(gameServerId);
  }

  /** Remove an allocation — refuse if it is the only one or the primary. */
  async removeAllocation(allocationId: string): Promise<GameAllocation[]> {
    const row = await this.db.get<GameAllocationRow>(`SELECT * FROM game_allocations WHERE id = ?`, [allocationId]);
    if (!row) throw errors.notFound("Allocation not found");
    const total = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM game_allocations WHERE game_server_id = ?`, [row.game_server_id]);
    if ((total?.n ?? 0) <= 1) throw errors.conflict("Cannot remove the last allocation — a game server needs at least one");
    if (row.is_primary) throw errors.conflict("The primary allocation is the one the container binds — set another allocation as primary first");
    await this.db.run(`DELETE FROM game_allocations WHERE id = ?`, [allocationId]);
    const game = await this.get(row.game_server_id);
    await this.ctx.audit({ action: "game.allocation.delete", resourceType: "game-server", resourceId: row.game_server_id, resourceName: game.name, serverId: game.server_id, metadata: { allocationId, ip: row.ip, port: row.port } });
    return this.listAllocations(row.game_server_id);
  }

  async updateAllocationNotes(allocationId: string, notes: string): Promise<GameAllocation> {
    const row = await this.db.get<GameAllocationRow>(`SELECT * FROM game_allocations WHERE id = ?`, [allocationId]);
    if (!row) throw errors.notFound("Allocation not found");
    await this.db.run(`UPDATE game_allocations SET notes = ?, updated_at = ? WHERE id = ?`, [notes.trim() || null, new Date().toISOString(), allocationId]);
    const game = await this.get(row.game_server_id);
    await this.ctx.audit({ action: "game.allocation.update", resourceType: "game-server", resourceId: row.game_server_id, resourceName: game.name, serverId: game.server_id, metadata: { allocationId } });
    return this.toAllocation((await this.db.get<GameAllocationRow>(`SELECT * FROM game_allocations WHERE id = ?`, [allocationId]))!);
  }

  async setPrimaryAllocation(gameServerId: string, allocationId: string): Promise<GameAllocation[]> {
    const game = await this.get(gameServerId);
    const row = await this.db.get<GameAllocationRow>(`SELECT * FROM game_allocations WHERE id = ? AND game_server_id = ?`, [allocationId, gameServerId]);
    if (!row) throw errors.notFound("Allocation not found");
    const oldPort = game.port;
    const newPort = row.port;
    await this.db.run(`UPDATE game_allocations SET is_primary = 0, updated_at = ? WHERE game_server_id = ?`, [new Date().toISOString(), gameServerId]);
    await this.db.run(`UPDATE game_allocations SET is_primary = 1, updated_at = ? WHERE id = ?`, [new Date().toISOString(), allocationId]);

    // A primary allocation is what the container actually binds — if the port
    // changed, update the server record and recreate the container so the
    // published port really moves (Pterodactyl behaviour).
    let recreated = false;
    if (newPort !== oldPort) {
      await this.db.run(`UPDATE game_servers SET port = ?, updated_at = ? WHERE id = ?`, [newPort, new Date().toISOString(), gameServerId]);
      const hub = this.ctx.hub;
      if (hub.isOnline(game.server_id) && game.container_id) {
        try {
          const containerName = `nexus-game-${game.id.replace("gme_", "")}`;
          await hub.request(game.server_id, "container.remove", { id: game.container_id, force: true, volumes: false }).catch(() => {});
          const result = await hub.request(game.server_id, "game.create", {
            gameServerId: game.id,
            image: game.image,
            containerName,
            port: newPort,
            memoryBytes: game.memory_bytes,
            cpuLimit: game.cpu_limit,
            env: ensureRcon(parseEnv(game.environment)),
            volumeName: game.volume_name ?? containerName,
            restartPolicy: "unless-stopped",
            labels: {},
          } as never, { timeoutMs: 10 * 60 * 1000 }) as { containerId: string };
          await this.db.run(`UPDATE game_servers SET container_id = ?, status = 'RUNNING', updated_at = ? WHERE id = ?`, [result.containerId, new Date().toISOString(), gameServerId]);
          recreated = true;
        } catch {
          recreated = false;
        }
      }
    }

    await this.ctx.audit({ action: "game.allocation.primary", resourceType: "game-server", resourceId: gameServerId, resourceName: game.name, serverId: game.server_id, metadata: { allocationId, oldPort, newPort, recreated } });
    return this.listAllocations(gameServerId);
  }

  /* ── Sub-users (Pterodactyl-style access control) ────────────── */

  async grantUser(gameServerId: string, userId: string, permissions: string[]): Promise<{ id: string; userId: string; permissions: string[]; createdAt: string }> {
    const game = await this.get(gameServerId);
    const user = await this.db.get<{ id: string; role: string; name: string }>(`SELECT id, role, name FROM users WHERE id = ?`, [userId]);
    if (!user) throw errors.notFound("User not found");
    if (user.role === "owner") throw errors.validation({ userId: "The owner always has full access — no grant needed" });
    const perms = normalizeGamePerms(permissions);
    const existing = await this.db.get(`SELECT id FROM game_server_users WHERE game_server_id = ? AND user_id = ?`, [gameServerId, userId]);
    if (existing) throw errors.conflict("This user already has access to the game server");
    const id = newId("gsu");
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO game_server_users (id, game_server_id, user_id, permissions, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id, gameServerId, userId, JSON.stringify(perms), now],
    );
    await this.ctx.audit({ action: "game.user.grant", resourceType: "game-server", resourceId: gameServerId, resourceName: game.name, serverId: game.server_id, metadata: { userId, permissions: perms } });
    return { id, userId, permissions: perms, createdAt: now };
  }

  async updateUserPermissions(grantId: string, permissions: string[]): Promise<{ id: string; userId: string; permissions: string[]; createdAt: string }> {
    const row = await this.db.get<{ id: string; game_server_id: string; user_id: string; created_at: string }>(`SELECT * FROM game_server_users WHERE id = ?`, [grantId]);
    if (!row) throw errors.notFound("Grant not found");
    const perms = normalizeGamePerms(permissions);
    await this.db.run(`UPDATE game_server_users SET permissions = ? WHERE id = ?`, [JSON.stringify(perms), grantId]);
    const game = await this.get(row.game_server_id);
    await this.ctx.audit({ action: "game.user.update", resourceType: "game-server", resourceId: row.game_server_id, resourceName: game.name, serverId: game.server_id, metadata: { grantId, permissions: perms } });
    return { id: row.id, userId: row.user_id, permissions: perms, createdAt: row.created_at };
  }

  async revokeUser(gameServerId: string, userId: string): Promise<void> {
    const game = await this.get(gameServerId);
    await this.db.run(`DELETE FROM game_server_users WHERE game_server_id = ? AND user_id = ?`, [gameServerId, userId]);
    await this.ctx.audit({ action: "game.user.revoke", resourceType: "game-server", resourceId: gameServerId, resourceName: game.name, serverId: game.server_id, metadata: { userId } });
  }

  async listUsers(gameServerId: string): Promise<{
    items: { id: string; userId: string; name: string; email: string; role: string; permissions: string[]; createdAt: string }[];
    available: { id: string; name: string; email: string; role: string }[];
  }> {
    await this.get(gameServerId);
    const rows = await this.db.all<{ id: string; user_id: string; name: string; email: string; role: string; permissions: string; created_at: string }>(
      `SELECT gu.id, gu.user_id, u.name, u.email, u.role, gu.permissions, gu.created_at
       FROM game_server_users gu JOIN users u ON u.id = gu.user_id
       WHERE gu.game_server_id = ? ORDER BY gu.created_at ASC`,
      [gameServerId],
    );
    const available = await this.db.all<{ id: string; name: string; email: string; role: string }>(
      `SELECT id, name, email, role FROM users
       WHERE role != 'owner' AND id NOT IN (SELECT user_id FROM game_server_users WHERE game_server_id = ?)
       ORDER BY name ASC`,
      [gameServerId],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        name: r.name,
        email: r.email,
        role: r.role,
        permissions: safeGamePerms(r.permissions),
        createdAt: r.created_at,
      })),
      available,
    };
  }

  /** Grant check used by route middleware for non-admin users. */
  async userHasGamePerm(gameServerId: string, userId: string, perm?: string): Promise<boolean> {
    const row = await this.db.get<{ permissions: string }>(
      `SELECT permissions FROM game_server_users WHERE game_server_id = ? AND user_id = ?`,
      [gameServerId, userId],
    );
    if (!row) return false;
    if (!perm) return true;
    const perms = safeGamePerms(row.permissions);
    return perms.includes(perm) || perms.includes("*");
  }

  /* ── Startup ─────────────────────────────────────────────────── */

  /** Compose a human-readable startup command from the env (cosmetic, Pterodactyl-style). */
  private startupCommand(env: Record<string, string>, port: number): string {
    const mem = env.MEMORY ?? "1024M";
    const jar = env.SERVER_JAR ?? "server.jar";
    const flags = ["-Xms128M", `-Xmx${mem}`, "-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200", "-jar", jar, "nogui"].join(" ");
    return `java ${flags}`;
  }

  async getStartup(id: string): Promise<{
    image: string;
    images: string[];
    environment: Record<string, string>;
    command: string;
  }> {
    const row = await this.get(id);
    const env = row.environment ? (JSON.parse(row.environment) as Record<string, string>) : {};
    const images = GAME_IMAGES[row.game as keyof typeof GAME_IMAGES]?.versions ?? [];
    return { image: row.image, images, environment: env, command: this.startupCommand(env, row.port) };
  }

  /** Update the image / environment and re-create the container (volume preserved). */
  async updateStartup(id: string, input: { image?: string; environment?: Record<string, string> }): Promise<{ gameServer: GameServer; applied: boolean }> {
    const row = await this.get(id);
    const env = parseEnv(row.environment);
    const nextEnv = ensureRcon({ ...env, ...(input.environment ?? {}) });
    const image = input.image?.trim() || row.image;
    const def = GAME_IMAGES[row.game as keyof typeof GAME_IMAGES];
    if (def && !def.versions.includes(image) && !image.includes(":")) {
      throw errors.validation({ image: `Image must be one of: ${def.versions.join(", ")} or a full image tag` });
    }
    await this.db.run(`UPDATE game_servers SET image = ?, environment = ?, updated_at = ? WHERE id = ?`, [image, JSON.stringify(nextEnv), new Date().toISOString(), id]);

    // Recreate the container with the new settings (same volume, same port).
    const hub = this.ctx.hub;
    const containerName = `nexus-game-${row.id.replace("gme_", "")}`;
    let applied = false;
    if (hub.isOnline(row.server_id)) {
      try {
        if (row.container_id) {
          await hub.request(row.server_id, "container.remove", { id: row.container_id, force: true, volumes: false }).catch(() => {});
        }
        const result = await hub.request(row.server_id, "game.create", {
          gameServerId: row.id,
          image,
          containerName,
          port: row.port,
          memoryBytes: row.memory_bytes,
          cpuLimit: row.cpu_limit,
          env: nextEnv,
          volumeName: row.volume_name ?? containerName,
          restartPolicy: "unless-stopped",
          labels: {},
        } as never, { timeoutMs: 10 * 60 * 1000 }) as { containerId: string };
        await this.db.run(`UPDATE game_servers SET container_id = ?, status = 'RUNNING', updated_at = ? WHERE id = ?`, [result.containerId, new Date().toISOString(), id]);
        applied = true;
      } catch {
        applied = false;
      }
    }
    await this.ctx.audit({ action: "game.startup.update", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { image, applied } });
    return { gameServer: await this.getPublic(id), applied };
  }
}
