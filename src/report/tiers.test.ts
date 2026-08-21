import { describe, it, expect } from 'vitest';
import type { TierBReason } from '../types.js';
import {
  findingKey,
  formatFoundLines,
  formatSummaryLines,
  formatTierBFinding,
  formatTierBSection,
  orderTierB,
  tierBFinding,
  tierBJson,
  tierBReasonCounts,
  TIER_B_ACTION_LINE,
  TIER_B_HEADING,
  TIER_B_REASON_ORDER,
  TIER_B_REASON_TEXT,
  type TierBFinding,
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

  it('projects to exactly the seven documented JSON keys', () => {
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
      'file',
      'line',
      'column',
      'modelId',
      'replacement',
      'reason',
      'reasonText',
    ]);
  });
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
  it('renders the location, both ids, both reason forms and the no-patch action', () => {
    const lines = formatTierBFinding(
      tierBFinding(
        {
          file: 'agent_app/simulator.py',
          line: 166,
          column: 13,
          modelId: 'gpt-4',
          replacement: 'gpt-5.6-sol',
        },
        'usage_unverified',
      ),
    );

    expect(lines[0]).toBe('agent_app/simulator.py:166:13');
    expect(lines[1]).toBe('  found:       "gpt-4"');
    expect(lines[2]).toBe('  replacement: "gpt-5.6-sol"');
    expect(lines[3]).toBe(
      '  reason:      usage_unverified -- assigned to a model-like variable, but no',
    );
    // The wrapped sentence hangs under the reason VALUE, not under the label.
    expect(lines[4]).toBe(
      '               supported SDK call or parameter sink was found in this file.',
    );
    expect(lines.at(-1)).toBe(`  action:      ${TIER_B_ACTION_LINE}`);
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
    // The detail never displaces the action line: "is there a patch?" is
    // answered for every finding, however much audit trail it carries.
    expect(lines.at(-1)).toBe(`  action:      ${TIER_B_ACTION_LINE}`);
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
    // One "action:" row per finding — the count the section LISTS.
    expect(lines.filter((l) => l.includes('action:')).length).toBe(findings.length);
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
    // actually lists (one `action:` row each).
    const listed = formatTierBSection(findings).filter((l) => l.includes('action:')).length;
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

  it('can report all three dispositions at once, and they sum to the tier count', () => {
    const summary = formatSummaryLines(
      { tierA: 6, tierB: 0, tierC: 0 },
      { applied: 1, ready: 2, downgraded: 3 },
    ).join('\n');
    expect(summary).toContain(
      'tier A 6 (1 auto-fixed, 2 ready to apply -- not written, ' +
        '3 downgraded -- gates failed, not applied)',
    );
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
