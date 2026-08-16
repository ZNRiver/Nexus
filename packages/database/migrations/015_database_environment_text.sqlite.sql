-- Preserve the raw .env editor text (comments and ordering) per database.
ALTER TABLE databases ADD COLUMN environment_text TEXT;
