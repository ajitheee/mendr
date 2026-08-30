import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification, withheldVerification } from '../usage/llmRegistry.js';
import { foldConfigExposure, scanConfigText } from '../config/scanConfig.js';
import { NO_RUNTIME_EVIDENCE } from '../runtime/evidence.js';
import { buildInvestigations, type AuditCoverage } from './investigation.js';
import { diffFindings, fingerprint, identityOf, toFindings } from './fingerprint.js';
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
    const d = diffFindings([], current);
    expect(d.fresh).toHaveLength(current.length);
    expect(d.continuing).toHaveLength(0);
    expect(d.resolved).toHaveLength(0);
  });
  it('is all-continuing against the same fingerprints', () => {
    const d = diffFindings(current.map((f) => f.fingerprint), current);
    expect(d.fresh).toHaveLength(0);
    expect(d.continuing).toHaveLength(current.length);
  });
  it('reports a vanished fingerprint as resolved', () => {
    const d = diffFindings(['deadbeefdeadbeef'], current);
    expect(d.resolved).toEqual(['deadbeefdeadbeef']);
  });
});

describe('state round-trip', () => {
  it('parses back the state it wrote', () => {
    const r = renderAuditIssue({ investigations: configInvestigations(), coverage: coverage(), sha: SHA, scannedAt: AT, previous: EMPTY_STATE });
    const parsed = parseAuditState(r.body);
    expect(parsed.open).toEqual(r.state.open);
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
      const r = renderAuditIssue({ investigations: configInvestigations(), coverage: coverage(), sha: SHA, scannedAt: AT, previous: prev });
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
