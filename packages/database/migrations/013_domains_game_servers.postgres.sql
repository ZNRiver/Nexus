-- Domains can now be attached to game servers as well as applications.
ALTER TABLE domains ADD COLUMN IF NOT EXISTS game_server_id TEXT REFERENCES game_servers(id) ON DELETE CASCADE;
ALTER TABLE domains ALTER COLUMN application_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_game ON domains(game_server_id, hostname);
