import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification, withheldVerification } from '../usage/llmRegistry.js';
import { foldConfigExposure, scanConfigText } from '../config/scanConfig.js';
import { NO_RUNTIME_EVIDENCE } from '../runtime/evidence.js';
import { buildInvestigations, type AuditCoverage } from './investigation.js';
import { diffFindings, fingerprint, identityOf, toFindings, toOpenFinding, surfaceCompleted, resolutionsAreTrustworthy } from './fingerprint.js';
import {
  AUDIT_CLEAR_MARKER,
  AUDIT_MARKER,
  EMPTY_STATE,
  MAX_HISTORY_ENTRIES,
  mayClose,
  parseAuditState,
  prEligibleFindings,
  redactSecrets,
  renderAuditIssue,
  requiredSurfacesCompleted,
} from './issueReport.js';

const REGISTRY: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'text-davinci-003', replacement: 'gpt-4o-mini', status: 'retired', shutdownDate: '2024-01-04', verification: withheldVerification('unverified') },
];
const NOW = new Date('2026-08-26T00:00:00Z');
const AT = NOW.toISOString();
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function coverage(over: Partial<AuditCoverage> = {}): AuditCoverage {
  return {
    source: { analyzed: true, filesScanned: 10, tsFiles: 10, pyFiles: 0 },
    config: { analyzed: true, filesScanned: 3 },
    registry: { providers: ['openai'] },
    runtime: { connected: false, source: null },
    readerTieBack: { proven: false },
    ...over,
  };
}

const configInvestigations = (yaml = 'model: gpt-4\n', file = 'app.yaml') =>
  buildInvestigations(NO_RUNTIME_EVIDENCE, foldConfigExposure(scanConfigText(file, yaml, REGISTRY)), NOW, [], REGISTRY);

describe('fingerprint — stable identity that survives line moves', () => {
  it('is identical when only the line number changes', () => {
    const a = toFindings(configInvestigations('model: gpt-4\n'))[0];
    const b = toFindings(configInvestigations('# a new comment\n# another\nmodel: gpt-4\n'))[0];
    expect(b.lines).not.toEqual(a.lines); // the line genuinely moved
    expect(b.fingerprint).toBe(a.fingerprint); // the identity did not
  });

  it('changes when the semantics change (different file)', () => {
    const a = toFindings(configInvestigations('model: gpt-4\n', 'app.yaml'))[0];
    const b = toFindings(configInvestigations('model: gpt-4\n', 'other.yaml'))[0];
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it('does not include the line number in the identity string', () => {
    const id = identityOf({ provider: 'openai', model: 'gpt-4', path: 'a/b.ts', key: 'model', evidenceType: 'code_call_site' });
    expect(id).toBe('openai|gpt-4|a/b.ts|model|code_call_site');
    expect(fingerprint(id)).toHaveLength(16);
  });

  it('normalizes windows separators so the same file is one identity', () => {
    expect(identityOf({ provider: 'o', model: 'm', path: 'a\\b.ts', key: null, evidenceType: 'e' }))
      .toBe(identityOf({ provider: 'o', model: 'm', path: 'a/b.ts', key: null, evidenceType: 'e' }));
  });

  it('collapses repeat occurrences in one file into ONE finding with a count', () => {
    const [f] = toFindings(configInvestigations('model: gpt-4\nmodel: gpt-4\n'));
    expect(f.occurrences).toBe(2);
    expect(f.lines).toEqual([1, 2]);
  });
});

describe('diffFindings — new / continuing / resolved', () => {
  const current = toFindings(configInvestigations());
  it('is all-new against no prior state', () => {
    const d = diffFindings([], current, coverage());
    expect(d.fresh).toHaveLength(current.length);
    expect(d.continuing).toHaveLength(0);
    expect(d.resolved).toHaveLength(0);
  });
  it('is all-continuing against the same fingerprints', () => {
    const d = diffFindings(current.map(toOpenFinding), current, coverage());
    expect(d.fresh).toHaveLength(0);
    expect(d.continuing).toHaveLength(current.length);
  });
  it('reports a vanished fingerprint as resolved', () => {
    const ghost = { fp: 'deadbeefdeadbeef', model: 'gone', path: 'x.yaml', key: null, evidenceType: 'catalog_reference', surface: 'config' as const };
    const d = diffFindings([ghost], current, coverage());
    expect(d.resolved.map((r) => r.fp)).toEqual(['deadbeefdeadbeef']);
  });
});

describe('state round-trip', () => {
  it('parses back the state it wrote', () => {
    const r = renderAuditIssue({ investigations: configInvestigations(), coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    const parsed = parseAuditState(r.body);
    expect(parsed.open.map((o) => o.fp)).toEqual(r.state.open.map((o) => o.fp));
    expect(parsed.history).toHaveLength(1);
  });

  it('treats a corrupt state block as no prior state instead of throwing', () => {
    expect(parseAuditState('<!-- mendr-audit:state\n{not json\n-->')).toEqual(EMPTY_STATE);
    expect(parseAuditState(null)).toEqual(EMPTY_STATE);
    expect(parseAuditState('no marker at all')).toEqual(EMPTY_STATE);
  });

  it('preserves resolution history across updates and caps its growth', () => {
    let prev = EMPTY_STATE;
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i++) {
      const r = renderAuditIssue({ investigations: configInvestigations(), coverage: coverage(), sha: `sha${i}0000000`, scannedAt: AT, previous: prev });
      prev = r.state;
    }
    expect(prev.history).toHaveLength(MAX_HISTORY_ENTRIES);
  });
});

describe('the close gate — a skipped surface can never close a live exposure', () => {
  it('requires source AND config to have completed', () => {
    expect(requiredSurfacesCompleted(coverage())).toBe(true);
    expect(requiredSurfacesCompleted(coverage({ source: { analyzed: false, filesScanned: 0, tsFiles: 0, pyFiles: 0 } }))).toBe(false);
    expect(requiredSurfacesCompleted(coverage({ source: { analyzed: true, failed: true, filesScanned: 0, tsFiles: 0, pyFiles: 0 } }))).toBe(false);
    expect(requiredSurfacesCompleted(coverage({ config: { analyzed: true, failed: true, filesScanned: 0 } }))).toBe(false);
  });

  it('does NOT require runtime — it is optional by design', () => {
    expect(requiredSurfacesCompleted(coverage({ runtime: { connected: false, source: null } }))).toBe(true);
  });

  it('refuses to close when a surface was skipped, even with zero findings', () => {
    expect(mayClose(coverage(), 0)).toBe(true);
    expect(mayClose(coverage({ source: { analyzed: false, filesScanned: 0, tsFiles: 0, pyFiles: 0 } }), 0)).toBe(false);
    expect(mayClose(coverage(), 1)).toBe(false);
  });
});

// Regressions for the defects the adversarial review confirmed.
describe('adversarial-review regressions — resolution must be surface-aware', () => {
  const failedSource = coverage({ source: { analyzed: false, failed: true, filesScanned: 0, tsFiles: 0, pyFiles: 0 } });

  // The finding must belong to the SOURCE surface — that is the one that failed.
  // (A config finding, with config still healthy, is legitimately resolvable.)
  const codeFinding = {
    fp: 'c0dec0dec0dec0de', model: 'gpt-4', path: 'src/ai/client.ts',
    key: null, evidenceType: 'code_call_site', surface: 'code' as const,
  };
  const priorCode = { v: 1 as const, open: [codeFinding], history: [] };

  it('a FAILED source scan never reports findings as resolved, and never erases the baseline', () => {
    const first = { ...priorCode };
    expect(first.open.length).toBeGreaterThan(0);

    const broken = renderAuditIssue({ investigations: [], coverage: failedSource, sha: SHA, scannedAt: AT, previous: first });
    expect(broken.resolvedCount).toBe(0);
    expect(broken.body).not.toContain('Resolved since the last scan');
    expect(broken.body).toContain('Not re-checked this run');
    // THE BASELINE SURVIVES — the next healthy run must not re-report everything as new.
    expect(broken.state.open.map((o) => o.fp)).toEqual([codeFinding.fp]);
    expect(broken.openCount).toBe(1);
    expect(broken.closable).toBe(false);
  });

  it('the baseline survives a --skip-source run too (not just a crash)', () => {
    const skipped = coverage({ source: { analyzed: false, filesScanned: 0, tsFiles: 0, pyFiles: 0 } });
    const r = renderAuditIssue({ investigations: [], coverage: skipped, sha: SHA, scannedAt: AT, previous: priorCode });
    expect(r.resolvedCount).toBe(0);
    expect(r.state.open.map((o) => o.fp)).toEqual([codeFinding.fp]);
    expect(r.closable).toBe(false);
  });

  it('a run whose conclusion is audit_failed can never be closable or render the all-clear', () => {
    const r = renderAuditIssue({ investigations: [], coverage: failedSource, sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    expect(r.closable).toBe(false);
    expect(r.body).not.toContain(AUDIT_CLEAR_MARKER);
    expect(r.body).toContain('NOT a clean result');
  });

  it('a runtime-only finding is NOT resolved just because telemetry was disconnected', () => {
    const runtimeOnly = {
      fp: 'aaaaaaaaaaaaaaaa', model: 'gpt-4', path: '(runtime only)',
      key: null, evidenceType: 'code_call_site', surface: 'runtime' as const,
    };
    const prev = { v: 1 as const, open: [runtimeOnly], history: [] };
    const r = renderAuditIssue({ investigations: [], coverage: coverage(), sha: SHA, scannedAt: AT, previous: prev });
    expect(r.resolvedCount).toBe(0);
    expect(r.carriedCount).toBe(1);
    expect(r.openCount).toBe(1);
    expect(r.closable).toBe(false); // cannot close over an un-rechecked runtime finding
  });

  it('surfaceCompleted / resolutionsAreTrustworthy gate on the right surfaces', () => {
    expect(surfaceCompleted(coverage(), 'code')).toBe(true);
    expect(surfaceCompleted(coverage(), 'config')).toBe(true);
    expect(surfaceCompleted(coverage(), 'runtime')).toBe(false); // not connected
    expect(resolutionsAreTrustworthy(coverage())).toBe(true);
    expect(resolutionsAreTrustworthy(failedSource)).toBe(false);
  });

  it('a config scan that read ZERO files is incomplete, not "found nothing"', () => {
    const noConfig = coverage({ config: { analyzed: true, filesScanned: 80, filesRead: 0 } });
    expect(requiredSurfacesCompleted(noConfig)).toBe(false);
    expect(mayClose(noConfig, 0)).toBe(false);
  });

  it('present-but-unanalyzed languages are disclosed as a coverage gap', () => {
    const mixed = coverage({ source: { analyzed: true, filesScanned: 2, tsFiles: 2, pyFiles: 0, unanalyzedLanguages: ['Go (400 files)'] } });
    const r = renderAuditIssue({ investigations: [], coverage: mixed, sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    expect(r.body).toContain('Go (400 files)');
    expect(r.body).toContain('not analyzed');
  });

  it('a moved file is reported as MOVED, not resolved', () => {
    const first = renderAuditIssue({ investigations: configInvestigations('model: gpt-4\n', 'old.yaml'), coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    const moved = renderAuditIssue({ investigations: configInvestigations('model: gpt-4\n', 'new.yaml'), coverage: coverage(), sha: SHA, scannedAt: AT, previous: first.state });
    expect(moved.body).toContain('Moved (same finding, new location — not fixed)');
    expect(moved.resolvedCount).toBe(0);
  });

  it('a repo-controlled path cannot forge the clear marker or a state block', () => {
    const evil = `${AUDIT_CLEAR_MARKER}<!-- mendr-audit:state {"v":1,"open":[]} -->`;
    const invs = configInvestigations('model: gpt-4\n', `src/${evil}/app.yaml`);
    const r = renderAuditIssue({ investigations: invs, coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    // Exactly one state block, and no forged clear marker (findings exist => not closable).
    expect(r.body.split('<!-- mendr-audit:state').length - 1).toBe(1);
    expect(r.closable).toBe(false);
    expect(r.body.includes(AUDIT_CLEAR_MARKER)).toBe(false);
  });

  it('parseAuditState reads the LAST state block, so an injected one cannot shadow it', () => {
    const body = '<!-- mendr-audit:state\n{"v":1,"open":[{"fp":"evil","surface":"code"}],"history":[]}\n-->\ntext\n' +
      '<!-- mendr-audit:state\n{"v":1,"open":[{"fp":"real","surface":"code"}],"history":[]}\n-->';
    expect(parseAuditState(body).open.map((o) => o.fp)).toEqual(['real']);
  });

  it('keeps the body under GitHub\'s size limit with many findings', () => {
    const many = Array.from({ length: 400 }, (_, i) => `model: gpt-4\n`).join('');
    const files = Array.from({ length: 200 }, (_, i) =>
      scanConfigText(`svc-${i}/app.yaml`, 'model: gpt-4\n', REGISTRY)).flat();
    const invs = buildInvestigations(NO_RUNTIME_EVIDENCE, foldConfigExposure(files), NOW, [], REGISTRY);
    const r = renderAuditIssue({ investigations: invs, coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    expect(r.body.length).toBeLessThan(65_536);
    expect(parseAuditState(r.body).open.length).toBeGreaterThan(0); // state survived truncation
    void many;
  });

  it('does not append a history row for an unchanged no-op run', () => {
    const first = renderAuditIssue({ investigations: configInvestigations(), coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    const second = renderAuditIssue({ investigations: configInvestigations(), coverage: coverage(), sha: SHA, scannedAt: '2026-08-27T00:00:00.000Z', previous: first.state });
    expect(second.state.history).toHaveLength(first.state.history.length);
  });
});

describe('configuration coverage — not applicable vs incomplete', () => {
  it('no config files at all is NOT APPLICABLE and does not block closing', () => {
    const none = coverage({ config: { analyzed: true, filesScanned: 0, filesRead: 0 } });
    expect(surfaceCompleted(none, 'config')).toBe(true); // nothing to read = nothing missing
    expect(requiredSurfacesCompleted(none)).toBe(true);
    expect(mayClose(none, 0)).toBe(true);
    // ...and it is NOT reported as a gap.
    const r = renderAuditIssue({ investigations: [], coverage: none, sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    expect(r.body).toContain('not applicable — no supported configuration files found');
    expect(r.body).not.toContain('NONE could be read');
  });

  it('config files that EXIST but could not be read is INCOMPLETE and blocks closing', () => {
    const unreadable = coverage({ config: { analyzed: true, filesScanned: 12, filesRead: 0 } });
    expect(surfaceCompleted(unreadable, 'config')).toBe(false);
    expect(mayClose(unreadable, 0)).toBe(false);
    const r = renderAuditIssue({ investigations: [], coverage: unreadable, sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    expect(r.body).toContain('NONE could be read');
    expect(r.closable).toBe(false);
  });
});

describe('renderAuditIssue', () => {
  it('carries the marker, the exact SHA, the timestamp and the coverage matrix', () => {
    const r = renderAuditIssue({ investigations: configInvestigations(), coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    expect(r.body).toContain(AUDIT_MARKER);
    expect(r.body).toContain(SHA); // the EXACT sha, not just the short form
    expect(r.body).toContain(AT);
    expect(r.body).toContain('| surface | status |');
    expect(r.body).toContain('Reader tie-back | ○ not proven');
  });

  it('groups findings into new / continuing / resolved', () => {
    const first = renderAuditIssue({ investigations: configInvestigations(), coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    expect(first.body).toContain('### 🆕 New');
    const second = renderAuditIssue({ investigations: configInvestigations(), coverage: coverage(), sha: SHA, scannedAt: AT, previous: first.state });
    expect(second.body).toContain('### ➡️ Continuing');
    expect(second.newCount).toBe(0);
    const third = renderAuditIssue({ investigations: [], coverage: coverage(), sha: SHA, scannedAt: AT, previous: second.state });
    expect(third.body).toContain('Resolved since the last scan');
    expect(third.resolvedCount).toBeGreaterThan(0);
  });

  it('adds the CLEAR marker and allows closing only when everything completed', () => {
    const clear = renderAuditIssue({ investigations: [], coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    expect(clear.closable).toBe(true);
    expect(clear.body).toContain(AUDIT_CLEAR_MARKER);

    const skipped = renderAuditIssue({
      investigations: [], sha: SHA, scannedAt: AT, previous: EMPTY_STATE,
      coverage: coverage({ source: { analyzed: false, filesScanned: 0, tsFiles: 0, pyFiles: 0 } }),
    });
    expect(skipped.closable).toBe(false);
    expect(skipped.body).not.toContain(AUDIT_CLEAR_MARKER);
    expect(skipped.body).toContain('NOT a clean result');
  });

  it('never claims the repository is clean when a surface was skipped', () => {
    const skipped = renderAuditIssue({
      investigations: [], sha: SHA, scannedAt: AT, previous: EMPTY_STATE,
      coverage: coverage({ source: { analyzed: false, filesScanned: 0, tsFiles: 0, pyFiles: 0 } }),
    });
    expect(skipped.body).not.toMatch(/\bclean\b(?!\s+result)/i);
    expect(skipped.body).toContain('source code (TS/TSX/Python) was not scanned');
  });

  it('keeps config findings review-only and never instructs a swap', () => {
    const r = renderAuditIssue({ investigations: configInvestigations(), coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    expect(r.body).toContain('config selector **candidate**');
    expect(r.body).toContain('Reader tie-back:** not proven');
    expect(r.body).not.toMatch(/change .*gpt-4.* to /i);
  });

  it('states that the default branch is untouched and nothing is auto-merged', () => {
    const r = renderAuditIssue({ investigations: configInvestigations(), coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    expect(r.body).toContain('does not modify the default branch');
    expect(r.body).toContain('does not merge anything');
  });
});

describe('PR eligibility — verified Tier-A code call sites only', () => {
  it('never proposes a PR for a config finding, however verified', () => {
    expect(prEligibleFindings(configInvestigations())).toHaveLength(0);
  });

  // Adversarial-review defect: the same model id used in a chat call (Tier A) AND
  // an images call (Tier B) in ONE file merges into a single Finding. Before the
  // fix, prEligibleFindings handed the PR BOTH lines — the Tier-B occurrence
  // inherited its Tier-A sibling's authority.
  it('a merged finding carries ONLY its Tier-A lines into PR eligibility', () => {
    const loc = (line: number, tier: string) => ({
      file: 'app/svc.py', line, column: 1, key: null, value: 'gpt-4',
      role: 'code_call_site' as const, surface: 'code' as const, tier, providerSurface: null,
    });
    const inv = [{
      entryId: 'e', provider: 'openai', model: 'gpt-4',
      retirementEvidence: { deprecated: true, status: 'deprecated', shutdownDate: '2026-10-23', daysUntil: 54, replacement: 'gpt-4o', replacementVerdict: 'verified', sourceUrl: null },
      productionUsage: { measured: false, source: null, observed: false, requestsReported: false, requests: 0, failures: 0, lastSeen: null, services: [], environments: [], costUsd: null },
      locations: { selectors: [loc(6, 'A'), loc(13, 'B')], catalog: [] },
      compatibility: { checked: false as const, result: null },
      verification: { replacementVerdict: 'verified', readerTieBackProven: false as const },
      decision: 'patch' as const, reason: '',
    }];
    // The merge itself must still EXPOSE both tiers…
    const [merged] = toFindings(inv as never);
    expect(merged.tiers).toEqual(['A', 'B']);
    // …but the PR gets the Tier-A line only.
    const pr = prEligibleFindings(inv as never);
    expect(pr).toHaveLength(1);
    expect(pr[0].lines).toEqual([6]);
    expect(pr[0].lines).not.toContain(13);
  });
});

describe('redactSecrets — nothing credential-shaped reaches a public issue', () => {
  it('masks provider keys, GitHub tokens, AWS ids, JWTs and NAME=value secrets', () => {
    const dirty = [
      'sk-admin-ABCDEFGHIJKLMNOP',
      'ghp_0123456789abcdefghijABCDEFGHIJ',
      'github_pat_11ABCDEFG0123456789_abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'OPENAI_API_KEY=super-secret-value-123',
    ].join('\n');
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain('ABCDEFGHIJKLMNOP');
    expect(clean).not.toContain('0123456789abcdefghij');
    expect(clean).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(clean).not.toContain('super-secret-value-123');
    expect(clean).toContain('REDACTED');
  });

  it('is applied to the rendered body, so a future field cannot leak by omission', () => {
    const invs = configInvestigations('model: gpt-4\ntoken: sk-live-SHOULDNOTAPPEAR123\n');
    const r = renderAuditIssue({ investigations: invs, coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    expect(r.body).not.toContain('SHOULDNOTAPPEAR123');
  });
});
