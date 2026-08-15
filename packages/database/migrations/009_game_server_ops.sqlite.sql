CREATE TABLE IF NOT EXISTS game_schedules (
  id TEXT PRIMARY KEY,
  game_server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  only_online INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE backups ADD COLUMN game_server_id TEXT;
ALTER TABLE backups ADD COLUMN sha1 TEXT;
ALTER TABLE backups ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS game_allocations (
  id TEXT PRIMARY KEY,
  game_server_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  port INTEGER NOT NULL,
  notes TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
