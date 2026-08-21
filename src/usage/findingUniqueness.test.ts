import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  crossTierCollisions,
  findingKey,
  multiTierNotes,
  TIER_PRECEDENCE,
  type Tier,
} from '../report/tiers.js';
import { collectPythonFiles, readPythonSources } from '../python/scanPy.js';
import { applyPyModelIdFixesToSources } from '../python/fixPy.js';
import { isVerified, loadLlmRegistry } from './llmRegistry.js';
import { buildRegistryPrefilter, loadPrefilteredProject } from './scanRepo.js';
import {
  findModelIdLiterals,
  toAzureDeploymentMatches,
  toBlockedModelArgMatches,
  toModelIdDataMatches,
  TYPE_CAST_REASON,
} from './scanLiterals.js';

// A REGRESSION LOCK, not a bug fix. A reviewer suspected mendr double-counts —
// that one source position could surface as two findings and inflate the debt
// a repo appears to carry. It does not: the classifier assigns each matched
// literal exactly one position, and the projections partition on that
// position, so no location can appear twice. That is a property of how the
// scanners are wired today, and nothing in the code says it out loud — which
// is precisely how it would stop being true. So it is asserted here, across
// EVERY finding class at once and for both languages, on a fixture built to
// stress the near-collisions: the same id twice on one line, two different ids
// on one line, and the same id in several distinct positions in one file.
//
// The key is (file, line, column, modelId) — the model id is part of the
// identity because two ids can legitimately sit on the same line, and a weaker
// key would make this test pass by hiding a real finding.

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-unique-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'unique-fixture' }, null, 2));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'sim'));

  // Live calls: one verified (Tier A), one not (Tier B).
  writeFileSync(
    join(dir, 'src', 'live.ts'),
    [
      'export async function a(client: any) {',
      "  return client.chat.completions.create({ model: 'gpt-4-0613', messages: [] });",
      '}',
      'export async function b(client: any) {',
      "  return client.chat.completions.create({ model: 'gpt-4-0314', messages: [] });",
      '}',
      '',
    ].join('\n'),
  );
  // Azure alias + a cast-masked live arg: two more classes, same ids.
  writeFileSync(
    join(dir, 'src', 'platform.ts'),
    [
      'type LLMID = string & { readonly __llmid: unique symbol };',
      "export const cfg = { deployment: 'gpt-4-0613' };",
      'export async function c(client: any) {',
      "  return client.chat.completions.create({ model: ('gpt-4-0613' as LLMID), messages: [] });",
      '}',
      '',
    ].join('\n'),
  );
  // THE STRESS CASE: the same id twice on ONE line, and two ids on one line.
  writeFileSync(
    join(dir, 'src', 'prices.ts'),
    [
      'export const PRICES: Record<string, number> = {',
      "  'gpt-4-0613': 0.03, 'gemini-2.0-flash': 0.01,",
      '};',
      "export const ALIASES = ['gpt-4-0613', 'gpt-4-0613'];",
      "export function isOld(m: string) { return m === 'gpt-4-0613'; }",
      '',
    ].join('\n'),
  );
  // Python: a sink-verified swap, an unverified replacement, an unproven
  // assignment, and a dict of data ids.
  writeFileSync(
    join(dir, 'sim', 'agent.py'),
    [
      'import openai',
      '',
      'def live(client):',
      '    return client.chat.completions.create(model="gpt-4-0613", messages=[])',
      '',
      'def blocked(client):',
      '    return client.chat.completions.create(model="gpt-4-0314", messages=[])',
      '',
      'def event():',
      '    model = "o1-preview"',
      '    print(model)',
      '',
      'PRICES = {"gpt-4-0613": 0.03, "gemini-2.0-flash": 0.01}',
      '',
    ].join('\n'),
  );
  // THE TWO-GPT-4 SHAPE, copied from the Splunk-Agent repo that started this:
  // `"gpt-4"` as a lookup-table KEY (Tier C, line 2) and `model = "gpt-4"` as
  // an unproven assignment (Tier B, line 7). Two different literals, and the
  // report was read twice as one literal counted twice.
  writeFileSync(
    join(dir, 'sim', 'simulator.py'),
    [
      'MODELS = {',
      '    "gpt-4": {"cost": 0.03},',
      '    "gemini-1.5-pro": {"cost": 0.01},',
      '}',
      '',
      'def emit_event():',
      '    model = "gpt-4"',
      '    print(model)',
      '',
    ].join('\n'),
  );
  return dir;
}

/**
 * The TIER a finding class terminates in. This mirrors cli.ts's split exactly
 * -- including the one case that is not obvious from the class name: the cast
 * guard's matches ride in the DATA stream but graduate to Tier B, because the
 * literal sits in a live-looking position and only the repo's own type stands
 * in the way.
 */
function tierOf(cls: string, reason?: string): Tier {
  if (cls.endsWith(':tierA')) return 'A';
  if (cls.endsWith(':data')) return reason === TYPE_CAST_REASON ? 'B' : 'C';
  return 'B';
}

/** Every finding the scanners produce, reduced to one comparable shape. */
async function allFindings(repo: string): Promise<
  {
    cls: string;
    tier: Tier;
    file: string;
    line: number;
    column: number;
    modelId: string;
  }[]
> {
  const registry = loadLlmRegistry();
  const prefilter = buildRegistryPrefilter(registry);
  const { project } = loadPrefilteredProject(repo, prefilter);
  const literals = findModelIdLiterals(project, registry);

  const pySources = readPythonSources(collectPythonFiles(repo));
  const py = await applyPyModelIdFixesToSources(pySources, registry, repo);

  const rows: {
    cls: string;
    tier: Tier;
    file: string;
    line: number;
    column: number;
    modelId: string;
  }[] = [];
  const push = (
    cls: string,
    items: {
      value: string;
      reason?: string;
      location: { file: string; line: number; column: number };
    }[],
  ): void => {
    for (const i of items) {
      rows.push({
        cls,
        tier: tierOf(cls, i.reason),
        file: i.location.file.replace(/\\/g, '/'),
        line: i.location.line,
        column: i.location.column,
        modelId: i.value,
      });
    }
  };

  // THE ENGINE GATE, called -- not re-implemented. This line used to read
  // the raw `verification.status` stamp, which is a SECOND copy of the Tier A
  // rule; the day the gate started refusing entries whose own reasons
  // contradict their stamp, the copy kept promoting them and the fixture
  // reported one occurrence in two tiers.
  push(
    'ts:tierA',
    literals.filter((m) => m.position === 'model_arg' && isVerified(m.deprecation)),
  );
  push('ts:blocked', toBlockedModelArgMatches(literals));
  push('ts:azure', toAzureDeploymentMatches(literals));
  push('ts:data', toModelIdDataMatches(literals));
  push('py:tierA', py.swapMatches);
  push('py:blocked', py.blockedMatches);
  push('py:azure', py.azureMatches);
  push('py:usageUnverified', py.usageUnverifiedMatches);
  push('py:data', py.dataMatches);
  return rows;
}

describe('finding uniqueness', () => {
  it('never reports one (file, line, column, modelId) twice across ANY finding class', async () => {
    const rows = await allFindings(makeRepo());
    // The fixture has to actually exercise the surfaces, or the assertion
    // below is vacuously true.
    expect(rows.length).toBeGreaterThan(8);
    expect(new Set(rows.map((r) => r.cls)).size).toBeGreaterThan(4);

    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const r of rows) {
      const key = findingKey(r);
      const previous = seen.get(key);
      if (previous) duplicates.push(`${key} in both ${previous} and ${r.cls}`);
      else seen.set(key, r.cls);
    }
    expect(duplicates).toEqual([]);
    expect(seen.size).toBe(rows.length);
  });

  it('keeps two ids on the SAME line distinct (the key is not file+line alone)', async () => {
    const rows = await allFindings(makeRepo());
    const sameLine = rows.filter((r) => r.file.endsWith('src/prices.ts') && r.line === 2);
    expect(sameLine.map((r) => r.modelId).sort()).toEqual(['gemini-2.0-flash', 'gpt-4-0613']);
    expect(new Set(sameLine.map(findingKey)).size).toBe(sameLine.length);
  });

  it('keeps the SAME id twice on one line distinct by column', async () => {
    const rows = await allFindings(makeRepo());
    const repeated = rows.filter(
      (r) => r.file.endsWith('src/prices.ts') && r.line === 4 && r.modelId === 'gpt-4-0613',
    );
    expect(repeated.length).toBe(2);
    expect(repeated[0].column).not.toBe(repeated[1].column);
  });
});

// --- CROSS-TIER DISJOINTNESS ----------------------------------------------
//
// Uniqueness within a finding class was never the whole property. What the
// report actually claims -- when it prints three tier counts and then a note
// saying two same-named findings are "different occurrences" -- is that each
// occurrence has exactly ONE terminal tier, resolved A > B > C. If a single
// (file, line, column, id) could reach two tiers, the counts really would
// double-count it and the note would be a lie dressed as an explanation.
//
// So the property is asserted on the same real fixture, tier-tagged.
describe('one occurrence, one terminal tier', () => {
  it('never lets one (file, line, column, modelId) reach two tiers', async () => {
    const rows = await allFindings(makeRepo());
    // The fixture must actually populate all three tiers, or this passes for
    // the wrong reason.
    const tiers = new Set(rows.map((r) => r.tier));
    expect([...tiers].sort()).toEqual([...TIER_PRECEDENCE]);
    expect(crossTierCollisions(rows)).toEqual([]);
  });

  // THE SHAPE THAT WAS MISREAD, asserted on real scanner output rather than a
  // hand-built pair: one `gpt-4` as a dict key, one `gpt-4` in an assignment,
  // in one file, in two tiers -- and NOT one occurrence counted twice.
  it('classifies the two gpt-4 literals in simulator.py as two occurrences in two tiers', async () => {
    const rows = await allFindings(makeRepo());
    const gpt4 = rows
      .filter((r) => r.file.endsWith('sim/simulator.py') && r.modelId === 'gpt-4')
      .sort((a, b) => a.line - b.line);

    expect(gpt4.length).toBe(2);
    // The lookup-table key is informational; the assignment is review-required.
    expect(gpt4[0].line).toBe(2);
    expect(gpt4[0].tier).toBe('C');
    expect(gpt4[1].line).toBe(7);
    expect(gpt4[1].tier).toBe('B');
    // Two DIFFERENT literals: different positions, therefore different keys.
    expect(findingKey(gpt4[0])).not.toBe(findingKey(gpt4[1]));
    expect(crossTierCollisions(gpt4)).toEqual([]);

    // ...and this is exactly the case the report explains out loud.
    const notes = multiTierNotes(rows.filter((r) => r.modelId === 'gpt-4'));
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('these are different occurrences');
    expect(notes[0]).toContain('tier B: L7');
    expect(notes[0]).toContain('tier C: L2');
  });

  it('says nothing about an id that only ever lands in one tier', async () => {
    const rows = await allFindings(makeRepo());
    const single = rows.filter((r) => r.modelId === 'gemini-1.5-pro');
    expect(single.length).toBeGreaterThan(0);
    expect(new Set(single.map((r) => r.tier)).size).toBe(1);
    expect(multiTierNotes(single)).toEqual([]);
  });
});
