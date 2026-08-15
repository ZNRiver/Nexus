ALTER TABLE applications ADD COLUMN backup_schedule_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE applications ADD COLUMN backup_schedule_cron TEXT;
ALTER TABLE applications ADD COLUMN backup_retention INTEGER NOT NULL DEFAULT 7;
ALTER TABLE applications ADD COLUMN backup_next_run_at TEXT;
ALTER TABLE applications ADD COLUMN backup_last_run_at TEXT;
