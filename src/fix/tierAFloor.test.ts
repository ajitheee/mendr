import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmRegistry, VerificationInfo, VerificationStatus } from '../types.js';
import { isVerified, loadLlmRegistry } from '../usage/llmRegistry.js';
import { applyModelIdFixesToProject } from './modelId.js';

// THE TIER A FLOOR, ASSERTED AGAINST THE CODEMOD RATHER THAN THE PREDICATE.
//
// usage/llmRegistry.test.ts already pins isVerified() itself: the four-field
// conjunction, and its indifference to prose. That is necessary and not
// sufficient. The gate is only load-bearing if the thing that EDITS FILES
// consults it, and the way that breaks is not a wrong predicate -- it is a call
// site that grew a second opinion. findingUniqueness.test.ts documents one that
// already happened: a surface read `verification.status` directly, which is a
// COPY of the Tier A rule, and the copy kept promoting records the gate had
// started refusing.
//
// So every case here drives applyModelIdFixesToProject -- the function whose
// output becomes the diff and then, under --write, the user's files -- and asks
// only one question: did a byte change?
//
// Hermetic: an in-memory ts-morph project and inline registries. No repo on
// disk, no network, no shipped-registry dependency (the CLI suite covers the
// shipped records end to end).

/** A live model argument: the ONLY position a swap can legally happen in. */
const SOURCE = `import OpenAI from "openai";
const client = new OpenAI();
export async function ask() {
  return client.chat.completions.create({ model: "victim-model", messages: [] });
}
`;

function project(): Project {
  const p = new Project({ useInMemoryFileSystem: true });
  p.createSourceFile('src/ask.ts', SOURCE);
  return p;
}

function registryWith(verification: VerificationInfo | undefined): LlmRegistry {
  return [
    {
      entryId: 'x.victim-model.retirement-undated',
      provider: 'x',
      kind: 'model_id',
      deprecated: 'victim-model',
      replacement: 'SWAPPED',
      status: 'retired',
      sourceUrl: 'https://example.invalid/deprecations',
      verification,
    },
  ];
}

/** Did the codemod touch the file? The only question that matters here. */
function swapped(verification: VerificationInfo | undefined): boolean {
  const result = applyModelIdFixesToProject(project(), registryWith(verification));
  const edited = result.siteCount > 0;
  // siteCount and the diff must agree, or one of them is lying to a caller.
  expect(result.diff.includes('SWAPPED')).toBe(edited);
  return edited;
}

/** All four conditions satisfied. Every case below is this, minus one thing. */
const ALL_FOUR: VerificationInfo = {
  status: 'verified',
  officialSourceConfirmed: true,
  replacementConfirmed: true,
  autoApplyAllowed: true,
  quarantineReason: null,
  checkedAt: '2026-08-21',
};

describe('the Tier A floor: the codemod refuses everything short of all four conditions', () => {
  // THE CONTROL. Without it every assertion below is vacuously true -- a
  // codemod that swaps nothing at all would pass the whole suite.
  it('swaps when, and only when, all four conditions hold', () => {
    expect(swapped(ALL_FOUR)).toBe(true);
    expect(isVerified(registryWith(ALL_FOUR)[0] as never)).toBe(true);
  });

  // ONE CONDITION AT A TIME. Flipping several at once cannot distinguish "the
  // conjunction holds" from "one dominant clause holds and the rest are
  // decoration" -- and the reviewer's question was precisely whether all four
  // are load-bearing.
  const NON_VERIFIED_STATUSES: Exclude<VerificationStatus, 'verified'>[] = [
    'quarantined',
    'unverified',
    'unverifiable',
  ];
  for (const status of NON_VERIFIED_STATUSES) {
    it(`refuses status "${status}" with all three switches still on`, () => {
      expect(
        swapped({
          ...ALL_FOUR,
          status,
          // A quarantine must state a cause; the other two must not.
          quarantineReason: status === 'quarantined' ? 'held pending review' : null,
        }),
      ).toBe(false);
    });
  }

  const SWITCHES = [
    'officialSourceConfirmed',
    'replacementConfirmed',
    'autoApplyAllowed',
  ] as const;
  for (const field of SWITCHES) {
    it(`refuses a "verified" stamp with ${field} false`, () => {
      expect(swapped({ ...ALL_FOUR, [field]: false })).toBe(false);
    });
  }

  // The absent block, which parseSwitch turns into three false switches. A
  // registry written before these fields existed must read as "proved nothing",
  // never as "nothing objected".
  it('refuses a record carrying no verification block at all', () => {
    expect(swapped(undefined)).toBe(false);
  });
});

describe('the Tier A floor is blind to prose', () => {
  // THE REGRESSION THIS EXISTS FOR. Safety used to be computed by
  // regex-matching English in `verification.reasons`, so rewording a caveat
  // moved a record into or out of Tier A. The behaviour must now be IDENTICAL
  // for every wording -- including the exact sentences that used to hold a
  // record back, and including wordings no marker list would ever contain.
  const WORDINGS: [string, string[] | undefined][] = [
    ['no reasons at all', undefined],
    ['the marker that used to gate', ['DO NOT AUTO-APPLY']],
    ['several markers at once', ['status unknown; unverified; itself deprecated; stale']],
    ['the same caveat in French', ['Ne pas appliquer automatiquement -- statut inconnu']],
    ['glowing prose', ['fully verified, safe, ship it']],
  ];

  for (const [name, reasons] of WORDINGS) {
    it(`swaps a fully-verified record regardless of its reasons (${name})`, () => {
      expect(swapped({ ...ALL_FOUR, reasons })).toBe(true);
    });

    it(`refuses a quarantined record regardless of its reasons (${name})`, () => {
      expect(
        swapped({
          ...ALL_FOUR,
          status: 'quarantined',
          autoApplyAllowed: false,
          replacementConfirmed: false,
          officialSourceConfirmed: false,
          quarantineReason: 'held pending review',
          reasons,
        }),
      ).toBe(false);
    });
  }
});

describe('the Tier A floor survives the JSON loader', () => {
  // The cases above hand the codemod an object literal. A real user edits a
  // FILE, so the same conjunction has to hold across parse -- including the
  // fail-closed rule that an absent switch reads as false rather than as
  // "unspecified, assume fine".
  function viaLoader(verification: unknown): LlmRegistry {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-floor-'));
    const path = join(dir, 'registry.json');
    writeFileSync(
      path,
      JSON.stringify([
        {
          entryId: 'x.victim-model.retirement-undated',
          provider: 'x',
          kind: 'model_id',
          deprecated: 'victim-model',
          replacement: 'SWAPPED',
          status: 'retired',
          verification,
        },
      ]),
    );
    return loadLlmRegistry(path);
  }

  it('swaps an all-four record read off disk', () => {
    const result = applyModelIdFixesToProject(project(), viaLoader({ ...ALL_FOUR }));
    expect(result.siteCount).toBe(1);
  });

  it('refuses a "verified" block whose switches were simply left out', () => {
    // The dangerous shape: a hand-written or pre-P0 entry that says `verified`
    // and never mentions the three booleans.
    const registry = viaLoader({ status: 'verified' });
    expect(registry[0].kind === 'model_id' && isVerified(registry[0])).toBe(false);
    expect(applyModelIdFixesToProject(project(), registry).siteCount).toBe(0);
  });

  it('refuses to load a switch that is not a boolean, rather than coercing it', () => {
    // `"true"`, `1` and `"yes"` are the shapes a hand-edit produces. Any of
    // them read as truthy by an unguarded check would auto-apply a record
    // nobody verified.
    for (const truthy of ['true', 1, 'yes', {}]) {
      expect(() =>
        viaLoader({ status: 'verified', autoApplyAllowed: truthy }),
      ).toThrow(/non-boolean verification.autoApplyAllowed/);
    }
  });
});
