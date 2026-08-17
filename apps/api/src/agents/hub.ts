import { createLogger } from "@nexus/logger";
import type { AgentAction, AgentToApiMessage, DeploymentLogEntry, ManagedContainerState } from "@nexus/types";
import type { DbConnection, ServerRow } from "@nexus/database";
import { errors } from "../lib/errors";
import { eventHub } from "../lib/events";

const log = createLogger("api:agent-hub");

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onEvent?: (eventType: string, resourceId: string | undefined, data: Record<string, unknown>) => void;
}

interface AgentConnection {
  serverId: string;
  agentId: string;
  version: string;
  ws: WebSocket;
  pending: Map<string, PendingRequest>;
}

export interface AgentUpdateStatus {
  enabled: boolean;
  lastCheckedAt: string | null;
  lastUpgradedAt: string | null;
  lastError: string | null;
  runningSha256: string | null;
}

export class AgentHub {
  private connections = new Map<string, AgentConnection>();
  private updateStatus = new Map<string, AgentUpdateStatus>();

  constructor(private readonly db: DbConnection) {}

  isOnline(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  listOnline(): string[] {
    return [...this.connections.keys()];
  }

  /** Self-update status reported by an agent's heartbeat (if enabled). */
  getUpdateStatus(serverId: string): AgentUpdateStatus | null {
    return this.updateStatus.get(serverId) ?? null;
  }

  async register(serverId: string, agentId: string, version: string, ws: WebSocket): Promise<void> {
    // Validate agent belongs to this server
    const server = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [serverId]);
    if (!server) throw errors.notFound("Server not found");
    if (server.agent_id && server.agent_id !== agentId) {
      throw errors.forbidden("Agent identity does not match this server");
    }
    const agent = await this.db.get<{ revoked_at: string | null }>(`SELECT revoked_at FROM server_agents WHERE server_id = ?`, [serverId]);
    if (agent?.revoked_at) {
      throw errors.forbidden("This Agent has been revoked");
    }

    const existing = this.connections.get(serverId);
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close();
      } catch {
        /* ignore */
      }
      this.rejectAll(existing, errors.serverError("Replaced by a new agent connection"));
    }

    this.connections.set(serverId, {
      serverId,
      agentId,
      version,
      ws,
      pending: new Map(),
    });

    const wasOnline = server.status === "ONLINE";
    await this.db.run(
      `UPDATE servers SET status = 'ONLINE', agent_version = ?, last_heartbeat_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
      [version, new Date().toISOString(), new Date().toISOString(), serverId],
    );
    await this.db.run(`UPDATE server_agents SET connected = TRUE, last_seen_at = ?, version = ? WHERE server_id = ?`, [
      new Date().toISOString(),
      version,
      serverId,
    ]);
    eventHub.emit({ type: "server.status", serverId, status: "ONLINE" });
    // Notify on a real reconnect (was offline/error/installing before).
    if (!wasOnline) {
      try {
        const { NotificationsService } = await import("../services/notifications.service");
        const owner = await this.db.get<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`);
        if (owner) {
          await new NotificationsService(this.db).create(owner.id, "server.online", "Server online", `${server.name} reconnected — agent is ready.`);
        }
      } catch (err) {
        log.warn("failed to notify server online", { serverId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    log.info("agent registered", { serverId, agentId, version });
  }

  unregister(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    this.rejectAll(conn, errors.serverOffline("Agent disconnected"));
    this.connections.delete(serverId);
    void this.db.run(`UPDATE server_agents SET connected = FALSE WHERE server_id = ?`, [serverId]);
    // Any live log streams on this server just died — tell subscribers so the
    // dashboards fall back to re-seeding / re-subscribing.
    void import("../websocket/log-streams").then(({ handleAgentDisconnect }) => handleAgentDisconnect(serverId));
  }

  private rejectAll(conn: AgentConnection, err: Error): void {
    for (const [, pending] of conn.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    conn.pending.clear();
  }

  /** Send an action to an agent and await its result. */
  async request(
    serverId: string,
    action: AgentAction,
    payload: Record<string, unknown>,
    opts: { timeoutMs?: number; onEvent?: (eventType: string, resourceId: string | undefined, data: Record<string, unknown>) => void } = {},
  ): Promise<unknown> {
    const conn = this.connections.get(serverId);
    if (!conn) throw errors.serverOffline();
    const requestId = `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(requestId);
        reject(errors.serverOffline(`Agent did not respond to ${action}`));
      }, opts.timeoutMs ?? 120000);

      conn.pending.set(requestId, {
        resolve,
        reject,
        timer,
        onEvent: opts.onEvent,
      });

      try {
        conn.ws.send(JSON.stringify({ type: "request", requestId, action, payload }));
      } catch (err) {
        clearTimeout(timer);
        conn.pending.delete(requestId);
        reject(errors.serverOffline("Agent connection lost"));
      }
    });
  }

  async handleMessage(serverId: string, raw: string): Promise<void> {
    let msg: AgentToApiMessage;
    try {
      msg = JSON.parse(raw) as AgentToApiMessage;
    } catch {
      return;
    }
    const conn = this.connections.get(serverId);
    if (!conn) return;

    switch (msg.type) {
      case "ack": {
        const pending = conn.pending.get(msg.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        conn.pending.delete(msg.requestId);
        pending.resolve(msg.result);
        return;
      }
      case "error": {
        const pending = conn.pending.get(msg.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        conn.pending.delete(msg.requestId);
        pending.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        return;
      }
      case "event": {
        const event = msg.event;
        conn.pending.forEach((p) => p.onEvent?.(event.type, event.resourceId, event.data));
        await this.handleAgentEvent(serverId, event);
        return;
      }
      case "heartbeat": {
        await this.handleHeartbeat(serverId, msg.metrics);
        const update = (msg as { update?: AgentUpdateStatus }).update;
        if (update) this.updateStatus.set(serverId, update);
        return;
      }
      case "hello": {
        // registration already handled at socket open; update system info
        if (msg.system) {
          await this.db.run(
            `UPDATE servers SET os = ?, arch = ?, hostname = ?, cpu_model = ?, cpu_cores = ?, memory_total_bytes = ?, disk_total_bytes = ?, docker_version = ?, docker_available = ?, status = 'ONLINE', last_heartbeat_at = ?, updated_at = ? WHERE id = ?`,
            [msg.system.os, msg.system.arch, msg.system.hostname, msg.system.cpuModel ?? null, msg.system.cpuCores, msg.system.memoryTotalBytes, msg.system.diskTotalBytes, msg.system.dockerVersion ?? null, msg.system.dockerAvailable ? 1 : 0, new Date().toISOString(), new Date().toISOString(), serverId],
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private async handleHeartbeat(serverId: string, metrics: SystemMetrics): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE servers SET status = 'ONLINE', last_heartbeat_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
      [now, now, serverId],
    );
    // Reconcile resource status against the agent's real container states so
    // the panel never reports RUNNING for a container that is actually dead
    // (crash, OOM, external `docker stop`, host reboot, …).
    if (Array.isArray(metrics.managedContainers) && metrics.managedContainers.length > 0) {
      await this.reconcileResourceStatus(serverId, metrics.managedContainers, now).catch((err) => {
        log.warn("status reconcile failed", { serverId, error: err instanceof Error ? err.message : String(err) });
      });
    }
    // Persist metric sample (single row per heartbeat; pruned by retention).
    await this.db.run(
      `INSERT INTO monitoring_metrics (id, server_id, ts, cpu_percent, memory_percent, disk_percent, containers_running, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `met_${Math.random().toString(36).slice(2, 14)}`,
        serverId,
        now,
        metrics.cpuPercent,
        metrics.memoryPercent,
        metrics.diskPercent,
        metrics.containersRunning,
        JSON.stringify(metrics),
      ],
    );
    eventHub.emit({ type: "server.metrics", serverId, metrics });
  }

  /**
   * Syncs the DB status of applications/databases/game servers on this host
   * with the actual docker container states reported by the agent. Only rows
   * that already have a container are considered (CREATING/STARTING/DEPLOYING
   * are left untouched — they are transient and will resolve via events).
   */
  private async reconcileResourceStatus(
    serverId: string,
    containers: ManagedContainerState[],
    now: string,
  ): Promise<void> {
    const byType = new Map<string, Map<string, ManagedContainerState>>();
    for (const c of containers) {
      if (!c.type || !c.resourceId) continue;
      if (!byType.has(c.type)) byType.set(c.type, new Map());
      byType.get(c.type)!.set(c.resourceId, c);
    }
    const running = (c?: ManagedContainerState) => c?.state === "running";

    // Applications — `current_container_id` must match the container id.
    const apps = await this.db.all<{ id: string; status: string; current_container_id: string | null }>(
      `SELECT id, status, current_container_id FROM applications WHERE server_id = ?`,
      [serverId],
    );
    for (const app of apps) {
      if (!app.current_container_id) continue;
      const real = byType.get("application")?.get(app.id);
      if (app.status === "DEPLOYING" || app.status === "NOT_DEPLOYED") continue;
      const isRunning = running(real) && real?.id === app.current_container_id;
      if (isRunning && app.status !== "RUNNING") {
        await this.db.run(`UPDATE applications SET status = 'RUNNING', updated_at = ? WHERE id = ?`, [now, app.id]);
        this.emitResourceEvent("application", app.id, "RUNNING");
      } else if (!isRunning && app.status === "RUNNING") {
        await this.db.run(`UPDATE applications SET status = 'STOPPED', updated_at = ? WHERE id = ?`, [now, app.id]);
        this.emitResourceEvent("application", app.id, "STOPPED");
      }
    }

    // Databases.
    const dbs = await this.db.all<{ id: string; status: string; container_id: string | null }>(
      `SELECT id, status, container_id FROM databases WHERE server_id = ?`,
      [serverId],
    );
    for (const dbRow of dbs) {
      if (!dbRow.container_id) continue;
      const real = byType.get("database")?.get(dbRow.id);
      if (dbRow.status === "CREATING" || dbRow.status === "REMOVING") continue;
      const isRunning = running(real) && real?.id === dbRow.container_id;
      if (isRunning && dbRow.status !== "RUNNING") {
        await this.db.run(`UPDATE databases SET status = 'RUNNING', updated_at = ? WHERE id = ?`, [now, dbRow.id]);
        this.emitResourceEvent("database", dbRow.id, "RUNNING");
      } else if (!isRunning && dbRow.status === "RUNNING") {
        await this.db.run(`UPDATE databases SET status = 'STOPPED', updated_at = ? WHERE id = ?`, [now, dbRow.id]);
        this.emitResourceEvent("database", dbRow.id, "STOPPED");
      }
    }

    // Game servers.
    const games = await this.db.all<{ id: string; status: string; container_id: string | null }>(
      `SELECT id, status, container_id FROM game_servers WHERE server_id = ?`,
      [serverId],
    );
    for (const g of games) {
      if (!g.container_id) continue;
      const real = byType.get("game")?.get(g.id);
      if (g.status === "CREATING" || g.status === "STARTING" || g.status === "REMOVING") continue;
      const isRunning = running(real) && real?.id === g.container_id;
      if (isRunning && g.status !== "RUNNING") {
        await this.db.run(`UPDATE game_servers SET status = 'RUNNING', updated_at = ? WHERE id = ?`, [now, g.id]);
        this.emitResourceEvent("game", g.id, "RUNNING");
      } else if (!isRunning && g.status === "RUNNING") {
        await this.db.run(`UPDATE game_servers SET status = 'STOPPED', updated_at = ? WHERE id = ?`, [now, g.id]);
        this.emitResourceEvent("game", g.id, "STOPPED");
      }
    }
  }

  /** Emits the status change to dashboard sockets using the existing event shapes. */
  private emitResourceEvent(
    type: "application" | "database" | "game",
    id: string,
    status: string,
  ): void {
    if (type === "database") {
      void this.db
        .get<Record<string, unknown>>(`SELECT * FROM databases WHERE id = ?`, [id])
        .then((row) => {
          if (row) eventHub.emit({ type: "database.status", database: row as never });
        })
        .catch(() => {});
      return;
    }
    if (type === "game") {
      void this.db
        .get<Record<string, unknown>>(`SELECT * FROM game_servers WHERE id = ?`, [id])
        .then((row) => {
          if (row) eventHub.emit({ type: "game.status", gameServer: row as never });
        })
        .catch(() => {});
      return;
    }
    // Applications have no dedicated status event; the dashboard polls instead.
  }

  private async handleAgentEvent(serverId: string, event: { type: string; resourceId?: string; data: Record<string, unknown>; timestamp: string }): Promise<void> {
    const { type, resourceId, data } = event;
    const deploymentId = String(resourceId ?? "");

    switch (type) {
      case "deployment.log": {
        const message = String(data.message ?? "");
        if (!deploymentId || !message) return;
        await this.db.run(
          `INSERT INTO deployment_logs (id, deployment_id, stream, message, timestamp) VALUES (?, ?, ?, ?, ?)`,
          [`dlog_${Math.random().toString(36).slice(2, 14)}`, deploymentId, String(data.stream ?? "stdout"), message, new Date().toISOString()],
        );
        eventHub.emit({ type: "deployment.log", deploymentId, entry: { stream: (String(data.stream ?? "stdout") as DeploymentLogEntry["stream"]), message, timestamp: new Date().toISOString() } });
        return;
      }
      case "deployment.status": {
        const status = String(data.status ?? "");
        if (!deploymentId || !status) return;
        await this.db.run(
          `UPDATE application_deployments SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`,
          [status, new Date().toISOString(), deploymentId],
        );
        const dep = await this.db.get(`SELECT * FROM application_deployments WHERE id = ?`, [deploymentId]);
        if (dep) {
          eventHub.emit({
            type: "deployment.status",
            deployment: {
              id: dep.id,
              applicationId: dep.application_id,
              serverId: dep.server_id,
              status,
              commit: dep.commit_sha,
              branch: dep.branch,
              image: dep.image,
              containerId: dep.container_id,
              startedAt: dep.started_at,
              finishedAt: dep.finished_at,
              error: dep.error,
              createdAt: dep.created_at,
            } as never,
          });
        }
        return;
      }
      case "resource.log": {
        const resourceIdValue = String(resourceId ?? "");
        const message = String(data.message ?? "");
        const resourceType = (String(data.resourceType ?? "") as "database" | "application" | "backup" | "game") || "database";
        if (!resourceIdValue || !message) return;
        const id = `rlog_${Math.random().toString(36).slice(2, 14)}`;
        await this.db.run(
          `INSERT INTO resource_logs (id, resource_type, resource_id, stream, message, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
          [id, resourceType, resourceIdValue, String(data.stream ?? "stdout"), message, new Date().toISOString()],
        );
        eventHub.emit({
          type: "resource.log",
          resourceType,
          resourceId: resourceIdValue,
          entry: { id, resourceType, resourceId: resourceIdValue, stream: (String(data.stream ?? "stdout") as "stdout" | "stderr" | "system"), message, timestamp: new Date().toISOString() },
        });
        return;
      }
      case "container.status": {
        eventHub.emit({ type: "container.status", serverId, container: data as never });
        return;
      }
      case "database.status": {
        const databaseId = String(resourceId ?? "");
        if (databaseId && data.status) {
          await this.db.run(`UPDATE databases SET status = ?, updated_at = ? WHERE id = ?`, [String(data.status), new Date().toISOString(), databaseId]);
        }
        return;
      }
      case "game.status": {
        const gameId = String(resourceId ?? "");
        if (gameId && data.status) {
          await this.db.run(`UPDATE game_servers SET status = ?, updated_at = ? WHERE id = ?`, [String(data.status), new Date().toISOString(), gameId]);
        }
        return;
      }
      case "container.log": {
        const streamId = String(resourceId ?? "");
        if (!streamId) return;
        eventHub.emit({
          type: "container.log",
          streamId,
          containerId: String(data.containerId ?? ""),
          line: String(data.line ?? ""),
          ended: data.ended === true,
        });
        return;
      }
      default:
        return;
    }
  }
}

import type { SystemMetrics } from "@nexus/types";
