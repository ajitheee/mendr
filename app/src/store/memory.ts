import {
  COMPLETED_CONCLUSIONS,
  type Acknowledgement,
  type AcknowledgementInput,
  type AuditLogEntry,
  type AuditLogInput,
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
import { sanitizeEntry } from './auditLog.js';

/** Development and test store. Everything is lost on restart, by design. */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private installations = new Map<number, Installation>();
  private repos = new Map<number, Repo>();
  private runs = new Map<number, RunRecord>();
  private nextRunId = 1;
  private migrations = new Map<number, MigrationRecord>();
  private nextMigrationId = 1;
  private acknowledgements = new Map<number, Acknowledgement>();
  private nextAcknowledgementId = 1;

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

  // --- migrations ---

  async saveMigration(m: MigrationInput): Promise<MigrationRecord> {
    const existing = [...this.migrations.values()].find((x) => x.repoId === m.repoId && x.runId === m.runId && x.runAttempt === m.runAttempt);
    const id = existing?.id ?? this.nextMigrationId++;
    const record: MigrationRecord = { ...m, id, receivedAt: new Date().toISOString() };
    this.migrations.set(id, record);
    return { ...record };
  }

  private sortedMigrations(repoId: number): MigrationRecord[] {
    return [...this.migrations.values()].filter((x) => x.repoId === repoId).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id - a.id);
  }

  async listMigrations(repoId: number, limit: number): Promise<MigrationSummary[]> {
    return this.sortedMigrations(repoId)
      .slice(0, limit)
      .map(({ report: _report, ...summary }) => summary);
  }

  async latestMigration(repoId: number): Promise<MigrationRecord | null> {
    const m = this.sortedMigrations(repoId)[0];
    return m ? { ...m } : null;
  }

  async pruneMigrations(repoId: number, keep: number): Promise<void> {
    for (const m of this.sortedMigrations(repoId).slice(keep)) this.migrations.delete(m.id);
  }

  async pruneMigrationsByAge(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    let deleted = 0;
    for (const [id, m] of [...this.migrations]) {
      if (m.receivedAt < cutoff) {
        this.migrations.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  // --- acknowledgements ---

  private activeAck(repoId: number, provider: string, model: string): Acknowledgement | undefined {
    return [...this.acknowledgements.values()].find((a) => a.repoId === repoId && a.provider === provider && a.model === model && !a.clearedAt);
  }

  async acknowledge(a: AcknowledgementInput): Promise<Acknowledgement> {
    const at = new Date().toISOString();
    const prior = this.activeAck(a.repoId, a.provider, a.model);
    if (prior) this.acknowledgements.set(prior.id, { ...prior, clearedAt: at, clearedBy: a.acknowledgedBy });
    const record: Acknowledgement = { ...a, id: this.nextAcknowledgementId++, createdAt: at, clearedAt: null, clearedBy: null };
    this.acknowledgements.set(record.id, record);
    return { ...record };
  }

  async clearAcknowledgement(repoId: number, provider: string, model: string, clearedBy: string): Promise<boolean> {
    const active = this.activeAck(repoId, provider, model);
    if (!active) return false;
    this.acknowledgements.set(active.id, { ...active, clearedAt: new Date().toISOString(), clearedBy });
    return true;
  }

  async activeAcknowledgements(repoId: number): Promise<Map<string, Acknowledgement>> {
    const out = new Map<string, Acknowledgement>();
    for (const a of this.acknowledgements.values()) if (a.repoId === repoId && !a.clearedAt) out.set(`${a.provider}/${a.model}`, { ...a });
    return out;
  }

  async deleteRepoData(repoId: number): Promise<RepoDeletion> {
    let runsDeleted = 0;
    for (const [id, r] of [...this.runs]) {
      if (r.repoId === repoId) {
        this.runs.delete(id);
        runsDeleted++;
      }
    }
    let migrationsDeleted = 0;
    for (const [id, m] of [...this.migrations]) {
      if (m.repoId === repoId) {
        this.migrations.delete(id);
        migrationsDeleted++;
      }
    }
    let acknowledgementsDeleted = 0;
    for (const [id, a] of [...this.acknowledgements]) {
      if (a.repoId === repoId) {
        this.acknowledgements.delete(id);
        acknowledgementsDeleted++;
      }
    }
    this.repos.delete(repoId);
    return { runsDeleted, migrationsDeleted, acknowledgementsDeleted };
  }

  async deleteInstallationData(installationId: number, at: string): Promise<RepoDeletion & { reposDeleted: number }> {
    const repoIds = [...this.repos.values()].filter((r) => r.installationId === installationId).map((r) => r.id);
    const total: RepoDeletion = { runsDeleted: 0, migrationsDeleted: 0, acknowledgementsDeleted: 0 };
    for (const id of repoIds) {
      const gone = await this.deleteRepoData(id);
      total.runsDeleted += gone.runsDeleted;
      total.migrationsDeleted += gone.migrationsDeleted;
      total.acknowledgementsDeleted += gone.acknowledgementsDeleted;
    }
    const inst = this.installations.get(installationId);
    if (inst) this.installations.set(installationId, { ...inst, deletedAt: at });
    return { reposDeleted: repoIds.length, ...total };
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

  async latestCompletedRunPerRepo(): Promise<Map<number, RunSummary>> {
    const out = new Map<number, RunSummary>();
    for (const r of [...this.runs.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id - a.id)) {
      if (!COMPLETED_CONCLUSIONS.has(r.conclusion) || out.has(r.repoId)) continue;
      const { report: _report, ...summary } = r;
      out.set(r.repoId, summary);
    }
    return out;
  }
}
