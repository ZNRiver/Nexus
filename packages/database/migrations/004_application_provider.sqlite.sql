-- Add explicit source provider to applications (Github / Gitlab / Bitbucket / Gitea / Docker / Git)
ALTER TABLE applications ADD COLUMN provider TEXT;
