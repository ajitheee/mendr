import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type { AuditReport } from '../ingest/validate.js';
import type { Installation, Repo, RepoInput, RunInput, RunRecord, RunSummary, Store } from './types.js';

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
  return { id: n(r.id), installationId: n(r.installation_id), fullName: String(r.full_name), private: !!r.private, removedAt: iso(r.removed_at) };
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

export class PgStore implements Store {
  readonly kind = 'postgres' as const;
  constructor(private readonly pool: pg.Pool) {}

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
        JSON.stringify(run.report),
      ],
    );
    const row = rows[0] as Row;
    return { ...summary(row), report: row.report as AuditReport };
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
    return { ...summary(row), report: row.report as AuditReport };
  }

  async pruneRuns(repoId: number, keep: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM runs WHERE repo_id = $1 AND id NOT IN (SELECT id FROM runs WHERE repo_id = $1 ORDER BY received_at DESC, id DESC LIMIT $2)`,
      [repoId, keep],
    );
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
}

export async function createPgStore(connectionString: string): Promise<PgStore> {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const store = new PgStore(pool);
  await store.ensureSchema();
  return store;
}
