import { describe, it, expect } from 'vitest';
import type { TierBReason } from '../types.js';
import {
  assertSingleTerminalTier,
  crossTierCollisions,
  findingKey,
  formatFoundLines,
  formatSummaryLines,
  formatTierBFinding,
  formatTierBSection,
  multiTierNotes,
  orderTierB,
  resolveTerminalTier,
  tierBFinding,
  tierBJson,
  tierBReasonCounts,
  classificationText,
  usageVerdictState,
  usageVerdictText,
  TIER_A_DOWNGRADED_CLASSIFICATION,
  TIER_B_ACTION_LINE,
  TIER_B_HEADING,
  TIER_B_REASON_ORDER,
  TIER_B_REASON_TEXT,
  TIER_PRECEDENCE,
  type RegistryVerdict,
  type Tier,
  type TierBFinding,
  type TierOccurrence,
} from './tiers.js';

// Tier B is the class that can never be auto-applied, so everything a reader
// uses to decide about one — its reason code, its plain-English sentence, and
// the flat "no patch generated" — has to be there every time. And the counts
// the report prints have to equal the items it lists; a report that says "4
// tier B" over three findings is one nobody checks twice.

const EVERY_REASON: TierBReason[] = [
  'usage_unverified',
  'replacement_unverified',
  'platform_blocked',
  'dynamic_model_value',
  'insufficient_dataflow',
  'type_cast_masked',
];

// EVERY verdict a finding can carry — the same union effectiveVerificationState
// returns. Enumerated once so the exhaustive loops below cannot quietly stop
// being exhaustive: `unverifiable` and `unstamped` were missing from the union
// itself, fell through to `unverified`, and every loop that hardcoded four
// values agreed with the bug.
const EVERY_VERDICT: RegistryVerdict[] = [
  'verified',
  'quarantined',
  'unverified',
  'unverifiable',
  'unstamped',
  'withheld',
];

function finding(reason: TierBReason, file = 'a.ts', line = 1, column = 1): TierBFinding {
  return tierBFinding({ file, line, column, modelId: 'gpt-4', replacement: 'gpt-5.6-sol' }, reason);
}

describe('TIER_B_REASON_TEXT', () => {
  it('carries a sentence for every reason in the union, including the reserved ones', () => {
    for (const reason of EVERY_REASON) {
      expect(TIER_B_REASON_TEXT[reason], reason).toBeTruthy();
      // A "sentence", not a restated code: it has to read as English.
      expect(TIER_B_REASON_TEXT[reason].split(' ').length, reason).toBeGreaterThan(5);
    }
  });

  it('gives every reason a print position, so none can render in an arbitrary place', () => {
    expect([...TIER_B_REASON_ORDER].sort()).toEqual([...EVERY_REASON].sort());
  });

  // AN HONESTY LOCK, not a style rule. Two of these sentences used to assert
  // things the detector never checked: `platform_blocked` said "the value IS a
  // deployment alias rather than a model id" when all mendr saw was a property
  // KEY named `deployment` (an Azure deployment is routinely named after its
  // model, and the key shows up in non-Azure configs), and `type_cast_masked`
  // said "the model-id union this value belongs to" when the guard fires on any
  // `as` cast that is not `string`/`const` -- including `as any`, where no union
  // exists at all. Both now report the POSITION as fact and mark the inference
  // as an inference. If someone tightens the sentence again without tightening
  // the detector, this fails.
  it('never asserts more about a finding than the detector checked', () => {
    // The deployment rule reads a key name; it never inspects the value.
    expect(TIER_B_REASON_TEXT.platform_blocked).not.toContain('the value is a deployment alias');
    expect(TIER_B_REASON_TEXT.platform_blocked).toContain('likely');
    // The cast guard never resolves the cast target, so it cannot know a union
    // (or the repo's "type registry") exists.
    expect(TIER_B_REASON_TEXT.type_cast_masked).not.toContain('the model-id union');
    expect(TIER_B_REASON_TEXT.type_cast_masked).toContain('may');
  });
});

describe('tierBFinding', () => {
  it('derives reasonText from reason, so the two cannot disagree', () => {
    for (const reason of EVERY_REASON) {
      expect(finding(reason).reasonText).toBe(TIER_B_REASON_TEXT[reason]);
    }
  });

  it('projects to exactly the documented JSON keys, in order', () => {
    const f = tierBFinding(
      {
        file: 'a.ts',
        line: 3,
        column: 9,
        modelId: 'gpt-4',
        replacement: 'gpt-5.6-sol',
        // Internal plumbing for the derived legacy arrays — must NOT leak into
        // the published shape.
        detail: ['some audit reason'],
        status: 'unverified',
      },
      'replacement_unverified',
    );
    expect(Object.keys(tierBJson(f))).toEqual([
      'entryId',
      'file',
      'line',
      'column',
      'modelId',
      'replacement',
      // THE THREE DIMENSIONS, separately, so a consumer cannot read one
      // verdict as covering the other two.
      'replacementVerdict',
      'usageVerdict',
      'tier',
      // DEPRECATED for one release, and still populated.
      'registryVerdict',
      'verdictCheckedAt',
      'reason',
      'reasonText',
    ]);
  });

  // THE DEPRECATION CONTRACT, pinned: `registryVerdict` still ships, and it
  // still says exactly what `replacementVerdict` says. A consumer that has not
  // migrated yet must not start reading a different value from the old key.
  it('keeps the deprecated registryVerdict key equal to replacementVerdict', () => {
    for (const verdict of EVERY_VERDICT) {
      const j = tierBJson(
        tierBFinding(
          {
            file: 'a.ts',
            line: 1,
            column: 1,
            modelId: 'gpt-4',
            replacement: 'o1',
            registryVerdict: verdict,
          },
          'usage_unverified',
        ),
      );
      expect(j.registryVerdict, verdict).toBe(j.replacementVerdict);
      expect(j.tier, verdict).toBe('B');
    }
  });

  // The usage dimension is DERIVED FROM THE REASON CODE, never from the
  // mapping's stamp -- which is the whole point of splitting the two.
  it('reports usage as confirmed only for the reason whose usage WAS confirmed', () => {
    const usageOf = (reason: TierBReason) =>
      tierBJson(
        tierBFinding(
          {
            file: 'a.ts',
            line: 1,
            column: 1,
            modelId: 'gpt-4',
            replacement: 'o1',
            registryVerdict: 'quarantined',
          },
          reason,
        ),
      ).usageVerdict;
    expect(usageOf('replacement_unverified')).toBe('confirmed');
    for (const reason of EVERY_REASON.filter((r) => r !== 'replacement_unverified')) {
      expect(usageOf(reason), reason).toBe('unverified');
    }
  });

  // FAIL CLOSED. A site that says nothing about the registry's verdict gets
  // the weaker word, never the stronger one: printing `verified` over a mapping
  // nobody checked is the exact failure this field exists to prevent.
  it('defaults an unstated registry verdict to unverified', () => {
    const f = tierBFinding(
      { file: 'a.ts', line: 1, column: 1, modelId: 'gpt-4', replacement: 'gpt-5.6-sol' },
      'platform_blocked',
    );
    expect(f.registryVerdict).toBe('unverified');
    expect(tierBJson(f).registryVerdict).toBe('unverified');
    // No date to report is reported as no date, never as a blank that reads
    // like one was checked.
    expect(tierBJson(f).verdictCheckedAt).toBeNull();
  });

  it('carries a verified stamp through to the JSON projection', () => {
    const f = tierBFinding(
      {
        file: 'a.ts',
        line: 1,
        column: 1,
        modelId: 'gpt-4',
        replacement: 'gpt-5.6-sol',
        registryVerdict: 'verified',
        verdictCheckedAt: '2026-08-21',
      },
      'usage_unverified',
    );
    expect(tierBJson(f).registryVerdict).toBe('verified');
    expect(tierBJson(f).verdictCheckedAt).toBe('2026-08-21');
  });

  // A `replacement_unverified` finding IS the finding that the replacement is
  // unverified. A caller that hands it a `verified` stamp is contradicting the
  // reason code, and the constructor -- not the renderer -- settles it.
  it('never lets a replacement_unverified finding claim a verified replacement', () => {
    const f = tierBFinding(
      {
        file: 'a.ts',
        line: 1,
        column: 1,
        modelId: 'gpt-4-0314',
        replacement: 'gpt-5.6-sol',
        registryVerdict: 'verified',
      },
      'replacement_unverified',
    );
    expect(f.registryVerdict).toBe('unverified');
  });

  // ...but neither `quarantined` nor `withheld` claims anything cleared, so
  // both survive: each is the reason the finding is in Tier B at all, and
  // collapsing either to a plain `unverified` would hide what the file says.
  it.each(['quarantined', 'withheld'] as const)(
    'keeps a %s verdict on a replacement_unverified finding',
    (verdict) => {
      const f = tierBFinding(
        {
          file: 'a.ts',
          line: 1,
          column: 1,
          modelId: 'gemini-2.0-flash',
          replacement: 'gemini-3.6-flash',
          registryVerdict: verdict,
        },
        'replacement_unverified',
      );
      expect(f.registryVerdict).toBe(verdict);
    },
  );
});

// --- the documented surface -> reason-code mapping -------------------------
//
// The four codes that a detector actually emits today, each pinned to the
// surface the reviewer named. A regression here is not a formatting nit: it is
// a machine consumer routing "there is a deployment to provision" into the
// queue for "someone needs to verify a replacement".
describe('finding class -> reason code', () => {
  const CASES: { surface: string; reason: TierBReason; expectText: string }[] = [
    {
      surface: 'python sink rule: model-like assignment with no traced sink',
      reason: 'usage_unverified',
      expectText: 'no supported SDK call or parameter sink',
    },
    {
      surface: 'live model arg whose registry replacement is not verified',
      reason: 'replacement_unverified',
      expectText: 'has not cleared verification',
    },
    {
      surface: 'value under an azure deployment key',
      reason: 'platform_blocked',
      expectText: 'likely a provisioning change rather than a code change',
    },
    {
      surface: 'literal masked by an `as LLMID` cast',
      reason: 'type_cast_masked',
      expectText: 'wrapped in an `as` cast to a named type',
    },
  ];

  for (const c of CASES) {
    it(`${c.surface} -> ${c.reason}`, () => {
      expect(TIER_B_REASON_TEXT[c.reason]).toContain(c.expectText);
    });
  }

  it('leaves the two reserved codes unmapped to any live surface', () => {
    const emitted = new Set(CASES.map((c) => c.reason));
    expect(emitted.has('dynamic_model_value')).toBe(false);
    expect(emitted.has('insufficient_dataflow')).toBe(false);
  });
});

describe('formatTierBFinding', () => {
  it('renders the location, both ids, the three verdict rows and both reason forms', () => {
    const lines = formatTierBFinding(
      tierBFinding(
        {
          file: 'agent_app/simulator.py',
          line: 166,
          column: 13,
          modelId: 'gpt-4',
          replacement: 'gpt-5.6-sol',
          registryVerdict: 'verified',
          verdictCheckedAt: '2026-08-21',
        },
        'usage_unverified',
      ),
    );

    expect(lines[0]).toBe('agent_app/simulator.py:166:13');
    expect(lines[1]).toBe('  found:                 "gpt-4"');
    expect(lines[2]).toBe('  replacement:           "gpt-5.6-sol"');
    // THREE ROWS, THREE DIMENSIONS. The mapping's stamp says nothing about the
    // position, and the position is exactly what this finding could not
    // confirm -- so the two are stated separately, and the outcome third.
    expect(lines[3]).toBe(
      '  replacement verdict:   verified (registry stamp 2026-08-21, not re-checked',
    );
    expect(lines[4]).toBe('                         this run)');
    expect(lines[5]).toBe('  usage verdict:         unverified -- no traced sink in this file');
    expect(lines[6]).toBe(
      `  classification:        tier B -- review required, ${TIER_B_ACTION_LINE}`,
    );
    expect(lines[7]).toBe('  reason:                usage_unverified -- assigned to a model-like');
    // The wrapped sentence hangs under the reason VALUE, not under the label.
    expect(lines[8]).toBe(
      '                         variable, but no supported SDK call or parameter sink',
    );
    // NO `action:` ROW ANY MORE. `classification:` carries the same promise,
    // from the same constant, and one block does not say "no patch generated"
    // twice.
    expect(lines.some((l) => l.startsWith('  action:'))).toBe(false);
  });

  it('prints the verification gate reasons as detail under a blocked finding', () => {
    const lines = formatTierBFinding(
      tierBFinding(
        {
          file: 'src/chat.ts',
          line: 2,
          column: 40,
          modelId: 'gpt-4-0613',
          replacement: 'gpt-5.6-sol',
          status: 'unverified',
          detail: ['replacement not present in any live catalog'],
        },
        'replacement_unverified',
      ),
    );
    expect(lines.join('\n')).toContain('- replacement not present in any live catalog');
    // The detail never displaces the classification: "is there a patch?" is
    // answered for every finding, however much audit trail it carries.
    expect(lines).toContain(
      `  classification:        tier B -- review required, ${TIER_B_ACTION_LINE}`,
    );
  });
});

// --- the replacement verdict -----------------------------------------------
//
// A Tier B block used to print `replacement: "o3"` and stop, which reads as a
// checked fact whether or not anyone checked it. Some registry entries did NOT
// clear verification, and a reader deciding whether to migrate needs to know
// which kind they are looking at -- from the LABEL, which is unskippable, not
// only from a row below it.
//
// The row is SCOPED TO THE REPLACEMENT MAPPING and named for what backs it: a
// verdict stamped into a JSON file on some past date. Two earlier names are
// pinned out here. `replacement evidence` named something the registry does not
// have (`entry.evidence` is empty on every shipped entry, and no snapshot is
// stored), and its value called mappings "not catalog-confirmed" where the
// recorded reasons said the opposite. `registry verdict` was honest about the
// backing but wrong about the SCOPE: on a Tier B finding one row reading
// `verified` reads as a verdict on the finding, when the usage is the half that
// could not be confirmed. These tests pin the honest wording so neither drifts
// back.
describe('the replacement verdict on a Tier B finding', () => {
  const site = {
    file: 'agent_app/simulator.py',
    line: 166,
    column: 13,
    modelId: 'gpt-4',
    replacement: 'gpt-5.6-sol',
  };

  it('calls a verified mapping a "replacement" and dates the stamp it read', () => {
    const lines = formatTierBFinding(
      tierBFinding(
        { ...site, registryVerdict: 'verified', verdictCheckedAt: '2026-08-21' },
        'usage_unverified',
      ),
    ).join('\n');
    expect(lines).toContain('  replacement:           "gpt-5.6-sol"');
    expect(lines.replace(/\s+/g, ' ')).toContain(
      'replacement verdict: verified (registry stamp 2026-08-21, not re-checked this run)',
    );
    expect(lines).not.toContain('candidate replacement');
  });

  // THE CLAIM THIS ROW MAY NOT MAKE. A fix-llm run contacts no catalog and the
  // registry stores no evidence documents, so neither word may appear as a
  // description of what happened.
  it('never claims evidence, and never claims a live check', () => {
    for (const verdict of EVERY_VERDICT) {
      for (const reason of EVERY_REASON) {
        const rendered = formatTierBFinding(
          tierBFinding(
            { ...site, registryVerdict: verdict, verdictCheckedAt: '2026-08-21' },
            reason,
          ),
        ).join(' ');
        // The `evidence:` ROW is legitimate now -- it prints a command, not a
        // claim about what was consulted. What may never appear is the CLAIM,
        // so the check targets the words that would make one.
        expect(rendered, `${reason}/${verdict}`).not.toContain('catalog-confirmed');
        expect(rendered, `${reason}/${verdict}`).not.toContain('evidence captured');
        expect(rendered, `${reason}/${verdict}`).not.toContain('replacement evidence');
      }
    }
  });

  // QUARANTINE, RENDERED. The record's own stated cause is printed verbatim,
  // so the reader gets the actual reason on this screen instead of a pointer to
  // go find one.
  it('prints a quarantined record own stated reason', () => {
    const flat = formatTierBFinding(
      tierBFinding(
        {
          ...site,
          modelId: 'gemini-2.0-flash',
          replacement: 'gemini-3.6-flash',
          registryVerdict: 'quarantined',
          verdictCheckedAt: '2026-08-21',
          quarantineReason: 'no source-side verdict exists for this exact id',
        },
        'replacement_unverified',
      ),
    )
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(flat).toContain('candidate replacement: "gemini-3.6-flash"');
    expect(flat).toContain(
      'replacement verdict: quarantined (registry stamp 2026-08-21) -- no source-side ' +
        'verdict exists for this exact id',
    );
  });

  // THE DEFENCE-IN-DEPTH CASE, rendered: the file says `verified` and mendr
  // refuses anyway, so the row says BOTH -- and names the FIELD, not a quoted
  // fragment of somebody's sentence.
  it('reports a withheld verified stamp by naming the switch that is off', () => {
    const flat = formatTierBFinding(
      tierBFinding(
        {
          ...site,
          modelId: 'gemini-2.0-flash',
          replacement: 'gemini-3.6-flash',
          registryVerdict: 'withheld',
          verdictCheckedAt: '2026-08-21',
          withheldSwitches: ['replacementConfirmed'],
        },
        'replacement_unverified',
      ),
    )
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(flat).toContain(
      'replacement verdict: registry stamp says verified 2026-08-21, but withheld -- ' +
        'replacementConfirmed is false on this record',
    );
  });

  it('calls an unverified mapping a "candidate replacement", and says why', () => {
    const lines = formatTierBFinding(
      tierBFinding({ ...site, modelId: 'o1-preview', replacement: 'o1' }, 'usage_unverified'),
    ).join('\n');
    // The WORD changes, not just the status: a reader skimming for the id
    // reads the label and may never reach the row below it.
    expect(lines).toContain('  candidate replacement: "o1"');
    expect(lines.replace(/\s+/g, ' ')).toContain(
      'unverified -- this mapping did not clear verification',
    );
  });

  it('applies to EVERY reason code, not just the ones that mention verification', () => {
    for (const reason of EVERY_REASON) {
      const rendered = formatTierBFinding(tierBFinding({ ...site }, reason)).join('\n');
      expect(rendered, reason).toContain('replacement verdict:');
      expect(rendered, reason).toContain('candidate replacement:');
      // ...and so do the other two dimensions: three rows on every finding,
      // whatever the reason code.
      expect(rendered, reason).toContain('usage verdict:');
      expect(rendered, reason).toContain('classification:        tier B --');
    }
  });

  // THE COHERENCE CASE. `replacement_unverified` already says the replacement
  // did not clear verification; an evidence row that reads like a second,
  // separate defect makes the block look self-contradictory. One statement.
  it('states replacement_unverified as ONE fact, not two that look contradictory', () => {
    const rendered = formatTierBFinding(
      tierBFinding(
        { ...site, modelId: 'gpt-4-0314', detail: ['replacement not in any live catalog'] },
        'replacement_unverified',
      ),
    ).join('\n');
    // The verdict sentence wraps, so the claim is checked on the unwrapped
    // text: the wording is the assertion here, not the column it broke at.
    const flat = rendered.replace(/\s+/g, ' ');
    expect(flat).toContain('candidate replacement:');
    // ONE wording for every unverified finding: the verdict row restates the
    // reason code's fact in the field a machine consumer routes on, and adds
    // nothing that could be read as a second, separate defect.
    expect(flat).toContain(
      'replacement verdict: unverified -- this mapping did not clear verification',
    );
    // AND the usage row says the opposite, because for this reason code the
    // usage IS confirmed -- that separation is the point of the split.
    expect(flat).toContain('usage verdict: confirmed live model argument');
  });

  // THE WORD MUST SURVIVE THE TRIP. A finding sends the reader to
  // `mendr evidence <id>`; if the two screens use different words for the same
  // record, the reader cannot tell whether they are looking at the same thing.
  // `unverifiable` printed as `unverified` for exactly this reason -- it was
  // absent from RegistryVerdict and fell through the default branch -- while
  // the footer counted it under `unverifiable` and `mendr evidence` printed
  // `unverifiable`. Three surfaces, one record, two words.
  it('gives unverifiable its own word, and does not call it "did not clear"', () => {
    const flat = formatTierBFinding(
      tierBFinding(
        { ...site, registryVerdict: 'unverifiable', verdictCheckedAt: '2026-08-21' },
        'replacement_unverified',
      ),
    )
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(flat).toContain('replacement verdict: unverifiable (registry stamp 2026-08-21)');
    // The DISTINCTION, not just the word: no catalog covers this model class,
    // which is not the same fact as a mapping that was checked and failed.
    expect(flat).toContain('could not be checked either way');
    expect(flat).not.toContain('did not clear verification');
  });

  it('gives an unstamped record its own word rather than borrowing "unverified"', () => {
    const flat = formatTierBFinding(
      tierBFinding({ ...site, registryVerdict: 'unstamped' }, 'replacement_unverified'),
    )
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(flat).toContain(
      'replacement verdict: unstamped -- this record carries no verification block',
    );
  });

  it('never prints a replacement without its verdict on the very next row', () => {
    for (const verdict of EVERY_VERDICT) {
      for (const reason of EVERY_REASON) {
        const lines = formatTierBFinding(tierBFinding({ ...site, registryVerdict: verdict }, reason));
        const row = lines.findIndex((l) => l.includes('replacement:'));
        expect(row, `${reason}/${verdict}`).toBeGreaterThan(-1);
        expect(lines[row + 1], `${reason}/${verdict}`).toContain('replacement verdict:');
      }
    }
  });

  // THE ROW THAT USED TO BE MISSING. `usage verdict` is a function of the
  // REASON CODE and nothing else -- never of the mapping's stamp -- so a
  // `verified` stamp over an unconfirmed position cannot make the position
  // read as confirmed. That combination is exactly what shipped before.
  it('states the usage dimension from the reason code, not from the stamp', () => {
    const expected: Record<TierBReason, string> = {
      usage_unverified: 'unverified -- no traced sink in this file',
      replacement_unverified: 'confirmed live model argument',
      platform_blocked: 'unverified -- sits under a deployment key, not in a model argument',
      type_cast_masked: 'unverified -- masked by an `as` cast',
      dynamic_model_value: 'unverified -- the model value is assembled at runtime',
      insufficient_dataflow: 'unverified -- not traced to a definite use',
    };
    for (const reason of EVERY_REASON) {
      // A `verified` stamp on EVERY case: if the usage row were reading the
      // stamp, every line below would say "confirmed".
      const flat = formatTierBFinding(
        tierBFinding(
          { ...site, registryVerdict: 'verified', verdictCheckedAt: '2026-08-21' },
          reason,
        ),
      )
        .join(' ')
        .replace(/\s+/g, ' ');
      expect(flat, reason).toContain(`usage verdict: ${expected[reason]}`);
    }
  });

  // THE OUTCOME ROW. It names the tier AND what mendr will do, so a reader
  // never has to infer the second from a heading three sections up.
  it('classifies every Tier B finding as review-only, with no patch', () => {
    for (const reason of EVERY_REASON) {
      const flat = formatTierBFinding(tierBFinding({ ...site }, reason))
        .join(' ')
        .replace(/\s+/g, ' ');
      expect(flat, reason).toContain(
        `classification: tier B -- review required, ${TIER_B_ACTION_LINE}`,
      );
    }
  });
});

// --- the three dimensions, across all three tiers ---------------------------
//
// One vocabulary for the whole report. The Tier A section and the Tier B block
// render from these same functions, so the two tiers cannot describe the same
// dimension in two different words -- which is how `registry verdict` and
// `replacement evidence` ended up naming one thing on two screens.
describe('usageVerdictText / classificationText', () => {
  it('gives each tier its own usage sentence and machine word', () => {
    expect(usageVerdictText('A')).toBe('confirmed -- flows to a live model call');
    expect(usageVerdictState('A')).toBe('confirmed');
    expect(usageVerdictText('B', 'platform_blocked')).toBe(
      'unverified -- sits under a deployment key, not in a model argument',
    );
    expect(usageVerdictState('B', 'platform_blocked')).toBe('unverified');
    // A data position is not a model argument at all, so it is n/a -- not a
    // failed check, and not a passed one.
    expect(usageVerdictText('C')).toBe('n/a -- data position, not a model argument');
    expect(usageVerdictState('C')).toBe('n/a');
  });

  it('names the tier AND what mendr will do, for every tier', () => {
    expect(classificationText('A')).toBe('tier A -- auto-fixable, will apply with --write');
    expect(classificationText('B')).toBe(
      `tier B -- review required, ${TIER_B_ACTION_LINE}`,
    );
    expect(classificationText('C')).toBe('tier C -- informational, no action');
    // The gate-failed disposition is still Tier A -- the tier is what was
    // DETECTED, not how the gates went -- and it never promises a patch.
    expect(TIER_A_DOWNGRADED_CLASSIFICATION).toContain('tier A candidate');
    expect(TIER_A_DOWNGRADED_CLASSIFICATION).not.toContain('will apply');
  });

  // THE ROW RENDERS BEFORE THE WRITE IS ATTEMPTED, so under --write it cannot
  // know the outcome -- and it must not promise a --write that already
  // happened. The unconditional sentence printed `will apply with --write`
  // three lines above `write refused, working tree unchanged`.
  it('never promises a future --write on a run that already passed one', () => {
    expect(classificationText('A', 'WRITE')).toBe(
      'tier A -- auto-fixable; see Summary for whether it was applied',
    );
    expect(classificationText('A', 'WRITE')).not.toContain('will apply with --write');
    // LOOK keeps the forward statement, which is true there.
    expect(classificationText('A', 'LOOK')).toBe('tier A -- auto-fixable, will apply with --write');
    // It states no outcome of its own either way -- the Summary owns that.
    for (const mode of ['LOOK', 'WRITE'] as const) {
      expect(classificationText('A', mode)).not.toContain('auto-fixed');
      expect(classificationText('A', mode)).not.toContain('applied to');
    }
    // Mode is a Tier A concern only; B and C say the same thing under both.
    for (const mode of ['LOOK', 'WRITE'] as const) {
      expect(classificationText('B', mode)).toBe(
        `tier B -- review required, ${TIER_B_ACTION_LINE}`,
      );
      expect(classificationText('C', mode)).toBe('tier C -- informational, no action');
    }
  });

  // THE OVERCLAIM THIS ROW SHIPPED WITH: `platform alias, not a model id`
  // asserted the VALUE's nature, while the only thing checked is the enclosing
  // property key. It was refutable inside one run -- the same literal is
  // auto-patched as a model id from a `model:` argument in the same file.
  it('reports the deployment KEY, and never denies the value is a model id', () => {
    const row = usageVerdictText('B', 'platform_blocked');
    expect(row).toBe('unverified -- sits under a deployment key, not in a model argument');
    expect(row).not.toContain('not a model id');
    expect(row).not.toContain('platform alias');
    // The provisioning INFERENCE stays on the reason row, which hedges it.
    expect(TIER_B_REASON_TEXT.platform_blocked).toContain('likely a provisioning change');
  });
});

describe('formatTierBSection', () => {
  it('is empty when there is nothing to review (no heading over nothing)', () => {
    expect(formatTierBSection([])).toEqual([]);
  });

  it('heads the section and lists every finding', () => {
    const findings = [finding('usage_unverified', 'a.py'), finding('platform_blocked', 'b.ts')];
    const lines = formatTierBSection(findings);
    expect(lines[0]).toBe(TIER_B_HEADING);
    // One "classification:" row per finding — the count the section LISTS.
    expect(lines.filter((l) => l.includes('classification:')).length).toBe(findings.length);
  });

  it('orders by actionability, then file/line/column', () => {
    const ordered = orderTierB([
      finding('type_cast_masked', 'z.ts'),
      finding('usage_unverified', 'a.py', 20),
      finding('usage_unverified', 'a.py', 3),
      finding('replacement_unverified', 'm.ts'),
      finding('platform_blocked', 'k.ts'),
    ]);
    expect(ordered.map((f) => f.reason)).toEqual([
      'replacement_unverified',
      'platform_blocked',
      'usage_unverified',
      'usage_unverified',
      'type_cast_masked',
    ]);
    expect(ordered[2].line).toBe(3);
    expect(ordered[3].line).toBe(20);
  });
});

describe('tierBReasonCounts', () => {
  it('counts only the reasons present, in print order', () => {
    expect(
      tierBReasonCounts([
        finding('usage_unverified', 'a.py'),
        finding('usage_unverified', 'b.py'),
        finding('platform_blocked', 'c.ts'),
      ]),
    ).toEqual([
      { reason: 'platform_blocked', count: 1 },
      { reason: 'usage_unverified', count: 2 },
    ]);
  });
});

// --- THE INVARIANT: printed count == listed items --------------------------
describe('tier counts are consistent with what is listed', () => {
  it('prints each tier number once in the Found block, matching the section sizes', () => {
    const findings = [
      finding('replacement_unverified', 'a.ts'),
      finding('platform_blocked', 'b.ts'),
      finding('usage_unverified', 'c.py'),
    ];
    const counts = { tierA: 2, tierB: findings.length, tierC: 17 };
    const found = formatFoundLines(counts, findings).join('\n');

    expect(found).toContain('2 tier A');
    expect(found).toContain('3 tier B');
    expect(found).toContain('17 tier C');
    // The number printed for tier B equals the number of findings the section
    // actually lists (one `classification:` row each).
    const listed = formatTierBSection(findings).filter((l) =>
      l.includes('classification:'),
    ).length;
    expect(listed).toBe(counts.tierB);
    // ...and the per-reason breakdown sums back to the same number.
    const byReason = tierBReasonCounts(findings).reduce((n, r) => n + r.count, 0);
    expect(byReason).toBe(counts.tierB);
  });

  it('omits the reason breakdown when tier B is empty', () => {
    const found = formatFoundLines({ tierA: 0, tierB: 0, tierC: 0 }, []);
    expect(found.join('\n')).not.toContain('by reason');
  });

  it('repeats the SAME three numbers in the Summary block', () => {
    const counts = { tierA: 2, tierB: 3, tierC: 17 };
    const summary = formatSummaryLines(counts, { applied: 2, ready: 0, downgraded: 0 }).join('\n');
    expect(summary).toContain('tier A 2');
    expect(summary).toContain('tier B 3');
    expect(summary).toContain('tier C 17');
    expect(summary).toContain('no patch generated');
  });

  it('splits tier A into applied vs downgraded without changing its total', () => {
    const summary = formatSummaryLines(
      { tierA: 5, tierB: 0, tierC: 0 },
      { applied: 2, ready: 0, downgraded: 3 },
    ).join('\n');
    expect(summary).toContain('tier A 5 (2 auto-fixed, 3 downgraded -- gates failed, not applied)');
  });

  // THE READ-ONLY RUN, which is the default and therefore the common case: the
  // gates passed and a diff is on screen, but the working tree is untouched.
  // "auto-fixed" there is a claim about a file that did not change.
  it('never says "auto-fixed" for a patch that was not written', () => {
    const summary = formatSummaryLines(
      { tierA: 3, tierB: 0, tierC: 0 },
      { applied: 0, ready: 3, downgraded: 0 },
    ).join('\n');
    expect(summary).toContain('tier A 3 (0 auto-fixed, 3 ready to apply -- not written)');
    expect(summary).not.toContain('3 auto-fixed');
  });

  it('can report all four dispositions at once, and they sum to the tier count', () => {
    const summary = formatSummaryLines(
      { tierA: 10, tierB: 0, tierC: 0 },
      { applied: 1, ready: 2, refused: 4, downgraded: 3 },
    ).join('\n');
    expect(summary).toContain(
      'tier A 10 (1 auto-fixed, 2 ready to apply -- not written, ' +
        '4 not written -- write refused, working tree unchanged, ' +
        '3 downgraded -- gates failed, not applied)',
    );
  });

  // THE ABORTED WRITE. `--write` ran, the gates passed, and the atomic write
  // refused (a read-only file, an editor lock, content that drifted). Nothing
  // changed on disk, so nothing may be called auto-fixed -- and the reason is
  // NOT a gate failure, which would send a reader off to debug a good diff.
  it('never says "auto-fixed" for a write that was refused', () => {
    const summary = formatSummaryLines(
      { tierA: 3, tierB: 0, tierC: 0 },
      { applied: 0, ready: 0, refused: 3, downgraded: 0 },
    ).join('\n');
    expect(summary).toContain(
      'tier A 3 (0 auto-fixed, 3 not written -- write refused, working tree unchanged)',
    );
    expect(summary).not.toContain('3 auto-fixed');
    expect(summary).not.toContain('gates failed');
  });

  it('still prints a disposition slot when tier A is empty', () => {
    const summary = formatSummaryLines(
      { tierA: 0, tierB: 0, tierC: 0 },
      { applied: 0, ready: 0, downgraded: 0 },
    ).join('\n');
    expect(summary).toContain('tier A 0 (0 auto-fixed)');
  });
});

describe('findingKey', () => {
  it('is file + line + column + model id, so two ids on one line stay distinct', () => {
    const a = { file: 'a.ts', line: 1, column: 1, modelId: 'gpt-4' };
    const b = { file: 'a.ts', line: 1, column: 1, modelId: 'gemini-pro' };
    expect(findingKey(a)).not.toBe(findingKey(b));
    expect(findingKey(a)).toBe(findingKey({ ...a }));
  });
});

// --- one occurrence, one tier ----------------------------------------------
//
// The rule the report now RELIES on when it tells a reader "these are
// different occurrences": every (file, line, column, deprecatedId) lands in
// exactly one terminal tier, resolved A > B > C. Asserted here rather than
// assumed, because a note that explains a coincidence is only honest if the
// coincidence is the only thing it can be.
describe('terminal tier precedence', () => {
  it('resolves in the order A > B > C, whatever order the candidates arrive in', () => {
    expect(TIER_PRECEDENCE).toEqual(['A', 'B', 'C']);
    expect(resolveTerminalTier(['C', 'A', 'B'])).toBe('A');
    expect(resolveTerminalTier(['C', 'B'])).toBe('B');
    expect(resolveTerminalTier(['C'])).toBe('C');
    expect(resolveTerminalTier([])).toBeUndefined();
  });

  it('is total: any non-empty candidate set yields exactly one tier', () => {
    const ALL: Tier[] = ['A', 'B', 'C'];
    for (const a of ALL) {
      for (const b of ALL) {
        const resolved = resolveTerminalTier([a, b]);
        expect(resolved).toBeDefined();
        expect(ALL).toContain(resolved);
      }
    }
  });
});

describe('cross-tier disjointness', () => {
  const at = (tier: Tier, line: number, modelId = 'gpt-4'): TierOccurrence => ({
    tier,
    file: 'agent_app/simulator.py',
    line,
    column: 5,
    modelId,
  });

  it('sees no collision when the SAME id sits in two tiers at two positions', () => {
    // The shape two reviewers misread: `gpt-4` at line 12 (a lookup-table key,
    // Tier C) and `gpt-4` at line 166 (an assignment, Tier B). Two literals.
    expect(crossTierCollisions([at('B', 166), at('C', 12)])).toEqual([]);
    expect(() => assertSingleTerminalTier([at('B', 166), at('C', 12)])).not.toThrow();
  });

  it('sees no collision when two ids share one position', () => {
    const key = { tier: 'C' as Tier, file: 'a.ts', line: 2, column: 3 };
    expect(
      crossTierCollisions([
        { ...key, modelId: 'gpt-4' },
        { ...key, tier: 'B', modelId: 'gemini-pro' },
      ]),
    ).toEqual([]);
  });

  it('CATCHES one key landing in two tiers, and names the key and the tiers', () => {
    const collisions = crossTierCollisions([at('B', 166), at('C', 166)]);
    expect(collisions).toEqual(['agent_app/simulator.py:166:5:gpt-4 in tiers B + C']);
  });

  it('throws on a collision, because that is a classifier bug and not a report', () => {
    expect(() => assertSingleTerminalTier([at('A', 9), at('C', 9)])).toThrow(
      /exactly one tier/,
    );
  });
});

// --- the clarifying note ---------------------------------------------------
describe('multiTierNotes', () => {
  const sim = (tier: Tier, line: number, modelId = 'gpt-4'): TierOccurrence => ({
    tier,
    file: 'agent_app/simulator.py',
    line,
    column: 5,
    modelId,
  });

  it('says nothing when every id lives in a single tier', () => {
    expect(multiTierNotes([sim('B', 166), sim('C', 12, 'gemini-1.5-pro')])).toEqual([]);
  });

  it('explains the one id that appears in two tiers, with the positions', () => {
    expect(multiTierNotes([sim('B', 166), sim('C', 12), sim('C', 30, 'gemini-1.5-pro')])).toEqual([
      'note: "gpt-4" appears in more than one tier -- these are different ' +
        'occurrences (tier B: L166; tier C: L12).',
    ]);
  });

  it('orders the tiers A, B, C however the occurrences arrive', () => {
    const note = multiTierNotes([sim('C', 12), sim('A', 3), sim('B', 166)])[0];
    expect(note).toContain('(tier A: L3; tier B: L166; tier C: L12)');
  });

  it('qualifies positions with the FILE as soon as more than one is involved', () => {
    const note = multiTierNotes([
      sim('B', 166),
      { tier: 'C', file: 'agent_app/prices.py', line: 12, column: 1, modelId: 'gpt-4' },
    ])[0];
    expect(note).toContain('tier B: agent_app/simulator.py:166');
    expect(note).toContain('tier C: agent_app/prices.py:12');
  });

  it('caps the positions it lists per tier', () => {
    const note = multiTierNotes([
      sim('B', 1),
      ...[10, 11, 12, 13, 14, 15].map((line) => sim('C', line)),
    ])[0];
    expect(note).toContain('tier C: L10, L11, L12, L13, +2 more');
  });

  it('emits one line per multi-tier id, in id order', () => {
    const notes = multiTierNotes([
      sim('B', 1, 'zeta-1'),
      sim('C', 2, 'zeta-1'),
      sim('B', 3, 'alpha-1'),
      sim('C', 4, 'alpha-1'),
    ]);
    expect(notes.length).toBe(2);
    expect(notes[0]).toContain('"alpha-1"');
    expect(notes[1]).toContain('"zeta-1"');
  });
});
