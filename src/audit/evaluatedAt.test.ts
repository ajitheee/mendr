import { describe, expect, it } from 'vitest';
import { EVALUATED_AT_ENV, EvaluatedAtError, resolveEvaluationTime } from './evaluatedAt.js';

// THE EVALUATION INSTANT — read once, pinnable, and NEVER guessed.
//
// Runs 7 and 8 on 2026-09-29 crossed the bundled registry's 2.0-day mark, so six of twelve
// repositories reported `ageDays: 1.9` and six reported `2`. The same clock also drives deadline
// severity and the freshness grade — a conclusion — so a batch straddling a boundary can hand two
// repositories different verdicts for no reason but when their turn came. Hence one clock read per
// run, with a pin for batches.
//
// The first version FELL BACK to the system clock on an unreadable pin. These tests exist to make
// sure that never returns: someone who deliberately pinned an instant would otherwise get a
// confident, valid-looking report computed at a different time than they asked for, with every
// deadline shifted and nothing saying so. A pin that can be silently ignored is not a pin.

const FIXED = () => new Date('2020-01-01T00:00:00Z');
const withVar = (v: string | undefined) => (v === undefined ? {} : { [EVALUATED_AT_ENV]: v });

describe('when the variable is absent', () => {
  it('reads the system clock once and says so', () => {
    const t = resolveEvaluationTime({}, FIXED);
    expect(t.source).toBe('system');
    expect(t.at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('when the variable is valid', () => {
  it('honours a full RFC 3339 instant with Z, and records it as an override', () => {
    const t = resolveEvaluationTime(withVar('2026-10-23T14:30:00Z'), FIXED);
    expect(t.source).toBe('override');
    expect(t.at.toISOString()).toBe('2026-10-23T14:30:00.000Z');
  });

  it('honours an explicit numeric offset and normalises it to UTC', () => {
    // 14:30 at +05:30 is 09:00 UTC. The report must carry the UTC instant, not the local text.
    const t = resolveEvaluationTime(withVar('2026-10-23T14:30:00+05:30'), FIXED);
    expect(t.at.toISOString()).toBe('2026-10-23T09:00:00.000Z');
  });

  it('DEFINES a date-only value as UTC midnight', () => {
    // This is a definition, stated in the docs, not an accident of the JS Date parser.
    const t = resolveEvaluationTime(withVar('2026-10-23'), FIXED);
    expect(t.source).toBe('override');
    expect(t.at.toISOString()).toBe('2026-10-23T00:00:00.000Z');
  });

  it('tolerates the surrounding whitespace a shell pipeline adds', () => {
    expect(resolveEvaluationTime(withVar('  2026-10-23T00:00:00Z \n'), FIXED).at.toISOString()).toBe(
      '2026-10-23T00:00:00.000Z',
    );
  });

  it('accepts fractional seconds and a lowercase z', () => {
    expect(resolveEvaluationTime(withVar('2026-10-23T00:00:00.250z'), FIXED).at.toISOString()).toBe(
      '2026-10-23T00:00:00.250Z',
    );
  });
});

describe('when the variable is present but unusable, the run STOPS — it never falls back', () => {
  const rejects = (v: string, why: string, mentions?: RegExp) => {
    let caught: unknown;
    try {
      resolveEvaluationTime(withVar(v), FIXED);
    } catch (e) {
      caught = e;
    }
    expect(caught, why).toBeInstanceOf(EvaluatedAtError);
    const msg = (caught as Error).message;
    // Plain-language rule: the message names the variable and says what to do, never a parser dump.
    expect(msg, why).toContain(EVALUATED_AT_ENV);
    if (mentions) expect(msg, why).toMatch(mentions);
  };

  it('rejects plain nonsense', () => {
    rejects('yesterday', 'a word is not an instant', /date .*or a timestamp with a timezone/);
    rejects('not-a-date', 'hyphenated nonsense');
  });

  it('rejects an EMPTY value rather than treating it as absent', () => {
    // Something set it, and that something meant to pass an instant. Guessing which is the error
    // this function refuses to make.
    rejects('', 'empty', /set but empty/);
    rejects('   ', 'whitespace only', /set but empty/);
  });

  it('rejects a datetime with NO timezone, and says exactly what to add', () => {
    // `2026-10-23T00:00:00` is LOCAL midnight to JavaScript — a different instant on every machine,
    // which is the irreproducibility a pin exists to remove. Reject it and name the fix.
    rejects('2026-10-23T00:00:00', 'naked datetime', /no timezone.*add Z/);
    rejects('2026-10-23 14:30', 'naked datetime with a space', /no timezone/);
  });

  it('rejects a well-shaped but impossible date', () => {
    rejects('2026-13-45', 'month 13', /not a real date/);
    rejects('2026-02-30T00:00:00Z', 'February 30th', /not a real date/);
  });

  it('never returns a system-clock result when the variable is set to anything', () => {
    // The property under test, stated directly: no input with the variable SET may ever yield
    // `source: 'system'`. Either it is an override or it is an error.
    for (const v of ['2026-10-23', '2026-10-23T00:00:00Z', 'garbage', '', '2026-10-23T00:00:00']) {
      let result: ReturnType<typeof resolveEvaluationTime> | null = null;
      try {
        result = resolveEvaluationTime(withVar(v), FIXED);
      } catch (e) {
        expect(e, v).toBeInstanceOf(EvaluatedAtError);
        continue;
      }
      expect(result.source, v).toBe('override');
    }
  });
});
