/**
 * Row types mirroring the SQL migrations. Stored values use snake_case;
 * the API layer maps these to the camelCase @nexus/types domain models.
 */

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: "owner" | "admin" | "developer" | "viewer";
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  last_used_at: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerRow {
  id: string;
  name: string;
  type: "local" | "remote";
  host: string;
  port: number;
  username: string;
  auth_method: "password" | "privateKey";
  auth_data_encrypted: string | null;
  status: string;
  agent_id: string | null;
  agent_token_encrypted: string | null;
  agent_version: string | null;
  agent_api_url: string | null;
  os: string | null;
  arch: string | null;
  hostname: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  memory_total_bytes: number | null;
  disk_total_bytes: number | null;
  docker_version: string | null;
  docker_available: boolean | number;
  last_heartbeat_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerAgentRow {
  id: string;
  server_id: string;
  agent_id: string;
  token_hash: string;
  version: string | null;
  connected: boolean | number;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface ApplicationRow {
  id: string;
  project_id: string | null;
  server_id: string;
  name: string;
  description: string | null;
  repository: string;
  branch: string;
  provider: string | null;
  trigger_type: string;
  deployment_method: "DOCKERFILE" | "COMPOSE";
  dockerfile_path: string;
  build_context: string;
  compose_path: string;
  compose_project_name: string | null;
  port: number | null;
  start_command: string | null;
  healthcheck: string | null;
  restart_policy: string;
  cpu_limit: number | null;
  memory_limit_bytes: number | null;
  memory_reservation_bytes: number | null;
  pids_limit: number | null;
  volume_name: string | null;
  volume_mount_path: string | null;
  registry: string | null;
  registry_username: string | null;
  registry_password_encrypted: string | null;
  status: string;
  autodeploy: number;
  last_deployment_id: string | null;
  current_image: string | null;
  current_container_id: string | null;
  backup_schedule_enabled: boolean | number;
  backup_schedule_cron: string | null;
  backup_retention: number;
  backup_next_run_at: string | null;
  backup_last_run_at: string | null;
  /** Raw .env editor text (comments + ordering). Secret values are masked with dots. */
  environment_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentRow {
  id: string;
  application_id: string;
  server_id: string;
  status: string;
  commit_sha: string | null;
  branch: string;
  image: string | null;
  container_id: string | null;
  compose_project_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  triggered_by: string | null;
  triggered_by_name: string | null;
  rollback_from: string | null;
  created_at: string;
}

export interface DeploymentLogRow {
  id: string;
  deployment_id: string;
  stream: string;
  message: string;
  timestamp: string;
}

export interface DatabaseRow {
  id: string;
  project_id: string | null;
  server_id: string;
  type: string;
  version: string;
  name: string;
  description: string | null;
  db_name: string | null;
  username: string | null;
  password_encrypted: string | null;
  port: number;
  internal_port: number;
  status: string;
  image: string;
  container_id: string | null;
  volume_name: string | null;
  storage_limit_bytes: number | null;
  max_connections: number | null;
  cpu_limit: number | null;
  memory_limit_bytes: number | null;
  backup_schedule_enabled: boolean | number;
  backup_schedule_cron: string | null;
  backup_retention: number;
  backup_next_run_at: string | null;
  backup_last_run_at: string | null;
  /** Raw .env editor text (comments + ordering). Secret values are masked with dots. */
  environment_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatabaseCredentialRow {
  id: string;
  database_id: string;
  username: string;
  password_encrypted: string;
  created_at: string;
}

export interface ContainerRow {
  id: string;
  server_id: string;
  container_id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  labels: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComposeStackRow {
  id: string;
  server_id: string;
  application_id: string | null;
  project_name: string;
  compose_path: string;
  status: string;
  containers: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainRow {
  id: string;
  application_id: string | null;
  game_server_id: string | null;
  hostname: string;
  is_primary: boolean | number;
  ssl_enabled: boolean | number;
  ssl_status: string;
  created_at: string;
}

export interface EnvironmentVariableRow {
  id: string;
  application_id: string | null;
  database_id: string | null;
  game_server_id: string | null;
  var_key: string;
  value_encrypted: string;
  is_secret: boolean | number;
  created_at: string;
  updated_at: string;
}

export interface VolumeRow {
  id: string;
  server_id: string;
  name: string;
  driver: string;
  mountpoint: string | null;
  labels: string | null;
  size_bytes: number | null;
  used_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NetworkRow {
  id: string;
  server_id: string;
  name: string;
  driver: string;
  scope: string | null;
  subnet: string | null;
  gateway: string | null;
  internal: boolean | number;
  containers: string | null;
  created_at: string;
  updated_at: string;
}

export interface BackupRow {
  id: string;
  database_id: string | null;
  application_id: string | null;
  game_server_id: string | null;
  server_id: string;
  type: string;
  status: string;
  size_bytes: number | null;
  path: string | null;
  error: string | null;
  sha1: string | null;
  locked: boolean | number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface MetricsRow {
  id: string;
  server_id: string;
  ts: string;
  cpu_percent: number;
  memory_percent: number;
  disk_percent: number;
  containers_running: number;
  payload: string | null;
}

export interface GameServerRow {
  id: string;
  server_id: string;
  project_id: string | null;
  name: string;
  game: string;
  version: string;
  flavor: string | null;
  image: string;
  port: number;
  memory_bytes: number;
  cpu_limit: number | null;
  storage_bytes: number;
  environment: string | null;
  status: string;
  container_id: string | null;
  volume_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface GameScheduleRow {
  id: string;
  game_server_id: string;
  name: string;
  cron: string;
  command: string;
  enabled: boolean | number;
  only_online: boolean | number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GameAllocationRow {
  id: string;
  game_server_id: string;
  ip: string;
  port: number;
  notes: string | null;
  is_primary: boolean | number;
  created_at: string;
  updated_at: string;
}

export interface AuditLogRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  resource_name: string | null;
  server_id: string | null;
  metadata: string | null;
  ip: string | null;
  request_id: string | null;
  created_at: string;
}

export interface JobRow {
  id: string;
  type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  payload: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  read: boolean | number;
  created_at: string;
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}
