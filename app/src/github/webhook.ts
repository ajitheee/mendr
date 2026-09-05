import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Store } from '../store/types.js';

/** `X-Hub-Signature-256: sha256=<hex>` over the raw body, compared in constant time. */
export function verifyWebhookSignature(secret: string, rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = signatureHeader.slice('sha256='.length);
  if (given.length !== expected.length || !/^[0-9a-f]+$/i.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

interface RepoPayload {
  id: number;
  full_name: string;
  private?: boolean;
}

interface InstallationPayload {
  id: number;
  account?: { login?: string; type?: string };
  suspended_at?: string | null;
}

function repos(list: unknown): { id: number; fullName: string; private: boolean }[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r): r is RepoPayload => !!r && typeof r === 'object' && typeof (r as RepoPayload).id === 'number' && typeof (r as RepoPayload).full_name === 'string')
    .map((r) => ({ id: r.id, fullName: r.full_name, private: r.private !== false }));
}

/**
 * Apply one GitHub webhook to the store. Only the two installation events
 * matter: they define the tenant boundary. Everything else is acknowledged
 * and ignored, because the App never reads repository content.
 */
export async function applyWebhook(store: Store, event: string, payload: unknown, now: string): Promise<string> {
  if (!payload || typeof payload !== 'object') return 'ignored: no payload';
  const p = payload as { action?: string; installation?: InstallationPayload; repositories?: unknown; repositories_added?: unknown; repositories_removed?: unknown };
  const inst = p.installation;
  if (!inst || typeof inst.id !== 'number') return `ignored: ${event} without installation`;

  if (event === 'installation') {
    switch (p.action) {
      case 'created':
      case 'unsuspend':
      case 'new_permissions_accepted': {
        await store.upsertInstallation({
          id: inst.id,
          accountLogin: inst.account?.login ?? '?',
          accountType: inst.account?.type === 'Organization' ? 'Organization' : 'User',
          suspended: false,
          deletedAt: null,
        });
        const added = repos(p.repositories);
        if (added.length) await store.upsertRepos(inst.id, added);
        await store.appendAuditLog({ event: 'installation_connected', installationId: inst.id, repo: null, actor: inst.account?.login ?? null, detail: { action: p.action ?? '', repositories: added.length } });
        return `installation ${inst.id} ${p.action}: ${added.length} repositories`;
      }
      case 'suspend':
        await store.setInstallationSuspended(inst.id, true);
        await store.appendAuditLog({ event: 'installation_suspended', installationId: inst.id, repo: null, actor: inst.account?.login ?? null, detail: {} });
        return `installation ${inst.id} suspended`;
      case 'deleted': {
        // Uninstall = remove the customer's stored data: every finding and repo
        // is hard-deleted; the installation row survives as a deletion record.
        const gone = await store.deleteInstallationData(inst.id, now);
        await store.appendAuditLog({ event: 'installation_removed', installationId: inst.id, repo: null, actor: inst.account?.login ?? null, detail: { reposDeleted: gone.reposDeleted, runsDeleted: gone.runsDeleted } });
        return `installation ${inst.id} deleted: purged ${gone.reposDeleted} repositories and ${gone.runsDeleted} run(s)`;
      }
      default:
        return `ignored: installation.${p.action ?? '?'}`;
    }
  }

  if (event === 'installation_repositories') {
    const existing = await store.getInstallation(inst.id);
    if (!existing) {
      await store.upsertInstallation({
        id: inst.id,
        accountLogin: inst.account?.login ?? '?',
        accountType: inst.account?.type === 'Organization' ? 'Organization' : 'User',
        suspended: false,
        deletedAt: null,
      });
    }
    const added = repos(p.repositories_added);
    const removed = repos(p.repositories_removed);
    if (added.length) await store.upsertRepos(inst.id, added);
    // Access removed = findings deleted: hard-delete each removed repo's runs
    // and the repo row, not a soft-delete that keeps the data around.
    let runsDeleted = 0;
    for (const r of removed) runsDeleted += (await store.deleteRepoData(r.id)).runsDeleted;
    if (added.length) await store.appendAuditLog({ event: 'repos_added', installationId: inst.id, repo: null, actor: inst.account?.login ?? null, detail: { count: added.length } });
    if (removed.length) await store.appendAuditLog({ event: 'repos_removed', installationId: inst.id, repo: null, actor: inst.account?.login ?? null, detail: { count: removed.length, runsDeleted } });
    return `installation ${inst.id}: +${added.length} repositories, -${removed.length} (purged ${runsDeleted} run(s))`;
  }

  return `ignored: ${event}`;
}
