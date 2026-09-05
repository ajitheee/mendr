import type { AuditLogEntry, AuditLogInput, Installation, Repo, RepoInput, RunInput, RunRecord, RunSummary, Store } from './types.js';
import { sanitizeEntry } from './auditLog.js';

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

  async deleteRepoData(repoId: number): Promise<{ runsDeleted: number }> {
    let runsDeleted = 0;
    for (const [id, r] of [...this.runs]) {
      if (r.repoId === repoId) {
        this.runs.delete(id);
        runsDeleted++;
      }
    }
    this.repos.delete(repoId);
    return { runsDeleted };
  }

  async deleteInstallationData(installationId: number, at: string): Promise<{ reposDeleted: number; runsDeleted: number }> {
    const repoIds = [...this.repos.values()].filter((r) => r.installationId === installationId).map((r) => r.id);
    let runsDeleted = 0;
    for (const id of repoIds) runsDeleted += (await this.deleteRepoData(id)).runsDeleted;
    const inst = this.installations.get(installationId);
    if (inst) this.installations.set(installationId, { ...inst, deletedAt: at });
    return { reposDeleted: repoIds.length, runsDeleted };
  }

  private auditLog: AuditLogEntry[] = [];
  private nextAuditId = 1;

  async appendAuditLog(entry: AuditLogInput): Promise<void> {
    const clean = sanitizeEntry(entry);
    this.auditLog.push({ ...clean, id: this.nextAuditId++, at: new Date().toISOString() });
  }

  async listAuditLog(opts: { installationId?: number; limit?: number } = {}): Promise<AuditLogEntry[]> {
    return this.auditLog
      .filter((e) => opts.installationId === undefined || e.installationId === opts.installationId)
      .sort((a, b) => b.id - a.id)
      .slice(0, opts.limit ?? 200)
      .map((e) => ({ ...e }));
  }

  async pruneRunsByAge(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    let deleted = 0;
    for (const [id, r] of [...this.runs]) {
      if (r.receivedAt < cutoff) {
        this.runs.delete(id);
        deleted++;
      }
    }
    return deleted;
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
