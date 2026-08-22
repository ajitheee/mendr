import { describe, it, expect } from 'vitest';
import type { LlmModelIdDeprecation } from '../types.js';
import {
  formatCatalogLine,
  formatDataFileGroupLine,
  formatDataHitLine,
  formatGateRow,
  formatGateSummary,
  formatRegistryEntryLines,
  groupDataFindingsByFile,
  isCatalogLike,
  purposePhrase,
  replacementFamily,
  swapLabel,
  behavioralGateRow,
  behavioralVerificationLines,
  behavioralVerificationNote,
  registryVerdictRows,
  BEHAVIORAL_VERIFICATION_NOTE,
  type DataFindingView,
  type GateRow,
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

describe('formatGateSummary (one row per check, one outcome per row)', () => {
  // THE FAILURE THIS GUARDS: a single word covering several different checks.
  // A run where the type-check passed, the tests never ran and no eval existed
  // is not "verified" -- and a reader given one word cannot recover which of
  // the three actually happened.
  const TS_ROWS: GateRow[] = [
    {
      label: 'replacement verdict',
      state: 'verified',
      detail: 'stamped 2026-08-14',
    },
    { label: 'official source', state: 'confirmed' },
    {
      label: 'usage verdict',
      state: 'confirmed',
      detail: 'live model argument at the call site',
    },
    { label: 'syntax', state: 'n/a', detail: 'typescript -- the type-check gate subsumes parsing' },
    {
      label: 'type-check',
      state: 'passed',
      detail: 'no new errors; 3 pre-existing ignored',
      required: true,
    },
    {
      label: 'tests',
      state: 'inconclusive',
      detail: 'repo has no installed node_modules to link -- cannot run tests',
    },
  ];

  it('names both groups, and marks the behavioral one NOT checked', () => {
    const lines = formatGateSummary(TS_ROWS);
    expect(lines[0]).toBe('Code verification (what mendr checked):');
    expect(lines).toContain('Behavioral verification (NOT checked):');
    const text = lines.join('\n');
    expect(text).toMatch(/output quality, latency, cost and response/);
    // Code claims come FIRST, the disclaimer last -- a disclaimer above the
    // evidence reads as boilerplate and gets skipped.
    expect(text.indexOf('type-check')).toBeLessThan(text.indexOf('Behavioral verification'));
  });

  it('gives every check its OWN outcome word, and never lends one to another', () => {
    const text = formatGateSummary(TS_ROWS).join('\n');
    expect(text).toMatch(
      /^ {2}replacement verdict: +verified \(stamped 2026-08-14\)$/m,
    );
    expect(text).toMatch(/^ {2}official source: +confirmed$/m);
    expect(text).toMatch(/^ {2}syntax: +n\/a \(typescript/m);
    expect(text).toMatch(/^ {2}type-check: +passed \(no new errors; 3 pre-existing ignored\)/m);
    // The one that matters most: the tests gate could not RUN, and nothing on
    // that line reads as a pass.
    expect(text).toMatch(/^ {2}tests: +inconclusive \(repo has no installed node_modules/m);
    expect(text).not.toMatch(/^ {2}tests: +passed/m);
    // And nothing collapses the six checks into a verdict of its own.
    expect(text).not.toMatch(/^ {2}(gates|verification): /m);
  });

  it('tags the gates the policy required, so an inconclusive row explains itself', () => {
    const text = formatGateSummary(TS_ROWS).join('\n');
    expect(text).toMatch(/^ {2}type-check: +passed \([^)]*\) {2}\[required\]$/m);
    // Untagged rows are not "optional" -- they are simply not required to pass.
    expect(text).not.toMatch(/^ {2}official source: .*\[required\]$/m);
  });

  it('itemizes the behavioral gate too, in the same table', () => {
    const lines = formatGateSummary(TS_ROWS);
    expect(lines).toContain('  behavioral evaluation:  not configured');
    // Every value -- code rows and the behavioral row alike -- starts at one
    // column, so the checks read as one list rather than two vocabularies.
    const LABELS =
      /^ {2}(replacement verdict|official source|usage verdict|syntax|type-check|tests|behavioral evaluation): +/;
    const valueRows = lines.filter((l) => LABELS.test(l));
    expect(valueRows).toHaveLength(7);
    expect(new Set(valueRows.map((row) => LABELS.exec(row)![0].length)).size).toBe(1);
  });

  it('renders the python row set with its own n/a and passed outcomes', () => {
    const py = formatGateSummary([
      { label: 'usage verdict', state: 'confirmed', detail: 'python sink rule' },
      { label: 'syntax', state: 'passed', detail: 'baseline-relative re-parse' },
      { label: 'type-check', state: 'n/a', detail: 'mendr runs no type checker for python' },
      { label: 'tests', state: 'inconclusive', detail: 'mendr has no python test runner' },
    ]).join('\n');
    expect(py).toMatch(/^ {2}syntax: +passed \(baseline-relative re-parse\)$/m);
    // A gate that does not EXIST here is n/a -- never a silent pass, and never
    // the same word as a gate that exists and could not run.
    expect(py).toMatch(/^ {2}type-check: +n\/a \(mendr runs no type checker for python\)$/m);
    expect(py).toMatch(/^ {2}tests: +inconclusive \(mendr has no python test runner\)$/m);
  });
});

describe('registryVerdictRows (two claims, two rows)', () => {
  // The first row's LABEL is `replacement verdict`, the same words report/tiers
  // uses for the same dimension. It was `registry verdict`, which read as a
  // verdict on the whole record; the Tier B split renamed it there, and one
  // report may not carry two names for one dimension.
  function entry(over: Partial<LlmModelIdDeprecation> = {}): LlmModelIdDeprecation {
    return {
      provider: 'openai',
      kind: 'model_id',
      deprecated: 'gpt-4',
      replacement: 'gpt-5.6-sol',
      verification: {
        status: 'verified',
        officialSourceConfirmed: true,
        replacementConfirmed: true,
        autoApplyAllowed: true,
        quarantineReason: null,
        checkedAt: '2026-08-14',
      },
      ...over,
    };
  }

  it('names the stamp it read rather than a live catalog check it never made', () => {
    const [replacement, official] = registryVerdictRows([entry()]);
    expect(replacement).toEqual({
      label: 'replacement verdict',
      state: 'verified',
      detail: 'stamped 2026-08-14',
    });
    // THE WORD THIS ROW MAY NOT USE. `entry.evidence` is empty on all 106
    // shipped records and `mendr evidence <id>` says so per record, so a Tier A
    // row calling the same value "evidence" contradicts the command it sends
    // the reader to. It is a registry VERDICT, and it says so.
    expect(formatGateRow(replacement)).not.toContain('evidence');
    expect(official).toEqual({
      label: 'official source',
      state: 'confirmed',
      detail:
        'a provider docs url and a lifecycle claim are recorded on the record; ' +
        'the page was not fetched',
    });
    expect(formatGateRow(replacement)).not.toContain('live catalog');
  });

  it('reports the provider-docs claim SEPARATELY from the catalog claim', () => {
    // The two are independently stamped (P0): a replacement can be live in the
    // catalogs while the deprecation itself rests on a blog post. One word over
    // both would hide exactly that gap.
    const rows = registryVerdictRows([
      entry(),
      entry({
        deprecated: 'gpt-4-0613',
        verification: {
          status: 'verified',
          officialSourceConfirmed: false,
          replacementConfirmed: true,
          autoApplyAllowed: true,
          quarantineReason: null,
          checkedAt: '2026-08-01',
        },
      }),
    ]);
    expect(rows[0].state).toBe('verified');
    expect(rows[1]).toEqual({
      label: 'official source',
      state: 'not confirmed',
      detail: '1 of 2 records not backed by provider documentation',
    });
  });

  it('dates the set by its OLDEST stamp, and says when records carry none', () => {
    const base = entry().verification!;
    const rows = registryVerdictRows([
      entry(),
      entry({ deprecated: 'o1-mini', verification: { ...base, checkedAt: '2026-02-02' } }),
      entry({ deprecated: 'gpt-4-0314', verification: { ...base, checkedAt: undefined } }),
    ]);
    expect(rows[0].detail).toBe('stamped 2026-02-02; 1 record undated');
  });

  it('refuses to print "verified" over an empty set (a param-only patch)', () => {
    const rows = registryVerdictRows([]);
    expect(rows[0].state).toBe('n/a');
    expect(rows[0].detail).toContain('no model-id swap');
    expect(rows[1].state).toBe('n/a');
  });

  it('says "not verified" when a record is not stamped verified', () => {
    const rows = registryVerdictRows([entry({ verification: undefined })]);
    expect(rows[0].state).toBe('not verified');
    expect(rows[0].detail).toBe('no recheck date recorded');
  });
});

describe('behavioralGateRow (the sixth check, itemized)', () => {
  it('separates "nothing configured" from "configured but no verdict"', () => {
    expect(behavioralGateRow({ status: 'not-tested' })).toEqual({
      label: 'behavioral evaluation',
      state: 'not configured',
      required: false,
    });
    // An eval that timed out is INCONCLUSIVE. Reporting it as "not configured"
    // would hide a gate that tried and failed to run; reporting it as anything
    // passing would be a lie about behavior.
    expect(behavioralGateRow({ status: 'not-tested', reason: 'timed out after 1500ms' })).toEqual({
      label: 'behavioral evaluation',
      state: 'inconclusive',
      detail: 'timed out after 1500ms',
      required: false,
    });
  });

  it('reports a completed run with its command and exit code', () => {
    expect(
      behavioralGateRow({ status: 'pass', command: 'npm run eval', exitCode: 0 }, true),
    ).toEqual({
      label: 'behavioral evaluation',
      state: 'passed',
      detail: 'your eval command: npm run eval, exit 0',
      required: true,
    });
    expect(behavioralGateRow({ status: 'fail', command: 'npm run eval', exitCode: 3 }).state).toBe(
      'failed',
    );
  });
});

describe('behavioralVerificationLines (the configurable-eval boundary)', () => {
  it('not-tested keeps the disclaimer AND says how to switch it on', () => {
    const text = behavioralVerificationLines({ status: 'not-tested' }).join('\n');
    expect(text).toContain('Behavioral verification (NOT checked):');
    expect(text).toContain('behavioral evaluation:  not configured');
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
      'behavioral evaluation:  inconclusive (eval command timed out after 1500ms)',
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
    expect(text).toContain(
      'behavioral evaluation:  passed (your eval command: npm run eval, exit 0)',
    );
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
    expect(text).toContain(
      'behavioral evaluation:  failed (your eval command: npm run eval, exit 1)',
    );
    expect(text).toContain('NOT');
    expect(text).toMatch(/blocks it exactly like a failing test gate/);
  });

  it('formatGateSummary defaults to the disclaimer when no result is passed', () => {
    // A caller that forgets the argument must get "not checked", never a pass.
    expect(formatGateSummary([{ label: 'tests', state: 'passed' }])).toContain(
      'Behavioral verification (NOT checked):',
    );
  });

  it('formatGateSummary swaps in the eval group when one ran', () => {
    const text = formatGateSummary(
      [
        { label: 'type-check', state: 'passed' },
        { label: 'tests', state: 'passed' },
      ],
      { status: 'pass', command: 'npm run eval', exitCode: 0 },
    ).join('\n');
    expect(text).toContain('Behavioral verification (your own evaluation):');
    expect(text).not.toContain('Behavioral verification (NOT checked):');
    // The code rows survive unchanged -- the eval ADDS a claim, it replaces none.
    expect(text).toMatch(/^ {2}type-check: +passed$/m);
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

  // THE CLAIM THAT WAS FALSE. Under --skip-gates the default note read
  // "mendr verified the CODE only -- see the gate summary above", printed
  // under a run that type-checked nothing, tested nothing, and suppressed the
  // very summary it pointed at.
  it('refuses to say anything was verified when the gates were skipped', () => {
    for (const view of [
      { status: 'not-tested' } as const,
      { status: 'pass', command: 'npm run eval', exitCode: 0 } as const,
    ]) {
      const note = behavioralVerificationNote(view, true);
      expect(note).toContain('mendr verified NOTHING on this run');
      expect(note).toContain('--skip-gates');
      // Neither the false claim nor the pointer to a summary that is not there.
      expect(note).not.toContain('verified the CODE');
      expect(note).not.toContain('gate summary above');
    }
  });

  it('keeps the normal wording when the gates were not skipped', () => {
    expect(behavioralVerificationNote({ status: 'not-tested' }, false)).toBe(
      BEHAVIORAL_VERIFICATION_NOTE,
    );
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

// Tier A is rendered as a DIFF, not as per-finding blocks, so these two rows
// are the only place a reader can learn WHICH registry records authorised the
// edit they are being shown -- and the only way to go read one without first
// guessing its id.
describe('formatRegistryEntryLines', () => {
  const entry = (
    provider: string,
    deprecated: string,
    shutdownDate?: string,
  ): LlmModelIdDeprecation => ({
    provider,
    kind: 'model_id',
    deprecated,
    replacement: 'gpt-5.6-sol',
    ...(shutdownDate ? { shutdownDate } : {}),
  });

  it('prints the record id and the command that takes it', () => {
    expect(formatRegistryEntryLines([entry('openai', 'gpt-4', '2026-10-23')])).toEqual([
      '  registry entry:        openai.gpt-4.retirement-2026-10-23',
      '  evidence:              mendr evidence openai.gpt-4.retirement-2026-10-23',
    ]);
  });

  it('prints one pair per DISTINCT record, in the order the swaps were listed', () => {
    const lines = formatRegistryEntryLines([
      entry('openai', 'gpt-4', '2026-10-23'),
      entry('google', 'gemini-2.0-flash'),
      entry('openai', 'gpt-4', '2026-10-23'),
    ]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('openai.gpt-4.retirement-2026-10-23');
    expect(lines[2]).toContain('google.gemini-2.0-flash.retirement-undated');
  });

  it('never wraps -- an id and its command are things a reader pastes', () => {
    const long = entry('openai', 'gpt-4-1106-vision-preview-with-a-very-long-name');
    for (const line of formatRegistryEntryLines([long])) {
      expect(line.split('\n')).toHaveLength(1);
    }
  });

  it('has nothing to say about an empty patch', () => {
    expect(formatRegistryEntryLines([])).toEqual([]);
  });

  // THE SAME THREE ROWS TIER B PRINTS. Tier A has no per-finding block -- it is
  // a diff -- so its dimensions used to be scattered across a gate summary, a
  // prose line and a heading. Stating them here, in the Tier B vocabulary and
  // at the Tier B column, is what makes the two tiers comparable: same rows,
  // and a reader can see which one is the one that did not hold.
  describe('the three verdict rows', () => {
    const verified = (): LlmModelIdDeprecation => ({
      provider: 'openai',
      kind: 'model_id',
      deprecated: 'gpt-4',
      replacement: 'gpt-5.6-sol',
      shutdownDate: '2026-10-23',
      verification: {
        status: 'verified',
        officialSourceConfirmed: true,
        replacementConfirmed: true,
        autoApplyAllowed: true,
        quarantineReason: null,
        checkedAt: '2026-08-21',
      },
    });

    it('states replacement, usage and classification above the id rows', () => {
      const lines = formatRegistryEntryLines(
        [verified()],
        'tier A -- auto-fixable, will apply with --write',
      );
      expect(lines[0]).toBe(
        '  replacement verdict:   verified (registry stamp 2026-08-21, not re-checked',
      );
      expect(lines[1]).toBe('                         this run)');
      expect(lines[2]).toBe('  usage verdict:         confirmed -- flows to a live model call');
      expect(lines[3]).toBe(
        '  classification:        tier A -- auto-fixable, will apply with --write',
      );
      expect(lines[4]).toBe('  registry entry:        openai.gpt-4.retirement-2026-10-23');
      expect(lines[5]).toBe(
        '  evidence:              mendr evidence openai.gpt-4.retirement-2026-10-23',
      );
    });

    // The row names a STAMP, never a live check and never "evidence" -- the
    // same two claims the Tier B row is forbidden from making, for the same
    // reason: `entry.evidence` is empty on every shipped record.
    it('names the stamp, and claims neither evidence nor a live check', () => {
      const flat = formatRegistryEntryLines([verified()], 'tier A')
        .join(' ')
        .replace(/\s+/g, ' ');
      expect(flat).toContain('registry stamp 2026-08-21');
      expect(flat).toContain('not re-checked this run');
      expect(flat).not.toContain('replacement evidence');
      expect(flat).not.toContain('live catalog');
    });

    // A gate-failed candidate rests on the SAME records, and the caller passes
    // the disposition -- so this block can never claim a patch that did not
    // land while printing the record that would have authorised it.
    it('prints the disposition it is given, not one it assumes', () => {
      const lines = formatRegistryEntryLines(
        [verified()],
        'tier A candidate -- gates failed, no patch applied',
      );
      expect(lines).toContain(
        '  classification:        tier A candidate -- gates failed, no patch applied',
      );
      expect(lines.join(' ')).not.toContain('will apply with --write');
    });

    it('keeps the id rows alone when no disposition is stated', () => {
      expect(formatRegistryEntryLines([verified()])).toHaveLength(2);
    });
  });
});
