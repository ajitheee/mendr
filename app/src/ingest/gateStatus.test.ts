import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_STATUSES, toGateStatus } from './gateStatus.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Pull the quoted words out of a `const NAME = [...] as const;` declaration. */
function wordsOf(source: string, name: string): string[] {
  const decl = new RegExp(`${name}\\s*:?[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!decl) throw new Error(`could not find a ${name} array literal`);
  return [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('the App speaks exactly the CLI verification vocabulary', () => {
  // The break this test exists for: the CLI's five words were introduced in
  // src/ only, and this package kept its own four-word list for a full release
  // cycle. Nothing failed — 1,480 tests stayed green — because no test read
  // both sides. This one does.
  it('mirrors the word list in src/gates/status.ts', () => {
    const cli = readFileSync(join(here, '..', '..', '..', 'src', 'gates', 'status.ts'), 'utf8');
    expect([...GATE_STATUSES].sort()).toEqual(wordsOf(cli, 'CHECK_STATUSES').sort());
  });
});

describe('toGateStatus', () => {
  it('passes every current word through unchanged', () => {
    for (const w of GATE_STATUSES) expect(toGateStatus(w)).toBe(w);
  });

  it('translates the four words a pre-merge CLI sends', () => {
    expect(toGateStatus('pass')).toBe('passed');
    expect(toGateStatus('fail')).toBe('failed');
    expect(toGateStatus('inconclusive')).toBe('inconclusive');
    expect(toGateStatus('not-configured')).toBe('not_run');
  });

  it('never invents a claim for a word it does not know', () => {
    // The whole point. An unknown word must not become `passed` (a claim that
    // a check ran and could have failed) and must not become `not_run` (a
    // claim about the customer's repository). Both were reachable before.
    for (const junk of ['bogus', '', 'PASSED', 'not configured', 'skip', 'ok']) {
      expect(toGateStatus(junk)).toBe('inconclusive');
    }
  });

  it('never invents a claim for a value that is not a string', () => {
    for (const junk of [undefined, null, 42, {}, [], true]) {
      expect(toGateStatus(junk)).toBe('inconclusive');
    }
  });

  it('cannot report a failure as an absence', () => {
    // The live defect, stated as an assertion: a gate that RAN AND FAILED
    // was being stored and rendered as "there was nothing to run".
    expect(toGateStatus('failed')).not.toBe('not_run');
    expect(toGateStatus('fail')).not.toBe('not_run');
  });
});
