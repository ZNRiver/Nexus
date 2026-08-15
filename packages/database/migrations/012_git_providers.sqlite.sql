-- Connected Git provider accounts (GitHub / GitLab / Bitbucket / Gitea).
-- Tokens are encrypted at rest; the agent uses them to clone private
-- repositories during deployments.
CREATE TABLE IF NOT EXISTS git_providers (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,               -- github | gitlab | bitbucket | gitea
  name TEXT NOT NULL,                   -- display name / account handle
  token_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_git_providers_provider ON git_providers(provider);
