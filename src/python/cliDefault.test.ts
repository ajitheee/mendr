import { beforeAll, describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { Project } from 'ts-morph';
import { findPyModelIdLiterals, PY_CLI_DEFAULT_REASON } from './scanPy.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { TS_CLI_DEFAULT_REASON } from '../usage/tsSurface.js';

// A COMMAND-LINE DEFAULT IS A SELECTOR.
//
// Found on going-doer/Paper2Code (2026-09-16), a 4,954-star repository whose documented
// Quick Start is `bash run.sh` and whose README evaluation commands take no --gpt_version
// flag. Every one of those paths runs `o3-mini`, which OpenAI retires 2026-10-23. The audit
// said NO EXPOSURE IN COMPLETED SURFACES.
//
// Two rules had to miss it independently. `modelNamedAssignmentTarget` looks for a model-named
// ASSIGNMENT TARGET, and `parser.add_argument(...)` is a bare call statement with none. And
// `isModelLikeName` is /model/i, which `--gpt_version` does not satisfy. So the literal fell
// through to `{ position: 'data', purpose: 'generic' }` — the same bucket as a docstring.
//
// A wrong "clean" is the one answer this scanner must never give, which is what makes this
// worse than a missed finding.

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'o3-mini', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
];

async function scan(text: string, path = 'main.py') {
  const matches = await findPyModelIdLiterals([{ path, text }], REG);
  return matches.map((m) => ({
    value: m.value,
    position: m.position,
    reason: m.reason,
    tier: classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason }).tier,
  }));
}

beforeAll(async () => {
  await findPyModelIdLiterals([{ path: 'warm.py', text: 'x = 1\n' }], REG);
});

describe('argparse defaults', () => {
  it('the Paper2Code line is a review candidate, not documentation', async () => {
    const out = await scan("parser.add_argument('--gpt_version', type=str, default=\"o3-mini\")\n");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ position: 'usage_unverified', reason: PY_CLI_DEFAULT_REASON, tier: 'B' });
  });

  // The flag name is not the signal and must not be: the whole defect was that
  // `--gpt_version` reads as unrelated to a model while naming exactly one.
  it('fires whatever the flag is called', async () => {
    for (const flag of ['--gpt_version', '--engine', '--llm', '-m']) {
      const out = await scan(`parser.add_argument('${flag}', type=str, default="o3-mini")\n`);
      expect(out[0], flag).toMatchObject({ position: 'usage_unverified', tier: 'B' });
    }
  });

  it('works inside a function as well as at module level', async () => {
    const out = await scan(
      'def build():\n    p = argparse.ArgumentParser()\n    p.add_argument("--m", default="o3-mini")\n    return p\n',
    );
    expect(out[0]).toMatchObject({ position: 'usage_unverified', tier: 'B' });
  });

  it('covers click and typer option declarations too', async () => {
    for (const src of [
      '@click.option("--model", default="o3-mini")\ndef run():\n    pass\n',
      'def run(model: str = typer.Option(default="o3-mini")):\n    pass\n',
    ]) {
      expect((await scan(src))[0]).toMatchObject({ position: 'usage_unverified', tier: 'B' });
    }
  });
});

describe('what it must NOT swallow', () => {
  // `choices` is a catalog of permitted values, and rewriting one silently changes
  // what the program accepts. Only `default=` names the id that actually runs.
  it('choices stay informational', async () => {
    const out = await scan("parser.add_argument('--model', choices=[\"o3-mini\", \"gpt-4\"])\n");
    for (const o of out) expect(o.tier).toBe('C');
  });

  it('help text is not a selector', async () => {
    const out = await scan("parser.add_argument('--model', help=\"defaults to o3-mini\")\n");
    for (const o of out) expect(o.tier).toBe('C');
  });

  // The rule must not make a CLI default patch-eligible. The path from `args.x` to a
  // provider request is never traced, so a swap here is a guess, and the Tier A bar is
  // a first-party SDK call with the client resolvable in the same file.
  it('is never swap-eligible, only review', async () => {
    const out = await scan("parser.add_argument('--model', default=\"o3-mini\")\n");
    expect(out[0]!.tier).toBe('B');
    expect(out[0]!.tier).not.toBe('A');
  });

  // The neighbouring rule still owns its own case; adding this one must not shadow it.
  it('leaves the model-named field default to the field rule', async () => {
    const out = await scan('model_name: str = Field(default="gpt-4")\n');
    expect(out[0]).toMatchObject({ position: 'usage_unverified', tier: 'B' });
    expect(out[0]!.reason).not.toBe(PY_CLI_DEFAULT_REASON);
  });

  it('an unrelated default on an unrelated call is untouched', async () => {
    const out = await scan('register(name="x", default="o3-mini")\n');
    for (const o of out) expect(o.tier).toBe('C');
  });
});

// THE SAME DEFECT IN TYPESCRIPT.
//
// tsSurface already had `isCliModelOptionDefault` for commander's positional default
// (`program.option('-m, --model <model>', 'Model ID', 'dall-e-3')`), and it was gated on the
// FLAG NAME matching /model/i — the identical mistake Python made with isModelLikeName. It
// also knew nothing of the yargs spelling, where the default is a `default:` property of an
// options object rather than a positional argument.
//
// Verified before the fix: `yargs.option('gptVersion', { default: 'o3-mini' })` feeding
// `model: argv.gptVersion` audited as NO EXPOSURE IN COMPLETED SURFACES.

function tsScan(source: string, value = 'o3-mini') {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile('cli.ts', source);
  const m = findModelIdLiterals(project, REG).find((x) => x.value === value);
  if (!m) return undefined;
  return {
    position: m.position,
    reason: m.reason,
    tier: classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason }).tier,
  };
}

describe('typescript CLI defaults', () => {
  it('the yargs options-object default is a review candidate', () => {
    expect(tsScan("yargs(process.argv).option('gptVersion', { type: 'string', default: 'o3-mini' });")).toMatchObject({
      position: 'usage_unverified',
      reason: TS_CLI_DEFAULT_REASON,
      tier: 'B',
    });
  });

  // The gate that hid the defect: a flag naming a model without the word "model" in it.
  it('the commander positional default no longer needs a model-named flag', () => {
    expect(tsScan("program.option('--gpt-version <v>', 'which model', 'o3-mini');")).toMatchObject({
      position: 'usage_unverified',
      tier: 'B',
    });
  });

  it('still fires for the flag names it always caught', () => {
    expect(tsScan("program.option('-m, --model <model>', 'Model ID', 'o3-mini');")).toMatchObject({ tier: 'B' });
  });

  it('never becomes swap-eligible', () => {
    expect(tsScan("yargs.option('m', { default: 'o3-mini' });")!.tier).not.toBe('A');
  });

  // The flag SPEC itself is the option's name, not its default value.
  it('does not treat the flag spec as a default', () => {
    const out = tsScan("program.option('--o3-mini', 'enable it');");
    if (out) expect(out.tier).toBe('C');
  });

  it('a plain catalog object is untouched', () => {
    const out = tsScan("const MODELS = [{ id: 'o3-mini', label: 'O3 Mini' }];");
    if (out) expect(out.tier).toBe('C');
  });
});
