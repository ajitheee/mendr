import { describe, it, expect } from 'vitest';
import type { LlmModelIdDeprecation, LlmRegistry, VerificationInfo } from '../types.js';
import {
  autoApplyVerification,
  loadLlmRegistry,
  resolveRegistryPath,
  withheldVerification,
} from '../usage/llmRegistry.js';
import { entryIdFor } from './entryId.js';
import { formatValidation, validateRegistry, type RegistryViolationCode } from './validateRegistry.js';

// WHY A VALIDATOR AND NOT JUST THE GATE. The engine gate fails CLOSED and says
// nothing: a record that loses one of its proofs stops being auto-appliable and
// nobody finds out. A registry can rot for months that way, and the only signal
// a user gets is a headline number quietly shrinking. So every internal
// contradiction is a BUILD FAILURE, checked offline, on every CI run.

/** A well-formed record; overrides break exactly one rule at a time. */
function record(over: Partial<LlmModelIdDeprecation> = {}): LlmModelIdDeprecation {
  const base: LlmModelIdDeprecation = {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4',
    replacement: 'gpt-5.6-sol',
    status: 'deprecated',
    shutdownDate: '2026-10-23',
    sourceUrl: 'https://developers.openai.com/api/docs/deprecations',
    verification: autoApplyVerification(),
    ...over,
  };
  return { ...base, entryId: over.entryId ?? entryIdFor(base) };
}

/** The violation codes a registry produced, in report order. */
function codesFor(registry: LlmRegistry): RegistryViolationCode[] {
  return validateRegistry(registry).violations.map((v) => v.code);
}

describe('validateRegistry', () => {
  it('passes a well-formed record with nothing to say about it', () => {
    const result = validateRegistry([record()]);
    expect(result.recordsChecked).toBe(1);
    expect(result.violations).toEqual([]);
  });

  it('ignores param entries, which carry no verification block at all', () => {
    const result = validateRegistry([
      { provider: 'openai', kind: 'param_removal', param: 'temperature', on_models: ['o1'] },
    ]);
    expect(result.recordsChecked).toBe(0);
    expect(result.violations).toEqual([]);
  });

  // --- the four structured switches ----------------------------------------

  it.each([
    ['officialSourceConfirmed', 'verified_without_official_source'],
    ['replacementConfirmed', 'verified_without_replacement_confirmation'],
    ['autoApplyAllowed', 'verified_without_auto_apply'],
  ] as const)('fails a verified record with %s false', (field, code) => {
    const verification = autoApplyVerification({ [field]: false } as Partial<VerificationInfo>);
    expect(codesFor([record({ verification })])).toContain(code);
  });

  it.each(['quarantined', 'unverified', 'unverifiable'] as const)(
    'fails autoApplyAllowed:true on a %s record',
    (status) => {
      const verification = withheldVerification(status, { autoApplyAllowed: true });
      expect(codesFor([record({ verification })])).toContain('auto_apply_without_verified_status');
    },
  );

  it('fails a quarantine with no stated cause', () => {
    const verification = withheldVerification('quarantined', { quarantineReason: '   ' });
    expect(codesFor([record({ verification })])).toContain('quarantined_without_reason');
  });

  it('accepts a quarantine that says what has to be resolved', () => {
    const verification = withheldVerification('quarantined', {
      quarantineReason: 'no source-side verdict for this exact snapshot id',
    });
    expect(codesFor([record({ verification })])).toEqual([]);
  });

  // --- the record's own substance ------------------------------------------

  it('fails a record with no replacement -- there is nothing to migrate to', () => {
    expect(codesFor([record({ replacement: '' })])).toContain('missing_replacement');
  });

  it('fails a record claiming neither a lifecycle nor a shutdown date', () => {
    const bare = record({ status: undefined, shutdownDate: undefined });
    expect(codesFor([bare])).toContain('missing_lifecycle');
  });

  it('accepts a lifecycle with no date, and a date with no lifecycle', () => {
    expect(codesFor([record({ shutdownDate: undefined })])).toEqual([]);
    expect(codesFor([record({ status: undefined })])).toEqual([]);
  });

  // --- THE PROSE LINT -------------------------------------------------------
  //
  // The one job the old regex fail-safe still has. It is not a gate: it is the
  // check that catches "somebody wrote a warning and flipped the switch
  // anyway", which is the exact shape of the defect that started all this.

  it('fails an auto-appliable record that carries a caveat in its reasons', () => {
    const verification = autoApplyVerification({
      reasons: ['Status unknown; DO NOT AUTO-APPLY until a source-side verdict exists.'],
    });
    const result = validateRegistry([record({ verification })]);
    const violation = result.violations.find((v) => v.code === 'caveat_over_auto_apply');
    expect(violation).toBeTruthy();
    // The message quotes the markers, so a reviewer knows which sentence to go
    // resolve rather than re-reading the whole block.
    expect(violation!.message).toContain('"do not auto-apply"');
    expect(violation!.message).toContain('"status unknown"');
  });

  it('says nothing about the same caveat on a record that is NOT auto-appliable', () => {
    // A quarantined record is SUPPOSED to carry the caveat that quarantined it.
    // Flagging that would train people to delete their own audit trail.
    const verification = withheldVerification('quarantined', {
      quarantineReason: 'no source-side verdict',
      reasons: ['Status unknown; do not auto-apply.'],
    });
    expect(codesFor([record({ verification })])).toEqual([]);
  });

  it('leaves the classifier own sentences alone', () => {
    const verification = autoApplyVerification({
      reasons: [
        'replacement "gpt-5.6-sol" is live in a public catalog',
        'matches the provider\'s officially-recommended replacement "gpt-5.6-sol"',
      ],
    });
    expect(codesFor([record({ verification })])).toEqual([]);
  });

  // --- identity -------------------------------------------------------------

  it('fails a record with no entryId, and names the id it should carry', () => {
    const anonymous = { ...record(), entryId: undefined };
    const violation = validateRegistry([anonymous]).violations.find(
      (v) => v.code === 'missing_entry_id',
    );
    expect(violation).toBeTruthy();
    expect(violation!.message).toContain('openai.gpt-4.retirement-2026-10-23');
  });

  it('fails a hand-chosen entryId -- the id is generated, not picked', () => {
    expect(codesFor([record({ entryId: 'openai.the-one-with-the-vision-thing' })])).toContain(
      'entry_id_mismatch',
    );
  });

  it('fails a duplicated entryId, once per colliding record', () => {
    // Two genuinely different records forced onto one id: neither can be looked
    // up by it, so both are reported.
    const a = record({ entryId: 'openai.gpt-4.retirement-2026-10-23' });
    const b = record({
      deprecated: 'gpt-4-32k',
      entryId: 'openai.gpt-4.retirement-2026-10-23',
    });
    const dupes = validateRegistry([a, b]).violations.filter(
      (v) => v.code === 'duplicate_entry_id',
    );
    expect(dupes).toHaveLength(2);
  });

  // --- reporting ------------------------------------------------------------

  it('reports EVERY violation, not just the first', () => {
    // A reviewer fixing a batch wants the whole list in one run; a validator
    // that stops at the first failure trains people to run it ten times.
    const broken = record({
      replacement: '',
      status: undefined,
      shutdownDate: undefined,
      verification: autoApplyVerification({ officialSourceConfirmed: false }),
    });
    const codes = codesFor([broken]);
    expect(codes).toContain('verified_without_official_source');
    expect(codes).toContain('missing_replacement');
    expect(codes).toContain('missing_lifecycle');
  });

  it('prints each violation under its record id, then a per-code summary', () => {
    const verification = autoApplyVerification({ replacementConfirmed: false });
    const lines = formatValidation(validateRegistry([record({ verification })])).join('\n');
    expect(lines).toContain('openai.gpt-4.retirement-2026-10-23');
    expect(lines).toContain('[verified_without_replacement_confirmation]');
    expect(lines).toContain('summary: 1 violation(s) across 1 model_id records');
  });

  it('proves it RAN when it finds nothing, instead of printing silence', () => {
    // A green CI step that prints nothing is indistinguishable from one that
    // matched nothing.
    expect(formatValidation(validateRegistry([record()]))).toEqual([
      'registry OK: 0 violations across 1 model_id records.',
    ]);
  });
});

// THE SHIPPED REGISTRY. This is the assertion the CI job exists to make, run
// here too so a bad record fails `npm test` on the commit that introduces it
// rather than on the following Monday.
describe('the shipped registry', () => {
  it('has zero violations', () => {
    const result = validateRegistry(loadLlmRegistry(resolveRegistryPath()));
    // The ids are printed on failure: a bare count would send the reader back
    // to the command line to find out which records are broken.
    expect(
      result.violations.map((v) => `${v.entryId}: ${v.code}`),
      formatValidation(result).join('\n'),
    ).toEqual([]);
    expect(result.recordsChecked).toBe(106);
  });
});
