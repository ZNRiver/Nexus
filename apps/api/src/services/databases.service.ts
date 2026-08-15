import type { BackupRow, DatabaseCredentialRow, DatabaseRow, DbConnection, JobRow, ServerRow } from "@nexus/database";
import { decrypt, encrypt, newId, newToken } from "../lib/crypto";
import { errors } from "../lib/errors";
import type { Backup, CreateDatabaseInput, Database, DatabaseConnectionInfo, DatabaseStatus, DatabaseType } from "@nexus/types";
import type { AppContext } from "../context";
import { JobQueue } from "../jobs/queue";
import { eventHub } from "../lib/events";
import { nextRun, parseCron } from "../lib/cron";

export const DATABASE_IMAGES: Record<DatabaseType, { default: string; versions: string[]; internalPort: number; env: (user: string, pass: string, db: string) => Record<string, string>; volumePath: string }> = {
  POSTGRESQL: {
    default: "postgres:17",
    versions: ["17", "16", "15", "14", "13"],
    internalPort: 5432,
    env: (u, p, d) => ({ POSTGRES_USER: u, POSTGRES_PASSWORD: p, POSTGRES_DB: d }),
    volumePath: "/var/lib/postgresql/data",
  },
  MYSQL: {
    default: "mysql:8",
    versions: ["8.4", "8.0", "5.7"],
    internalPort: 3306,
    env: (u, p, d) => ({ MYSQL_ROOT_PASSWORD: p, MYSQL_DATABASE: d, MYSQL_USER: u, MYSQL_PASSWORD: p }),
    volumePath: "/var/lib/mysql",
  },
  MARIADB: {
    default: "mariadb:11",
    versions: ["11", "10.11", "10.6"],
    internalPort: 3306,
    env: (u, p, d) => ({ MARIADB_ROOT_PASSWORD: p, MARIADB_DATABASE: d, MARIADB_USER: u, MARIADB_PASSWORD: p }),
    volumePath: "/var/lib/mysql",
  },
  REDIS: {
    default: "redis:7",
    versions: ["7", "6.2", "5"],
    internalPort: 6379,
    env: () => ({}),
    volumePath: "/data",
  },
  MONGODB: {
    default: "mongo:8",
    versions: ["8", "7", "6"],
    internalPort: 27017,
    env: (u, p) => ({ MONGO_INITDB_ROOT_USERNAME: u, MONGO_INITDB_ROOT_PASSWORD: p }),
    volumePath: "/data/db",
  },
  INFLUXDB: {
    default: "influxdb:2.7",
    versions: ["2.7", "2.6", "1.8"],
    internalPort: 8086,
    env: (u, p, d) => ({
      INFLUXDB_DB: d,
      INFLUXDB_USERNAME: u,
      INFLUXDB_PASSWORD: p,
      INFLUXDB_ADMIN_USER: u,
      INFLUXDB_ADMIN_PASSWORD: p,
    }),
    volumePath: "/var/lib/influxdb2",
  },
};

export function toDatabase(row: DatabaseRow): Database {
  return {
    id: row.id,
    projectId: row.project_id,
    serverId: row.server_id,
    type: row.type as DatabaseType,
    version: row.version,
    name: row.name,
    description: row.description,
    dbName: row.db_name ?? row.name,
    username: row.username,
    port: row.port,
    internalPort: row.internal_port,
    status: row.status as DatabaseStatus,
    image: row.image,
    containerId: row.container_id,
    volumeName: row.volume_name,
    storageLimitBytes: row.storage_limit_bytes,
    maxConnections: row.max_connections,
    cpuLimit: row.cpu_limit,
    memoryLimitBytes: row.memory_limit_bytes,
    backupSchedule: {
      enabled: !!row.backup_schedule_enabled,
      cron: row.backup_schedule_cron ?? "0 2 * * *",
      retention: row.backup_retention ?? 7,
      nextRunAt: row.backup_next_run_at ?? null,
      lastRunAt: row.backup_last_run_at ?? null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DatabasesService {
  constructor(
    private readonly db: DbConnection,
    private readonly ctx: AppContext,
  ) {}

  async list(opts: { serverId?: string; projectId?: string; limit: number; cursor?: string }): Promise<{ items: Database[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.serverId) {
      where.push("server_id = ?");
      params.push(opts.serverId);
    }
    if (opts.projectId) {
      where.push("project_id = ?");
      params.push(opts.projectId);
    }
    if (opts.cursor) {
      where.push("created_at <= ?");
      params.push(opts.cursor);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await this.db.all<DatabaseRow>(
      `SELECT * FROM databases ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, opts.limit + 1],
    );
    const hasMore = rows.length > opts.limit;
    const items = rows.slice(0, opts.limit).map(toDatabase);
    return { items, nextCursor: hasMore ? items[items.length - 1]?.createdAt ?? null : null };
  }

  async get(id: string): Promise<DatabaseRow> {
    const row = await this.db.get<DatabaseRow>(`SELECT * FROM databases WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Database not found");
    return row;
  }

  async getPublic(id: string): Promise<Database> {
    return toDatabase(await this.get(id));
  }

  async create(input: CreateDatabaseInput): Promise<Database> {
    const server = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [input.serverId]);
    if (!server) throw errors.notFound("Server not found");

    const type = input.type as DatabaseType;
    const def = DATABASE_IMAGES[type];
    if (!def) throw errors.validation({ type: "Unsupported database type" });
    // Accept either "17" or "postgres:17" — always prefix with the type's image name.
    const version = input.version ?? def.default;
    const imageName = version.includes(":") ? version : `${def.default.split(":")[0]}:${version}`;

    const name = input.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!name || name.length < 2) throw errors.validation({ name: "Database name must be at least 2 characters (lowercase alphanumeric)" });

    const username = input.username?.trim() || (type === "REDIS" ? "" : name.slice(0, 16));
    const password = input.password && input.password.length >= 8 ? input.password : newToken(16);
    const port = input.port ?? def.internalPort;

    const id = newId("db");
    const now = new Date().toISOString();
    const dbName = input.dbName?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || name;
    const row: DatabaseRow = {
      id,
      project_id: input.projectId ?? null,
      server_id: input.serverId,
      type,
      version: imageName,
      name,
      description: input.description?.trim() || null,
      db_name: dbName,
      username: username || null,
      password_encrypted: encrypt(password, this.ctx.config.encryptionKey),
      port,
      internal_port: def.internalPort,
      status: "CREATING",
      image: imageName,
      container_id: null,
      volume_name: `nexus-db-${id.replace("db_", "")}`,
      storage_limit_bytes: input.storageLimitBytes ?? null,
      max_connections: input.maxConnections ?? null,
      cpu_limit: input.cpuLimit ?? null,
      memory_limit_bytes: input.memoryLimitBytes ?? null,
      backup_schedule_enabled: false,
      backup_schedule_cron: null,
      backup_retention: 7,
      backup_next_run_at: null,
      backup_last_run_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.run(
      `INSERT INTO databases (id, project_id, server_id, type, version, name, description, db_name, username, password_encrypted, port, internal_port, status, image, container_id, volume_name, storage_limit_bytes, max_connections, cpu_limit, memory_limit_bytes, backup_schedule_enabled, backup_schedule_cron, backup_retention, backup_next_run_at, backup_last_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.project_id, row.server_id, row.type, row.version, row.name, row.description, row.db_name, row.username, row.password_encrypted, row.port, row.internal_port, row.status, row.image, row.container_id, row.volume_name, row.storage_limit_bytes, row.max_connections, row.cpu_limit, row.memory_limit_bytes, row.backup_schedule_enabled, row.backup_schedule_cron, row.backup_retention, row.backup_next_run_at, row.backup_last_run_at, row.created_at, row.updated_at],
    );
    await this.db.run(
      `INSERT INTO database_credentials (id, database_id, username, password_encrypted, created_at) VALUES (?, ?, ?, ?, ?)`,
      [newId("dbc"), id, username || "root", encrypt(password, this.ctx.config.encryptionKey), now],
    );

    const queue = new JobQueue(this.db);
    await queue.enqueue("database-create", { databaseId: id });

    await this.ctx.audit({ action: "database.create", resourceType: "database", resourceId: id, resourceName: name, serverId: input.serverId });
    await this.ctx.notify("database.created", "Database created", `${name} (${type}) was created — starting the container…`);
    return toDatabase(row);
  }

  /** Run the database container on the target server with the row's current settings. */
  private async ensureContainer(row: DatabaseRow): Promise<string> {
    const hub = this.ctx.hub;
    const password = row.password_encrypted ? decrypt(row.password_encrypted, this.ctx.config.encryptionKey) : "";
    const def = DATABASE_IMAGES[row.type as DatabaseType];
    const dbName = row.db_name ?? row.name;
    const env = def.env(row.username ?? "root", password, dbName);
    const containerName = `nexus-db-${row.id.replace("db_", "")}`;
    const requestedPort = row.port ?? def.internalPort;
    // The requested host port may already be taken on the target (e.g. a
    // local PostgreSQL listening on 5432). Walk up the port range until the
    // container binds successfully, and persist the chosen port.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      const hostPort = requestedPort + attempt;
      try {
        const result = await hub.request(row.server_id, "database.create", {
          databaseId: row.id,
          containerName,
          image: row.image,
          hostPort,
          internalPort: row.internal_port,
          volumeName: row.volume_name ?? containerName,
          volumePath: def.volumePath,
          memoryBytes: row.memory_limit_bytes,
          cpuLimit: row.cpu_limit,
          env,
          labels: {},
        } as never, { timeoutMs: 5 * 60 * 1000 }) as { containerId: string };
        if (hostPort !== requestedPort) {
          await this.db.run(`UPDATE databases SET port = ?, updated_at = ? WHERE id = ?`, [hostPort, new Date().toISOString(), row.id]);
        }
        return result.containerId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Only retry when the port itself is the problem.
        if (!/port is already allocated|address already in use|bind.*failed/i.test(msg)) {
          throw err;
        }
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Could not find a free port for the database container");
  }

  /** Job handler — actually runs the database container on the target server. */
  async runDatabaseCreate(job: JobRow): Promise<void> {
    const payload = job.payload as unknown as { databaseId: string };
    const row = await this.get(payload.databaseId);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) {
      throw Object.assign(new Error("Server is offline — database creation will retry"), { retryable: true });
    }
    try {
      const containerId = await this.ensureContainer(row);
      await this.db.run(`UPDATE databases SET container_id = ?, status = 'RUNNING', updated_at = ? WHERE id = ?`, [
        containerId,
        new Date().toISOString(),
        row.id,
      ]);
    } catch (err) {
      await this.db.run(`UPDATE databases SET status = 'FAILED', updated_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
      throw err;
    }
    const updated = await this.getPublic(row.id);
    eventHub.emit({ type: "database.status", database: updated });
  }

  /** Recreate the container with the current settings (volume preserved). */
  async deploy(id: string): Promise<Database> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();

    if (row.container_id) {
      await hub.request(row.server_id, "container.remove", { id: row.container_id, force: true, volumes: false }).catch(() => {});
    } else {
      const containers = await hub.request(row.server_id, "docker.ps", {}).catch(() => []) as { id: string; labels: Record<string, string> }[];
      const mine = containers.find((c) => c.labels?.["nexus.database"] === row.id);
      if (mine) await hub.request(row.server_id, "container.remove", { id: mine.id, force: true, volumes: false }).catch(() => {});
    }

    try {
      const containerId = await this.ensureContainer(row);
      await this.db.run(`UPDATE databases SET container_id = ?, status = 'RUNNING', updated_at = ? WHERE id = ?`, [
        containerId,
        new Date().toISOString(),
        row.id,
      ]);
    } catch (err) {
      await this.db.run(`UPDATE databases SET status = 'FAILED', updated_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
      throw err;
    }
    const updated = await this.getPublic(row.id);
    eventHub.emit({ type: "database.status", database: updated });
    await this.ctx.audit({ action: "database.deploy", resourceType: "database", resourceId: id, resourceName: row.name, serverId: row.server_id });
    return updated;
  }

  /** Restart the container (Reload). */
  async restart(id: string): Promise<{ id: string }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.container_id) throw errors.conflict("Database container is not running — deploy it first");
    const result = await hub.request(row.server_id, "container.restart", { id: row.container_id }) as { id: string };
    await this.ctx.audit({ action: "database.restart", resourceType: "database", resourceId: id, resourceName: row.name, serverId: row.server_id });
    return result;
  }

  /** Start the container. */
  async start(id: string): Promise<{ id: string }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.container_id) throw errors.conflict("Database container was never deployed");
    const result = await hub.request(row.server_id, "container.start", { id: row.container_id }) as { id: string };
    await this.db.run(`UPDATE databases SET status = 'RUNNING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    const updated = await this.getPublic(id);
    eventHub.emit({ type: "database.status", database: updated });
    await this.ctx.audit({ action: "database.start", resourceType: "database", resourceId: id, resourceName: row.name, serverId: row.server_id });
    return result;
  }

  /** Run a command inside the database container. */
  /* ── Console (run SQL / schema browser) ─────────────────────── */

  async query(id: string, sql: string): Promise<{ columns: string[]; rows: string[][]; truncated: boolean; message?: string }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    const result = await hub.request(row.server_id, "db.query", {
      type: row.type,
      containerId: row.container_id ?? "",
      name: row.db_name ?? row.name,
      username: row.username,
      password: row.password_encrypted ? decrypt(row.password_encrypted, this.ctx.config.encryptionKey) : undefined,
      sql,
    } as never, { timeoutMs: 60 * 1000 }) as { columns: string[]; rows: string[][]; truncated: boolean; message?: string };
    await this.ctx.audit({ action: "database.query", resourceType: "database", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { sql: sql.slice(0, 200) } });
    return result;
  }

  async schema(id: string): Promise<{ tables: { name: string; columns: { name: string; type: string }[] }[]; message?: string }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    const result = await hub.request(row.server_id, "db.schema", {
      type: row.type,
      containerId: row.container_id ?? "",
      name: row.db_name ?? row.name,
      username: row.username,
      password: row.password_encrypted ? decrypt(row.password_encrypted, this.ctx.config.encryptionKey) : undefined,
    } as never, { timeoutMs: 60 * 1000 }) as { tables: { name: string; columns: { name: string; type: string }[] }[]; message?: string };
    await this.ctx.audit({ action: "database.schema.read", resourceType: "database", resourceId: id, resourceName: row.name, serverId: row.server_id });
    return result;
  }

  async objects(id: string): Promise<{
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
  }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    const result = await hub.request(row.server_id, "db.objects", {
      type: row.type,
      containerId: row.container_id ?? "",
      name: row.db_name ?? row.name,
      username: row.username,
      password: row.password_encrypted ? decrypt(row.password_encrypted, this.ctx.config.encryptionKey) : undefined,
    } as never, { timeoutMs: 60 * 1000 }) as {
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
    };
    await this.ctx.audit({ action: "database.objects.read", resourceType: "database", resourceId: id, resourceName: row.name, serverId: row.server_id });
    return result;
  }

  async tableInfo(id: string, table: string): Promise<{
    columns: { name: string; type: string; nullable: boolean; key: string; defaultValue?: string | null }[];
    constraints: { name: string; type: string; definition?: string }[];
    foreignKeys: { name: string; columns: string; references: string }[];
    triggers: { name: string; event: string; timing: string }[];
    indexes: { name: string; columns: string; unique: boolean }[];
    message?: string;
  }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    const result = await hub.request(row.server_id, "db.tableInfo", {
      type: row.type,
      containerId: row.container_id ?? "",
      name: row.db_name ?? row.name,
      table,
      username: row.username,
      password: row.password_encrypted ? decrypt(row.password_encrypted, this.ctx.config.encryptionKey) : undefined,
    } as never, { timeoutMs: 60 * 1000 }) as {
      columns: { name: string; type: string; nullable: boolean; key: string; defaultValue?: string | null }[];
      constraints: { name: string; type: string; definition?: string }[];
      foreignKeys: { name: string; columns: string; references: string }[];
      triggers: { name: string; event: string; timing: string }[];
      indexes: { name: string; columns: string; unique: boolean }[];
      message?: string;
    };
    await this.ctx.audit({ action: "database.tableinfo.read", resourceType: "database", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { table } });
    return result;
  }

  async exec(id: string, cmd: string[]): Promise<{ output: string; exitCode: number }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.container_id) throw errors.conflict("Database container is not running");
    const result = await hub.request(row.server_id, "container.exec", {
      id: row.container_id,
      cmd,
      timeoutMs: 30000,
    }) as { output: string; exitCode: number };
    await this.ctx.audit({ action: "database.exec", resourceType: "database", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { cmd } });
    return result;
  }

  /** Container logs. */
  async logs(id: string, tail = 200): Promise<string> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.container_id) throw errors.conflict("Database container is not running");
    const result = await hub.request(row.server_id, "container.logs", { id: row.container_id, tail }) as { logs: string };
    return result.logs;
  }

  /** Real-time container stats (CPU / memory). */
  async stats(id: string): Promise<{ cpuPercent: number; memoryUsageBytes: number; memoryLimitBytes: number }> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();
    if (!row.container_id) throw errors.conflict("Database container is not running");
    const name = `nexus-db-${row.id.replace("db_", "")}`;
    return await hub.request(row.server_id, "container.stats", { id: row.container_id, name }) as {
      cpuPercent: number;
      memoryUsageBytes: number;
      memoryLimitBytes: number;
    };
  }

  /** Effective environment of the database container (secrets masked). */
  async env(id: string): Promise<{ key: string; value: string }[]> {
    const row = await this.get(id);
    const password = row.password_encrypted ? decrypt(row.password_encrypted, this.ctx.config.encryptionKey) : "";
    const def = DATABASE_IMAGES[row.type as DatabaseType];
    const dbName = row.db_name ?? row.name;
    const env = def.env(row.username ?? "root", password, dbName);
    return Object.entries(env).map(([key, value]) => ({
      key,
      value: value === password ? "••••••••" : value,
    }));
  }

  async remove(id: string, opts: { destroyData?: boolean } = {}): Promise<void> {
    const row = await this.get(id);
    const hub = this.ctx.hub;
    if (hub.isOnline(row.server_id)) {
      if (row.container_id) {
        await hub.request(row.server_id, "container.remove", { id: row.container_id, force: true, volumes: opts.destroyData ?? false }).catch(() => {});
      } else {
        // Find by label
        const containers = await hub.request(row.server_id, "docker.ps", {}).catch(() => []) as { id: string; labels: Record<string, string> }[];
        const mine = containers.find((c) => c.labels?.["nexus.database"] === row.id);
        if (mine) await hub.request(row.server_id, "container.remove", { id: mine.id, force: true, volumes: opts.destroyData ?? false }).catch(() => {});
      }
      if (opts.destroyData && row.volume_name) {
        await hub.request(row.server_id, "volume.remove", { name: row.volume_name, force: true }).catch(() => {});
      }
    }
    await this.db.run(`DELETE FROM databases WHERE id = ?`, [id]);
    await this.db.run(`DELETE FROM database_credentials WHERE database_id = ?`, [id]);
    await this.ctx.audit({ action: "database.delete", resourceType: "database", resourceId: id, resourceName: row.name, serverId: row.server_id, metadata: { destroyData: opts.destroyData } });
  }

  async connectionInfo(id: string, opts: { revealPassword?: boolean } = {}): Promise<DatabaseConnectionInfo> {
    const row = await this.get(id);
    const password = row.password_encrypted ? decrypt(row.password_encrypted, this.ctx.config.encryptionKey) : "";
    const server = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [row.server_id]);
    const host = row.server_id && server ? (server.type === "local" ? "localhost" : server.host) : "localhost";
    const type = row.type as DatabaseType;
    const dbName = row.db_name ?? row.name;
    const uri =
      type === "REDIS"
        ? `redis://default:${password}@${host}:${row.port}/${row.max_connections ?? 0}`
        : type === "MONGODB"
          ? `mongodb://${row.username ?? "root"}:${password}@${host}:${row.port}/?authSource=admin`
          : type === "INFLUXDB"
            ? `http://${row.username ?? "root"}:${password}@${host}:${row.port}/db/${dbName}`
            : `${type === "POSTGRESQL" ? "postgresql" : type === "MYSQL" ? "mysql" : "mariadb"}://${row.username ?? "root"}:${password}@${host}:${row.port}/${dbName}`;
    return {
      host,
      port: row.port,
      database: dbName,
      username: row.username ?? "root",
      password: opts.revealPassword ? password : "•".repeat(Math.min(password.length, 12)),
      uri: opts.revealPassword ? uri : uri.replace(/:([^:@\/]+)@/, ":***@"),
    };
  }

  /* ── Backups ────────────────────────────────────────────────── */

  async createBackup(databaseId: string, opts: { scheduled?: boolean } = {}): Promise<Backup> {
    const row = await this.get(databaseId);
    const id = newId("bak");
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO backups (id, database_id, application_id, server_id, type, status, created_at) VALUES (?, ?, NULL, ?, 'DATABASE', 'PENDING', ?)`,
      [id, databaseId, row.server_id, now],
    );
    const queue = new JobQueue(this.db);
    await queue.enqueue("database-backup", { backupId: id, databaseId, scheduled: opts.scheduled ?? false });
    await this.ctx.audit({ action: "backup.create", resourceType: "backup", resourceId: id, resourceName: row.name, serverId: row.server_id });
    await this.ctx.notify("database.backup.started", "Backup started", `Backing up ${row.name}…`);
    return this.getBackup(id);
  }

  async runBackup(job: JobRow): Promise<void> {
    const payload = job.payload as unknown as { backupId: string; databaseId: string };
    const backup = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [payload.backupId]);
    if (!backup) return;
    const row = await this.get(payload.databaseId);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw Object.assign(new Error("Server offline — backup will retry"), { retryable: true });

    await this.db.run(`UPDATE backups SET status = 'RUNNING', started_at = ? WHERE id = ?`, [new Date().toISOString(), backup.id]);
    try {
      const result = await hub.request(row.server_id, "db.backup", {
        backupId: backup.id,
        databaseId: row.id,
        type: row.type,
        containerId: row.container_id ?? "",
        name: row.db_name ?? row.name,
        username: row.username,
        password: row.password_encrypted ? decrypt(row.password_encrypted, this.ctx.config.encryptionKey) : undefined,
        port: row.port,
        internalPort: row.internal_port,
        destDir: "/opt/nexus/agent/backups",
        fileName: `${row.id}_${new Date().toISOString().replace(/[:.]/g, "-")}.dump`,
      } as never, { timeoutMs: 10 * 60 * 1000 }) as { path: string; sizeBytes: number };
      await this.db.run(
        `UPDATE backups SET status = 'SUCCESS', path = ?, size_bytes = ?, finished_at = ? WHERE id = ?`,
        [result.path, result.sizeBytes, new Date().toISOString(), backup.id],
      );
      const owner = await this.db.get<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`);
      if (owner) {
        const { NotificationsService } = await import("./notifications.service");
        await new NotificationsService(this.db).create(owner.id, "database.backup.completed", "Backup completed", `Backup for ${row.name} completed (${Math.round(result.sizeBytes / 1024)} KB)`);
      }
      // External notification (webhook/email) for scheduled backups.
      if ((payload as { scheduled?: boolean }).scheduled) {
        const { NotifierService } = await import("./notifier.service");
        const { SettingsService } = await import("./settings.service");
        await new NotifierService(this.db, new SettingsService(this.db)).notifyBackupResult({ backupId: backup.id, scheduled: true }).catch(() => {});
      }
      // Enforce retention: keep only the newest N successful backups.
      await this.pruneBackups(row.id).catch((e) => {
        const logger = this.ctx.logger;
        logger?.warn("backup retention prune failed", { databaseId: row.id, error: e instanceof Error ? e.message : String(e) });
      });
    } catch (err) {
      await this.db.run(`UPDATE backups SET status = 'FAILED', error = ?, finished_at = ? WHERE id = ?`, [
        err instanceof Error ? err.message : String(err),
        new Date().toISOString(),
        backup.id,
      ]);
      throw err;
    }
  }

  async restoreBackup(backupId: string): Promise<void> {
    const backup = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [backupId]);
    if (!backup) throw errors.notFound("Backup not found");
    if (backup.status !== "SUCCESS" || !backup.path) throw errors.conflict("Only completed backups can be restored");
    if (!backup.database_id) throw errors.conflict("This backup is not attached to a database");
    const row = await this.get(backup.database_id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(row.server_id)) throw errors.serverOffline();

    await hub.request(row.server_id, "db.restore", {
      backupId: backup.id,
      databaseId: row.id,
      type: row.type,
      containerId: row.container_id ?? "",
      name: row.db_name ?? row.name,
      username: row.username,
      password: row.password_encrypted ? decrypt(row.password_encrypted, this.ctx.config.encryptionKey) : undefined,
      port: row.port,
      internalPort: row.internal_port,
      filePath: backup.path,
    } as never, { timeoutMs: 10 * 60 * 1000 });

    await this.ctx.audit({ action: "backup.restore", resourceType: "backup", resourceId: backupId, resourceName: row.name, serverId: row.server_id });
    await this.ctx.notify("backup.restored", "Backup restored", `${row.name} was restored from backup ${backupId.slice(-8)}.`);
  }

  async listBackups(databaseId: string): Promise<Backup[]> {
    await this.get(databaseId);
    const rows = await this.db.all<BackupRow>(`SELECT * FROM backups WHERE database_id = ? ORDER BY created_at DESC`, [databaseId]);
    return rows.map((r) => ({
      id: r.id,
      databaseId: r.database_id,
      applicationId: r.application_id,
      serverId: r.server_id,
      type: r.type as Backup["type"],
      status: r.status as Backup["status"],
      sizeBytes: r.size_bytes,
      path: r.path,
      error: r.error,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      createdAt: r.created_at,
    }));
  }

  async deleteBackup(backupId: string): Promise<void> {
    const row = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [backupId]);
    if (!row) throw errors.notFound("Backup not found");
    if (row.path && row.server_id) {
      const hub = this.ctx.hub;
      if (hub.isOnline(row.server_id)) {
        await hub.request(row.server_id, "file.remove", { path: row.path }).catch(() => {});
      }
    }
    await this.db.run(`DELETE FROM backups WHERE id = ?`, [backupId]);
    await this.ctx.audit({ action: "backup.delete", resourceType: "backup", resourceId: backupId, serverId: row.server_id });
  }

  async getBackup(id: string): Promise<Backup> {
    const row = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Backup not found");
    return {
      id: row.id,
      databaseId: row.database_id,
      applicationId: row.application_id,
      serverId: row.server_id,
      type: row.type as Backup["type"],
      status: row.status as Backup["status"],
      sizeBytes: row.size_bytes,
      path: row.path,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      createdAt: row.created_at,
    };
  }

  /* ── Scheduled backups ────────────────────────────────────────── */

  /** Persist the backup schedule; computes the next run when enabled. */
  async updateBackupSchedule(databaseId: string, input: { enabled: boolean; cron?: string; retention?: number }): Promise<Database> {
    const row = await this.get(databaseId);
    const cron = (input.cron ?? row.backup_schedule_cron ?? "0 2 * * *").trim();
    const parsed = parseCron(cron);
    if (!parsed) throw errors.validation({ cron: "Invalid cron expression — expected 5 fields (minute hour day month weekday)" });
    const retention = Math.max(1, Math.min(365, Math.round(input.retention ?? row.backup_retention ?? 7)));
    const next = input.enabled ? nextRun(parsed, new Date()) : null;
    await this.db.run(
      `UPDATE databases SET backup_schedule_enabled = ?, backup_schedule_cron = ?, backup_retention = ?, backup_next_run_at = ?, updated_at = ? WHERE id = ?`,
      [input.enabled ? 1 : 0, cron, retention, next ? next.toISOString() : null, new Date().toISOString(), databaseId],
    );
    await this.ctx.audit({
      action: input.enabled ? "database.backup-schedule.enabled" : "database.backup-schedule.disabled",
      resourceType: "database",
      resourceId: databaseId,
      resourceName: row.name,
      serverId: row.server_id,
      metadata: { cron, retention },
    });
    return this.getPublic(databaseId);
  }

  /**
   * Scheduler tick — find databases whose schedule is due (next_run_at in the
   * past) and enqueue a backup. Returns the number of backups started.
   */
  async runDueBackups(): Promise<number> {
    const now = new Date();
    const rows = await this.db.all<DatabaseRow>(
      `SELECT * FROM databases WHERE backup_schedule_enabled = 1 AND backup_next_run_at IS NOT NULL AND backup_next_run_at <= ?`,
      [now.toISOString()],
    );
    let started = 0;
    for (const row of rows) {
      const parsed = parseCron(row.backup_schedule_cron ?? "0 2 * * *");
      if (!parsed) {
        // Corrupt schedule — disable so the row stops being picked up.
        await this.db.run(`UPDATE databases SET backup_schedule_enabled = 0, backup_next_run_at = NULL WHERE id = ?`, [row.id]);
        continue;
      }
      const backup = await this.createBackup(row.id, { scheduled: true });
      const next = nextRun(parsed, new Date());
      await this.db.run(
        `UPDATE databases SET backup_last_run_at = ?, backup_next_run_at = ?, updated_at = ? WHERE id = ?`,
        [now.toISOString(), next ? next.toISOString() : null, new Date().toISOString(), row.id],
      );
      await this.ctx.audit({ action: "database.backup-schedule.run", resourceType: "backup", resourceId: backup.id, resourceName: row.name, serverId: row.server_id });
      started++;
    }
    return started;
  }

  /**
   * Retention — keep the newest N successful backups for a database, deleting
   * older ones from both the DB and the agent host (best effort).
   */
  async pruneBackups(databaseId: string): Promise<number> {
    const row = await this.get(databaseId);
    const keep = Math.max(1, row.backup_retention ?? 7);
    const backups = await this.db.all<BackupRow>(
      `SELECT * FROM backups WHERE database_id = ? AND status = 'SUCCESS' AND path IS NOT NULL ORDER BY created_at DESC`,
      [databaseId],
    );
    const toDelete = backups.slice(keep);
    const hub = this.ctx.hub;
    for (const b of toDelete) {
      if (hub.isOnline(row.server_id) && b.path) {
        await hub.request(row.server_id, "file.remove", { path: b.path }).catch(() => {});
      }
      await this.db.run(`DELETE FROM backups WHERE id = ?`, [b.id]);
    }
    return toDelete.length;
  }

  async credentials(databaseId: string): Promise<DatabaseCredentialRow[]> {
    return this.db.all<DatabaseCredentialRow>(`SELECT * FROM database_credentials WHERE database_id = ?`, [databaseId]);
  }
}
