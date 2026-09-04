import type { Installation, Repo, RepoInput, RunInput, RunRecord, RunSummary, Store } from './types.js';

/** Development and test store. Everything is lost on restart, by design. */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private installations = new Map<number, Installation>();
  private repos = new Map<number, Repo>();
  private runs = new Map<number, RunRecord>();
  private nextRunId = 1;

  async upsertInstallation(i: Installation): Promise<void> {
    this.installations.set(i.id, { ...i });
  }

  async markInstallationDeleted(id: number, at: string): Promise<void> {
    const i = this.installations.get(id);
    if (i) this.installations.set(id, { ...i, deletedAt: at });
  }

  async setInstallationSuspended(id: number, suspended: boolean): Promise<void> {
    const i = this.installations.get(id);
    if (i) this.installations.set(id, { ...i, suspended });
  }

  async getInstallation(id: number): Promise<Installation | null> {
    const i = this.installations.get(id);
    return i ? { ...i } : null;
  }

  async upsertRepos(installationId: number, repos: RepoInput[]): Promise<void> {
    for (const r of repos) this.repos.set(r.id, { id: r.id, installationId, fullName: r.fullName, private: r.private, removedAt: null });
  }

  async removeRepos(installationId: number, repoIds: number[], at: string): Promise<void> {
    for (const id of repoIds) {
      const r = this.repos.get(id);
      if (r && r.installationId === installationId) this.repos.set(id, { ...r, removedAt: at });
    }
  }

  async getRepo(id: number): Promise<Repo | null> {
    const r = this.repos.get(id);
    return r ? { ...r } : null;
  }

  async getRepoByName(fullName: string): Promise<Repo | null> {
    const lower = fullName.toLowerCase();
    for (const r of this.repos.values()) if (r.fullName.toLowerCase() === lower && !r.removedAt) return { ...r };
    return null;
  }

  async listRepos(): Promise<Repo[]> {
    return [...this.repos.values()].filter((r) => !r.removedAt).sort((a, b) => a.fullName.localeCompare(b.fullName)).map((r) => ({ ...r }));
  }

  async saveRun(run: RunInput): Promise<RunRecord> {
    const existing = [...this.runs.values()].find((r) => r.repoId === run.repoId && r.runId === run.runId && r.runAttempt === run.runAttempt);
    const id = existing?.id ?? this.nextRunId++;
    const record: RunRecord = { ...run, id, receivedAt: new Date().toISOString(), checkRunUrl: null };
    this.runs.set(id, record);
    return { ...record };
  }

  async setRunCheckUrl(id: number, url: string): Promise<void> {
    const r = this.runs.get(id);
    if (r) this.runs.set(id, { ...r, checkRunUrl: url });
  }

  private sorted(repoId: number): RunRecord[] {
    return [...this.runs.values()].filter((r) => r.repoId === repoId).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id - a.id);
  }

  async listRuns(repoId: number, limit: number): Promise<RunSummary[]> {
    return this.sorted(repoId)
      .slice(0, limit)
      .map(({ report: _report, ...summary }) => summary);
  }

  async getRun(id: number): Promise<RunRecord | null> {
    const r = this.runs.get(id);
    return r ? { ...r } : null;
  }

  async pruneRuns(repoId: number, keep: number): Promise<void> {
    for (const r of this.sorted(repoId).slice(keep)) this.runs.delete(r.id);
  }

  async latestRunPerRepo(): Promise<Map<number, RunSummary>> {
    const out = new Map<number, RunSummary>();
    for (const r of [...this.runs.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id - a.id)) {
      if (!out.has(r.repoId)) {
        const { report: _report, ...summary } = r;
        out.set(r.repoId, summary);
      }
    }
    return out;
  }
}
