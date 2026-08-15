-- Add configurable deployment trigger type to applications
ALTER TABLE applications ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'MANUAL';
