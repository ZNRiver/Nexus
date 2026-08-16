/**
 * NEXUS — shared domain types.
 * Single source of truth consumed by the dashboard, the API and the Agent.
 */

/* ── IDs ─────────────────────────────────────────────────────────── */
export type ID = string;

/* ── Users / sessions ────────────────────────────────────────────── */
export type Role = "owner" | "admin" | "developer" | "viewer";

export interface User {
  id: ID;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInfo {
  id: ID;
  userId: ID;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  userAgent?: string;
  ip?: string;
  current: boolean;
}

/* ── Servers ─────────────────────────────────────────────────────── */
export type ServerType = "local" | "remote";
export type ServerStatus =
  | "CONNECTING"
  | "ONLINE"
  | "OFFLINE"
  | "ERROR"
  | "INSTALLING"
  | "MAINTENANCE";

export type SshAuthMethod = "password" | "privateKey";

export interface Server {
  id: ID;
  name: string;
  type: ServerType;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  /** true when SSH credentials are stored (encrypted) — enough to re-provision */
  hasCredentials: boolean;
  status: ServerStatus;
  agentId?: ID | null;
  agentVersion?: string | null;
  /** Optional per-server override for the URL the remote agent connects back to. */
  agentApiUrl?: string | null;
  os?: string | null;
  arch?: string | null;
  hostname?: string | null;
  cpuModel?: string | null;
  cpuCores?: number | null;
  memoryTotalBytes?: number | null;
  diskTotalBytes?: number | null;
  dockerVersion?: string | null;
  dockerAvailable: boolean;
  lastHeartbeatAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServerSystemInfo {
  hostname: string;
  os: string;
  platform: string;
  arch: string;
  cpuModel?: string;
  cpuCores: number;
  cpuSpeedMhz?: number;
  memoryTotalBytes: number;
  memoryFreeBytes?: number;
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  dockerVersion?: string | null;
  dockerAvailable: boolean;
  kernel?: string;
  uptimeSeconds?: number;
}

export interface ServerWithAgentToken extends Server {
  agentToken?: string;
}

/* ── Projects ────────────────────────────────────────────────────── */
export interface Project {
  id: ID;
  name: string;
  slug: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
  /** populated by the API when listing with counts */
  applicationCount?: number;
  databaseCount?: number;
  gameServerCount?: number;
}

/* ── Applications ────────────────────────────────────────────────── */
export type DeploymentMethod = "DOCKERFILE" | "COMPOSE";
export type TriggerType = "MANUAL" | "ON_PUSH" | "SCHEDULE";
export type ApplicationStatus =
  | "NOT_DEPLOYED"
  | "DEPLOYING"
  | "RUNNING"
  | "STOPPED"
  | "UNHEALTHY"
  | "FAILED";

export type RestartPolicy = "no" | "always" | "on-failure" | "unless-stopped";
export type HealthcheckType = "http" | "tcp";

export interface HealthcheckConfig {
  type: HealthcheckType;
  path?: string;
  port?: number;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  retries?: number;
}

export interface Application {
  id: ID;
  projectId?: ID | null;
  serverId: ID;
  name: string;
  description?: string | null;
  repository: string;
  branch: string;
  /** Explicitly selected source provider (Github / Gitlab / Bitbucket / Gitea / Docker / Git). */
  provider?: string | null;
  /** When deployments are triggered: manual button, on push (webhook) or schedule. */
  triggerType: TriggerType;
  deploymentMethod: DeploymentMethod;
  dockerfilePath: string;
  buildContext: string;
  composePath: string;
  composeProjectName?: string | null;
  port?: number | null;
  startCommand?: string | null;
  healthcheck?: HealthcheckConfig | null;
  restartPolicy: RestartPolicy;
  /** Deploy automatically when the source pushes (requires a webhook/provider integration). */
  autodeploy: boolean;
  cpuLimit?: number | null;
  memoryLimitBytes?: number | null;
  memoryReservationBytes?: number | null;
  pidsLimit?: number | null;
  volumeName?: string | null;
  volumeMountPath?: string | null;
  registry?: string | null;
  registryUsername?: string | null;
  status: ApplicationStatus;
  lastDeploymentId?: ID | null;
  currentImage?: string | null;
  currentContainerId?: string | null;
  /** scheduled automatic volume backups (null when the feature is untouched) */
  backupSchedule?: DatabaseBackupSchedule | null;
  /** Raw .env editor text (comments + ordering). Secret values are masked with dots. */
  environmentText?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationWithExtras extends Application {
  server?: Server | null;
  project?: Project | null;
  deploymentCount?: number;
  envVarCount?: number;
  domainCount?: number;
  currentDeployment?: Deployment | null;
}

/* ── Deployments ─────────────────────────────────────────────────── */
export type DeploymentStatus =
  | "QUEUED"
  | "CLONING"
  | "BUILDING"
  | "PUSHING"
  | "DEPLOYING"
  | "STARTING"
  | "HEALTH_CHECK"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED"
  | "WAITING_FOR_SERVER";

export interface Deployment {
  id: ID;
  applicationId: ID;
  serverId: ID;
  status: DeploymentStatus;
  commit?: string | null;
  branch: string;
  image?: string | null;
  containerId?: string | null;
  composeProjectName?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  triggeredBy?: ID | null;
  triggeredByName?: string | null;
  rollbackFrom?: ID | null;
  createdAt: string;
}

export interface DeploymentLogEntry {
  stream: "stdout" | "stderr" | "system";
  message: string;
  timestamp: string;
}

/** Progress log line for any resource operation (create/deploy/backup/restore). */
export interface ResourceLogEntry {
  id: string;
  resourceType: "database" | "application" | "backup" | "game";
  resourceId: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
  timestamp: string;
}

/* ── Databases ───────────────────────────────────────────────────── */
export type DatabaseType = "POSTGRESQL" | "MYSQL" | "MARIADB" | "REDIS" | "MONGODB" | "INFLUXDB";
export type DatabaseStatus = "CREATING" | "RUNNING" | "STOPPED" | "FAILED" | "REMOVING";

export interface DatabaseBackupSchedule {
  /** whether scheduled backups are enabled for this database */
  enabled: boolean;
  /** 5-field cron expression (minute hour day month weekday) */
  cron: string;
  /** number of backups to keep (older ones are pruned) */
  retention: number;
  /** next scheduled run (ISO) or null when disabled */
  nextRunAt?: string | null;
  /** last scheduled run (ISO) or null when never ran */
  lastRunAt?: string | null;
}

export interface Database {
  id: ID;
  projectId?: ID | null;
  serverId: ID;
  type: DatabaseType;
  version: string;
  name: string;
  description?: string | null;
  /** actual database name inside the engine (defaults to name) */
  dbName?: string | null;
  username?: string | null;
  port: number;
  internalPort: number;
  status: DatabaseStatus;
  image: string;
  containerId?: string | null;
  volumeName?: string | null;
  storageLimitBytes?: number | null;
  maxConnections?: number | null;
  cpuLimit?: number | null;
  memoryLimitBytes?: number | null;
  /** scheduled automatic backups (null when the feature is untouched) */
  backupSchedule?: DatabaseBackupSchedule | null;
  /** Raw .env editor text (comments + ordering). Secret values are masked with dots. */
  environmentText?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseConnectionInfo {
  host: string;
  port: number;
  database: string;
  username: string;
  /** only revealed via explicit action */
  password: string;
  uri: string;
}

export interface DatabaseCredential {
  id: ID;
  databaseId: ID;
  username: string;
  /** masked for display; full value only on explicit reveal */
  passwordMasked: string;
  createdAt: string;
}

/* ── Docker resources ────────────────────────────────────────────── */
export interface ContainerPort {
  ip?: string;
  privatePort: number;
  publicPort?: number;
  type: "tcp" | "udp" | "sctp";
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  imageId?: string;
  state: "created" | "running" | "paused" | "restarting" | "exited" | "dead" | "removing";
  status: string;
  created: string;
  startedAt?: string | null;
  ports: ContainerPort[];
  networks: string[];
  volumes: string[];
  labels: Record<string, string>;
  restartCount?: number;
  exitCode?: number | null;
  cpuPercent?: number | null;
  memoryUsageBytes?: number | null;
  memoryLimitBytes?: number | null;
}

export interface ImageInfo {
  id: string;
  repository: string;
  tag: string;
  sizeBytes: number;
  created: string;
  containers: number;
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  labels: Record<string, string>;
  sizeBytes?: number | null;
  /** containers using this volume */
  usedBy: string[];
}

export interface NetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
  subnet?: string | null;
  gateway?: string | null;
  internal: boolean;
  containers: { id: string; name: string }[];
}

/* ── Environment variables & secrets ─────────────────────────────── */
export interface EnvironmentVariable {
  id: ID;
  applicationId?: ID | null;
  databaseId?: ID | null;
  gameServerId?: ID | null;
  key: string;
  /** masked unless reveal requested */
  valueMasked: string;
  isSecret: boolean;
  updatedAt: string;
}

/* ── Domains ─────────────────────────────────────────────────────── */
export type SslStatus = "DISABLED" | "PENDING" | "ACTIVE" | "FAILED";

export interface Domain {
  id: ID;
  /** owner — exactly one of applicationId / gameServerId is set */
  applicationId?: ID | null;
  gameServerId?: ID | null;
  hostname: string;
  isPrimary: boolean;
  sslEnabled: boolean;
  sslStatus: SslStatus;
  createdAt: string;
}

/* ── Backups ─────────────────────────────────────────────────────── */
export type BackupType = "DATABASE" | "VOLUME";
export type BackupStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";

export interface Backup {
  id: ID;
  databaseId?: ID | null;
  applicationId?: ID | null;
  gameServerId?: ID | null;
  serverId: ID;
  type: BackupType;
  status: BackupStatus;
  sizeBytes?: number | null;
  path?: string | null;
  error?: string | null;
  sha1?: string | null;
  locked?: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
}

/* ── Game servers ────────────────────────────────────────────────── */
export type GameType = "MINECRAFT";
export type MinecraftFlavor = "VANILLA" | "PAPER" | "PURPUR" | "FABRIC" | "FORGE";
export type GameServerStatus = "CREATING" | "RUNNING" | "STOPPED" | "STARTING" | "FAILED" | "REMOVING";

export interface GameServer {
  id: ID;
  serverId: ID;
  projectId?: ID | null;
  name: string;
  game: GameType;
  version: string;
  flavor?: MinecraftFlavor | null;
  image: string;
  port: number;
  memoryBytes: number;
  cpuLimit?: number | null;
  storageBytes: number;
  environment: Record<string, string>;
  status: GameServerStatus;
  containerId?: string | null;
  volumeName?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A cron-based schedule that fires a console command at a fixed time. */
export interface GameSchedule {
  id: ID;
  gameServerId: ID;
  name: string;
  cron: string;
  command: string;
  enabled: boolean;
  onlyOnline: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A network allocation (IP + port) assigned to a game server. */
export interface GameAllocation {
  id: ID;
  gameServerId: ID;
  ip: string;
  port: number;
  notes?: string | null;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

/* ── Metrics ─────────────────────────────────────────────────────── */
export interface ContainerMetric {
  id: string;
  name: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
}

/** Actual per-container state reported by the agent (used to reconcile resource status). */
export interface ManagedContainerState {
  id: string;
  name: string;
  state: "created" | "running" | "paused" | "restarting" | "exited" | "dead" | "removing" | "unknown";
  /** `nexus.type` label — which kind of resource this container belongs to. */
  type?: string;
  /** `nexus.application` / `nexus.database` / `nexus.game` label value. */
  resourceId?: string;
}

export interface SystemMetrics {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryPercent: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  diskPercent: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  uptimeSeconds: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
  containersRunning: number;
  containersTotal: number;
  containerStats: ContainerMetric[];
  /** Actual state of every managed container (has `nexus.managed=true` label). */
  managedContainers?: ManagedContainerState[];
}

export interface MetricsPoint {
  ts: string;
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
  containersRunning: number;
}

/* ── Jobs ────────────────────────────────────────────────────────── */
export type JobType =
  | "deployment"
  | "database-create"
  | "database-backup"
  | "database-restore"
  | "application-backup"
  | "application-restore"
  | "agent-install"
  | "container-operation"
  | "image-pull"
  | "server-sync"
  | "game-server-create"
  | "game-server-reinstall"
  | "game-backup"
  | "cleanup";

export type JobStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";

export interface Job {
  id: ID;
  type: JobType;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/* ── Notifications ───────────────────────────────────────────────── */
export type NotificationType =
  | "deployment.started"
  | "deployment.success"
  | "deployment.failed"
  | "database.created"
  | "application.created"
  | "game.created"
  | "database.backup.started"
  | "database.backup.completed"
  | "backup.restored"
  | "server.offline"
  | "server.online"
  | "server.install-failed"
  | "container.stopped"
  | "ssl.expiring"
  | "system";

export interface Notification {
  id: ID;
  userId: ID;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

/* ── Audit ───────────────────────────────────────────────────────── */
export interface AuditLogEntry {
  id: ID;
  userId?: ID | null;
  userName?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  resourceName?: string | null;
  serverId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  requestId?: string | null;
  createdAt: string;
}

/* ── Settings ────────────────────────────────────────────────────── */
export interface NexusSettings {
  instanceName: string;
  retention: {
    deployments: number;
    deploymentLogDays: number;
    metricsHours: number;
    auditLogDays: number;
  };
  monitoring: {
    intervalSeconds: number;
  };
  security: {
    sessionTtlHours: number;
    maxFailedLogins: number;
    lockoutMinutes: number;
  };
  registry?: {
    username?: string;
    registry?: string;
  };
  /** External notification channels (webhook / SMTP email). */
  notifications?: {
    /** Receive events when a scheduled backup completes or fails. */
    backupEventsEnabled?: boolean;
    /** POST JSON to this URL on backup events. */
    webhookUrl?: string;
    emailEnabled?: boolean;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
    smtpUser?: string;
    smtpPass?: string;
    emailFrom?: string;
    emailTo?: string;
  };
}
