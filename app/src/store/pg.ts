import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type { AuditReport } from '../ingest/validate.js';
import type { MigrationOutcome, MigrationReport, MigrationVerdict } from '../ingest/migrationReport.js';
import {
  COMPLETED_CONCLUSIONS,
  type Acknowledgement,
  type AcknowledgementInput,
  type Approval,
  type ApprovalEvent,
  type ApprovalInput,
  type ApprovalMode,
  type ApprovalStatus,
  type AuditLogEntry,
  type AuditLogInput,
  type EncryptionStatus,
  type Installation,
  type MigrationInput,
  type MigrationRecord,
  type MigrationSummary,
  type Repo,
  type RepoDeletion,
  type RepoInput,
  type RunInput,
  type RunRecord,
  type RunSummary,
  type Store,
} from './types.js';
import { open as openField, sealForStore, type DataKeyring } from './encryption.js';
import { sanitizeEntry } from './auditLog.js';

type Row = Record<string, unknown>;

function n(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function installation(r: Row): Installation {
  return {
    id: n(r.id),
    accountLogin: String(r.account_login),
    accountType: r.account_type === 'Organization' ? 'Organization' : 'User',
    suspended: !!r.suspended,
    deletedAt: iso(r.deleted_at),
  };
}

function repo(r: Row): Repo {
  return {
    id: n(r.id),
    installationId: n(r.installation_id),
    fullName: String(r.full_name),
    private: !!r.private,
    removedAt: iso(r.removed_at),
    migrateSeenAt: iso(r.migrate_seen_at),
    migrateWorkflow: r.migrate_workflow === null || r.migrate_workflow === undefined ? null : String(r.migrate_workflow),
  };
}

function approval(r: Row): Approval {
  const events = Array.isArray(r.events) ? (r.events as ApprovalEvent[]) : [];
  return {
    id: n(r.id),
    repoId: n(r.repo_id),
    provider: String(r.provider),
    model: String(r.model),
    replacement: r.replacement === null ? null : String(r.replacement),
    mode: String(r.mode) as ApprovalMode,
    approvedBy: String(r.approved_by),
    createdAt: iso(r.created_at) ?? new Date().toISOString(),
    status: String(r.status) as ApprovalStatus,
    dispatchedAt: iso(r.dispatched_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    runId: r.run_id === null ? null : n(r.run_id),
    migrationId: r.migration_id === null ? null : n(r.migration_id),
    outcome: r.outcome === null ? null : String(r.outcome),
    events,
  };
}

function summary(r: Row): RunSummary {
  return {
    id: n(r.id),
    repoId: n(r.repo_id),
    sha: String(r.sha),
    ref: String(r.ref),
    runId: n(r.run_id),
    runAttempt: n(r.run_attempt),
    workflowRef: r.workflow_ref === null ? null : String(r.workflow_ref),
    actor: r.actor === null ? null : String(r.actor),
    receivedAt: iso(r.received_at) ?? new Date().toISOString(),
    generatedAt: r.generated_at === null ? null : String(r.generated_at),
    conclusion: String(r.conclusion),
    counts: { patch: n(r.patch), review: n(r.review), informational: n(r.informational) },
    checkRunUrl: r.check_run_url === null ? null : String(r.check_run_url),
  };
}

const SUMMARY_COLUMNS = 'id, repo_id, sha, ref, run_id, run_attempt, workflow_ref, actor, received_at, generated_at, conclusion, patch, review, informational, check_run_url';

function migrationSummary(r: Row): MigrationSummary {
  return {
    id: n(r.id),
    repoId: n(r.repo_id),
    sha: String(r.sha),
    ref: String(r.ref),
    runId: n(r.run_id),
    runAttempt: n(r.run_attempt),
    workflowRef: r.workflow_ref === null ? null : String(r.workflow_ref),
    actor: r.actor === null ? null : String(r.actor),
    receivedAt: iso(r.received_at) ?? new Date().toISOString(),
    generatedAt: r.generated_at === null ? null : String(r.generated_at),
    outcome: String(r.outcome) as MigrationOutcome,
    verdict: r.verdict === null ? null : (String(r.verdict) as MigrationVerdict),
    prUrl: r.pr_url === null ? null : String(r.pr_url),
  };
}

const MIGRATION_SUMMARY_COLUMNS = 'id, repo_id, sha, ref, run_id, run_attempt, workflow_ref, actor, received_at, generated_at, outcome, verdict, pr_url';

function acknowledgement(r: Row): Acknowledgement {
  return {
    id: n(r.id),
    repoId: n(r.repo_id),
    provider: String(r.provider),
    model: String(r.model),
    acknowledgedBy: String(r.acknowledged_by),
    owner: r.owner === null ? null : String(r.owner),
    note: r.note === null ? null : String(r.note),
    createdAt: iso(r.created_at) ?? new Date().toISOString(),
    clearedAt: iso(r.cleared_at),
    clearedBy: r.cleared_by === null ? null : String(r.cleared_by),
  };
}

export class PgStore implements Store {
  readonly kind = 'postgres' as const;
  constructor(
    private readonly pool: pg.Pool,
    /** Field-level encryption for the `report` column; null = plaintext (dev). */
    private readonly keyring: DataKeyring | null = null,
  ) {}

  /** Apply schema.sql (idempotent) so a fresh database is usable at boot. */
  async ensureSchema(): Promise<void> {
    const sql = await readFile(new URL('../../schema.sql', import.meta.url), 'utf8');
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertInstallation(i: Installation): Promise<void> {
    await this.pool.query(
      `INSERT INTO installations (id, account_login, account_type, suspended, deleted_at)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (id) DO UPDATE SET account_login = EXCLUDED.account_login, account_type = EXCLUDED.account_type,
         suspended = EXCLUDED.suspended, deleted_at = NULL, updated_at = now()`,
      [i.id, i.accountLogin, i.accountType, i.suspended],
    );
  }

  async markInstallationDeleted(id: number, at: string): Promise<void> {
    await this.pool.query('UPDATE installations SET deleted_at = $2, updated_at = now() WHERE id = $1', [id, at]);
  }

  async setInstallationSuspended(id: number, suspended: boolean): Promise<void> {
    await this.pool.query('UPDATE installations SET suspended = $2, updated_at = now() WHERE id = $1', [id, suspended]);
  }

  async getInstallation(id: number): Promise<Installation | null> {
    const { rows } = await this.pool.query('SELECT * FROM installations WHERE id = $1', [id]);
    return rows[0] ? installation(rows[0] as Row) : null;
  }

  async upsertRepos(installationId: number, repos: RepoInput[]): Promise<void> {
    for (const r of repos) {
      await this.pool.query(
        `INSERT INTO repos (id, installation_id, full_name, private, removed_at) VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT (id) DO UPDATE SET installation_id = EXCLUDED.installation_id, full_name = EXCLUDED.full_name,
           private = EXCLUDED.private, removed_at = NULL`,
        [r.id, installationId, r.fullName, r.private],
      );
    }
  }

  async removeRepos(installationId: number, repoIds: number[], at: string): Promise<void> {
    if (!repoIds.length) return;
    await this.pool.query('UPDATE repos SET removed_at = $3 WHERE installation_id = $1 AND id = ANY($2::bigint[])', [installationId, repoIds, at]);
  }

  async getRepo(id: number): Promise<Repo | null> {
    const { rows } = await this.pool.query('SELECT * FROM repos WHERE id = $1', [id]);
    return rows[0] ? repo(rows[0] as Row) : null;
  }

  async getRepoByName(fullName: string): Promise<Repo | null> {
    const { rows } = await this.pool.query('SELECT * FROM repos WHERE lower(full_name) = lower($1) AND removed_at IS NULL LIMIT 1', [fullName]);
    return rows[0] ? repo(rows[0] as Row) : null;
  }

  async listRepos(): Promise<Repo[]> {
    const { rows } = await this.pool.query('SELECT * FROM repos WHERE removed_at IS NULL ORDER BY full_name');
    return rows.map((r) => repo(r as Row));
  }

  async saveRun(run: RunInput): Promise<RunRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO runs (repo_id, sha, ref, run_id, run_attempt, workflow_ref, actor, generated_at, conclusion, patch, review, informational, report, check_run_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL)
       ON CONFLICT (repo_id, run_id, run_attempt) DO UPDATE SET sha = EXCLUDED.sha, ref = EXCLUDED.ref, workflow_ref = EXCLUDED.workflow_ref,
         actor = EXCLUDED.actor, received_at = now(), generated_at = EXCLUDED.generated_at, conclusion = EXCLUDED.conclusion,
         patch = EXCLUDED.patch, review = EXCLUDED.review, informational = EXCLUDED.informational, report = EXCLUDED.report, check_run_url = NULL
       RETURNING *`,
      [
        run.repoId,
        run.sha,
        run.ref,
        run.runId,
        run.runAttempt,
        run.workflowRef,
        run.actor,
        run.generatedAt,
        run.conclusion,
        run.counts.patch,
        run.counts.review,
        run.counts.informational,
        JSON.stringify(sealForStore(run.report, this.keyring)),
      ],
    );
    const row = rows[0] as Row;
    return { ...summary(row), report: openField<AuditReport>(row.report, this.keyring) };
  }

  async setRunCheckUrl(id: number, url: string): Promise<void> {
    await this.pool.query('UPDATE runs SET check_run_url = $2 WHERE id = $1', [id, url]);
  }

  async listRuns(repoId: number, limit: number): Promise<RunSummary[]> {
    const { rows } = await this.pool.query(`SELECT ${SUMMARY_COLUMNS} FROM runs WHERE repo_id = $1 ORDER BY received_at DESC, id DESC LIMIT $2`, [repoId, limit]);
    return rows.map((r) => summary(r as Row));
  }

  async getRun(id: number): Promise<RunRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM runs WHERE id = $1', [id]);
    if (!rows[0]) return null;
    const row = rows[0] as Row;
    return { ...summary(row), report: openField<AuditReport>(row.report, this.keyring) };
  }

  async pruneRuns(repoId: number, keep: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM runs WHERE repo_id = $1 AND id NOT IN (SELECT id FROM runs WHERE repo_id = $1 ORDER BY received_at DESC, id DESC LIMIT $2)`,
      [repoId, keep],
    );
  }

  // --- migrations ---

  async saveMigration(m: MigrationInput): Promise<MigrationRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO migrations (repo_id, sha, ref, run_id, run_attempt, workflow_ref, actor, generated_at, outcome, verdict, pr_url, report)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (repo_id, run_id, run_attempt) DO UPDATE SET sha = EXCLUDED.sha, ref = EXCLUDED.ref, workflow_ref = EXCLUDED.workflow_ref,
         actor = EXCLUDED.actor, received_at = now(), generated_at = EXCLUDED.generated_at, outcome = EXCLUDED.outcome,
         verdict = EXCLUDED.verdict, pr_url = EXCLUDED.pr_url, report = EXCLUDED.report
       RETURNING *`,
      [m.repoId, m.sha, m.ref, m.runId, m.runAttempt, m.workflowRef, m.actor, m.generatedAt, m.outcome, m.verdict, m.prUrl, JSON.stringify(sealForStore(m.report, this.keyring))],
    );
    const row = rows[0] as Row;
    return { ...migrationSummary(row), report: openField<MigrationReport>(row.report, this.keyring) };
  }

  async listMigrations(repoId: number, limit: number): Promise<MigrationSummary[]> {
    const { rows } = await this.pool.query(`SELECT ${MIGRATION_SUMMARY_COLUMNS} FROM migrations WHERE repo_id = $1 ORDER BY received_at DESC, id DESC LIMIT $2`, [repoId, limit]);
    return rows.map((r) => migrationSummary(r as Row));
  }

  async latestMigration(repoId: number): Promise<MigrationRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM migrations WHERE repo_id = $1 ORDER BY received_at DESC, id DESC LIMIT 1', [repoId]);
    if (!rows[0]) return null;
    const row = rows[0] as Row;
    return { ...migrationSummary(row), report: openField<MigrationReport>(row.report, this.keyring) };
  }

  async pruneMigrations(repoId: number, keep: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM migrations WHERE repo_id = $1 AND id NOT IN (SELECT id FROM migrations WHERE repo_id = $1 ORDER BY received_at DESC, id DESC LIMIT $2)`,
      [repoId, keep],
    );
  }

  async pruneMigrationsByAge(days: number): Promise<number> {
    const del = await this.pool.query(`DELETE FROM migrations WHERE received_at < now() - ($1 || ' days')::interval`, [String(days)]);
    return del.rowCount ?? 0;
  }

  // --- acknowledgements ---

  async acknowledge(a: AcknowledgementInput): Promise<Acknowledgement> {
    // Retire the active row first so at most one is active per finding.
    await this.pool.query('UPDATE acknowledgements SET cleared_at = now(), cleared_by = $4 WHERE repo_id = $1 AND provider = $2 AND model = $3 AND cleared_at IS NULL', [
      a.repoId,
      a.provider,
      a.model,
      a.acknowledgedBy,
    ]);
    const { rows } = await this.pool.query('INSERT INTO acknowledgements (repo_id, provider, model, acknowledged_by, owner, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [
      a.repoId,
      a.provider,
      a.model,
      a.acknowledgedBy,
      a.owner,
      a.note,
    ]);
    return acknowledgement(rows[0] as Row);
  }

  async clearAcknowledgement(repoId: number, provider: string, model: string, clearedBy: string): Promise<boolean> {
    const res = await this.pool.query('UPDATE acknowledgements SET cleared_at = now(), cleared_by = $4 WHERE repo_id = $1 AND provider = $2 AND model = $3 AND cleared_at IS NULL', [
      repoId,
      provider,
      model,
      clearedBy,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async activeAcknowledgements(repoId: number): Promise<Map<string, Acknowledgement>> {
    const { rows } = await this.pool.query('SELECT * FROM acknowledgements WHERE repo_id = $1 AND cleared_at IS NULL ORDER BY id DESC', [repoId]);
    const out = new Map<string, Acknowledgement>();
    for (const r of rows) {
      const a = acknowledgement(r as Row);
      const key = `${a.provider}/${a.model}`;
      if (!out.has(key)) out.set(key, a);
    }
    return out;
  }

  // --- approvals ---

  async createApproval(a: ApprovalInput): Promise<Approval> {
    const { rows } = await this.pool.query('INSERT INTO approvals (repo_id, provider, model, replacement, mode, approved_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [
      a.repoId,
      a.provider,
      a.model,
      a.replacement,
      a.mode,
      a.approvedBy,
    ]);
    return approval(rows[0] as Row);
  }

  async getApproval(id: number): Promise<Approval | null> {
    const { rows } = await this.pool.query('SELECT * FROM approvals WHERE id = $1', [id]);
    return rows[0] ? approval(rows[0] as Row) : null;
  }

  async activeApprovals(repoId: number): Promise<Map<string, Approval>> {
    const { rows } = await this.pool.query(`SELECT * FROM approvals WHERE repo_id = $1 AND status IN ('queued', 'running') ORDER BY id DESC`, [repoId]);
    const out = new Map<string, Approval>();
    for (const r of rows) {
      const a = approval(r as Row);
      const key = `${a.provider}/${a.model}`;
      if (!out.has(key)) out.set(key, a);
    }
    return out;
  }

  async listApprovals(repoId: number, limit: number): Promise<Approval[]> {
    const { rows } = await this.pool.query('SELECT * FROM approvals WHERE repo_id = $1 ORDER BY id DESC LIMIT $2', [repoId, limit]);
    return rows.map((r) => approval(r as Row));
  }

  async claimApprovals(repoId: number, ids: number[], runId: number, event: ApprovalEvent): Promise<Approval[]> {
    if (!ids.length) return [];
    const { rows } = await this.pool.query(
      `UPDATE approvals SET status = 'running', started_at = $3, run_id = $4, events = events || $5::jsonb
       WHERE repo_id = $1 AND id = ANY($2::bigint[]) AND status = 'queued' RETURNING *`,
      [repoId, ids, event.at, runId, JSON.stringify([event])],
    );
    return rows.map((r) => approval(r as Row));
  }

  async appendApprovalEvent(id: number, event: ApprovalEvent): Promise<void> {
    await this.pool.query('UPDATE approvals SET events = events || $2::jsonb WHERE id = $1', [id, JSON.stringify([event])]);
  }

  async markApprovalDispatched(id: number, event: ApprovalEvent): Promise<void> {
    await this.pool.query('UPDATE approvals SET dispatched_at = $2, events = events || $3::jsonb WHERE id = $1', [id, event.at, JSON.stringify([event])]);
  }

  async finishApprovals(repoId: number, runId: number, migrationId: number, outcome: string, event: ApprovalEvent): Promise<Approval[]> {
    const { rows } = await this.pool.query(
      `UPDATE approvals SET status = $5, finished_at = $6, migration_id = $3, outcome = $4, events = events || $7::jsonb
       WHERE repo_id = $1 AND run_id = $2 AND status IN ('queued', 'running') RETURNING *`,
      [repoId, runId, migrationId, outcome, event.stage === 'failed' ? 'failed' : 'done', event.at, JSON.stringify([event])],
    );
    return rows.map((r) => approval(r as Row));
  }

  async cancelApproval(id: number, event: ApprovalEvent): Promise<boolean> {
    const res = await this.pool.query(`UPDATE approvals SET status = 'cancelled', finished_at = $2, events = events || $3::jsonb WHERE id = $1 AND status IN ('queued', 'running')`, [
      id,
      event.at,
      JSON.stringify([event]),
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async markMigrateSeen(repoId: number, at: string, workflowFile: string | null): Promise<void> {
    await this.pool.query('UPDATE repos SET migrate_seen_at = $2, migrate_workflow = COALESCE($3, migrate_workflow) WHERE id = $1', [repoId, at, workflowFile]);
  }

  // A key that arrives after data already exists must not leave the old rows
  // in plaintext: seal them, one row at a time, with the primary key.
  async sealPlaintextReports(): Promise<{ runs: number; migrations: number }> {
    if (!this.keyring) return { runs: 0, migrations: 0 };
    const seal = async (table: 'runs' | 'migrations'): Promise<number> => {
      const { rows } = await this.pool.query(`SELECT id, report FROM ${table} WHERE NOT (report ? 'enc') ORDER BY id`);
      let sealed = 0;
      for (const r of rows) {
        const row = r as Row;
        await this.pool.query(`UPDATE ${table} SET report = $2 WHERE id = $1 AND NOT (report ? 'enc')`, [n(row.id), JSON.stringify(sealForStore(row.report, this.keyring))]);
        sealed++;
      }
      return sealed;
    };
    return { runs: await seal('runs'), migrations: await seal('migrations') };
  }

  // A sealed report is a JSON envelope with an `enc` key (encryption.ts); a
  // plaintext one is the report itself, which has none. Counting the key is
  // proof enough from the outside, and it never touches the contents.
  async encryptionStatus(): Promise<EncryptionStatus> {
    const count = async (table: 'runs' | 'migrations'): Promise<{ sealed: number; plain: number }> => {
      const { rows } = await this.pool.query(`SELECT count(*) FILTER (WHERE report ? 'enc') AS sealed, count(*) FILTER (WHERE NOT (report ? 'enc')) AS plain FROM ${table}`);
      const r = (rows[0] ?? {}) as Row;
      return { sealed: n(r.sealed ?? 0), plain: n(r.plain ?? 0) };
    };
    const runs = await count('runs');
    const migrations = await count('migrations');
    let decrypt: EncryptionStatus['decrypt'] = 'none';
    const { rows } = await this.pool.query(`SELECT report FROM runs WHERE report ? 'enc' ORDER BY id DESC LIMIT 1`);
    if (rows[0]) {
      try {
        openField((rows[0] as Row).report, this.keyring);
        decrypt = 'ok';
      } catch {
        decrypt = 'failed';
      }
    }
    return { sealedRuns: runs.sealed, plaintextRuns: runs.plain, sealedMigrations: migrations.sealed, plaintextMigrations: migrations.plain, decrypt };
  }

  async setMigrateWorkflow(repoId: number, workflowFile: string): Promise<void> {
    await this.pool.query('UPDATE repos SET migrate_workflow = $2 WHERE id = $1', [repoId, workflowFile]);
  }

  async deleteRepoData(repoId: number): Promise<RepoDeletion> {
    const del = await this.pool.query('DELETE FROM runs WHERE repo_id = $1', [repoId]);
    const mig = await this.pool.query('DELETE FROM migrations WHERE repo_id = $1', [repoId]);
    const ack = await this.pool.query('DELETE FROM acknowledgements WHERE repo_id = $1', [repoId]);
    const apr = await this.pool.query('DELETE FROM approvals WHERE repo_id = $1', [repoId]);
    await this.pool.query('DELETE FROM repos WHERE id = $1', [repoId]);
    return { runsDeleted: del.rowCount ?? 0, migrationsDeleted: mig.rowCount ?? 0, acknowledgementsDeleted: ack.rowCount ?? 0, approvalsDeleted: apr.rowCount ?? 0 };
  }

  async deleteInstallationData(installationId: number, at: string): Promise<RepoDeletion & { reposDeleted: number }> {
    const runs = await this.pool.query('DELETE FROM runs WHERE repo_id IN (SELECT id FROM repos WHERE installation_id = $1)', [installationId]);
    const migrations = await this.pool.query('DELETE FROM migrations WHERE repo_id IN (SELECT id FROM repos WHERE installation_id = $1)', [installationId]);
    const acks = await this.pool.query('DELETE FROM acknowledgements WHERE repo_id IN (SELECT id FROM repos WHERE installation_id = $1)', [installationId]);
    const approvals = await this.pool.query('DELETE FROM approvals WHERE repo_id IN (SELECT id FROM repos WHERE installation_id = $1)', [installationId]);
    const repos = await this.pool.query('DELETE FROM repos WHERE installation_id = $1', [installationId]);
    // Keep the installation row as a deletion record (it holds no findings).
    await this.pool.query('UPDATE installations SET deleted_at = $2, updated_at = now() WHERE id = $1', [installationId, at]);
    return {
      reposDeleted: repos.rowCount ?? 0,
      runsDeleted: runs.rowCount ?? 0,
      migrationsDeleted: migrations.rowCount ?? 0,
      acknowledgementsDeleted: acks.rowCount ?? 0,
      approvalsDeleted: approvals.rowCount ?? 0,
    };
  }

  async pruneRunsByAge(days: number): Promise<number> {
    const del = await this.pool.query(`DELETE FROM runs WHERE received_at < now() - ($1 || ' days')::interval`, [String(days)]);
    return del.rowCount ?? 0;
  }

  async appendAuditLog(entry: AuditLogInput): Promise<void> {
    const e = sanitizeEntry(entry);
    await this.pool.query('INSERT INTO audit_log (event, installation_id, repo, actor, detail) VALUES ($1, $2, $3, $4, $5)', [
      e.event,
      e.installationId,
      e.repo,
      e.actor,
      JSON.stringify(e.detail),
    ]);
  }

  async listAuditLog(opts: { installationId?: number; limit?: number } = {}): Promise<AuditLogEntry[]> {
    const limit = opts.limit ?? 200;
    const { rows } =
      opts.installationId === undefined
        ? await this.pool.query('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT $1', [limit])
        : await this.pool.query('SELECT * FROM audit_log WHERE installation_id = $1 ORDER BY at DESC, id DESC LIMIT $2', [opts.installationId, limit]);
    return rows.map((r) => {
      const row = r as Row;
      return {
        id: n(row.id),
        at: iso(row.at) ?? new Date().toISOString(),
        event: String(row.event) as AuditLogEntry['event'],
        installationId: row.installation_id === null ? null : n(row.installation_id),
        repo: row.repo === null ? null : String(row.repo),
        actor: row.actor === null ? null : String(row.actor),
        detail: (row.detail ?? {}) as AuditLogEntry['detail'],
      };
    });
  }

  async latestRunPerRepo(): Promise<Map<number, RunSummary>> {
    const { rows } = await this.pool.query(`SELECT DISTINCT ON (repo_id) ${SUMMARY_COLUMNS} FROM runs ORDER BY repo_id, received_at DESC, id DESC`);
    const out = new Map<number, RunSummary>();
    for (const r of rows) {
      const s = summary(r as Row);
      out.set(s.repoId, s);
    }
    return out;
  }

  async latestCompletedRunPerRepo(): Promise<Map<number, RunSummary>> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (repo_id) ${SUMMARY_COLUMNS} FROM runs WHERE conclusion = ANY($1::text[]) ORDER BY repo_id, received_at DESC, id DESC`,
      [[...COMPLETED_CONCLUSIONS]],
    );
    const out = new Map<number, RunSummary>();
    for (const r of rows) {
      const s = summary(r as Row);
      out.set(s.repoId, s);
    }
    return out;
  }
}

export async function createPgStore(connectionString: string, keyring: DataKeyring | null = null): Promise<PgStore> {
  // Enable TLS only when the connection string asks for it (an external managed
  // Postgres — sslmode=require, or a *.render.com host). A same-region Render
  // internal URL needs no TLS, so this is a no-op there; forcing TLS on it would
  // fail, which is why it is conditional. rejectUnauthorized:false accepts the
  // provider's managed certificate chain.
  const needsSsl = /sslmode=require/i.test(connectionString) || /\.render\.com|\.rds\.amazonaws\.com|\.neon\.tech|\.supabase\.co/i.test(connectionString);
  const pool = new pg.Pool({ connectionString, max: 5, ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}) });
  const store = new PgStore(pool, keyring);
  await store.ensureSchema();
  return store;
}
