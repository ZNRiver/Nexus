import type { BackupRow, DbConnection, ApplicationRow, EnvironmentVariableRow, DeploymentRow, ServerRow, DomainRow } from "@nexus/database";
import { decrypt, encrypt, newId } from "../lib/crypto";
import { errors } from "../lib/errors";
import type { Application, ApplicationWithExtras, Backup, CreateApplicationInput, DeploymentMethod, Domain, EnvironmentVariable, HealthcheckConfig } from "@nexus/types";
import type { AppContext } from "../context";
import { JobQueue } from "../jobs/queue";
import { nextRun, parseCron } from "../lib/cron";

export function toApplication(row: ApplicationRow): Application {
  let healthcheck: HealthcheckConfig | null = null;
  if (row.healthcheck) {
    try {
      healthcheck = JSON.parse(row.healthcheck) as HealthcheckConfig;
    } catch {
      healthcheck = null;
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    serverId: row.server_id,
    name: row.name,
    description: row.description,
    repository: row.repository,
    branch: row.branch,
    provider: row.provider,
    triggerType: (row.trigger_type ?? "MANUAL") as Application["triggerType"],
    deploymentMethod: row.deployment_method as DeploymentMethod,
    dockerfilePath: row.dockerfile_path,
    buildContext: row.build_context,
    composePath: row.compose_path,
    composeProjectName: row.compose_project_name,
    port: row.port,
    startCommand: row.start_command,
    healthcheck,
    restartPolicy: row.restart_policy as Application["restartPolicy"],
    autodeploy: !!row.autodeploy,
    cpuLimit: row.cpu_limit,
    memoryLimitBytes: row.memory_limit_bytes,
    memoryReservationBytes: row.memory_reservation_bytes,
    pidsLimit: row.pids_limit,
    volumeName: row.volume_name,
    volumeMountPath: row.volume_mount_path,
    registry: row.registry,
    registryUsername: row.registry_username,
    status: row.status as Application["status"],
    lastDeploymentId: row.last_deployment_id,
    currentImage: row.current_image,
    currentContainerId: row.current_container_id,
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

export class ApplicationsService {
  constructor(
    private readonly db: DbConnection,
    private readonly ctx: AppContext,
  ) {}

  async list(opts: { projectId?: string; serverId?: string; limit: number; cursor?: string }): Promise<{ items: ApplicationWithExtras[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.projectId) {
      where.push("a.project_id = ?");
      params.push(opts.projectId);
    }
    if (opts.serverId) {
      where.push("a.server_id = ?");
      params.push(opts.serverId);
    }
    if (opts.cursor) {
      where.push("a.created_at <= ?");
      params.push(opts.cursor);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await this.db.all<ApplicationRow>(
      `SELECT a.* FROM applications a ${whereSql} ORDER BY a.created_at DESC LIMIT ?`,
      [...params, opts.limit + 1],
    );
    const hasMore = rows.length > opts.limit;
    const items = rows.slice(0, opts.limit).map((r) => toApplication(r));
    const extras = await Promise.all(
      items.map(async (app) => {
        const [server, project, deploymentCount, envVarCount, domainCount, currentDeployment] = await Promise.all([
          app.serverId ? this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [app.serverId]) : null,
          app.projectId ? this.db.get(`SELECT * FROM projects WHERE id = ?`, [app.projectId]) : null,
          this.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM application_deployments WHERE application_id = ?`, [app.id]),
          this.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM environment_variables WHERE application_id = ?`, [app.id]),
          this.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM domains WHERE application_id = ?`, [app.id]),
          app.lastDeploymentId ? this.db.get<DeploymentRow>(`SELECT * FROM application_deployments WHERE id = ?`, [app.lastDeploymentId]) : null,
        ]);
        return {
          ...app,
          server: server ? this.toServerPublic(server) : null,
          project: project as never,
          deploymentCount: Number(deploymentCount?.c ?? 0),
          envVarCount: Number(envVarCount?.c ?? 0),
          domainCount: Number(domainCount?.c ?? 0),
          currentDeployment: currentDeployment ? this.toDeployment(currentDeployment) : undefined,
        } as ApplicationWithExtras;
      }),
    );
    return { items: extras, nextCursor: hasMore ? items[items.length - 1]?.createdAt ?? null : null };
  }

  async get(id: string): Promise<ApplicationRow> {
    const row = await this.db.get<ApplicationRow>(`SELECT * FROM applications WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Application not found");
    return row;
  }

  async getPublic(id: string): Promise<Application> {
    return toApplication(await this.get(id));
  }

  async create(input: CreateApplicationInput): Promise<Application> {
    const name = input.name.trim();
    if (name.length < 2) throw errors.validation({ name: "Name must be at least 2 characters" });
    const server = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [input.serverId]);
    if (!server) throw errors.notFound("Server not found");
    if (input.projectId) {
      const project = await this.db.get(`SELECT id FROM projects WHERE id = ?`, [input.projectId]);
      if (!project) throw errors.notFound("Project not found");
    }

    const method: DeploymentMethod = input.deploymentMethod === "COMPOSE" ? "COMPOSE" : "DOCKERFILE";
    const now = new Date().toISOString();
    const appId = newId("app");
    const row: ApplicationRow = {
      id: appId,
      project_id: input.projectId ?? null,
      server_id: input.serverId,
      name,
      description: input.description ?? null,
      repository: input.repository.trim(),
      branch: input.branch ?? "main",
      provider: input.provider ?? null,
      trigger_type: input.triggerType ?? "MANUAL",
      deployment_method: method,
      dockerfile_path: method === "DOCKERFILE" ? (input.dockerfilePath ?? "Dockerfile") : "Dockerfile",
      build_context: method === "DOCKERFILE" ? (input.buildContext ?? ".") : ".",
      compose_path: method === "COMPOSE" ? (input.composePath ?? "docker-compose.yml") : "docker-compose.yml",
      compose_project_name: method === "COMPOSE" ? `nexus_${appId.replace("app_", "app_")}` : null,
      port: input.port ?? null,
      start_command: input.startCommand ?? null,
      healthcheck: input.healthcheck ? JSON.stringify(input.healthcheck) : null,
      restart_policy: input.restartPolicy ?? "unless-stopped",
      cpu_limit: input.cpuLimit ?? null,
      memory_limit_bytes: input.memoryLimitBytes ?? null,
      memory_reservation_bytes: input.memoryReservationBytes ?? null,
      pids_limit: input.pidsLimit ?? null,
      volume_name: input.volumeName ?? null,
      volume_mount_path: input.volumeMountPath ?? null,
      registry: input.registry ?? null,
      registry_username: input.registryUsername ?? null,
      registry_password_encrypted: input.registryPassword ? encrypt(input.registryPassword, this.ctx.config.encryptionKey) : null,
      status: "NOT_DEPLOYED",
      autodeploy: input.autodeploy ? 1 : 0,
      last_deployment_id: null,
      current_image: null,
      current_container_id: null,
      backup_schedule_enabled: false,
      backup_schedule_cron: null,
      backup_retention: 7,
      backup_next_run_at: null,
      backup_last_run_at: null,
      created_at: now,
      updated_at: now,
    };

    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO applications (id, project_id, server_id, name, description, repository, branch, provider, trigger_type, deployment_method, dockerfile_path, build_context, compose_path, compose_project_name, port, start_command, healthcheck, restart_policy, autodeploy, cpu_limit, memory_limit_bytes, memory_reservation_bytes, pids_limit, volume_name, volume_mount_path, registry, registry_username, registry_password_encrypted, status, last_deployment_id, current_image, current_container_id, backup_schedule_enabled, backup_schedule_cron, backup_retention, backup_next_run_at, backup_last_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.project_id, row.server_id, row.name, row.description, row.repository, row.branch, row.provider, row.trigger_type, row.deployment_method, row.dockerfile_path, row.build_context, row.compose_path, row.compose_project_name, row.port, row.start_command, row.healthcheck, row.restart_policy, input.autodeploy ? 1 : 0, row.cpu_limit, row.memory_limit_bytes, row.memory_reservation_bytes, row.pids_limit, row.volume_name, row.volume_mount_path, row.registry, row.registry_username, row.registry_password_encrypted, row.status, row.last_deployment_id, row.current_image, row.current_container_id, row.backup_schedule_enabled, row.backup_schedule_cron, row.backup_retention, row.backup_next_run_at, row.backup_last_run_at, row.created_at, row.updated_at],
      );
      // Initial environment variables
      for (const env of input.environment ?? []) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env.key)) continue;
        await tx.run(
          `INSERT INTO environment_variables (id, application_id, database_id, game_server_id, var_key, value_encrypted, is_secret, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
          [newId("env"), appId, env.key, encrypt(env.value, this.ctx.config.encryptionKey), env.isSecret ? 1 : 0, now, now],
        );
      }
    });

    await this.ctx.audit({ action: "application.create", resourceType: "application", resourceId: appId, resourceName: name, serverId: input.serverId });
    return toApplication(row);
  }

  async update(id: string, patch: Partial<CreateApplicationInput>): Promise<Application> {
    const row = await this.get(id);
    const fields: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown) => {
      fields.push(`${col} = ?`);
      params.push(value);
    };
    if (patch.name) set("name", patch.name.trim());
    if (patch.description !== undefined) set("description", patch.description);
    if (patch.branch) set("branch", patch.branch);
    if (patch.repository) set("repository", patch.repository.trim());
    if (patch.provider !== undefined) set("provider", patch.provider);
    if (patch.triggerType !== undefined) set("trigger_type", patch.triggerType);
    if (patch.deploymentMethod !== undefined) set("deployment_method", patch.deploymentMethod);
    if (patch.dockerfilePath !== undefined) set("dockerfile_path", patch.dockerfilePath);
    if (patch.buildContext !== undefined) set("build_context", patch.buildContext);
    if (patch.composePath !== undefined) set("compose_path", patch.composePath);
    if (patch.port !== undefined) set("port", patch.port);
    if (patch.startCommand !== undefined) set("start_command", patch.startCommand);
    if (patch.healthcheck !== undefined) set("healthcheck", patch.healthcheck ? JSON.stringify(patch.healthcheck) : null);
    if (patch.restartPolicy !== undefined) set("restart_policy", patch.restartPolicy);
    if (patch.autodeploy !== undefined) set("autodeploy", patch.autodeploy ? 1 : 0);
    if (patch.cpuLimit !== undefined) set("cpu_limit", patch.cpuLimit);
    if (patch.memoryLimitBytes !== undefined) set("memory_limit_bytes", patch.memoryLimitBytes);
    if (patch.memoryReservationBytes !== undefined) set("memory_reservation_bytes", patch.memoryReservationBytes);
    if (patch.pidsLimit !== undefined) set("pids_limit", patch.pidsLimit);
    if (patch.volumeName !== undefined) set("volume_name", patch.volumeName);
    if (patch.volumeMountPath !== undefined) set("volume_mount_path", patch.volumeMountPath);
    if (patch.registry !== undefined) set("registry", patch.registry);
    if (patch.registryUsername !== undefined) set("registry_username", patch.registryUsername);
    if (patch.registryPassword !== undefined) set("registry_password_encrypted", encrypt(patch.registryPassword, this.ctx.config.encryptionKey));

    if (fields.length === 0) return toApplication(row);
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    await this.db.run(`UPDATE applications SET ${fields.join(", ")} WHERE id = ?`, params);
    return this.getPublic(id);
  }

  async remove(id: string, opts: { destroyResources?: boolean } = {}): Promise<void> {
    const row = await this.get(id);
    if (opts.destroyResources) {
      const hub = this.ctx.hub;
      if (hub.isOnline(row.server_id)) {
        try {
          // Remove the application's container(s)
          const containers = await hub.request(row.server_id, "docker.ps", {}) as { id: string; name: string; labels: Record<string, string> }[];
          const mine = containers.filter((c) => c.labels?.["nexus.application"] === id || c.labels?.["com.docker.compose.project"] === `nexus_${id.replace("app_", "app_")}`);
          for (const c of mine) {
            await hub.request(row.server_id, "container.remove", { id: c.id, force: true, volumes: false }).catch(() => {});
          }
          if (row.volume_name) {
            await hub.request(row.server_id, "volume.remove", { name: row.volume_name, force: false }).catch(() => {});
          }
        } catch {
          /* resources cleaned best-effort */
        }
      }
    }
    await this.db.run(`DELETE FROM applications WHERE id = ?`, [id]);
    await this.ctx.audit({ action: "application.delete", resourceType: "application", resourceId: id, resourceName: row.name, serverId: row.server_id });
  }

  /** Trigger a deployment: creates a Deployment + enqueues a job. */
  async deploy(id: string, opts: { branch?: string; commit?: string; userId?: string; userName?: string }): Promise<{ deploymentId: string }> {
    const app = await this.get(id);
    const server = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [app.server_id]);
    if (!server) throw errors.notFound("Server not found");

    const now = new Date().toISOString();
    const deploymentId = newId("dep");
    await this.db.run(
      `INSERT INTO application_deployments (id, application_id, server_id, status, commit_sha, branch, created_at, triggered_by, triggered_by_name)
       VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?)`,
      [deploymentId, id, app.server_id, opts.commit ?? null, opts.branch ?? app.branch, now, opts.userId ?? null, opts.userName ?? null],
    );
    await this.db.run(`UPDATE applications SET status = 'DEPLOYING', updated_at = ? WHERE id = ?`, [now, id]);

    const queue = new JobQueue(this.db);
    await queue.enqueue("deployment", { deploymentId, applicationId: id });

    await this.ctx.audit({ action: "application.deploy", resourceType: "deployment", resourceId: deploymentId, resourceName: app.name, serverId: app.server_id });
    return { deploymentId };
  }

  /** Rollback to a previous successful deployment. */
  async rollback(id: string, targetDeploymentId: string, userId?: string, userName?: string): Promise<{ deploymentId: string }> {
    const app = await this.get(id);
    const target = await this.db.get<DeploymentRow>(`SELECT * FROM application_deployments WHERE id = ? AND application_id = ?`, [targetDeploymentId, id]);
    if (!target) throw errors.notFound("Deployment not found");
    if (target.status !== "SUCCESS") throw errors.conflict("Only successful deployments can be rolled back to");
    if (app.deployment_method === "DOCKERFILE" && !target.image) throw errors.conflict("The target deployment has no image to restore");

    const now = new Date().toISOString();
    const deploymentId = newId("dep");
    await this.db.run(
      `INSERT INTO application_deployments (id, application_id, server_id, status, commit_sha, branch, image, created_at, triggered_by, triggered_by_name, rollback_from)
       VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?)`,
      [deploymentId, id, app.server_id, target.commit_sha, app.branch, target.image ?? null, now, userId ?? null, userName ?? null, targetDeploymentId],
    );
    await this.db.run(`UPDATE applications SET status = 'DEPLOYING', updated_at = ? WHERE id = ?`, [now, id]);

    const queue = new JobQueue(this.db);
    await queue.enqueue("deployment", { deploymentId, applicationId: id, rollbackFrom: targetDeploymentId });

    await this.ctx.audit({ action: "deployment.rollback", resourceType: "deployment", resourceId: deploymentId, resourceName: app.name, serverId: app.server_id, metadata: { from: targetDeploymentId } });
    return { deploymentId };
  }

  /* ── environment variables ──────────────────────────────────── */

  async listEnvVars(applicationId: string): Promise<EnvironmentVariable[]> {
    await this.get(applicationId);
    const rows = await this.db.all<EnvironmentVariableRow>(`SELECT * FROM environment_variables WHERE application_id = ? ORDER BY var_key ASC`, [applicationId]);
    return rows.map((r) => ({
      id: r.id,
      applicationId: r.application_id,
      databaseId: r.database_id,
      gameServerId: r.game_server_id,
      key: r.var_key,
      valueMasked: this.maskValue(r.value_encrypted),
      isSecret: !!r.is_secret,
      updatedAt: r.updated_at,
    }));
  }

  async upsertEnvVar(applicationId: string, key: string, value: string, isSecret: boolean): Promise<EnvironmentVariable> {
    await this.get(applicationId);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw errors.validation({ key: "Invalid environment variable name" });
    const now = new Date().toISOString();
    const encrypted = encrypt(value, this.ctx.config.encryptionKey);
    const existing = await this.db.get<EnvironmentVariableRow>(`SELECT * FROM environment_variables WHERE application_id = ? AND var_key = ?`, [applicationId, key]);
    if (existing) {
      await this.db.run(`UPDATE environment_variables SET value_encrypted = ?, is_secret = ?, updated_at = ? WHERE id = ?`, [encrypted, isSecret ? 1 : 0, now, existing.id]);
      await this.ctx.audit({ action: "environment.update", resourceType: "application", resourceId: applicationId, resourceName: key, serverId: null });
      return { id: existing.id, applicationId, databaseId: existing.database_id, gameServerId: existing.game_server_id, key, valueMasked: this.maskValue(encrypted), isSecret, updatedAt: now };
    }
    const id = newId("env");
    await this.db.run(
      `INSERT INTO environment_variables (id, application_id, database_id, game_server_id, var_key, value_encrypted, is_secret, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      [id, applicationId, key, encrypted, isSecret ? 1 : 0, now, now],
    );
    await this.ctx.audit({ action: "environment.create", resourceType: "application", resourceId: applicationId, resourceName: key, serverId: null });
    return { id, applicationId, databaseId: null, gameServerId: null, key, valueMasked: this.maskValue(encrypted), isSecret, updatedAt: now };
  }

  /** Replace the whole env map from a text-editor save (KEY=VALUE lines). */
  async syncEnvVars(applicationId: string, variables: { key: string; value: string; isSecret?: boolean }[]): Promise<EnvironmentVariable[]> {
    await this.get(applicationId);
    const now = new Date().toISOString();
    const seen = new Set<string>();
    const saved: EnvironmentVariable[] = [];
    const result = await this.db.transaction(async (tx) => {
      for (const v of variables) {
        const key = v.key.trim();
        if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        if (seen.has(key)) continue; // last occurrence wins
        seen.add(key);
        const existing = await tx.get<EnvironmentVariableRow>(`SELECT * FROM environment_variables WHERE application_id = ? AND var_key = ?`, [applicationId, key]);
        const isSecret = !!v.isSecret;
        let encrypted: string;
        if (existing && isSecret && /^[•*]+$/.test(v.value.trim())) {
          // Masked value sent back from the text editor — keep the stored secret.
          encrypted = existing.value_encrypted;
        } else {
          encrypted = encrypt(v.value, this.ctx.config.encryptionKey);
        }
        if (existing) {
          await tx.run(`UPDATE environment_variables SET value_encrypted = ?, is_secret = ?, updated_at = ? WHERE id = ?`, [encrypted, isSecret ? 1 : 0, now, existing.id]);
          saved.push({ id: existing.id, applicationId, databaseId: existing.database_id, gameServerId: existing.game_server_id, key, valueMasked: this.maskValue(encrypted), isSecret, updatedAt: now });
        } else {
          const id = newId("env");
          await tx.run(
            `INSERT INTO environment_variables (id, application_id, database_id, game_server_id, var_key, value_encrypted, is_secret, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
            [id, applicationId, key, encrypted, isSecret ? 1 : 0, now, now],
          );
          saved.push({ id, applicationId, databaseId: null, gameServerId: null, key, valueMasked: this.maskValue(encrypted), isSecret, updatedAt: now });
        }
      }
      // Remove variables that were deleted from the editor.
      const keys = variables.map((v) => v.key.trim()).filter(Boolean);
      if (keys.length === 0) {
        await tx.run(`DELETE FROM environment_variables WHERE application_id = ?`, [applicationId]);
      } else {
        await tx.run(`DELETE FROM environment_variables WHERE application_id = ? AND var_key NOT IN (${keys.map(() => "?").join(",")})`, [applicationId, ...keys]);
      }
      return saved;
    });
    await this.ctx.audit({ action: "environment.sync", resourceType: "application", resourceId: applicationId, resourceName: `${variables.length} variables`, serverId: null });
    return result;
  }

  async deleteEnvVar(applicationId: string, envId: string): Promise<void> {
    const row = await this.db.get<EnvironmentVariableRow>(`SELECT * FROM environment_variables WHERE id = ? AND application_id = ?`, [envId, applicationId]);
    if (!row) throw errors.notFound("Environment variable not found");
    await this.db.run(`DELETE FROM environment_variables WHERE id = ?`, [envId]);
    await this.ctx.audit({ action: "environment.delete", resourceType: "application", resourceId: applicationId, resourceName: row.var_key, serverId: null });
  }

  async revealEnvValue(applicationId: string, envId: string): Promise<{ value: string }> {
    const row = await this.db.get<EnvironmentVariableRow>(`SELECT * FROM environment_variables WHERE id = ? AND application_id = ?`, [envId, applicationId]);
    if (!row) throw errors.notFound("Environment variable not found");
    return { value: decrypt(row.value_encrypted, this.ctx.config.encryptionKey) };
  }

  /** Decrypted env map for a deployment. */
  async buildEnvMap(applicationId: string): Promise<Record<string, string>> {
    const rows = await this.db.all<EnvironmentVariableRow>(`SELECT * FROM environment_variables WHERE application_id = ?`, [applicationId]);
    const map: Record<string, string> = {};
    for (const r of rows) {
      try {
        map[r.var_key] = decrypt(r.value_encrypted, this.ctx.config.encryptionKey);
      } catch {
        /* skip corrupted */
      }
    }
    return map;
  }

  private maskValue(encrypted: string): string {
    const value = decrypt(encrypted, this.ctx.config.encryptionKey);
    if (value.length === 0) return "";
    if (value.length <= 6) return "•".repeat(value.length);
    return `${value.slice(0, 2)}${"•".repeat(8)}${value.slice(-1)}`;
  }

  /* ── domains ────────────────────────────────────────────────── */

  async listDomains(applicationId: string): Promise<Domain[]> {
    await this.get(applicationId);
    const rows = await this.db.all<DomainRow>(`SELECT * FROM domains WHERE application_id = ? ORDER BY created_at ASC`, [applicationId]);
    return rows.map((r) => ({
      id: r.id,
      applicationId: r.application_id,
      hostname: r.hostname,
      isPrimary: !!r.is_primary,
      sslEnabled: !!r.ssl_enabled,
      sslStatus: r.ssl_status as Domain["sslStatus"],
      createdAt: r.created_at,
    }));
  }

  async addDomain(applicationId: string, hostname: string, sslEnabled: boolean, isPrimary: boolean): Promise<Domain> {
    await this.get(applicationId);
    const h = hostname.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)) {
      throw errors.validation({ hostname: "Invalid hostname" });
    }
    const existing = await this.db.get<DomainRow>(`SELECT * FROM domains WHERE application_id = ? AND hostname = ?`, [applicationId, h]);
    if (existing) throw errors.conflict("This domain is already attached to the application");
    const id = newId("dom");
    await this.db.run(
      `INSERT INTO domains (id, application_id, hostname, is_primary, ssl_enabled, ssl_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, applicationId, h, isPrimary ? 1 : 0, sslEnabled ? 1 : 0, sslEnabled ? "PENDING" : "DISABLED", new Date().toISOString()],
    );
    if (isPrimary) {
      await this.db.run(`UPDATE domains SET is_primary = 0 WHERE application_id = ? AND id != ?`, [applicationId, id]);
    }
    await this.ctx.audit({ action: "domain.create", resourceType: "domain", resourceId: id, resourceName: h, serverId: null });
    return { id, applicationId, hostname: h, isPrimary, sslEnabled, sslStatus: sslEnabled ? "PENDING" : "DISABLED", createdAt: new Date().toISOString() };
  }

  async removeDomain(applicationId: string, domainId: string): Promise<void> {
    const row = await this.db.get<DomainRow>(`SELECT * FROM domains WHERE id = ? AND application_id = ?`, [domainId, applicationId]);
    if (!row) throw errors.notFound("Domain not found");
    await this.db.run(`DELETE FROM domains WHERE id = ?`, [domainId]);
    await this.ctx.audit({ action: "domain.delete", resourceType: "domain", resourceId: domainId, resourceName: row.hostname, serverId: null });
  }

  /* ── Volume backups (application persistent data) ────────────── */

  async createBackup(applicationId: string, opts: { scheduled?: boolean } = {}): Promise<Backup> {
    const row = await this.get(applicationId);
    if (!row.volume_name) throw errors.conflict("This application has no persistent volume — nothing to back up");
    const id = newId("bak");
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO backups (id, database_id, application_id, server_id, type, status, created_at) VALUES (?, NULL, ?, ?, 'VOLUME', 'PENDING', ?)`,
      [id, applicationId, row.server_id, now],
    );
    const queue = new JobQueue(this.db);
    await queue.enqueue("application-backup", { backupId: id, applicationId, scheduled: opts.scheduled ?? false });
    await this.ctx.audit({ action: "backup.create", resourceType: "backup", resourceId: id, resourceName: row.name, serverId: row.server_id });
    return this.getBackup(id);
  }

  /** Job handler — snapshots the application's volume via the agent. */
  async runBackup(job: { payload: unknown }): Promise<void> {
    const payload = job.payload as { backupId: string; applicationId: string };
    const backup = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [payload.backupId]);
    if (!backup) return;
    const app = await this.get(payload.applicationId);
    if (!app.volume_name) throw new Error("Application has no volume to back up");
    const hub = this.ctx.hub;
    if (!hub.isOnline(app.server_id)) throw Object.assign(new Error("Server offline — backup will retry"), { retryable: true });

    await this.db.run(`UPDATE backups SET status = 'RUNNING', started_at = ? WHERE id = ?`, [new Date().toISOString(), backup.id]);
    try {
      const fileName = `${app.id}_${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`;
      const result = await hub.request(app.server_id, "volume.backup", {
        backupId: backup.id,
        applicationId: app.id,
        volumeName: app.volume_name,
        fileName,
      } as never, { timeoutMs: 15 * 60 * 1000 }) as { path: string; sizeBytes: number };
      await this.db.run(
        `UPDATE backups SET status = 'SUCCESS', path = ?, size_bytes = ?, finished_at = ? WHERE id = ?`,
        [result.path, result.sizeBytes, new Date().toISOString(), backup.id],
      );
      const owner = await this.db.get<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`);
      if (owner) {
        const { NotificationsService } = await import("./notifications.service");
        await new NotificationsService(this.db).create(owner.id, "database.backup.completed", "Backup completed", `Volume backup for ${app.name} completed (${Math.round(result.sizeBytes / 1024)} KB)`);
      }
      // External notification (webhook/email) for scheduled backups.
      if ((payload as { scheduled?: boolean }).scheduled) {
        const { NotifierService } = await import("./notifier.service");
        const { SettingsService } = await import("./settings.service");
        await new NotifierService(this.db, new SettingsService(this.db)).notifyBackupResult({ backupId: backup.id, scheduled: true }).catch(() => {});
      }
      // Enforce retention: keep only the newest N successful backups.
      await this.pruneBackups(app.id).catch((e) => {
        this.ctx.logger?.warn("volume backup retention prune failed", { applicationId: app.id, error: e instanceof Error ? e.message : String(e) });
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

  /**
   * Restore a volume snapshot into the application's volume. The container is
   * stopped before the restore and started again afterwards so no process
   * writes to the volume while it is being replaced (concurrent writes would
   * corrupt data or get lost). If the container was not running, it stays
   * stopped.
   */
  async restoreBackup(backupId: string): Promise<void> {
    const backup = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [backupId]);
    if (!backup) throw errors.notFound("Backup not found");
    if (backup.status !== "SUCCESS" || !backup.path) throw errors.conflict("Only completed backups can be restored");
    if (!backup.application_id) throw errors.conflict("This backup is not attached to an application");
    const app = await this.get(backup.application_id);
    const hub = this.ctx.hub;
    if (!hub.isOnline(app.server_id)) throw errors.serverOffline();

    const wasRunning = !!app.current_container_id && app.status === "RUNNING";
    try {
      // 1. Stop the container so the volume is quiescent during the restore.
      if (wasRunning && app.current_container_id) {
        await hub.request(app.server_id, "container.stop", { id: app.current_container_id, timeoutSeconds: 15 });
        await this.db.run(`UPDATE applications SET status = 'STOPPED', updated_at = ? WHERE id = ?`, [new Date().toISOString(), app.id]);
      }

      // 2. Replace the volume contents from the snapshot.
      await hub.request(app.server_id, "volume.restore", {
        backupId: backup.id,
        applicationId: app.id,
        volumeName: app.volume_name ?? `nexus-app-${app.id.replace("app_", "")}`,
        filePath: backup.path,
      } as never, { timeoutMs: 15 * 60 * 1000 });

      // 3. Bring the container back up if it was running before.
      if (wasRunning && app.current_container_id) {
        await hub.request(app.server_id, "container.start", { id: app.current_container_id });
        await this.db.run(`UPDATE applications SET status = 'RUNNING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), app.id]);
      }
    } catch (err) {
      // Best-effort: if the restore failed but we stopped the container, try to
      // bring it back up so the app is not left down.
      if (wasRunning && app.current_container_id) {
        await hub.request(app.server_id, "container.start", { id: app.current_container_id }).catch(() => {});
        await this.db.run(`UPDATE applications SET status = 'RUNNING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), app.id]).catch(() => {});
      }
      throw err;
    }

    await this.ctx.audit({ action: "backup.restore", resourceType: "backup", resourceId: backupId, resourceName: app.name, serverId: app.server_id, metadata: { stoppedAndRestarted: wasRunning } });
  }

  async listBackups(applicationId: string): Promise<Backup[]> {
    await this.get(applicationId);
    const rows = await this.db.all<BackupRow>(`SELECT * FROM backups WHERE application_id = ? ORDER BY created_at DESC`, [applicationId]);
    return rows.map((r) => this.toBackup(r));
  }

  async getBackup(id: string): Promise<Backup> {
    const row = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Backup not found");
    return this.toBackup(row);
  }

  /* ── Scheduled volume backups ────────────────────────────────── */

  /** Persist the backup schedule; computes the next run when enabled. */
  async updateBackupSchedule(applicationId: string, input: { enabled: boolean; cron?: string; retention?: number }): Promise<Application> {
    const row = await this.get(applicationId);
    const cron = (input.cron ?? row.backup_schedule_cron ?? "0 2 * * *").trim();
    const parsed = parseCron(cron);
    if (!parsed) throw errors.validation({ cron: "Invalid cron expression — expected 5 fields (minute hour day month weekday)" });
    const retention = Math.max(1, Math.min(365, Math.round(input.retention ?? row.backup_retention ?? 7)));
    const next = input.enabled ? nextRun(parsed, new Date()) : null;
    await this.db.run(
      `UPDATE applications SET backup_schedule_enabled = ?, backup_schedule_cron = ?, backup_retention = ?, backup_next_run_at = ?, updated_at = ? WHERE id = ?`,
      [input.enabled ? 1 : 0, cron, retention, next ? next.toISOString() : null, new Date().toISOString(), applicationId],
    );
    await this.ctx.audit({
      action: input.enabled ? "application.backup-schedule.enabled" : "application.backup-schedule.disabled",
      resourceType: "application",
      resourceId: applicationId,
      resourceName: row.name,
      serverId: row.server_id,
      metadata: { cron, retention },
    });
    return this.getPublic(applicationId);
  }

  /** Scheduler tick — enqueue volume backups whose schedule is due. */
  async runDueBackups(): Promise<number> {
    const now = new Date();
    const rows = await this.db.all<ApplicationRow>(
      `SELECT * FROM applications WHERE backup_schedule_enabled = 1 AND backup_next_run_at IS NOT NULL AND backup_next_run_at <= ?`,
      [now.toISOString()],
    );
    let started = 0;
    for (const row of rows) {
      const parsed = parseCron(row.backup_schedule_cron ?? "0 2 * * *");
      if (!parsed) {
        await this.db.run(`UPDATE applications SET backup_schedule_enabled = 0, backup_next_run_at = NULL WHERE id = ?`, [row.id]);
        continue;
      }
      if (!row.volume_name) {
        // No volume — can't back up. Disable so the row stops being picked up.
        await this.db.run(`UPDATE applications SET backup_schedule_enabled = 0, backup_next_run_at = NULL WHERE id = ?`, [row.id]);
        continue;
      }
      const backup = await this.createBackup(row.id, { scheduled: true });
      const next = nextRun(parsed, new Date());
      await this.db.run(
        `UPDATE applications SET backup_last_run_at = ?, backup_next_run_at = ?, updated_at = ? WHERE id = ?`,
        [now.toISOString(), next ? next.toISOString() : null, new Date().toISOString(), row.id],
      );
      await this.ctx.audit({ action: "application.backup-schedule.run", resourceType: "backup", resourceId: backup.id, resourceName: row.name, serverId: row.server_id });
      started++;
    }
    return started;
  }

  /** Retention — keep the newest N successful volume backups for an app. */
  async pruneBackups(applicationId: string): Promise<number> {
    const row = await this.get(applicationId);
    const keep = Math.max(1, row.backup_retention ?? 7);
    const backups = await this.db.all<BackupRow>(
      `SELECT * FROM backups WHERE application_id = ? AND status = 'SUCCESS' AND path IS NOT NULL ORDER BY created_at DESC`,
      [applicationId],
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

  private toBackup(r: BackupRow): Backup {
    return {
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
    };
  }

  private toServerPublic(row: ServerRow) {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      os: row.os,
      arch: row.arch,
      hostname: row.hostname,
      dockerAvailable: !!row.docker_available,
      lastHeartbeatAt: row.last_heartbeat_at,
    };
  }

  private toDeployment(row: DeploymentRow) {
    return {
      id: row.id,
      applicationId: row.application_id,
      serverId: row.server_id,
      status: row.status,
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
}
