/**
 * NEXUS — API contract types (REST + dashboard WebSocket events).
 */

import type {
  Application,
  ApplicationWithExtras,
  AuditLogEntry,
  Backup,
  ContainerInfo,
  Database,
  DatabaseConnectionInfo,
  DatabaseCredential,
  Deployment,
  DeploymentStatus,
  DeploymentLogEntry,
  Domain,
  EnvironmentVariable,
  GameServer,
  ImageInfo,
  Job,
  MetricsPoint,
  NetworkInfo,
  Notification,
  Project,
  ResourceLogEntry,
  Server,
  ServerStatus,
  ServerSystemInfo,
  SessionInfo,
  SystemMetrics,
  User,
  VolumeInfo,
} from "./domain";

/* ── Pagination ──────────────────────────────────────────────────── */
export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
  total?: number;
}

/* ── API errors ──────────────────────────────────────────────────── */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/* ── Auth ────────────────────────────────────────────────────────── */
export interface SetupState {
  completed: boolean;
  adminCreated: boolean;
  localServerCreated: boolean;
}

export interface AuthMe {
  user: User;
  setup: SetupState;
}

export interface LoginResult {
  user: User;
}

export interface SetupResult {
  user: User;
  server: Server;
}

/* ── Dashboard WebSocket events ──────────────────────────────────── */
export type DashboardEvent =
  | { type: "server.status"; serverId: string; status: ServerStatus }
  | { type: "server.metrics"; serverId: string; metrics: SystemMetrics }
  | { type: "deployment.status"; deployment: Deployment }
  | { type: "deployment.log"; deploymentId: string; entry: DeploymentLogEntry }
  | { type: "resource.log"; resourceType: "database" | "application" | "backup"; resourceId: string; entry: ResourceLogEntry }
  | { type: "notification"; notification: Notification }
  | { type: "container.status"; serverId: string; container: ContainerInfo }
  | { type: "database.status"; database: Database }
  | { type: "game.status"; gameServer: GameServer }
  | { type: "job.status"; job: Job }
  | { type: "audit"; entry: AuditLogEntry };

/* ── Request/response bodies ─────────────────────────────────────── */

export interface CreateServerInput {
  name: string;
  host: string;
  port?: number;
  username: string;
  authMethod: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  /** URL the remote agent should connect back to (overrides auto-detection). */
  agentApiUrl?: string;
}

export interface UpdateServerInput {
  name?: string;
  port?: number;
  username?: string;
  agentApiUrl?: string | null;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  system?: ServerSystemInfo;
  error?: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
}

export interface CreateApplicationInput {
  name: string;
  description?: string;
  projectId?: string;
  serverId: string;
  repository: string;
  branch?: string;
  provider?: string;
  triggerType?: "MANUAL" | "ON_PUSH" | "SCHEDULE";
  deploymentMethod: "DOCKERFILE" | "COMPOSE";
  dockerfilePath?: string;
  buildContext?: string;
  composePath?: string;
  port?: number;
  startCommand?: string;
  healthcheck?: {
    type: "http" | "tcp";
    path?: string;
    port?: number;
    intervalSeconds?: number;
    timeoutSeconds?: number;
    retries?: number;
  } | null;
  restartPolicy?: string;
  autodeploy?: boolean;
  cpuLimit?: number;
  memoryLimitBytes?: number;
  memoryReservationBytes?: number;
  pidsLimit?: number;
  volumeName?: string;
  volumeMountPath?: string;
  registry?: string;
  registryUsername?: string;
  registryPassword?: string;
  environment?: { key: string; value: string; isSecret?: boolean }[];
}

export interface DeployInput {
  branch?: string;
  commit?: string;
}

export interface RollbackInput {
  deploymentId: string;
}

export interface CreateDatabaseInput {
  name: string;
  description?: string;
  serverId: string;
  type: "POSTGRESQL" | "MYSQL" | "MARIADB" | "REDIS" | "MONGODB" | "INFLUXDB";
  version?: string;
  dbName?: string;
  username?: string;
  password?: string;
  port?: number;
  storageLimitBytes?: number;
  maxConnections?: number;
  cpuLimit?: number;
  memoryLimitBytes?: number;
  projectId?: string;
}

export interface UpdateBackupScheduleInput {
  enabled: boolean;
  /** 5-field cron expression (minute hour day month weekday) */
  cron?: string;
  /** number of backups to keep */
  retention?: number;
}

export interface UpsertEnvVarInput {
  key: string;
  value: string;
  isSecret?: boolean;
}

export interface CreateDomainInput {
  hostname: string;
  isPrimary?: boolean;
  sslEnabled?: boolean;
}

export interface CreateGameServerInput {
  name: string;
  serverId: string;
  projectId?: string;
  game?: "MINECRAFT";
  version?: string;
  flavor?: "VANILLA" | "PAPER" | "PURPUR" | "FABRIC" | "FORGE";
  image?: string;
  port?: number;
  memoryBytes?: number;
  cpuLimit?: number;
  storageBytes?: number;
  environment?: Record<string, string>;
}

export interface CreateVolumeInput {
  name: string;
  driver?: string;
}

export interface CreateNetworkInput {
  name: string;
  driver?: string;
  subnet?: string;
}

export interface PullImageInput {
  image: string;
}

/* ── API module shapes (used by the dashboard client) ────────────── */
export interface ApplicationDetail {
  application: ApplicationWithExtras;
  deployments: Deployment[];
  environment: EnvironmentVariable[];
  domains: Domain[];
  containers?: ContainerInfo[];
}

export interface RecentDeploymentRow {
  id: string;
  application_id: string;
  app_name?: string | null;
  server_id: string;
  status: DeploymentStatus;
  branch: string;
  commit_sha?: string | null;
  image?: string | null;
  created_at: string;
  duration_ms?: number | null;
}

export interface RecentActivityRow {
  id: string;
  action: string;
  user_name?: string | null;
  resource_name?: string | null;
  created_at: string;
}

export interface ServerDetail {
  server: Server;
  system?: ServerSystemInfo | null;
  metrics?: SystemMetrics | null;
  containers: ContainerInfo[];
  recentDeployments: RecentDeploymentRow[];
  recentActivity: RecentActivityRow[];
}

export interface DatabaseDetail {
  database: Database;
  connection: DatabaseConnectionInfo | null;
  credentials: DatabaseCredential[];
  backups: Backup[];
}

export interface DeploymentDetail {
  deployment: Deployment;
  logs: DeploymentLogEntry[];
  application?: Application | null;
}

export interface DashboardOverview {
  servers: { total: number; online: number; offline: number; error: number };
  applications: { total: number; running: number; unhealthy: number };
  databases: { total: number; running: number };
  gameServers: { total: number; running: number };
  containers: { total: number; running: number };
  deployments: { total: number; failed: number; last24h: number };
  recentDeployments: (Deployment & { appName?: string | null })[];
  recentActivity: AuditLogEntry[];
  serverHealth: {
    serverId: string;
    name: string;
    status: ServerStatus;
    cpuPercent?: number | null;
    memoryPercent?: number | null;
    diskPercent?: number | null;
  }[];
  resourceUsage: {
    serverId: string;
    name: string;
    metrics: MetricsPoint[];
  }[];
  pendingJobs: number;
  unreadNotifications: number;
}

export interface ServerMetricsResponse {
  serverId: string;
  points: MetricsPoint[];
}

export interface SearchResults {
  servers: Server[];
  applications: Application[];
  databases: Database[];
  containers: ContainerInfo[];
  deployments: Deployment[];
}
