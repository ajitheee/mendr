import { describe, it, expect } from 'vitest';
import {
  countUniqueOccurrences,
  formatRunFooterLines,
  formatUniqueOccurrenceLine,
  runMode,
} from './runFooter.js';
import type { TierOccurrence } from './tiers.js';

// THE THREE RUN LINES. Two of them answer questions the report used to leave to
// inference — "was this run allowed to touch my files" and "how many did it
// touch" — and the third is a number that only helps if it RECONCILES with the
// tier counts printed above it. These tests pin the reconciliation, because an
// unreconcilable count reads as a fourth, secret tally.

function occ(tier: 'A' | 'B' | 'C', line: number, modelId = 'gpt-4'): TierOccurrence {
  return { tier, file: 'src/a.ts', line, column: 1, modelId };
}

describe('runMode', () => {
  // INTENT, NOT OUTCOME. `--write` that wrote nothing is still a WRITE run:
  // that is what the user asked for, the refusal message says why, and
  // `files modified: 0` carries the result. Collapsing it to LOOK would hide
  // the attempt entirely.
  it('is WRITE whenever --write was passed, and LOOK otherwise', () => {
    expect(runMode(true)).toBe('WRITE');
    expect(runMode(false)).toBe('LOOK');
    expect(runMode(undefined)).toBe('LOOK');
  });
});

describe('countUniqueOccurrences', () => {
  it('counts distinct (file, line, column, modelId) keys across every tier', () => {
    const counts = { tierA: 1, tierB: 1, tierC: 2 };
    const u = countUniqueOccurrences(
      [occ('A', 1), occ('B', 2), occ('C', 3), occ('C', 4, 'gemini-1.5-pro')],
      0,
      counts,
    );
    expect(u.modelId).toBe(4);
    expect(u.total).toBe(4);
    expect(u.reconciles).toBe(true);
  });

  // THE IDENTITY, stated as a test rather than as a comment: the number this
  // line prints must equal the three numbers the report already printed.
  it('equals tierA + tierB + tierC', () => {
    const occurrences = [occ('A', 1), occ('A', 2), occ('B', 3), occ('C', 4), occ('C', 5)];
    const counts = { tierA: 2, tierB: 1, tierC: 2 };
    const u = countUniqueOccurrences(occurrences, 0, counts);
    expect(u.total).toBe(counts.tierA + counts.tierB + counts.tierC);
    expect(u.reconciles).toBe(true);
  });

  // PARAM TRANSFORMS ARE COUNTED IN TIER A AND ABSENT FROM THE OCCURRENCE LIST
  // (their key would be a param name inside the model-id key space). Added back
  // by name, the total still reconciles -- and the line says what it is made of
  // rather than printing a number the reader cannot decompose.
  it('adds param-transform sites back, and names them', () => {
    const u = countUniqueOccurrences([occ('A', 1), occ('B', 2)], 2, {
      tierA: 3,
      tierB: 1,
      tierC: 0,
    });
    expect(u.modelId).toBe(2);
    expect(u.paramSites).toBe(2);
    expect(u.total).toBe(4);
    expect(u.reconciles).toBe(true);
    expect(formatUniqueOccurrenceLine(u)).toBe(
      'unique occurrences: 4 (2 model-id + 2 param transform)',
    );
  });

  it('never double-counts one position reported twice', () => {
    const u = countUniqueOccurrences([occ('B', 7), occ('B', 7)], 0, {
      tierA: 0,
      tierB: 1,
      tierC: 0,
    });
    expect(u.modelId).toBe(1);
  });
});

describe('formatUniqueOccurrenceLine', () => {
  it('prints the bare number when there is nothing to decompose', () => {
    const u = countUniqueOccurrences([occ('B', 1), occ('C', 2), occ('C', 3), occ('C', 4)], 0, {
      tierA: 0,
      tierB: 1,
      tierC: 3,
    });
    expect(formatUniqueOccurrenceLine(u)).toBe('unique occurrences: 4');
  });

  // THE CASE THE SPEC REFUSED TO LET US PAPER OVER: if the count and the tiers
  // ever disagree, the line says so, names the tier sum, and says which number
  // to trust. It does NOT quietly print a number nothing supports.
  it('states the discrepancy instead of printing an unreconcilable number', () => {
    const u = countUniqueOccurrences([occ('B', 1)], 0, { tierA: 2, tierB: 1, tierC: 0 });
    expect(u.reconciles).toBe(false);
    const line = formatUniqueOccurrenceLine(u);
    expect(line).toContain('does NOT reconcile with the tier counts');
    expect(line).toContain('tier A + B + C = 3');
    expect(line).toContain('the tier counts are authoritative');
  });
});

describe('formatRunFooterLines', () => {
  it('prints mode, occurrences and files modified, in that order', () => {
    const occurrences = countUniqueOccurrences([occ('A', 1)], 0, {
      tierA: 1,
      tierB: 0,
      tierC: 0,
    });
    expect(formatRunFooterLines({ mode: 'WRITE', occurrences, filesModified: 1 })).toEqual([
      'mode: WRITE',
      'unique occurrences: 1',
      'files modified: 1',
    ]);
  });

  // The two lines are deliberately independent: a WRITE run that wrote nothing
  // is exactly the shape a refused write leaves behind.
  it('lets WRITE stand over zero files modified', () => {
    const occurrences = countUniqueOccurrences([occ('A', 1)], 0, {
      tierA: 1,
      tierB: 0,
      tierC: 0,
    });
    expect(formatRunFooterLines({ mode: 'WRITE', occurrences, filesModified: 0 })).toContain(
      'files modified: 0',
    );
  });
});
