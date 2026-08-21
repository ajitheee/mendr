import { describe, it, expect } from 'vitest';
import {
  formatCatalogLine,
  formatDataFileGroupLine,
  formatDataHitLine,
  formatGateSummary,
  groupDataFindingsByFile,
  isCatalogLike,
  purposePhrase,
  replacementFamily,
  swapLabel,
  behavioralVerificationLines,
  behavioralVerificationNote,
  BEHAVIORAL_VERIFICATION_NOTE,
  type DataFindingView,
} from './llmReport.js';

// The report-shaping layer: a 100+ finding scan must collapse to one line per
// file (the acceptance bar is a ~30-line report on real repos), while --verbose
// keeps every hit reachable with purpose-aware language.

function hit(
  file: string,
  value: string,
  purpose?: DataFindingView['purpose'],
  line = 1,
): DataFindingView {
  return { file, value, replacement: 'x-replacement', line, column: 1, purpose };
}

describe('groupDataFindingsByFile', () => {
  it('collapses per-file with the LINES of every id, in first-sighting order', () => {
    const groups = groupDataFindingsByFile([
      hit('lib/limits.ts', 'gpt-4', undefined, 12),
      hit('lib/limits.ts', 'gpt-4', undefined, 30),
      hit('lib/limits.ts', 'gemini-pro', undefined, 31),
      hit('app/other.ts', 'o1-mini', undefined, 4),
    ]);

    expect(groups.map((g) => g.file)).toEqual(['lib/limits.ts', 'app/other.ts']);
    expect(groups[0].hits).toBe(3);
    // The POSITION of every hit survives the collapse -- that is the whole
    // point of the group: a reader must be able to tell this file's `gpt-4`
    // from a `gpt-4` reported in another tier.
    expect([...groups[0].idLines.entries()]).toEqual([
      ['gpt-4', [12, 30]],
      ['gemini-pro', [31]],
    ]);
    expect(groups[1].hits).toBe(1);
  });

  it('counts comparison-purpose hits separately (they may gate logic)', () => {
    const groups = groupDataFindingsByFile([
      hit('app/gate.ts', 'gpt-4', 'comparison'),
      hit('app/gate.ts', 'gpt-4', 'list_entry'),
    ]);
    expect(groups[0].comparisons).toBe(1);
  });
});

describe('catalog heuristic', () => {
  it('fires on >10 distinct deprecated ids regardless of filename', () => {
    expect(isCatalogLike('src/anything.ts', 11)).toBe(true);
    expect(isCatalogLike('src/anything.ts', 10)).toBe(false);
  });

  it('fires on catalog-suggesting basenames regardless of id count', () => {
    for (const f of [
      'lib/prices.ts',
      'app/models.py',
      'app/constant.ts',
      'lib/chat-setting-limits.ts',
      'src/openai-llm-list.ts',
      'app/masks.ts',
    ]) {
      expect(isCatalogLike(f, 1), f).toBe(true);
    }
    expect(isCatalogLike('src/routes/chat.ts', 1)).toBe(false);
  });

  it('matches the basename only, never the directory path', () => {
    // A file INSIDE a models/ directory is not itself catalog-named.
    expect(isCatalogLike('models/handler.ts', 1)).toBe(false);
  });
});

describe('formatDataFileGroupLine', () => {
  it('renders the one-line-per-file summary with per-id line numbers and a cap', () => {
    const groups = groupDataFindingsByFile([
      hit('lib/limits.ts', 'gpt-4', undefined, 12),
      hit('lib/limits.ts', 'gpt-4', undefined, 40),
      hit('lib/limits.ts', 'gemini-pro', undefined, 41),
      hit('lib/limits.ts', 'o1-mini', undefined, 42),
      hit('lib/limits.ts', 'gpt-4-32k', undefined, 43),
      hit('lib/limits.ts', 'text-davinci-003', undefined, 44),
    ]);
    const line = formatDataFileGroupLine(groups[0]);

    expect(line).toContain('lib/limits.ts -- 6 hits:');
    // Each id says WHERE, so a collapsed hit is still a locatable one.
    expect(line).toContain('gpt-4 (L12, L40)');
    expect(line).toContain('gemini-pro (L41)');
    // Only the first 4 ids are spelled out; the rest collapse to a count that
    // still tells the reader how many were left unnamed.
    expect(line).toContain('+1 more ids');
    expect(line).not.toContain('text-davinci-003');
    // "limits" basename -> catalog label.
    expect(line).toContain('[looks like a model catalog]');
  });

  // THE CASE THAT MISLED TWO REVIEWERS, in miniature: one id, two positions.
  // Without the line numbers the collapsed line said `gpt-4 x2` and left the
  // reader unable to tell two occurrences from one counted twice.
  it('names both positions when one id appears twice in a file', () => {
    const groups = groupDataFindingsByFile([
      hit('agent_app/simulator.py', 'gpt-4', undefined, 12),
      hit('agent_app/simulator.py', 'gemini-1.5-pro', undefined, 30),
      hit('agent_app/simulator.py', 'gemini-1.5-pro', undefined, 127),
    ]);
    expect(formatDataFileGroupLine(groups[0])).toBe(
      'agent_app/simulator.py -- 3 hits: gpt-4 (L12), gemini-1.5-pro (L30, L127)',
    );
  });

  it('caps the LINES listed per id, so a catalog file stays one line', () => {
    const groups = groupDataFindingsByFile(
      [3, 5, 7, 9, 11, 13].map((line) => hit('src/routes/chat.ts', 'gpt-4', undefined, line)),
    );
    const line = formatDataFileGroupLine(groups[0]);
    expect(line).toBe('src/routes/chat.ts -- 6 hits: gpt-4 (L3, L5, L7, L9, +2 more)');
  });

  // Two hits on ONE line collapse to a single `L`, and the `xN` is what keeps
  // the id's share of the line agreeing with the file's hit total.
  it('keeps the occurrence count visible when repeats share a line', () => {
    const groups = groupDataFindingsByFile([
      hit('src/aliases.ts', 'gpt-4', undefined, 4),
      hit('src/aliases.ts', 'gpt-4', undefined, 4),
    ]);
    expect(formatDataFileGroupLine(groups[0])).toBe('src/aliases.ts -- 2 hits: gpt-4 x2 (L4)');
  });

  it('flags runtime comparisons on the collapsed line', () => {
    const groups = groupDataFindingsByFile([hit('app/gate.ts', 'gpt-4', 'comparison')]);
    expect(formatDataFileGroupLine(groups[0])).toContain('1 runtime comparison (may gate logic, review)');
  });
});

describe('purpose-aware hit language (--verbose)', () => {
  it('maps each purpose to its phrase', () => {
    expect(purposePhrase('comparison')).toBe('in a runtime comparison (== / ===)');
    expect(purposePhrase('lookup_key')).toBe('used as a lookup key');
    expect(purposePhrase('list_entry')).toBe('used as a list entry');
    expect(purposePhrase('catalog_entry')).toBe('used as a config/catalog entry');
    expect(purposePhrase('generic')).toBe('used as data');
    expect(purposePhrase(undefined)).toBe('used as data');
  });

  it('a guard-supplied reason replaces the generic review advice', () => {
    const line = formatDataHitLine({
      file: 'src/chat.ts',
      value: 'gpt-4',
      replacement: 'gpt-5.6-sol',
      line: 3,
      column: 9,
      purpose: 'generic',
      reason: 'type-cast masks the model-id union -- review manually',
    });
    expect(line).toContain('src/chat.ts:3:9');
    expect(line).toContain('type-cast masks the model-id union');
    expect(line).not.toContain('would map to');
  });
});

describe('swapLabel (lifecycle attaches to the SOURCE id)', () => {
  it('attaches a shutdown date to the deprecated id, not the replacement', () => {
    expect(
      swapLabel({
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'gpt-4',
        replacement: 'gpt-5.6-sol',
        status: 'deprecated',
        shutdownDate: '2026-10-23',
      }),
    ).toBe('"gpt-4" (shuts down 2026-10-23) -> "gpt-5.6-sol"');
  });

  it('marks a retired source id', () => {
    expect(
      swapLabel({
        provider: 'google',
        kind: 'model_id',
        deprecated: 'gemini-2.0-flash',
        replacement: 'gemini-flash-latest',
        status: 'retired',
      }),
    ).toBe('"gemini-2.0-flash" (retired) -> "gemini-flash-latest"');
  });

  it('uses a plain arrow when the lifecycle is unknown', () => {
    expect(
      swapLabel({
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'o1-mini',
        replacement: 'o4-mini',
      }),
    ).toBe('"o1-mini" -> "o4-mini"');
  });
});

describe('formatCatalogLine (annotated model-catalog files)', () => {
  it('renders the known-migration-catalog line', () => {
    expect(formatCatalogLine({ file: 'src/registry/oracles.ts', ids: ['gpt-4', 'o1-mini'] })).toBe(
      'src/registry/oracles.ts -- known migration catalog: 2 deprecated ids ' +
        '(expected registry content, no action)',
    );
  });
});

describe('formatGateSummary (code vs behavioral verification)', () => {
  // The whole point of the two-group summary: a reader must not be able to
  // mistake "type-check + tests passed" for "the new model behaves the same".
  const TS_FACTS = {
    usageClassification: 'call-site',
    typeCheck: 'pass (no new errors; 3 pre-existing ignored)',
    tests: 'pass (npm test, 42 passed, 0 failed)',
  };

  it('names both groups, and marks the behavioral one NOT checked', () => {
    const lines = formatGateSummary(TS_FACTS);
    expect(lines[0]).toBe('Code verification (what mendr checked):');
    expect(lines).toContain('Behavioral verification (NOT checked):');
    const text = lines.join('\n');
    expect(text).toMatch(/output quality, latency, cost and response/);
    // Code claims come FIRST, the disclaimer last — a disclaimer above the
    // evidence reads as boilerplate and gets skipped.
    expect(text.indexOf('type-check')).toBeLessThan(text.indexOf('Behavioral verification'));
  });

  it('keeps the measurable test counts verbatim', () => {
    expect(formatGateSummary(TS_FACTS).join('\n')).toMatch(
      /^ {2}tests: +pass \(npm test, 42 passed, 0 failed\)$/m,
    );
  });

  it('lists only the gates that exist for the language', () => {
    expect(formatGateSummary(TS_FACTS).join('\n')).toContain('type-check:');

    // Python has no compiler: a syntax re-parse plus an explicit "not
    // configured" static-type row, never a silently-passed type gate.
    const py = formatGateSummary({
      usageClassification: 'verified-sink',
      syntax: 'pass',
      staticTypeGate: 'not configured or not detected',
      tests: 'not run (no supported test command detected)',
    }).join('\n');
    expect(py).not.toContain('type-check:');
    expect(py).toMatch(/^ {2}syntax: +pass$/m);
    expect(py).toMatch(/^ {2}static type gate: +not configured or not detected$/m);
    expect(py).toMatch(/^ {2}usage classification: +verified-sink$/m);
  });

  // This row sits under the heading "Code verification (what mendr checked)",
  // so it may only name a check this PROCESS made. It used to read "verified
  // against live catalogs" — a network check `fix-llm` never performs. What it
  // reads is the `verification.status` stamp in the registry JSON, which is as
  // old as its `checkedAt` and can disagree with a fresh `mendr verify-registry`
  // run. Naming the stamp is the whole claim this row is entitled to.
  it('names the registry stamp it read, not a live catalog check it never made', () => {
    const rendered = formatGateSummary(TS_FACTS).join('\n');
    expect(rendered).toMatch(
      /^ {2}replacement mapping: +registry entry stamped verified \(not re-checked live this run\)$/m,
    );
    expect(rendered).not.toContain('verified against live catalogs');
  });

  it('aligns every gate value in one column, so the rows read as one table', () => {
    const lines = formatGateSummary(TS_FACTS);
    const gateRows = lines.slice(1, lines.indexOf('Behavioral verification (NOT checked):'));
    expect(gateRows).toHaveLength(4);
    // Every row's value starts at the same column (labels padded to one width).
    const valueColumns = new Set(gateRows.map((row) => /^ {2}[\w -]+: +/.exec(row)![0].length));
    expect(valueColumns.size).toBe(1);
  });
});

describe('behavioralVerificationLines (the configurable-eval boundary)', () => {
  it('not-tested keeps the disclaimer AND says how to switch it on', () => {
    const text = behavioralVerificationLines({ status: 'not-tested' }).join('\n');
    expect(text).toContain('Behavioral verification (NOT checked):');
    expect(text).toMatch(/output quality, latency, cost and response/);
    // The actionable half: the limit is a CHOICE the user can reverse.
    expect(text).toContain('"evalCommand" in mendr.config.json');
    expect(text).toContain('--eval-command');
    expect(text).toContain('run your own evaluation against the patched code');
  });

  it('not-tested WITH a reason names the case instead of advising a setup already done', () => {
    // The configured-but-inconclusive case. Still "NOT checked" -- nothing was
    // verified -- but "set evalCommand" would be wrong advice: they did, and
    // that is precisely why the fix was blocked.
    const text = behavioralVerificationLines({
      status: 'not-tested',
      reason: 'eval command timed out after 1500ms',
    }).join('\n');
    expect(text).toContain('Behavioral verification (NOT checked):');
    expect(text).toContain(
      'your eval command was configured but did not complete: eval command timed out after 1500ms',
    );
    expect(text).toContain('will not apply a fix it could not behaviorally verify');
    expect(text).not.toContain('to check it: set "evalCommand"');
  });

  it('pass reports the command and exit code, and caps the claim there', () => {
    const text = behavioralVerificationLines({
      status: 'pass',
      command: 'npm run eval',
      exitCode: 0,
    }).join('\n');
    expect(text).toContain('behavioral verification: pass (your eval command: npm run eval, exit 0)');
    // It must not inflate one passing command into model equivalence.
    expect(text).toContain('YOUR eval passed against the patched code');
    expect(text).toMatch(/quality, latency, cost -- is untested/);
    expect(text).not.toMatch(/equivalent|safe to ship/i);
  });

  it('fail says the fix is blocked, in the same terms as a failed test gate', () => {
    const text = behavioralVerificationLines({
      status: 'fail',
      command: 'npm run eval',
      exitCode: 1,
    }).join('\n');
    expect(text).toContain('behavioral verification: fail (your eval command: npm run eval, exit 1)');
    expect(text).toContain('NOT');
    expect(text).toMatch(/blocks it exactly like a failing test gate/);
  });

  it('formatGateSummary defaults to the disclaimer when no result is passed', () => {
    // A caller that forgets the argument must get "not checked", never a pass.
    expect(formatGateSummary({ usageClassification: 'call-site', tests: 'pass' })).toContain(
      'Behavioral verification (NOT checked):',
    );
  });

  it('formatGateSummary swaps in the eval group when one ran', () => {
    const text = formatGateSummary(
      { usageClassification: 'call-site', typeCheck: 'pass', tests: 'pass (npm test)' },
      { status: 'pass', command: 'npm run eval', exitCode: 0 },
    ).join('\n');
    expect(text).toContain('Behavioral verification (your own evaluation):');
    expect(text).not.toContain('Behavioral verification (NOT checked):');
    // The code rows survive unchanged — the eval ADDS a claim, it replaces none.
    expect(text).toMatch(/^ {2}type-check: +pass$/m);
  });
});

describe('behavioralVerificationNote (the closing line)', () => {
  it('keeps the untested wording for everything except a passing eval', () => {
    expect(behavioralVerificationNote({ status: 'not-tested' })).toBe(BEHAVIORAL_VERIFICATION_NOTE);
    expect(behavioralVerificationNote({ status: 'fail', command: 'x', exitCode: 1 })).toBe(
      BEHAVIORAL_VERIFICATION_NOTE,
    );
  });

  it('names the passing eval but still refuses to generalize from it', () => {
    const note = behavioralVerificationNote({
      status: 'pass',
      command: 'npm run eval',
      exitCode: 0,
    });
    expect(note).toContain('ran YOUR eval command (npm run eval), which passed');
    expect(note).toContain('the only behavioral claim it makes');
    expect(note).toMatch(/is still untested/);
  });
});

describe('replacementFamily (mixed-target warning)', () => {
  it('cuts at the first digit run', () => {
    expect(replacementFamily('gpt-4.1')).toBe('gpt-4');
    expect(replacementFamily('gpt-5.6-sol')).toBe('gpt-5');
    expect(replacementFamily('claude-opus-4-8')).toBe('claude-opus-4');
  });

  it('an id with no digits is its own family', () => {
    expect(replacementFamily('gemini-flash-latest')).toBe('gemini-flash-latest');
  });
});
