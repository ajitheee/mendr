import type { AuditReport, DecisionCounts } from '../ingest/validate.js';

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

export type RunInput = Omit<RunRecord, 'id' | 'receivedAt'>;

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
  latestRunPerRepo(): Promise<Map<number, RunSummary>>;
}
