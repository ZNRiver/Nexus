import type { DbConnection, ServerRow } from "@nexus/database";
import { decrypt, encrypt, newId } from "../lib/crypto";
import { errors } from "../lib/errors";
import { SSHService } from "../servers/ssh";
import { provisionRemoteServer } from "../servers/provision";
import { resolveAgentApiUrl } from "../servers/api-url";
import type { CreateServerInput, Server, ServerStatus, ServerSystemInfo } from "@nexus/types";
import type { AppContext } from "../context";
import { SetupService } from "./setup.service";

function toServer(row: ServerRow): Server {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    host: row.host,
    port: row.port,
    username: row.username,
    authMethod: row.auth_method,
    hasCredentials: !!row.auth_data_encrypted,
    status: row.status as ServerStatus,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    agentApiUrl: row.agent_api_url,
    os: row.os,
    arch: row.arch,
    hostname: row.hostname,
    cpuModel: row.cpu_model,
    cpuCores: row.cpu_cores,
    memoryTotalBytes: row.memory_total_bytes,
    diskTotalBytes: row.disk_total_bytes,
    dockerVersion: row.docker_version,
    dockerAvailable: !!row.docker_available,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ServersService {
  constructor(
    private readonly db: DbConnection,
    private readonly ctx: AppContext,
  ) {}

  async list(): Promise<Server[]> {
    const rows = await this.db.all<ServerRow>(`SELECT * FROM servers ORDER BY type ASC, name ASC`);
    return rows.map(toServer);
  }

  async get(id: string): Promise<Server> {
    const row = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Server not found");
    return toServer(row);
  }

  async getRow(id: string): Promise<ServerRow> {
    const row = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Server not found");
    return row;
  }

  async create(input: CreateServerInput): Promise<Server> {
    const name = input.name.trim();
    if (name.length < 2) throw errors.validation({ name: "Name must be at least 2 characters" });
    const existing = await this.db.get<ServerRow>(`SELECT id FROM servers WHERE name = ?`, [name]);
    if (existing) throw errors.conflict(`A server named "${name}" already exists`);

    const host = input.host.trim();
    if (!host) throw errors.validation({ host: "Host is required" });

    const authData = input.authMethod === "password"
      ? JSON.stringify({ password: input.password ?? "" })
      : JSON.stringify({ privateKey: input.privateKey ?? "" });

    const now = new Date().toISOString();
    const row: ServerRow = {
      id: newId("srv"),
      name,
      type: "remote",
      host,
      port: input.port ?? 22,
      username: input.username || "root",
      auth_method: input.authMethod,
      auth_data_encrypted: encrypt(authData, this.ctx.config.encryptionKey),
      status: "CONNECTING",
      agent_id: null,
      agent_token_encrypted: null,
      agent_version: null,
      agent_api_url: input.agentApiUrl?.trim() || null,
      os: null,
      arch: null,
      hostname: null,
      cpu_model: null,
      cpu_cores: null,
      memory_total_bytes: null,
      disk_total_bytes: null,
      docker_version: null,
      docker_available: 0,
      last_heartbeat_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.run(
      `INSERT INTO servers (id, name, type, host, port, username, auth_method, auth_data_encrypted, status, agent_id, agent_token_encrypted, agent_version, agent_api_url, os, arch, hostname, cpu_model, cpu_cores, memory_total_bytes, disk_total_bytes, docker_version, docker_available, last_heartbeat_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.name, row.type, row.host, row.port, row.username, row.auth_method, row.auth_data_encrypted, row.status, row.agent_id, row.agent_token_encrypted, row.agent_version, row.agent_api_url, row.os, row.arch, row.hostname, row.cpu_model, row.cpu_cores, row.memory_total_bytes, row.disk_total_bytes, row.docker_version, row.docker_available, row.last_heartbeat_at, row.last_error, row.created_at, row.updated_at],
    );
    return toServer(row);
  }

  async update(id: string, patch: { name?: string; port?: number; username?: string; agentApiUrl?: string | null }): Promise<Server> {
    const row = await this.getRow(id);
    const next = {
      ...row,
      ...(patch.name ? { name: patch.name.trim() } : {}),
      ...(patch.port ? { port: patch.port } : {}),
      ...(patch.username ? { username: patch.username } : {}),
      ...("agentApiUrl" in patch ? { agent_api_url: patch.agentApiUrl?.trim() || null } : {}),
    };
    await this.db.run(`UPDATE servers SET name = ?, port = ?, username = ?, agent_api_url = ?, updated_at = ? WHERE id = ?`, [
      next.name, next.port, next.username, next.agent_api_url, new Date().toISOString(), id,
    ]);
    return this.get(id);
  }

  async remove(id: string, opts: { uninstallAgent?: boolean } = {}): Promise<void> {
    const row = await this.getRow(id);
    if (opts.uninstallAgent && row.type === "remote" && row.auth_data_encrypted) {
      const creds = this.getCredentials(row);
      const ssh = new SSHService();
      const client = await ssh.connect({ host: row.host, port: row.port, username: row.username, password: creds.password, privateKey: creds.privateKey });
      try {
        await ssh.execute(client, `systemctl disable --now nexus-agent 2>/dev/null; rm -rf /opt/nexus/agent`, 60000);
      } finally {
        await ssh.close(client);
      }
    }
    await this.db.run(`DELETE FROM servers WHERE id = ?`, [id]);
  }

  getCredentials(row: ServerRow): { password?: string; privateKey?: string } {
    if (!row.auth_data_encrypted) return {};
    try {
      const parsed = JSON.parse(decrypt(row.auth_data_encrypted, this.ctx.config.encryptionKey)) as { password?: string; privateKey?: string };
      return parsed;
    } catch {
      return {};
    }
  }

  /** Real SSH test — never simulated. */
  async testConnection(input: CreateServerInput & { id?: string }): Promise<{ ok: boolean; message: string; system?: ServerSystemInfo; error?: string }> {
    let password: string | undefined;
    let privateKey: string | undefined;
    if (input.id) {
      const row = await this.getRow(input.id);
      const creds = this.getCredentials(row);
      password = creds.password;
      privateKey = creds.privateKey;
    } else {
      password = input.authMethod === "password" ? input.password : undefined;
      privateKey = input.authMethod === "privateKey" ? input.privateKey : undefined;
    }

    const ssh = new SSHService();
    try {
      const client = await ssh.connect({
        host: input.host,
        port: input.port ?? 22,
        username: input.username || "root",
        password,
        privateKey,
      });
      try {
        const uname = await ssh.execute(client, `uname -s`);
        const arch = await ssh.execute(client, `uname -m`);
        const docker = await ssh.execute(client, `docker version --format '{{.Server.Version}}' 2>/dev/null`);
        const nproc = await ssh.execute(client, `nproc`);
        const mem = await ssh.execute(client, `grep MemTotal /proc/meminfo | awk '{print $2}'`);
        const hostname = await ssh.execute(client, `hostname`);
        return {
          ok: true,
          message: "Connection successful",
          system: {
            hostname: hostname.stdout.trim(),
            os: uname.stdout.trim(),
            platform: "linux",
            arch: arch.stdout.trim() || "unknown",
            cpuCores: parseInt(nproc.stdout.trim() || "1", 10),
            memoryTotalBytes: parseInt(mem.stdout.trim() || "0", 10) * 1024,
            dockerVersion: docker.stdout.trim() || null,
            dockerAvailable: docker.code === 0,
          },
        };
      } finally {
        await ssh.close(client);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message, error: message };
    }
  }

  async installAgent(id: string, apiUrlOverride?: string): Promise<{ steps: { step: string; ok: boolean; message: string }[] }> {
    const row = await this.getRow(id);
    const creds = this.getCredentials(row);
    if (!row.auth_data_encrypted) throw errors.badRequest("SSH credentials are required to install the agent");

    await this.db.run(`UPDATE servers SET status = 'INSTALLING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);

    const setup = new SetupService(this.db);
    const { token } = await setup.registerAgentForServer(id);

    try {
      // The agent must connect back over WS. For remote hosts a localhost
      // default would point at the remote host itself — resolve a LAN IP
      // reachable from the remote host when no explicit URL was configured.
      // Explicit per-server override wins, then the request-derived URL,
      // then a LAN IP resolved from the remote host, then the configured default.
      const apiUrl =
        row.agent_api_url?.trim() ||
        resolveAgentApiUrl(row.host, this.ctx.config.port, apiUrlOverride ?? this.ctx.config.apiUrl);
      const result = await provisionRemoteServer({
        host: row.host,
        port: row.port,
        username: row.username,
        password: creds.password,
        privateKey: creds.privateKey,
        agentToken: token,
        serverId: row.id,
        apiUrl,
        agentVersion: "0.1.0",
      });

      // Wait for the agent to connect back over WS (flips status to ONLINE
      // on hello/heartbeat). Fail fast with a clear message instead of
      // leaving the server stuck in INSTALLING forever.
      const connected = await this.waitForAgentConnection(id, 90_000);
      if (!connected) {
        const msg =
          "Agent installed but did not connect back to the API. Check that the API URL (" +
          apiUrl +
          ") is reachable from this host (firewall / reverse proxy).";
        await this.db.run(`UPDATE servers SET status = 'ERROR', last_error = ?, updated_at = ? WHERE id = ?`, [msg, new Date().toISOString(), id]);
        return { steps: [...result.steps, { step: "connect", ok: false, message: msg }] };
      }

      // Agent will connect via WS and flip status to ONLINE on hello/heartbeat.
      if (result.system.dockerVersion) {
        await this.db.run(
          `UPDATE servers SET os = ?, arch = ?, hostname = ?, cpu_model = ?, cpu_cores = ?, memory_total_bytes = ?, disk_total_bytes = ?, docker_version = ?, docker_available = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
          [result.system.os, result.system.arch, result.system.hostname, result.system.cpuModel ?? null, result.system.cpuCores, result.system.memoryTotalBytes, result.system.diskTotalBytes, result.system.dockerVersion ?? null, result.system.dockerAvailable ? 1 : 0, new Date().toISOString(), id],
        );
      } else {
        await this.db.run(`UPDATE servers SET last_error = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
      }
      return { steps: result.steps };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db.run(`UPDATE servers SET status = 'ERROR', last_error = ?, updated_at = ? WHERE id = ?`, [message, new Date().toISOString(), id]);
      throw err;
    }
  }

  async reconnect(id: string, apiUrlOverride?: string): Promise<{ token?: string }> {
    const row = await this.getRow(id);
    if (row.type === "local") {
      const setup = new SetupService(this.db);
      const { token } = await setup.registerAgentForServer(id);
      return { token };
    }
    const creds = this.getCredentials(row);
    if (!row.auth_data_encrypted) throw errors.badRequest("SSH credentials are required to reinstall the agent");
    await this.installAgent(id, apiUrlOverride);
    return {};
  }

  /** Live info + container sync from the connected agent. */
  async sync(id: string): Promise<{ server: Server; containers: unknown[]; system: ServerSystemInfo | null }> {
    const hub = this.ctx.hub;
    if (!hub.isOnline(id)) throw errors.serverOffline();
    const [system, containers] = await Promise.all([
      hub.request(id, "system.info", {}).catch(() => null),
      hub.request(id, "docker.ps", {}).catch(() => []),
    ]);
    const row = await this.getRow(id);
    return { server: toServer(row), containers: containers as unknown[], system: system as ServerSystemInfo | null };
  }

  /** Poll the hub until the agent registers (WS hello) or the timeout elapses. */
  private async waitForAgentConnection(id: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.ctx.hub.isOnline(id)) return true;
      // The hub also flips the DB row on hello — double check in case the hub
      // state and DB are out of sync after a restart.
      const row = await this.db.get<{ status: string }>(`SELECT status FROM servers WHERE id = ?`, [id]).catch(() => null);
      if (row?.status === "ONLINE") return true;
      await Bun.sleep(3_000);
    }
    return false;
  }
}
