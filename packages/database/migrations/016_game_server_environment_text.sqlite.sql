-- Preserve the raw .env editor text (comments and ordering) per game server.
ALTER TABLE game_servers ADD COLUMN environment_text TEXT;
