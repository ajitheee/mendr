-- Mendr App storage. Three tables, and none of them holds code.
--
-- installations: which GitHub accounts installed the App (the tenant boundary).
-- repos:         which repositories each installation covers (ids, names, privacy).
-- runs:          the sanitized evidence one CI run sent: findings, paths, line
--                numbers, classifications, redacted <=7-line snippets, line hashes.
--
-- Every statement is idempotent so the server can apply this file at boot.

CREATE TABLE IF NOT EXISTS installations (
  id            BIGINT PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_type  TEXT NOT NULL,
  suspended     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS repos (
  id              BIGINT PRIMARY KEY,
  installation_id BIGINT NOT NULL REFERENCES installations(id),
  full_name       TEXT NOT NULL,
  private         BOOLEAN NOT NULL DEFAULT TRUE,
  removed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS repos_full_name ON repos (full_name);
CREATE INDEX IF NOT EXISTS repos_installation ON repos (installation_id);

CREATE TABLE IF NOT EXISTS runs (
  id             BIGSERIAL PRIMARY KEY,
  repo_id        BIGINT NOT NULL REFERENCES repos(id),
  sha            TEXT NOT NULL,
  ref            TEXT NOT NULL,
  run_id         BIGINT NOT NULL,
  run_attempt    INTEGER NOT NULL,
  workflow_ref   TEXT,
  actor          TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_at   TEXT,
  conclusion     TEXT NOT NULL,
  patch          INTEGER NOT NULL DEFAULT 0,
  review         INTEGER NOT NULL DEFAULT 0,
  informational  INTEGER NOT NULL DEFAULT 0,
  report         JSONB NOT NULL,
  check_run_url  TEXT,
  UNIQUE (repo_id, run_id, run_attempt)
);
CREATE INDEX IF NOT EXISTS runs_repo_received ON runs (repo_id, received_at DESC);
