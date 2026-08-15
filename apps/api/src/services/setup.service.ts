import type { DbConnection, ServerRow, UserRow } from "@nexus/database";
import { newId, encrypt, newToken, hashToken } from "../lib/crypto";
import { errors } from "../lib/errors";
import type { ServerSystemInfo } from "@nexus/types";

export interface SetupState {
  completed: boolean;
  adminCreated: boolean;
  localServerCreated: boolean;
}

export class SetupService {
  constructor(private readonly db: DbConnection) {}

  async state(): Promise<SetupState> {
    const users = await this.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM users`);
    const servers = await this.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM servers WHERE type = 'local'`);
    const adminCreated = Number(users?.c ?? 0) > 0;
    const localServerCreated = Number(servers?.c ?? 0) > 0;
    return { adminCreated, localServerCreated, completed: adminCreated && localServerCreated };
  }

  async createAdminAndLocalServer(input: {
    name: string;
    email: string;
    password: string;
    system: ServerSystemInfo;
  }): Promise<{ user: UserRow; server: ServerRow; agentToken: string }> {
    const state = await this.state();
    if (state.completed) throw errors.conflict("Setup has already been completed");

    // Admin (transactional with local server)
    let agentToken = "";

    const { user, server } = await this.db.transaction(async (tx): Promise<{ user: UserRow; server: ServerRow }> => {
      let user: UserRow | null = null;
      let server: ServerRow | null = null;
      if (!state.adminCreated) {
        const email = input.email.trim().toLowerCase();
        if (input.password.length < 8) throw errors.validation({ password: "Password must be at least 8 characters" });
        const existing = await tx.get<UserRow>(`SELECT id FROM users WHERE email = ?`, [email]);
        if (existing) throw errors.conflict("An account with this email already exists");
        const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
        const now = new Date().toISOString();
        user = {
          id: newId("usr"),
          name: input.name.trim(),
          email,
          password_hash: passwordHash,
          role: "owner",
          created_at: now,
          updated_at: now,
        };
        await tx.run(`INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
          user.id, user.name, user.email, user.password_hash, user.role, user.created_at, user.updated_at,
        ]);
      } else {
        user = await tx.get<UserRow>(`SELECT * FROM users ORDER BY created_at LIMIT 1`);
      }

      if (!state.localServerCreated) {
        agentToken = newToken(48);
        const now = new Date().toISOString();
        const s = input.system;
        server = {
          id: newId("srv"),
          name: "Local Server",
          type: "local",
          host: "localhost",
          port: 22,
          username: process.env.USER ?? process.env.USERNAME ?? "root",
          auth_method: "password",
          auth_data_encrypted: null,
          status: "INSTALLING",
          agent_id: newId("agt"),
          agent_token_encrypted: encrypt(agentToken, process.env.ENCRYPTION_KEY ?? "dev-encryption-key-not-for-production"),
          agent_version: "0.1.0",
          agent_api_url: null,
          os: s.os,
          arch: s.arch,
          hostname: s.hostname,
          cpu_model: s.cpuModel ?? null,
          cpu_cores: s.cpuCores ?? null,
          memory_total_bytes: s.memoryTotalBytes ?? null,
          disk_total_bytes: s.diskTotalBytes ?? null,
          docker_version: s.dockerVersion ?? null,
          docker_available: s.dockerAvailable ? 1 : 0,
          last_heartbeat_at: null,
          last_error: null,
          created_at: now,
          updated_at: now,
        };
        await tx.run(
          `INSERT INTO servers (id, name, type, host, port, username, auth_method, auth_data_encrypted, status, agent_id, agent_token_encrypted, agent_version, os, arch, hostname, cpu_model, cpu_cores, memory_total_bytes, disk_total_bytes, docker_version, docker_available, last_heartbeat_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [server.id, server.name, server.type, server.host, server.port, server.username, server.auth_method, server.auth_data_encrypted, server.status, server.agent_id, server.agent_token_encrypted, server.agent_version, server.os, server.arch, server.hostname, server.cpu_model, server.cpu_cores, server.memory_total_bytes, server.disk_total_bytes, server.docker_version, server.docker_available, server.last_heartbeat_at, server.last_error, server.created_at, server.updated_at],
        );
        await tx.run(
          `INSERT INTO server_agents (id, server_id, agent_id, token_hash, version, connected, last_seen_at, revoked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId("sag"), server.id, server.agent_id, hashToken(agentToken), "0.1.0", 0, null, null, now],
        );
      }
      if (!user || !server) throw errors.serverError("Setup could not be completed");
      return { user, server };
    });

    return { user, server, agentToken };
  }

  /** Register (or refresh) the agent credential for a server (local or remote). */
  async registerAgentForServer(serverId: string): Promise<{ token: string }> {
    const server = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [serverId]);
    if (!server) throw errors.notFound("Server not found");
    const token = newToken(48);
    const encryptionKey = process.env.ENCRYPTION_KEY ?? "dev-encryption-key-not-for-production";
    // Same agent identity everywhere: servers.agent_id and server_agents.agent_id
    // must match, or the WS handshake rejects the agent with
    // "Agent identity does not match this server".
    const agentId = newId("agt");
    await this.db.run(`UPDATE servers SET agent_token_encrypted = ?, agent_id = ?, updated_at = ? WHERE id = ?`, [
      encrypt(token, encryptionKey),
      agentId,
      new Date().toISOString(),
      serverId,
    ]);
    await this.db.run(
      `INSERT INTO server_agents (id, server_id, agent_id, token_hash, version, connected, last_seen_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET agent_id = excluded.agent_id, token_hash = excluded.token_hash, revoked_at = NULL`,
      [newId("sag"), serverId, agentId, hashToken(token), null, 0, null, null, new Date().toISOString()],
    );
    return { token };
  }

  async revokeAgent(serverId: string): Promise<void> {
    await this.db.run(`UPDATE server_agents SET revoked_at = ?, connected = 0 WHERE server_id = ?`, [new Date().toISOString(), serverId]);
  }
}
