import type { DbConnection, ApplicationRow, DeploymentRow, DeploymentLogRow, JobRow, ServerRow } from "@nexus/database";
import { decrypt } from "../lib/crypto";
import { errors } from "../lib/errors";
import type { ApplicationWithExtras, Deployment, DeploymentLogEntry, DeploymentStatus } from "@nexus/types";
import { eventHub } from "../lib/events";
import type { AppContext } from "../context";
import { SettingsService } from "./settings.service";
import { appendResourceLog } from "./resource-logs.service";

export function toDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    applicationId: row.application_id,
    serverId: row.server_id,
    status: row.status as DeploymentStatus,
    commit: row.commit_sha,
    branch: row.branch,
    image: row.image,
    containerId: row.container_id,
    composeProjectName: row.compose_project_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    error: row.error,
    triggeredBy: row.triggered_by,
    triggeredByName: row.triggered_by_name,
    rollbackFrom: row.rollback_from,
    createdAt: row.created_at,
  };
}

export class DeploymentsService {
  constructor(
    private readonly db: DbConnection,
    private readonly ctx: AppContext,
  ) {}

  async get(id: string): Promise<DeploymentRow> {
    const row = await this.db.get<DeploymentRow>(`SELECT * FROM application_deployments WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Deployment not found");
    return row;
  }

  async getPublic(id: string): Promise<Deployment> {
    return toDeployment(await this.get(id));
  }

  async list(opts: { applicationId?: string; serverId?: string; limit: number; cursor?: string; status?: string }): Promise<{ items: Deployment[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.applicationId) {
      where.push("application_id = ?");
      params.push(opts.applicationId);
    }
    if (opts.serverId) {
      where.push("server_id = ?");
      params.push(opts.serverId);
    }
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.cursor) {
      where.push("created_at <= ?");
      params.push(opts.cursor);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await this.db.all<DeploymentRow>(
      `SELECT * FROM application_deployments ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, opts.limit + 1],
    );
    const hasMore = rows.length > opts.limit;
    const items = rows.slice(0, opts.limit).map(toDeployment);
    return { items, nextCursor: hasMore ? items[items.length - 1]?.createdAt ?? null : null };
  }

  async getLogs(deploymentId: string, sinceId?: string): Promise<DeploymentLogEntry[]> {
    await this.get(deploymentId);
    const rows = sinceId
      ? await this.db.all<DeploymentLogRow>(`SELECT * FROM deployment_logs WHERE deployment_id = ? AND id > ? ORDER BY timestamp ASC, id ASC LIMIT 2000`, [deploymentId, sinceId])
      : await this.db.all<DeploymentLogRow>(`SELECT * FROM deployment_logs WHERE deployment_id = ? ORDER BY timestamp ASC, id ASC LIMIT 5000`, [deploymentId]);
    return rows.map((r) => ({ stream: r.stream as DeploymentLogEntry["stream"], message: r.message, timestamp: r.timestamp }));
  }

  async cancel(id: string): Promise<Deployment> {
    const dep = await this.get(id);
    const running = ["QUEUED", "CLONING", "BUILDING", "PUSHING", "DEPLOYING", "STARTING", "HEALTH_CHECK", "WAITING_FOR_SERVER"].includes(dep.status);
    if (!running) throw errors.conflict(`Deployment is already ${dep.status}`);

    await this.db.run(`UPDATE application_deployments SET status = 'CANCELLED', finished_at = ?, duration_ms = ? WHERE id = ?`, [
      new Date().toISOString(),
      dep.started_at ? Date.now() - new Date(dep.started_at).getTime() : null,
      id,
    ]);
    await this.db.run(`UPDATE applications SET status = 'NOT_DEPLOYED', updated_at = ? WHERE id = ?`, [new Date().toISOString(), dep.application_id]);

    // Tell the agent to abort any in-flight work.
    const hub = this.ctx.hub;
    if (hub.isOnline(dep.server_id)) {
      await hub.request(dep.server_id, "deployment.cancel", { deploymentId: id }).catch(() => {});
    }

    const updated = await this.getPublic(id);
    eventHub.emit({ type: "deployment.status", deployment: updated });
    await this.ctx.audit({ action: "deployment.cancel", resourceType: "deployment", resourceId: id, serverId: dep.server_id });
    return updated;
  }

  /* ── Job handler: executes a deployment through the agent ────── */

  async runDeployment(job: JobRow): Promise<void> {
    const payload = job.payload as unknown as { deploymentId: string; applicationId: string; rollbackFrom?: string };
    const dep = await this.get(payload.deploymentId);
    const app = await this.db.get<ApplicationRow>(`SELECT * FROM applications WHERE id = ?`, [dep.application_id]);
    if (!app) {
      await this.ctx.audit({ action: "deployment.failed", resourceType: "deployment", resourceId: dep.id, metadata: { reason: "application deleted" } });
      throw new Error("Application no longer exists");
    }
    const server = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [dep.server_id]);

    // Log helper (persisted + streamed via hub events). Also mirrored into
    // resource_logs so the application progress panel can show the same lines.
    const log = async (message: string, stream: "stdout" | "stderr" | "system" = "stdout") => {
      await this.db.run(
        `INSERT INTO deployment_logs (id, deployment_id, stream, message, timestamp) VALUES (?, ?, ?, ?, ?)`,
        [`dlog_${Math.random().toString(36).slice(2, 14)}`, dep.id, stream, message, new Date().toISOString()],
      );
      eventHub.emit({ type: "deployment.log", deploymentId: dep.id, entry: { stream, message, timestamp: new Date().toISOString() } });
      await appendResourceLog(this.db, "application", payload.applicationId, message, stream);
    };

    await this.db.run(`UPDATE application_deployments SET status = 'CLONING', started_at = COALESCE(started_at, ?) WHERE id = ?`, [new Date().toISOString(), dep.id]);
    eventHub.emit({ type: "deployment.status", deployment: await this.getPublic(dep.id) });

    const hub = this.ctx.hub;
    if (!hub.isOnline(dep.server_id)) {
      await log("Server is offline — deployment will retry when the server returns.", "system");
      // Requeue with retry budget.
      throw Object.assign(new Error(`Server ${server?.name ?? dep.server_id} is offline`), { retryable: true, code: "SERVER_OFFLINE" });
    }

    try {
      const startedAt = Date.now();

      // Build the execution payload.
      const env = await this.buildDeploymentEnv(app);
      const rollbackTarget = dep.rollback_from ? await this.db.get<DeploymentRow>(`SELECT * FROM application_deployments WHERE id = ?`, [dep.rollback_from]) : null;
      const prebuiltImage = app.deployment_method === "DOCKERFILE" && rollbackTarget ? rollbackTarget.image ?? null : null;

      // Authenticated git clone: when the app's provider (or its repository
      // URL) maps to a connected account in git_providers, ship the decrypted
      // token to the agent so private repositories clone cleanly.
      const { GitProvidersService, normalizeGitProvider } = await import("./git-providers.service");
      const gitProvider = normalizeGitProvider(app.provider, app.repository);
      const gitToken = gitProvider ? await new GitProvidersService(this.ctx).tokenFor(gitProvider) : null;
      const gitAuth = gitProvider && gitToken ? { provider: gitProvider, token: gitToken } : null;

      const deploymentPayload = {
        deploymentId: dep.id,
        applicationId: app.id,
        repository: app.repository,
        branch: dep.branch,
        method: app.deployment_method,
        dockerfilePath: app.dockerfile_path,
        buildContext: app.build_context,
        composePath: app.compose_path,
        composeProjectName: app.compose_project_name ?? `nexus_${app.id.replace("app_", "app_")}`,
        port: app.port,
        startCommand: app.start_command,
        env,
        imageName: `nexus/${slugify(app.name)}:${dep.id}`,
        containerName: `nexus-${slugify(app.name)}-${dep.id.slice(-8)}`,
        networkName: `nexus-${app.id}`,
        volumeName: app.volume_name,
        mountPath: app.volume_mount_path,
        restartPolicy: app.restart_policy,
        cpuLimit: app.cpu_limit,
        memoryLimitBytes: app.memory_limit_bytes,
        memoryReservationBytes: app.memory_reservation_bytes,
        pidsLimit: app.pids_limit,
        healthcheck: app.healthcheck ? JSON.parse(app.healthcheck) : null,
        registry: app.registry,
        registryUsername: app.registry_username,
        registryPassword: app.registry_password_encrypted ? decrypt(app.registry_password_encrypted, this.ctx.config.encryptionKey) : undefined,
        prebuiltImage,
        gitAuth,
      };

      await log(`Deploying ${app.name} (${app.deployment_method}) to ${server?.name ?? dep.server_id}…`);

      const result = await hub.request(dep.server_id, "deployment.execute", deploymentPayload, {
        timeoutMs: 30 * 60 * 1000, // 30 min build budget
        onEvent: () => {
          /* deployment.log/status events are already persisted by the hub */
        },
      }) as { image?: string; containerId?: string; projectName?: string; containers?: string[]; commit?: string | null };

      const finishedAt = Date.now();
      const r = result as { image?: string; containerId?: string; projectName?: string; containers?: string[]; commit?: string | null };
      await this.db.run(
        `UPDATE application_deployments SET status = 'SUCCESS', image = COALESCE(?, image), container_id = ?, compose_project_name = COALESCE(?, compose_project_name), commit_sha = COALESCE(?, commit_sha), finished_at = ?, duration_ms = ?, error = NULL WHERE id = ?`,
        [r.image ?? null, r.containerId ?? null, r.projectName ?? null, r.commit ?? null, new Date().toISOString(), finishedAt - startedAt, dep.id],
      );
      await this.db.run(
        `UPDATE applications SET status = 'RUNNING', last_deployment_id = ?, current_image = COALESCE(?, current_image), current_container_id = COALESCE(?, current_container_id), updated_at = ? WHERE id = ?`,
        [dep.id, r.image ?? null, r.containerId ?? null, new Date().toISOString(), app.id],
      );

      await log("Deployment successful");
      eventHub.emit({ type: "deployment.status", deployment: await this.getPublic(dep.id) });
      await this.ctx.audit({ action: "deployment.success", resourceType: "deployment", resourceId: dep.id, resourceName: app.name, serverId: dep.server_id });

      const owner = await this.db.get<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`);
      if (owner) {
        const { NotificationsService } = await import("./notifications.service");
        await new NotificationsService(this.db).create(owner.id, "deployment.success", "Deployment successful", `${app.name} deployed successfully (${dep.id})`);
      }

      await this.applyRetention(app.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = (err as { retryable?: boolean }).retryable === true;
      await log(`Deployment failed: ${message}`, "stderr");
      await this.db.run(`UPDATE application_deployments SET status = ?, finished_at = ?, duration_ms = ?, error = ? WHERE id = ?`, [
        retryable ? "WAITING_FOR_SERVER" : "FAILED",
        new Date().toISOString(),
        dep.started_at ? Date.now() - new Date(dep.started_at).getTime() : null,
        message,
        dep.id,
      ]);
      if (!retryable) {
        await this.db.run(`UPDATE applications SET status = 'FAILED', updated_at = ? WHERE id = ?`, [new Date().toISOString(), app.id]);
      }
      eventHub.emit({ type: "deployment.status", deployment: await this.getPublic(dep.id) });
      await this.ctx.audit({ action: "deployment.failed", resourceType: "deployment", resourceId: dep.id, resourceName: app.name, serverId: dep.server_id, metadata: { error: message } });
      const owner = await this.db.get<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`);
      if (owner) {
        const { NotificationsService } = await import("./notifications.service");
        await new NotificationsService(this.db).create(owner.id, "deployment.failed", "Deployment failed", `${app.name} failed: ${message}`);
      }
      throw Object.assign(new Error(message), { retryable });
    }
  }

  private async buildDeploymentEnv(app: ApplicationRow): Promise<Record<string, string>> {
    const { ApplicationsService } = await import("./applications.service");
    const apps = new ApplicationsService(this.db, this.ctx);
    const env = await apps.buildEnvMap(app.id);
    env.NEXUS_APP_ID = app.id;
    env.NEXUS_APP_NAME = app.name;
    return env;
  }

  /** Keep the last N deployments (retention setting) — drop older rows + logs. */
  private async applyRetention(applicationId: string): Promise<void> {
    const settings = new SettingsService(this.db);
    const keep = (await settings.get()).retention.deployments;
    const rows = await this.db.all<DeploymentRow>(
      `SELECT id FROM application_deployments WHERE application_id = ? AND status = 'SUCCESS' ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
      [applicationId, keep],
    );
    for (const old of rows) {
      await this.db.run(`DELETE FROM deployment_logs WHERE deployment_id = ?`, [old.id]);
      await this.db.run(`DELETE FROM application_deployments WHERE id = ? AND application_id = ?`, [old.id, applicationId]);
    }
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
}
