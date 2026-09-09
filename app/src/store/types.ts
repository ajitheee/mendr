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
  /** When the repo's migration workflow last asked the App for approvals — proof it is listening. */
  migrateSeenAt: string | null;
  /** That workflow's file name (from the OIDC workflow_ref claim), where a start is sent. */
  migrateWorkflow: string | null;
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
 * A person's decision about one finding: seen, and who owns it. Keyed by
 * repository + provider + model so it follows the finding across runs. It is
 * a note ABOUT a finding — never the finding, and never a change to its status.
 */
export interface Acknowledgement {
  id: number;
  repoId: number;
  provider: string;
  model: string;
  /** The GitHub login that acknowledged (from the session, never from the form). */
  acknowledgedBy: string;
  /** Who owns the follow-up: a login, a team, a name. Free text, capped. */
  owner: string | null;
  /** A short free-text note, capped. */
  note: string | null;
  createdAt: string;
  clearedAt: string | null;
  clearedBy: string | null;
}

export type AcknowledgementInput = Pick<Acknowledgement, 'repoId' | 'provider' | 'model' | 'acknowledgedBy' | 'owner' | 'note'>;

/** What to do once the migration verifies: open a PR for review, or open it and merge when checks pass. */
export const APPROVAL_MODES = ['pr', 'auto-merge'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const APPROVAL_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
/** The stages a CI run streams while it carries an approval out (plus the App's own bookkeeping stages). */
export const APPROVAL_STAGES = ['queued', 'dispatched', 'claimed', 'verifying', 'verified', 'not-verified', 'applying', 'pushed', 'pr', 'done', 'failed', 'cancelled'] as const;
export type ApprovalStage = (typeof APPROVAL_STAGES)[number];

export interface ApprovalEvent {
  at: string;
  stage: ApprovalStage;
  /** A short, redacted, capped line — never code. */
  detail: string | null;
}

/**
 * A person's decision, made in the App, to migrate one finding. The customer's
 * own CI claims it (proven by OIDC), runs the verified migration for exactly
 * that model, streams progress here and reports the result. The App never
 * touches the repository: it records the decision and what the CI says.
 */
export interface Approval {
  id: number;
  repoId: number;
  provider: string;
  model: string;
  /** The replacement the registry recommended when it was approved (informational). */
  replacement: string | null;
  mode: ApprovalMode;
  /** The GitHub login that approved (from the session, never the form). */
  approvedBy: string;
  createdAt: string;
  status: ApprovalStatus;
  /** When the App started the workflow itself (only with the optional actions:write). */
  dispatchedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The Actions run that claimed it. */
  runId: number | null;
  /** The migration report that closed it. */
  migrationId: number | null;
  /** The report's outcome that closed it. */
  outcome: string | null;
  events: ApprovalEvent[];
}

export type ApprovalInput = Pick<Approval, 'repoId' | 'provider' | 'model' | 'replacement' | 'mode' | 'approvedBy'>;

/** Changes whenever an approval's visible state changes — the page polls it to know when to refresh. */
export function approvalVersion(a: Approval): string {
  return `${a.status}:${a.events.length}`;
}

/** Proof of encryption at rest, from the outside: counts and a verdict, never data. */
export interface EncryptionStatus {
  sealedRuns: number;
  plaintextRuns: number;
  sealedMigrations: number;
  plaintextMigrations: number;
  /** ok = the newest sealed report opens with the current key; failed = it does not (key mismatch); none = nothing sealed is stored. */
  decrypt: 'ok' | 'failed' | 'none';
}

/** What deletion removed, by kind — reported to the user and to the audit log. */
export interface RepoDeletion {
  runsDeleted: number;
  migrationsDeleted: number;
  acknowledgementsDeleted: number;
  approvalsDeleted: number;
}

/**
 * What the App remembers. Four things: who installed it, which repositories
 * that covers, the sanitized evidence each run sent, and who acknowledged a
 * finding. No code, no user tokens (those live only in the user's encrypted
 * cookie).
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
  // --- acknowledgements (a person's decision about a finding; never the finding) ---
  /** Record that someone owns this finding. Replaces any active acknowledgement of the same (repo, provider, model). */
  acknowledge(a: AcknowledgementInput): Promise<Acknowledgement>;
  /** Clear the active acknowledgement, keeping it as history. Returns whether one was active. */
  clearAcknowledgement(repoId: number, provider: string, model: string, clearedBy: string): Promise<boolean>;
  /** The active acknowledgements of a repository, keyed by `${provider}/${model}`. */
  activeAcknowledgements(repoId: number): Promise<Map<string, Acknowledgement>>;
  // --- approvals (decided here; carried out by the customer's own CI) ---
  createApproval(a: ApprovalInput): Promise<Approval>;
  getApproval(id: number): Promise<Approval | null>;
  /** Queued and running approvals of a repository, keyed by `${provider}/${model}` (newest wins). */
  activeApprovals(repoId: number): Promise<Map<string, Approval>>;
  /** Newest first. */
  listApprovals(repoId: number, limit: number): Promise<Approval[]>;
  /** Queued → running for these ids of this repository, recording the CI run that took them. Returns what was claimed. */
  claimApprovals(repoId: number, ids: number[], runId: number, event: ApprovalEvent): Promise<Approval[]>;
  /** Append a progress event. Never changes the status. */
  appendApprovalEvent(id: number, event: ApprovalEvent): Promise<void>;
  /** The App started the workflow itself. */
  markApprovalDispatched(id: number, event: ApprovalEvent): Promise<void>;
  /** Close whatever this CI run claimed, from the migration report it sent. Returns what was closed. */
  finishApprovals(repoId: number, runId: number, migrationId: number, outcome: string, event: ApprovalEvent): Promise<Approval[]>;
  /** Queued → cancelled. Returns whether it was still queued. */
  cancelApproval(id: number, event: ApprovalEvent): Promise<boolean>;
  /** The repo's migration workflow just asked for approvals: it is listening, and this is its file. */
  markMigrateSeen(repoId: number, at: string, workflowFile: string | null): Promise<void>;
  // --- operations (trust: prove encryption at rest from the outside) ---
  /** How many stored reports are sealed vs plaintext, and whether the newest sealed one opens with the current key. Counts only — never data. */
  encryptionStatus(): Promise<EncryptionStatus>;
  /** The audit saw which file carries the migration job (coverage.migration.workflowFile). */
  setMigrateWorkflow(repoId: number, workflowFile: string): Promise<void>;
  // --- retention & deletion (trust: data cleanup) ---
  /** Hard-delete a repository's stored runs, migration reports, acknowledgements and the repo row. Returns how many went. */
  deleteRepoData(repoId: number): Promise<RepoDeletion>;
  /**
   * Hard-delete ALL stored findings, migration reports, acknowledgements and
   * repositories for an installation (App uninstalled). The installation row
   * is kept, marked deleted, as a deletion record that holds no findings.
   */
  deleteInstallationData(installationId: number, at: string): Promise<RepoDeletion & { reposDeleted: number }>;
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
  | 'finding_acknowledged'
  | 'acknowledgement_cleared'
  | 'migration_approved'
  | 'approval_cancelled'
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
