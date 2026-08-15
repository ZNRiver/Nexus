ALTER TABLE databases ADD COLUMN backup_schedule_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN backup_schedule_cron TEXT;
ALTER TABLE databases ADD COLUMN backup_retention INTEGER NOT NULL DEFAULT 7;
ALTER TABLE databases ADD COLUMN backup_next_run_at TEXT;
ALTER TABLE databases ADD COLUMN backup_last_run_at TEXT;
