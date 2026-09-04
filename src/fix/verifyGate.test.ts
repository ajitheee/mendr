import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { applyLlmFixesToProject } from './llmFix.js';
import { applyModelIdFixesToProject } from './modelId.js';
import { findBlockedModelArgMatches } from '../usage/scanLiterals.js';
import { autoApplyVerification, withheldVerification } from '../usage/llmRegistry.js';

// THE ENGINE GATE, and it is a FOUR-FIELD CONJUNCTION, not a status check:
//   auto-apply (Tier A) fires only when status === 'verified' AND
//   officialSourceConfirmed AND replacementConfirmed AND autoApplyAllowed.
// Everything else -- quarantined, unverified, unverifiable, unstamped, and a
// `verified` stamp with any switch off -- is NEVER swapped.
//
// The last two cases are the ones worth a test of their own. `quarantined` is
// the state twelve shipped records were moved into, and a `verified` stamp over
// a false switch is what the gate used to decide by regex-matching English in
// `verification.reasons`. Neither may reach Tier A, and neither depends on a
// single word of prose to be held back.

/** One entry of each trust state, all referencing ids used in the source. */
const REGISTRY: LlmRegistry = [
  {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-opus-20240229',
    replacement: 'claude-opus-4-8',
    note: 'retired -> current opus',
    verification: autoApplyVerification(),
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'text-davinci-003',
    replacement: 'gpt-3.5-turbo-instruct',
    note: 'chained deprecation',
    verification: withheldVerification('unverified', {
      reasons: ['replacement "gpt-3.5-turbo-instruct" is itself deprecated (chained)'],
    }),
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'text-moderation-latest',
    replacement: 'omni-moderation-latest',
    note: 'moderation is out-of-class',
    verification: withheldVerification('unverifiable'),
  },
  {
    // QUARANTINED IN THE DATA. Both proofs hold -- the catalogs confirm the
    // replacement, the provider confirms the deprecation -- and the record is
    // still held, because a human said so and said why. This is the case the
    // old regex gate reached by reading a sentence.
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4-0314',
    replacement: 'gpt-5.6-sol',
    note: 'quarantined entry',
    verification: withheldVerification('quarantined', {
      officialSourceConfirmed: true,
      replacementConfirmed: true,
      quarantineReason: 'no source-side verdict for this exact snapshot id',
    }),
  },
  {
    // A `verified` STAMP WITH A SWITCH OFF. Nothing about the wording of any
    // reason is involved; one boolean is false and that is the whole story.
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4-32k',
    replacement: 'gpt-5.6-sol',
    note: 'verified stamp, replacement not confirmed',
    verification: autoApplyVerification({ replacementConfirmed: false }),
  },
  {
    // No verification block at all => `unstamped` => must NOT auto-apply.
    provider: 'google',
    kind: 'model_id',
    deprecated: 'gemini-2.0-flash',
    replacement: 'gemini-flash-latest',
    note: 'unstamped entry',
  },
];

/** Every deprecated id sits in a genuine `model:` argument OF A CALL. */
const SOURCE = `
import OpenAI from "openai";
const client = new OpenAI();
export const a = () => client.chat.completions.create({ model: "claude-3-opus-20240229" });  // verified     -> SWAP
export const b = () => client.chat.completions.create({ model: "text-davinci-003" });         // unverified   -> BLOCK
export const c = () => client.chat.completions.create({ model: "text-moderation-latest" });   // unverifiable -> BLOCK
export const d = () => client.chat.completions.create({ model: "gemini-2.0-flash" });         // unstamped    -> BLOCK
export const e = () => client.chat.completions.create({ model: "gpt-4-0314" });               // quarantined  -> BLOCK
export const f = () => client.chat.completions.create({ model: "gpt-4-32k" });                // switch off   -> BLOCK
`.trimStart();

function inMemoryProject(fileName: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(fileName, source);
  return project;
}

describe('engine gate: auto-apply only verified entries', () => {
  it('swaps the verified entry and leaves every non-verified one byte-identical', () => {
    const project = inMemoryProject('src/gate.ts', SOURCE);
    const result = applyLlmFixesToProject(project, REGISTRY);
    const text = project.getSourceFileOrThrow('src/gate.ts').getFullText();

    // VERIFIED -> swapped.
    expect(text).toContain('{ model: "claude-opus-4-8" }');
    // UNVERIFIED (chained) -> untouched.
    expect(text).toContain('{ model: "text-davinci-003" }');
    // UNVERIFIABLE (moderation) -> untouched.
    expect(text).toContain('{ model: "text-moderation-latest" }');
    // UNSTAMPED -> untouched (a missing stamp is NOT a licence to swap).
    expect(text).toContain('{ model: "gemini-2.0-flash" }');
    // QUARANTINED -> untouched, though both of its proofs are true.
    expect(text).toContain('{ model: "gpt-4-0314" }');
    // VERIFIED STAMP, SWITCH OFF -> untouched.
    expect(text).toContain('{ model: "gpt-4-32k" }');

    // Exactly one swap fired.
    expect(result.modelIdSites).toBe(1);
    // None of the blocked replacements leaked into the source.
    expect(text).not.toContain('gpt-3.5-turbo-instruct');
    expect(text).not.toContain('omni-moderation-latest');
    expect(text).not.toContain('gemini-flash-latest');
    expect(text).not.toContain('gpt-5.6-sol');
  });

  it('surfaces every blocked model-arg match, each under its own state', () => {
    const project = inMemoryProject('src/gate.ts', SOURCE);
    const result = applyLlmFixesToProject(project, REGISTRY);

    expect(result.blockedMatches).toHaveLength(5);
    const byValue = Object.fromEntries(result.blockedMatches.map((b) => [b.value, b.status]));
    // Each blocked record reports the state the FILE is in, never a flattened
    // "unverified" -- a reader sent to `mendr evidence <id>` has to find the
    // same word there.
    expect(byValue).toEqual({
      'text-davinci-003': 'unverified',
      'text-moderation-latest': 'unverifiable',
      'gemini-2.0-flash': 'unstamped',
      'gpt-4-0314': 'quarantined',
      'gpt-4-32k': 'withheld',
    });
    // The stamped reasons ride along for the CLI's Tier C explanation.
    const chained = result.blockedMatches.find((b) => b.value === 'text-davinci-003');
    expect(chained?.reasons?.join(' ')).toMatch(/chained/);
  });

  it('the model-id-only path reports the same blocked matches', () => {
    const project = inMemoryProject('src/gate.ts', SOURCE);
    const result = applyModelIdFixesToProject(project, REGISTRY);
    expect(result.siteCount).toBe(1);
    expect(result.blockedMatches).toHaveLength(5);
  });

  it('a blocked id in a DATA position is NOT reported as a blocked model-arg', () => {
    // Same unverified id, but as an object KEY (data) — belongs to the data
    // surface, not the blocked-model-arg surface.
    const src = `
import OpenAI from "openai";
const client = new OpenAI();
export const use = () => client.chat.completions.create({ model: "text-davinci-003" });  // model_arg + unverified -> blocked
export const PRICES = { "text-davinci-003": 1 };    // data key -> NOT a blocked model-arg
`.trimStart();
    const project = inMemoryProject('src/mixed.ts', src);
    const blocked = findBlockedModelArgMatches(project, REGISTRY);

    expect(blocked).toHaveLength(1);
    expect(blocked[0].value).toBe('text-davinci-003');
    expect(blocked[0].location.line).toBe(3);
  });
});
