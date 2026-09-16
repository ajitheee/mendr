import { describe, expect, it } from 'vitest';
import type { AuditCoverage, SourceCoverage } from '../audit/investigation.js';
import { concludeAudit, coverageGaps } from '../audit/investigation.js';
import { coverageDenominator } from './auditReport.js';

// SLICE 6 — THE COVERAGE DENOMINATOR.
//
// "No exposure" is only as good as the account of what was not looked at. Until now a reader
// could not add the numbers up, and two categories were not counted at all: a file that could not
// be opened, and a file that parsed WITH SYNTAX ERRORS.
//
// The second is the dangerous one. ts-morph is error-tolerant, so a malformed file does not fail
// the scan — it yields a damaged tree, and the damage changes the classification rather than
// announcing itself. Verified on a real two-file repository: with unbalanced braces a live
// `client.chat.completions.create({ model: 'gpt-3.5-turbo-0613' })` is reported as "code data
// reference" (informational, never migrated); balance the braces and the identical line becomes
// "verified provider SDK call site". v0.2.2-alpha called that repository
// "NO EXPOSURE IN COMPLETED SURFACES" and exited 0.

const source = (over: Partial<SourceCoverage> = {}): SourceCoverage => ({
  analyzed: true,
  failed: false,
  filesScanned: 10,
  filesRead: 10,
  tsFiles: 10,
  jsFiles: 0,
  pyFiles: 0,
  ...over,
});

const coverage = (src: Partial<SourceCoverage> = {}): AuditCoverage =>
  ({
    source: source(src),
    config: { analyzed: true, failed: false, filesScanned: 0, filesRead: 0 },
    registry: { providers: ['openai'], freshness: 'fresh' },
    runtime: { connected: false, source: null },
    readerTieBack: { proven: false },
  }) as unknown as AuditCoverage;

const numbers = (lines: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const l of lines) {
    const m = /^\s*(\d+)\s\s(.+)$/.exec(l);
    if (m) out[m[2]!.split(' —')[0]!.trim()] = Number(m[1]);
  }
  return out;
};

describe('the categories add up to the discovered total', () => {
  it('a clean repo: everything analyzed', () => {
    const n = numbers(coverageDenominator(source()));
    expect(n['discovered']).toBe(10);
    expect(n['analyzed (TS/TSX, JavaScript, Python)']).toBe(10);
  });

  // The per-language totals count files on disk by extension, so a broken file is already in
  // them. Counting it again under "parse failures" made the denominator larger than the repo.
  it('a parse failure is subtracted from analyzed, not counted twice', () => {
    const n = numbers(coverageDenominator(source({ tsFiles: 10, parseFailures: 2 })));
    expect(n['discovered']).toBe(10);
    expect(n['analyzed (TS/TSX, JavaScript, Python)']).toBe(8);
    expect(n['parse failures']).toBe(2);
  });

  it('an unopenable file is subtracted the same way', () => {
    const n = numbers(coverageDenominator(source({ tsFiles: 10, unreadableFiles: 3 })));
    expect(n['discovered']).toBe(10);
    expect(n['analyzed (TS/TSX, JavaScript, Python)']).toBe(7);
    expect(n['could not be opened']).toBe(3);
  });

  it('every category together still sums to discovered', () => {
    const n = numbers(
      coverageDenominator(
        source({ tsFiles: 20, parseFailures: 2, unreadableFiles: 1, unanalyzedFiles: 5, testFilesSkipped: 4 }),
      ),
    );
    const parts =
      n['analyzed (TS/TSX, JavaScript, Python)']! +
      n['test files']! +
      n['languages mendr does not read']! +
      n['parse failures']! +
      n['could not be opened']!;
    expect(parts).toBe(n['discovered']);
  });

  it('prints nothing at all when there are no files', () => {
    expect(coverageDenominator(source({ tsFiles: 0, pyFiles: 0, jsFiles: 0 }))).toEqual([]);
  });
});

describe('a file mendr could not read never produces a clean result', () => {
  it('a syntax error forces inconclusive, with no findings', () => {
    expect(concludeAudit(coverage({ parseFailures: 1 }), 0)).toBe('inconclusive');
  });

  it('an unopenable file forces inconclusive too', () => {
    expect(concludeAudit(coverage({ unreadableFiles: 1 }), 0)).toBe('inconclusive');
  });

  // One unreadable file is one place a live call site could be hiding. A threshold here would
  // only be a rule about when it is acceptable to guess.
  it('there is no threshold — one bad file in a thousand is still inconclusive', () => {
    expect(concludeAudit(coverage({ tsFiles: 1000, parseFailures: 1 }), 0)).toBe('inconclusive');
  });

  it('the same repo with nothing unreadable is allowed to be clean', () => {
    expect(concludeAudit(coverage({ tsFiles: 1000 }), 0)).toBe('no_exposure_in_completed_surfaces');
  });

  // A finding is still a finding: a parse failure narrows what silence proves, it does not
  // suppress what was actually found.
  it('an exposure is still reported as exposure, parse failure or not', () => {
    expect(concludeAudit(coverage({ parseFailures: 1 }), 1)).toBe('exposure_detected');
  });
});

describe('the limits say what a damaged parse actually does', () => {
  it('explains that a damaged parse reclassifies rather than fails', () => {
    const gaps = coverageGaps(coverage({ parseFailures: 2 })).join(' ');
    expect(gaps).toContain('SYNTAX ERRORS');
    expect(gaps).toContain('silently');
    expect(gaps).toContain('proven either way');
  });

  it('names unopenable files as their own gap', () => {
    expect(coverageGaps(coverage({ unreadableFiles: 4 })).join(' ')).toContain('could not be opened');
  });

  it('says nothing when there is nothing to say', () => {
    expect(coverageGaps(coverage()).join(' ')).not.toContain('SYNTAX');
  });
});
