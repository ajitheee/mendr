import type { AuditReport, DecisionCounts } from '../ingest/validate.js';
import type { MigrationOutcome, MigrationReport, MigrationVerdict } from '../ingest/migrationReport.js';

export interface Installation {
  id: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  suspended: boolean;
  deletedAt: string | null;
}

export interface Repo {
  id: number;
  installationId: number;
  fullName: string;
  private: boolean;
  removedAt: string | null;
}

export interface RepoInput {
  id: number;
  fullName: string;
  private: boolean;
}

export interface RunSummary {
  id: number;
  repoId: number;
  sha: string;
  ref: string;
  runId: number;
  runAttempt: number;
  workflowRef: string | null;
  actor: string | null;
  receivedAt: string;
  generatedAt: string | null;
  conclusion: string;
  counts: DecisionCounts;
  checkRunUrl: string | null;
}

export interface RunRecord extends RunSummary {
  report: AuditReport;
}

/** The conclusions of a scan that actually completed — the only runs a "last successful scan" may be. */
export const COMPLETED_CONCLUSIONS: ReadonlySet<string> = new Set(['exposure_detected', 'no_exposure_in_completed_surfaces']);

export type RunInput = Omit<RunRecord, 'id' | 'receivedAt'>;

/** What mendr-action reported after one migration run — never the diff. */
export interface MigrationSummary {
  id: number;
  repoId: number;
  sha: string;
  ref: string;
  runId: number;
  runAttempt: number;
  workflowRef: string | null;
  actor: string | null;
  receivedAt: string;
  generatedAt: string | null;
  outcome: MigrationOutcome;
  verdict: MigrationVerdict | null;
  prUrl: string | null;
}

export interface MigrationRecord extends MigrationSummary {
  report: MigrationReport;
}

export type MigrationInput = Omit<MigrationRecord, 'id' | 'receivedAt'>;

/**
 * What the App remembers. Three things: who installed it, which repositories
 * that covers, and the sanitized evidence each run sent. No code, no user
 * tokens (those live only in the user's encrypted cookie).
 */
export interface Store {
  readonly kind: 'memory' | 'postgres';
  upsertInstallation(i: Installation): Promise<void>;
  markInstallationDeleted(id: number, at: string): Promise<void>;
  setInstallationSuspended(id: number, suspended: boolean): Promise<void>;
  getInstallation(id: number): Promise<Installation | null>;
  upsertRepos(installationId: number, repos: RepoInput[]): Promise<void>;
  removeRepos(installationId: number, repoIds: number[], at: string): Promise<void>;
  getRepo(id: number): Promise<Repo | null>;
  getRepoByName(fullName: string): Promise<Repo | null>;
  /** Active (not removed) repositories, sorted by name. */
  listRepos(): Promise<Repo[]>;
  /** Insert, or replace the run with the same (repo, run id, attempt). */
  saveRun(run: RunInput): Promise<RunRecord>;
  setRunCheckUrl(id: number, url: string): Promise<void>;
  listRuns(repoId: number, limit: number): Promise<RunSummary[]>;
  getRun(id: number): Promise<RunRecord | null>;
  pruneRuns(repoId: number, keep: number): Promise<void>;
  /** The newest run per repository, whatever it concluded — the "last attempt". */
  latestRunPerRepo(): Promise<Map<number, RunSummary>>;
  /** The newest run per repository whose scan COMPLETED (COMPLETED_CONCLUSIONS) — the "last successful scan". */
  latestCompletedRunPerRepo(): Promise<Map<number, RunSummary>>;
  // --- migrations (what mendr-action reported; never the diff) ---
  /** Insert, or replace the report with the same (repo, run id, attempt). */
  saveMigration(m: MigrationInput): Promise<MigrationRecord>;
  listMigrations(repoId: number, limit: number): Promise<MigrationSummary[]>;
  /** The newest migration report for a repository, with its sanitized body. */
  latestMigration(repoId: number): Promise<MigrationRecord | null>;
  pruneMigrations(repoId: number, keep: number): Promise<void>;
  /** Delete migration reports older than `days`, across all repos. Retention control. */
  pruneMigrationsByAge(days: number): Promise<number>;
  // --- retention & deletion (trust: data cleanup) ---
  /** Hard-delete a repository's stored runs, migration reports and the repo row. Returns how many went. */
  deleteRepoData(repoId: number): Promise<{ runsDeleted: number; migrationsDeleted: number }>;
  /**
   * Hard-delete ALL stored findings, migration reports and repositories for an
   * installation (App uninstalled). The installation row is kept, marked
   * deleted, as a deletion record that holds no findings.
   */
  deleteInstallationData(installationId: number, at: string): Promise<{ reposDeleted: number; runsDeleted: number; migrationsDeleted: number }>;
  /** Delete runs older than `days`, across all repos. Returns how many went. Retention control. */
  pruneRunsByAge(days: number): Promise<number>;
  // --- audit log (trust: an append-only record of security-relevant events) ---
  /** Append one event. `detail` holds only scalars — never findings, secrets or code. */
  appendAuditLog(entry: AuditLogInput): Promise<void>;
  /** Read recent events, newest first; optionally scoped to one installation. */
  listAuditLog(opts?: { installationId?: number; limit?: number }): Promise<AuditLogEntry[]>;
}

/** The security-relevant events the audit log records. */
export type AuditEvent =
  | 'installation_connected'
  | 'installation_suspended'
  | 'installation_removed'
  | 'repos_added'
  | 'repos_removed'
  | 'audit_received'
  | 'data_deleted'
  // Emitted once their features land (acknowledgement tracking; the Action opens PRs):
  | 'finding_acknowledged'
  | 'migration_prepared'
  | 'pr_created';

export interface AuditLogInput {
  event: AuditEvent;
  installationId: number | null;
  /** Repository full name, when the event is about one. */
  repo: string | null;
  /** The GitHub login that caused it, when known. */
  actor: string | null;
  /** Scalar-only context (counts, ids, a conclusion). NEVER findings, secrets or source. */
  detail: Record<string, string | number | boolean | null>;
}

export interface AuditLogEntry extends AuditLogInput {
  id: number;
  at: string;
}
