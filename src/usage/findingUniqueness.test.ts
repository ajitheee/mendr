import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findingKey } from '../report/tiers.js';
import { collectPythonFiles, readPythonSources } from '../python/scanPy.js';
import { applyPyModelIdFixesToSources } from '../python/fixPy.js';
import { loadLlmRegistry } from './llmRegistry.js';
import { buildRegistryPrefilter, loadPrefilteredProject } from './scanRepo.js';
import {
  findModelIdLiterals,
  toAzureDeploymentMatches,
  toBlockedModelArgMatches,
  toModelIdDataMatches,
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
  return dir;
}

/** Every finding the scanners produce, reduced to one comparable shape. */
async function allFindings(
  repo: string,
): Promise<{ cls: string; file: string; line: number; column: number; modelId: string }[]> {
  const registry = loadLlmRegistry();
  const prefilter = buildRegistryPrefilter(registry);
  const { project } = loadPrefilteredProject(repo, prefilter);
  const literals = findModelIdLiterals(project, registry);

  const pySources = readPythonSources(collectPythonFiles(repo));
  const py = await applyPyModelIdFixesToSources(pySources, registry, repo);

  const rows: { cls: string; file: string; line: number; column: number; modelId: string }[] = [];
  const push = (
    cls: string,
    items: { value: string; location: { file: string; line: number; column: number } }[],
  ): void => {
    for (const i of items) {
      rows.push({
        cls,
        file: i.location.file.replace(/\\/g, '/'),
        line: i.location.line,
        column: i.location.column,
        modelId: i.value,
      });
    }
  };

  push(
    'ts:tierA',
    literals.filter((m) => m.position === 'model_arg' && m.deprecation.verification?.status === 'verified'),
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
