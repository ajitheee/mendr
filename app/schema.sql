-- Mendr App storage. Six data tables plus an audit log, and none of them holds code.
--
-- installations:    which GitHub accounts installed the App (the tenant boundary).
-- repos:            which repositories each installation covers (ids, names, privacy).
-- runs:             the sanitized evidence one CI run sent: findings, paths, line
--                   numbers, classifications, redacted <=7-line snippets, line hashes.
-- migrations:       what mendr-action reported after a migration run: outcome, PR
--                   url, verdict, gate statuses, model swaps and the file paths they
--                   touch — never the diff.
-- acknowledgements: a person's decision about one finding — "seen; X owns it" —
--                   keyed by repository and model so it follows the finding across
--                   runs. Names and a short note only; never the finding itself.
-- approvals:        a person's decision, made in the App, to migrate one finding.
--                   The customer's own CI picks it up (proven by OIDC), runs the
--                   verified migration for exactly that model, streams progress
--                   and reports the result. The App never touches the repository.
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
-- When the repository's migration workflow last asked the App for approvals,
-- and which workflow file it was (from the run's OIDC workflow_ref claim): the
-- proof that approvals made here will be carried out, and where to send a start.
ALTER TABLE repos ADD COLUMN IF NOT EXISTS migrate_seen_at TIMESTAMPTZ;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS migrate_workflow TEXT;

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

CREATE TABLE IF NOT EXISTS migrations (
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
  outcome        TEXT NOT NULL,
  verdict        TEXT,
  pr_url         TEXT,
  report         JSONB NOT NULL,
  UNIQUE (repo_id, run_id, run_attempt)
);
CREATE INDEX IF NOT EXISTS migrations_repo_received ON migrations (repo_id, received_at DESC);

-- acknowledgements: one row per acknowledgement; clearing keeps the row as
-- history (cleared_at, cleared_by). At most one row per (repo, provider, model)
-- is active at a time. Never changes a finding's status — only a scan can.
CREATE TABLE IF NOT EXISTS acknowledgements (
  id              BIGSERIAL PRIMARY KEY,
  repo_id         BIGINT NOT NULL REFERENCES repos(id),
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  acknowledged_by TEXT NOT NULL,
  owner           TEXT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at      TIMESTAMPTZ,
  cleared_by      TEXT
);
CREATE INDEX IF NOT EXISTS acknowledgements_repo_active ON acknowledgements (repo_id) WHERE cleared_at IS NULL;

-- approvals: queued → running (claimed by a CI run) → done | failed, or
-- cancelled while still queued. `events` is the progress timeline the CI run
-- streams: stage, time, a short redacted detail — never code.
CREATE TABLE IF NOT EXISTS approvals (
  id            BIGSERIAL PRIMARY KEY,
  repo_id       BIGINT NOT NULL REFERENCES repos(id),
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  replacement   TEXT,
  mode          TEXT NOT NULL DEFAULT 'pr',
  approved_by   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'queued',
  dispatched_at TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  run_id        BIGINT,
  migration_id  BIGINT,
  outcome       TEXT,
  events        JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS approvals_repo_status ON approvals (repo_id, status);
CREATE INDEX IF NOT EXISTS approvals_repo_run ON approvals (repo_id, run_id);

-- audit_log: an append-only record of security-relevant events. `detail` holds
-- only scalars (counts, ids, a conclusion) — never findings, secrets or code.
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  event           TEXT NOT NULL,
  installation_id BIGINT,
  repo            TEXT,
  actor           TEXT,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_installation ON audit_log (installation_id, at DESC);
