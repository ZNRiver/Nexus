/**
 * NEXUS — Agent ↔ API WebSocket protocol.
 *
 * The Agent opens an authenticated WebSocket to the API and keeps it open.
 * The API sends `request` frames (one action per request, correlated with a
 * requestId); the Agent answers with `ack`/`error` and streams long-running
 * output as `event` frames (deployment logs, progress, container status…).
 * The Agent pushes `hello` once and `heartbeat` frames every N seconds.
 */

import type {
  ContainerInfo,
  GameServer,
  ImageInfo,
  NetworkInfo,
  ServerSystemInfo,
  SystemMetrics,
  VolumeInfo,
} from "./domain";

/* ── Agent → API ─────────────────────────────────────────────────── */

export interface AgentHello {
  type: "hello";
  serverId: string;
  agentId: string;
  version: string;
  system: ServerSystemInfo;
}

export interface AgentHeartbeat {
  type: "heartbeat";
  serverId: string;
  metrics: SystemMetrics;
}

export interface AgentAck {
  type: "ack";
  requestId: string;
  result: unknown;
}

export interface AgentError {
  type: "error";
  requestId: string;
  error: { code: string; message: string };
}

export type AgentEventType =
  | "deployment.log"
  | "deployment.status"
  | "container.status"
  | "job.progress"
  | "database.status"
  | "game.status";

export interface AgentEvent {
  type: AgentEventType;
  /** resource id the event belongs to (deploymentId, containerId, databaseId…) */
  resourceId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export type AgentToApiMessage =
  | AgentHello
  | AgentHeartbeat
  | AgentAck
  | AgentError
  | { type: "event"; event: AgentEvent };

/* ── API → Agent ─────────────────────────────────────────────────── */

export type AgentAction =
  | "system.info"
  | "docker.ps"
  | "docker.images"
  | "docker.volumes"
  | "docker.networks"
  | "docker.inspect"
  | "container.start"
  | "container.stop"
  | "container.restart"
  | "container.pause"
  | "container.unpause"
  | "container.remove"
  | "container.logs"
  | "container.stats"
  | "container.exec"
  | "image.pull"
  | "image.remove"
  | "volume.create"
  | "volume.remove"
  | "volume.inspect"
  | "network.create"
  | "network.remove"
  | "network.inspect"
  | "deployment.execute"
  | "deployment.cancel"
  | "database.create"
  | "db.backup"
  | "db.restore"
  | "db.query"
  | "db.schema"
  | "db.objects"
  | "db.tableInfo"
  | "volume.backup"
  | "volume.restore"
  | "file.remove"
  | "file.read"
  | "file.upload"
  | "game.create"
  | "game.start"
  | "game.stop"
  | "game.remove";

export interface ApiAgentRequest {
  type: "request";
  requestId: string;
  action: AgentAction;
  payload: Record<string, unknown>;
}

export interface ApiAgentCancel {
  type: "cancel";
  requestId: string;
}

export type ApiToAgentMessage = ApiAgentRequest | ApiAgentCancel;

/* ── Action payloads ─────────────────────────────────────────────── */

export interface DeploymentExecutePayload {
  deploymentId: string;
  applicationId: string;
  repository: string;
  branch: string;
  method: "DOCKERFILE" | "COMPOSE";
  /** full path of the cloned checkout */
  workDir: string;
  dockerfilePath: string;
  buildContext: string;
  composePath: string;
  composeProjectName: string;
  port?: number | null;
  startCommand?: string | null;
  env: Record<string, string>;
  imageName: string;
  containerName: string;
  networkName: string;
  volumeName?: string | null;
  mountPath?: string | null;
  restartPolicy: string;
  cpuLimit?: number | null;
  memoryLimitBytes?: number | null;
  memoryReservationBytes?: number | null;
  pidsLimit?: number | null;
  healthcheck?: {
    type: "http" | "tcp";
    path?: string;
    port?: number;
    intervalSeconds?: number;
    timeoutSeconds?: number;
    retries?: number;
  } | null;
  registry?: string | null;
  registryUsername?: string | null;
  registryPassword?: string | null;
  /** when set, skip git clone/build and run this already-built image (rollback) */
  prebuiltImage?: string | null;
  cancelAt?: string | null;
}

export interface DockerfileDeployResult {
  image: string;
  containerId: string;
  commit?: string | null;
}

export interface ComposeDeployResult {
  projectName: string;
  containers: string[];
  commit?: string | null;
}

export interface DbBackupPayload {
  backupId: string;
  databaseId: string;
  type: string;
  containerId: string;
  name: string;
  username?: string | null;
  password?: string | null;
  port: number;
  internalPort: number;
  destDir: string;
  fileName: string;
}

export interface DbQueryPayload {
  type: string;
  containerId: string;
  name: string;
  username?: string;
  password?: string;
  sql: string;
}

export interface DbSchemaPayload {
  type: string;
  containerId: string;
  name: string;
  username?: string;
  password?: string;
}

export interface DbObjectsPayload {
  type: string;
  containerId: string;
  name: string;
  username?: string;
  password?: string;
}

export interface DbTableInfoPayload {
  type: string;
  containerId: string;
  name: string;
  table: string;
  username?: string;
  password?: string;
}

export interface DbRestorePayload {
  backupId: string;
  databaseId: string;
  type: string;
  containerId: string;
  name: string;
  username?: string | null;
  password?: string | null;
  port: number;
  internalPort: number;
  filePath: string;
}

export interface VolumeBackupPayload {
  backupId: string;
  applicationId: string;
  volumeName: string;
  fileName: string;
}

export interface VolumeRestorePayload {
  backupId: string;
  applicationId: string;
  volumeName: string;
  filePath: string;
}

export interface DatabaseCreatePayload {
  databaseId: string;
  containerName: string;
  image: string;
  hostPort: number;
  internalPort: number;
  volumeName: string;
  volumePath: string;
  memoryBytes?: number | null;
  cpuLimit?: number | null;
  env: Record<string, string>;
  labels: Record<string, string>;
}

export interface GameCreatePayload {
  gameServerId: string;
  image: string;
  containerName: string;
  port: number;
  memoryBytes: number;
  cpuLimit?: number | null;
  env: Record<string, string>;
  volumeName: string;
  restartPolicy: string;
  labels: Record<string, string>;
}

/* ── Registry of typed results for each action ───────────────────── */
export interface AgentActionResultMap {
  "system.info": ServerSystemInfo;
  "docker.ps": ContainerInfo[];
  "docker.images": ImageInfo[];
  "docker.volumes": VolumeInfo[];
  "docker.networks": NetworkInfo[];
  "docker.inspect": unknown;
  "container.start": { id: string };
  "container.stop": { id: string };
  "container.restart": { id: string };
  "container.pause": { id: string };
  "container.unpause": { id: string };
  "container.remove": { id: string };
  "container.logs": { logs: string };
  "container.stats": { cpuPercent: number; memoryUsageBytes: number; memoryLimitBytes: number };
  "container.exec": { output: string; exitCode: number };
  "image.pull": { image: string };
  "image.remove": { image: string };
  "volume.create": { name: string };
  "volume.remove": { name: string };
  "volume.inspect": VolumeInfo;
  "network.create": { name: string };
  "network.remove": { name: string };
  "network.inspect": NetworkInfo;
  "deployment.execute": DockerfileDeployResult | ComposeDeployResult;
  "deployment.cancel": { cancelled: boolean };
  "database.create": { containerId: string };
  "db.backup": { path: string; sizeBytes: number };
  "db.restore": { restored: boolean };
  "db.query": { columns: string[]; rows: string[][]; truncated: boolean; message?: string };
  "db.schema": { tables: { name: string; columns: { name: string; type: string }[] }[]; message?: string };
  "db.objects": {
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
  "db.tableInfo": {
    columns: { name: string; type: string; nullable: boolean; key: string; defaultValue?: string | null }[];
    constraints: { name: string; type: string; definition?: string }[];
    foreignKeys: { name: string; columns: string; references: string }[];
    triggers: { name: string; event: string; timing: string }[];
    indexes: { name: string; columns: string; unique: boolean }[];
    message?: string;
  };
  "volume.backup": { path: string; sizeBytes: number };
  "volume.restore": { restored: boolean };
  "file.remove": { removed: boolean };
  "file.read": { data: string; offset: number; length: number; total: number };
  "file.upload": { path: string; written: number; total: number };
  "game.create": { containerId: string };
  "game.start": { id: string };
  "game.stop": { id: string };
  "game.remove": { id: string };
}
