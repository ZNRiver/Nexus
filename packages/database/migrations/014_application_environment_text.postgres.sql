-- Preserve the raw .env editor text (comments and ordering) per application.
ALTER TABLE applications ADD COLUMN environment_text TEXT;
