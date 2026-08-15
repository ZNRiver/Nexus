-- NEXUS initial schema — SQLite (development)
-- Column types: TEXT ids/timestamps, INTEGER booleans/numbers, REAL floats.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL DEFAULT 'root',
  auth_method TEXT NOT NULL DEFAULT 'password',
  auth_data_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'OFFLINE',
  agent_id TEXT,
  agent_token_encrypted TEXT,
  agent_version TEXT,
  os TEXT,
  arch TEXT,
  hostname TEXT,
  cpu_model TEXT,
  cpu_cores INTEGER,
  memory_total_bytes INTEGER,
  disk_total_bytes INTEGER,
  docker_version TEXT,
  docker_available INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);

CREATE TABLE IF NOT EXISTS server_agents (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  version TEXT,
  connected INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_server ON server_agents(server_id);

CREATE TABLE IF NOT EXISTS projects_servers (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, server_id)
);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  deployment_method TEXT NOT NULL DEFAULT 'DOCKERFILE',
  dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
  build_context TEXT NOT NULL DEFAULT '.',
  compose_path TEXT NOT NULL DEFAULT 'docker-compose.yml',
  compose_project_name TEXT,
  port INTEGER,
  start_command TEXT,
  healthcheck TEXT,
  restart_policy TEXT NOT NULL DEFAULT 'unless-stopped',
  cpu_limit REAL,
  memory_limit_bytes INTEGER,
  memory_reservation_bytes INTEGER,
  pids_limit INTEGER,
  volume_name TEXT,
  volume_mount_path TEXT,
  registry TEXT,
  registry_username TEXT,
  registry_password_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'NOT_DEPLOYED',
  last_deployment_id TEXT,
  current_image TEXT,
  current_container_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apps_server ON applications(server_id);
CREATE INDEX IF NOT EXISTS idx_apps_project ON applications(project_id);

CREATE TABLE IF NOT EXISTS application_deployments (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  commit_sha TEXT,
  branch TEXT NOT NULL,
  image TEXT,
  container_id TEXT,
  compose_project_name TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  triggered_by TEXT,
  triggered_by_name TEXT,
  rollback_from TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deployments_app ON application_deployments(application_id);
CREATE INDEX IF NOT EXISTS idx_deployments_server ON application_deployments(server_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON application_deployments(status);

CREATE TABLE IF NOT EXISTS deployment_logs (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES application_deployments(id) ON DELETE CASCADE,
  stream TEXT NOT NULL DEFAULT 'stdout',
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deplogs_deployment ON deployment_logs(deployment_id);

CREATE TABLE IF NOT EXISTS databases (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT,
  password_encrypted TEXT,
  port INTEGER NOT NULL,
  internal_port INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATING',
  image TEXT NOT NULL,
  container_id TEXT,
  volume_name TEXT,
  storage_limit_bytes INTEGER,
  max_connections INTEGER,
  cpu_limit REAL,
  memory_limit_bytes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dbs_server ON databases(server_id);
CREATE INDEX IF NOT EXISTS idx_dbs_project ON databases(project_id);

CREATE TABLE IF NOT EXISTS database_credentials (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  password_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dbcreds_db ON database_credentials(database_id);

CREATE TABLE IF NOT EXISTS containers (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  container_id TEXT NOT NULL,
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  state TEXT NOT NULL,
  status TEXT NOT NULL,
  labels TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (server_id, container_id)
);
CREATE INDEX IF NOT EXISTS idx_containers_server ON containers(server_id);

CREATE TABLE IF NOT EXISTS compose_stacks (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  project_name TEXT NOT NULL,
  compose_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  containers TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  ssl_enabled INTEGER NOT NULL DEFAULT 0,
  ssl_status TEXT NOT NULL DEFAULT 'DISABLED',
  created_at TEXT NOT NULL,
  UNIQUE (application_id, hostname)
);
CREATE INDEX IF NOT EXISTS idx_domains_app ON domains(application_id);

CREATE TABLE IF NOT EXISTS environment_variables (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  database_id TEXT REFERENCES databases(id) ON DELETE CASCADE,
  game_server_id TEXT REFERENCES game_servers(id) ON DELETE CASCADE,
  var_key TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_env_app ON environment_variables(application_id);
CREATE INDEX IF NOT EXISTS idx_env_db ON environment_variables(database_id);

CREATE TABLE IF NOT EXISTS volumes (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  driver TEXT NOT NULL DEFAULT 'local',
  mountpoint TEXT,
  labels TEXT,
  size_bytes INTEGER,
  used_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (server_id, name)
);

CREATE TABLE IF NOT EXISTS networks (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  driver TEXT NOT NULL DEFAULT 'bridge',
  scope TEXT,
  subnet TEXT,
  gateway TEXT,
  internal INTEGER NOT NULL DEFAULT 0,
  containers TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (server_id, name)
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  database_id TEXT REFERENCES databases(id) ON DELETE SET NULL,
  application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
  server_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  size_bytes INTEGER,
  path TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_db ON backups(database_id);

CREATE TABLE IF NOT EXISTS monitoring_metrics (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  cpu_percent REAL NOT NULL,
  memory_percent REAL NOT NULL,
  disk_percent REAL NOT NULL,
  containers_running INTEGER NOT NULL DEFAULT 0,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_metrics_server_ts ON monitoring_metrics(server_id, ts);

CREATE TABLE IF NOT EXISTS game_servers (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  game TEXT NOT NULL DEFAULT 'MINECRAFT',
  version TEXT NOT NULL,
  flavor TEXT,
  image TEXT NOT NULL,
  port INTEGER NOT NULL,
  memory_bytes INTEGER NOT NULL,
  cpu_limit REAL,
  storage_bytes INTEGER NOT NULL,
  environment TEXT,
  status TEXT NOT NULL DEFAULT 'CREATING',
  container_id TEXT,
  volume_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_games_server ON game_servers(server_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  resource_name TEXT,
  server_id TEXT,
  metadata TEXT,
  ip TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  payload TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifs_user ON notifications(user_id, read);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
