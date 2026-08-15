-- Generic operation logs (database create/deploy, backups, restores, etc.)
-- so the UI can stream progress per resource.
CREATE TABLE IF NOT EXISTS resource_logs (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,          -- 'database' | 'application' | 'backup'
  resource_id TEXT NOT NULL,            -- database id / application id / backup id
  stream TEXT NOT NULL DEFAULT 'stdout',-- 'stdout' | 'stderr' | 'system'
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rsclogs_resource ON resource_logs(resource_type, resource_id, timestamp);
