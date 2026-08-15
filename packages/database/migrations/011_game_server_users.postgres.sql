-- Sub-users per game server (Pterodactyl-style): which platform user can
-- access each game server and which features they may use.
CREATE TABLE IF NOT EXISTS game_server_users (
  id TEXT PRIMARY KEY,
  game_server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- JSON array of granted feature permissions, e.g. ["console","files","backups"]
  permissions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gamesrv_users_unique ON game_server_users(game_server_id, user_id);
CREATE INDEX IF NOT EXISTS idx_gamesrv_users_user ON game_server_users(user_id);
