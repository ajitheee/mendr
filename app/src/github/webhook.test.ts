import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/memory.js';
import { applyWebhook, verifyWebhookSignature } from './webhook.js';

const secret = 'whsec_test';
const sign = (body: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifyWebhookSignature', () => {
  it('accepts GitHub-style sha256 signatures over the raw body', () => {
    const body = '{"action":"created"}';
    expect(verifyWebhookSignature(secret, body, sign(body))).toBe(true);
  });

  it('rejects a wrong secret, a tampered body, a missing header and a malformed header', () => {
    const body = '{"action":"created"}';
    expect(verifyWebhookSignature('other', body, sign(body))).toBe(false);
    expect(verifyWebhookSignature(secret, body + ' ', sign(body))).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha1=abc')).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha256=zz')).toBe(false);
  });
});

describe('applyWebhook maintains the tenant boundary', () => {
  const inst = { id: 42, account: { login: 'acme', type: 'Organization' } };

  it('installation.created records the installation and its repositories', async () => {
    const store = new MemoryStore();
    const out = await applyWebhook(store, 'installation', { action: 'created', installation: inst, repositories: [{ id: 1, full_name: 'acme/api', private: true }] }, '2026-09-04T00:00:00Z');
    expect(out).toContain('created');
    expect(await store.getInstallation(42)).toMatchObject({ accountLogin: 'acme', accountType: 'Organization', suspended: false });
    expect(await store.getRepo(1)).toMatchObject({ fullName: 'acme/api', installationId: 42 });
  });

  it('installation_repositories adds and removes repositories', async () => {
    const store = new MemoryStore();
    await applyWebhook(store, 'installation', { action: 'created', installation: inst, repositories: [{ id: 1, full_name: 'acme/api' }] }, 't');
    await applyWebhook(store, 'installation_repositories', { action: 'added', installation: inst, repositories_added: [{ id: 2, full_name: 'acme/web' }], repositories_removed: [] }, 't');
    await applyWebhook(store, 'installation_repositories', { action: 'removed', installation: inst, repositories_added: [], repositories_removed: [{ id: 1, full_name: 'acme/api' }] }, '2026-09-05T00:00:00Z');
    expect((await store.listRepos()).map((r) => r.fullName)).toEqual(['acme/web']);
    expect((await store.getRepo(1))?.removedAt).toBe('2026-09-05T00:00:00Z');
  });

  it('suspend, unsuspend and delete change what ingest will accept', async () => {
    const store = new MemoryStore();
    await applyWebhook(store, 'installation', { action: 'created', installation: inst }, 't');
    await applyWebhook(store, 'installation', { action: 'suspend', installation: inst }, 't');
    expect((await store.getInstallation(42))?.suspended).toBe(true);
    await applyWebhook(store, 'installation', { action: 'unsuspend', installation: inst }, 't');
    expect((await store.getInstallation(42))?.suspended).toBe(false);
    await applyWebhook(store, 'installation', { action: 'deleted', installation: inst }, '2026-09-06T00:00:00Z');
    expect((await store.getInstallation(42))?.deletedAt).toBe('2026-09-06T00:00:00Z');
  });

  it('ignores events that carry repository content or that it does not need', async () => {
    const store = new MemoryStore();
    expect(await applyWebhook(store, 'push', { installation: inst, commits: [] }, 't')).toContain('ignored');
    expect(await applyWebhook(store, 'installation', null, 't')).toContain('ignored');
    expect(await store.getInstallation(42)).toBeNull();
  });
});
