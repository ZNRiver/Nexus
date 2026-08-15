import type { DbConnection, GameServerRow, JobRow, ServerRow } from "@nexus/database";
import { newId } from "../lib/crypto";
import { errors } from "../lib/errors";
import type { CreateGameServerInput, GameServer, GameServerStatus, MinecraftFlavor } from "@nexus/types";
import type { AppContext } from "../context";
import { JobQueue } from "../jobs/queue";
import { eventHub } from "../lib/events";

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

  async list(opts: { serverId?: string; limit: number; cursor?: string }): Promise<{ items: GameServer[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.serverId) {
      where.push("server_id = ?");
      params.push(opts.serverId);
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
      ...(input.environment ?? {}),
    };

    const id = newId("gme");
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO game_servers (id, server_id, project_id, name, game, version, flavor, image, port, memory_bytes, cpu_limit, storage_bytes, environment, status, container_id, volume_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', NULL, ?, ?, ?)`,
      [id, input.serverId, input.projectId ?? null, name, game, version, flavor, image, port, memoryBytes, cpuLimit, storageBytes, JSON.stringify(environment), `nexus-game-${id.replace("gme_", "")}`, now, now],
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

    const environment = row.environment ? (JSON.parse(row.environment) as Record<string, string>) : {};
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

  /** Run a command inside the game server container (console). */
  async exec(id: string, cmd: string[]): Promise<{ output: string; exitCode: number }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.container_id) throw errors.conflict("Game server container is not running");
    const result = await hub.request(row.server_id, "container.exec", {
      id: row.container_id,
      cmd,
      timeoutMs: 30000,
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
    await this.db.run(`DELETE FROM game_servers WHERE id = ?`, [id]);
    await this.ctx.audit({ action: "game.delete", resourceType: "game-server", resourceId: id, resourceName: row.name, serverId: row.server_id });
  }
}
