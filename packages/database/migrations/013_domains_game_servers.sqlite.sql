-- Domains can now be attached to game servers as well as applications.
-- SQLite can't alter an existing column to drop NOT NULL, so rebuild the table.
ALTER TABLE domains RENAME TO domains_old;

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  game_server_id TEXT REFERENCES game_servers(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  ssl_enabled INTEGER NOT NULL DEFAULT 0,
  ssl_status TEXT NOT NULL DEFAULT 'DISABLED',
  created_at TEXT NOT NULL,
  UNIQUE (application_id, hostname)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_game ON domains(game_server_id, hostname);

INSERT INTO domains (id, application_id, hostname, is_primary, ssl_enabled, ssl_status, created_at)
  SELECT id, application_id, hostname, is_primary, ssl_enabled, ssl_status, created_at FROM domains_old;

DROP TABLE domains_old;
CREATE INDEX IF NOT EXISTS idx_domains_app ON domains(application_id);
