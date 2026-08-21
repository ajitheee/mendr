import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// END-TO-END wiring for the THREE-TIER report. The tier a finding lands in,
// the number printed for that tier, and the items listed under it are computed
// in different places; only running the real CLI proves they agree. The
// fixture deliberately holds one of EVERY surface at once, because the failure
// mode being guarded against is a report that is self-consistent for a repo
// with one finding and wrong for a repo with five.
//
// Hermetic: a temp-dir fixture, `--skip-gates` (no type-check, no test run, no
// network), and the CLI run from source through tsx — the same entry point
// `mendr` ships.

const MENDR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/**
 * A repo carrying one finding of every class mendr can produce:
 *   - `gpt-4-0613` in a live model arg  -> Tier A (registry-verified swap)
 *   - `gpt-4-0314` in a live model arg  -> Tier B replacement_unverified
 *   - a value under an azure `deployment` key -> Tier B platform_blocked
 *   - a live model arg behind an `as` cast    -> Tier B type_cast_masked
 *   - a python assignment with no sink        -> Tier B usage_unverified
 *   - two ids in a pricing table              -> Tier C informational
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-tiers-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tiers-fixture' }, null, 2));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'sim'));
  writeFileSync(
    join(dir, 'src', 'live.ts'),
    [
      'export async function verifiedCall(client: any) {',
      "  return client.chat.completions.create({ model: 'gpt-4-0613', messages: [] });",
      '}',
      'export async function unverifiedCall(client: any) {',
      "  return client.chat.completions.create({ model: 'gpt-4-0314', messages: [] });",
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'src', 'azure.ts'), "export const cfg = { deployment: 'gpt-4-0613' };\n");
  writeFileSync(
    join(dir, 'src', 'cast.ts'),
    [
      'type LLMID = string & { readonly __llmid: unique symbol };',
      'export async function castCall(client: any) {',
      "  return client.chat.completions.create({ model: ('gpt-4-0613' as LLMID), messages: [] });",
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'src', 'prices.ts'),
    [
      'export const PRICES: Record<string, number> = {',
      "  'gpt-4-0613': 0.03,",
      "  'gemini-2.0-flash': 0.01,",
      '};',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'sim', 'simulator.py'),
    ['def emit_event():', '    model = "gpt-4-0314"', '    print(model)', ''].join('\n'),
  );
  return dir;
}

/** Run fix-llm from source. `reject: false` — a non-zero exit is data here. */
async function runFixLlm(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa('tsx', ['src/cli.ts', 'fix-llm', ...args], {
    cwd: MENDR_ROOT,
    preferLocal: true,
    reject: false,
  });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

interface JsonReport {
  summary: Record<string, number | string>;
  tierA: unknown[];
  tierB: { file: string; line: number; column: number; modelId: string; reason: string }[];
  blocked: { file: string; line: number }[];
  azure: { file: string; line: number }[];
  informational: { file: string; count: number }[];
  usageUnverified: { file: string; line: number }[];
}

describe('fix-llm three-tier report', () => {
  it('maps every finding class onto its documented Tier B reason code', async () => {
    const repo = makeRepo();
    const { stdout } = await runFixLlm([repo, '--skip-gates', '--json']);
    const report = JSON.parse(stdout) as JsonReport;

    const byReason = new Map(report.tierB.map((f) => [f.reason, f]));
    expect([...byReason.keys()].sort()).toEqual([
      'platform_blocked',
      'replacement_unverified',
      'type_cast_masked',
      'usage_unverified',
    ]);
    expect(byReason.get('replacement_unverified')!.file).toBe('src/live.ts');
    expect(byReason.get('replacement_unverified')!.modelId).toBe('gpt-4-0314');
    expect(byReason.get('platform_blocked')!.file).toBe('src/azure.ts');
    expect(byReason.get('type_cast_masked')!.file).toBe('src/cast.ts');
    expect(byReason.get('usage_unverified')!.file).toBe('sim/simulator.py');

    // Every Tier B finding ships BOTH forms of its reason and a location.
    for (const f of report.tierB) {
      expect(Object.keys(f).sort()).toEqual([
        'column',
        'file',
        'line',
        'modelId',
        'reason',
        'reasonText',
        'replacement',
      ]);
    }
  }, 120_000);

  it('never generates a patch for a Tier B finding', async () => {
    const repo = makeRepo();
    const { stdout } = await runFixLlm([repo, '--skip-gates', '--json']);
    const report = JSON.parse(stdout) as JsonReport & { diff: string };
    expect(report.diff).toContain('gpt-5.6-sol');

    // Files whose ONLY findings are Tier B are absent from the diff entirely.
    // (src/live.ts is excluded on purpose: it holds a Tier A swap AND a Tier B
    // finding, and the point is that only the Tier A line changed.)
    for (const file of ['src/azure.ts', 'src/cast.ts', 'sim/simulator.py']) {
      expect(report.diff, file).not.toContain(file);
    }
    // And no line is REMOVED that carries the unverified id — the patch never
    // touches the position the gate refused to trust.
    const removed = report.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    expect(removed.some((l) => l.includes('gpt-4-0314'))).toBe(false);
  }, 120_000);

  it('keeps the deprecated JSON keys, DERIVED from the tier data (no drift)', async () => {
    const repo = makeRepo();
    const { stdout } = await runFixLlm([repo, '--skip-gates', '--json']);
    const report = JSON.parse(stdout) as JsonReport;

    expect(report.summary.tierB).toBe(report.tierB.length);
    expect(report.summary.blocked).toBe(
      report.tierB.filter((f) => f.reason === 'replacement_unverified').length,
    );
    expect(report.summary.usageUnverified).toBe(
      report.tierB.filter((f) => f.reason === 'usage_unverified').length,
    );
    expect(report.summary.informational).toBe(report.summary.tierC);
    // The legacy ARRAYS are projections of tierB, so their rows line up too.
    expect(report.blocked.map((b) => `${b.file}:${b.line}`)).toEqual(
      report.tierB
        .filter((f) => f.reason === 'replacement_unverified')
        .map((f) => `${f.file}:${f.line}`),
    );
    expect(report.azure.map((a) => `${a.file}:${a.line}`)).toEqual(
      report.tierB.filter((f) => f.reason === 'platform_blocked').map((f) => `${f.file}:${f.line}`),
    );
    expect(report.usageUnverified.map((u) => `${u.file}:${u.line}`)).toEqual(
      report.tierB.filter((f) => f.reason === 'usage_unverified').map((f) => `${f.file}:${f.line}`),
    );
    // Tier C's grouped view sums back to the tier count.
    expect(report.informational.reduce((n, g) => n + g.count, 0)).toBe(report.summary.tierC);
  }, 120_000);

  // THE INVARIANT the reviewer asked to be verified by test: the number
  // printed for a tier equals the number of items listed under it, in the
  // counts line AND in the Summary.
  it('prints counts that equal the items listed under each tier', async () => {
    const repo = makeRepo();
    const { stdout } = await runFixLlm([repo, '--skip-gates', '--verbose']);
    const lines = stdout.split('\n');

    const found = stdout.match(
      /Found: (\d+) tier A[\s\S]*?(\d+) tier B[\s\S]*?(\d+) tier C/,
    );
    expect(found, 'the Found block must print all three tiers').toBeTruthy();
    const [, foundA, foundB, foundC] = found!.map(Number);

    const summary = stdout.match(/Summary: tier A (\d+)[\s\S]*?tier B (\d+)[\s\S]*?tier C (\d+)/);
    expect(summary, 'the Summary block must print all three tiers').toBeTruthy();
    const [, sumA, sumB, sumC] = summary!.map(Number);

    // (1) the two blocks agree with each other
    expect([sumA, sumB, sumC]).toEqual([foundA, foundB, foundC]);

    // (2) Tier B: one "action:" row per listed finding
    const listedB = lines.filter((l) => l.startsWith('  action:')).length;
    expect(listedB).toBe(foundB);

    // (3) Tier C: --verbose lists every hit, one line each
    const tierCStart = lines.findIndex((l) => l.startsWith('=== Tier C:'));
    expect(tierCStart).toBeGreaterThan(-1);
    const listedC = lines
      .slice(tierCStart + 1)
      .filter((l) => l.startsWith('  deprecated model id ')).length;
    expect(listedC).toBe(foundC);
    // The Tier C heading repeats the same number a third time.
    expect(lines[tierCStart]).toContain(`(${foundC} hit`);

    // (4) Tier A: the section's own breakdown counts the swaps in the diff
    expect(stdout).toMatch(new RegExp(`Tier A: ${foundA} model-id swap`));
    expect(sumA).toBe(foundA);
  }, 120_000);

  // A READ-ONLY run is the default, and it changes nothing on disk. The
  // Summary used to print "1 auto-fixed" a few lines above "To apply: re-run
  // with --write" — a claim about a file that was never touched.
  it('does not claim a fix was applied when nothing was written', async () => {
    const repo = makeRepo();
    const { stdout } = await runFixLlm([repo, '--skip-gates']);
    expect(stdout).toContain('Summary: tier A 1 (0 auto-fixed, 1 ready to apply -- not written)');
    expect(stdout).not.toContain('1 auto-fixed');
    // The fixture's Tier A file is genuinely unchanged on disk.
    expect(readFileSync(join(repo, 'src', 'live.ts'), 'utf8')).toContain("'gpt-4-0613'");
  }, 120_000);

  it('orders the sections A, then B, then C', async () => {
    const repo = makeRepo();
    const { stdout } = await runFixLlm([repo, '--skip-gates']);
    const a = stdout.indexOf('=== Tier A:');
    const b = stdout.indexOf('=== Tier B: review required ===');
    const c = stdout.indexOf('=== Tier C:');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  }, 120_000);

  it('prints every Tier B finding with location, ids, both reason forms and no-patch', async () => {
    const repo = makeRepo();
    const { stdout } = await runFixLlm([repo, '--skip-gates']);
    expect(stdout).toContain('sim/simulator.py:2:13');
    expect(stdout).toContain('  found:       "gpt-4-0314"');
    expect(stdout).toContain('  replacement: "gpt-5.6-sol"');
    expect(stdout).toContain('  reason:      usage_unverified -- assigned to a model-like variable');
    expect(stdout).toContain('  action:      no patch generated.');
  }, 120_000);
});

describe('a Tier A candidate that fails its gates', () => {
  /** The Tier A fixture, plus an eval command that always fails. */
  function makeFailingRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-tiers-fail-'));
    created.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fail-fixture' }, null, 2));
    writeFileSync(join(dir, 'mendr.config.json'), JSON.stringify({ evalCommand: 'node eval.js' }));
    writeFileSync(join(dir, 'eval.js'), 'process.exit(1);\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src', 'chat.ts'),
      [
        'export async function chat(client: any) {',
        "  return client.chat.completions.create({ model: 'gpt-4-0613', messages: [] });",
        '}',
        '',
      ].join('\n'),
    );
    return dir;
  }

  it('stays a Tier A candidate in the count and reports its disposition', async () => {
    const { stdout } = await runFixLlm([makeFailingRepo()]);
    // It is NOT reclassified as Tier C — Tier C means an informational data
    // occurrence, and a reader counting Tier C findings would never find it.
    expect(stdout).toContain('=== Tier A candidate -> NOT APPLIED (gates failed, review only) ===');
    expect(stdout).toContain('Summary: tier A 1 (0 auto-fixed, 1 downgraded -- gates failed, not applied)');
    expect(stdout).toContain('tier C 0 (informational -- no action)');
  }, 120_000);
});

describe('fix-llm --fail-on', () => {
  it('gates on tierB', async () => {
    const repo = makeRepo();
    const { exitCode } = await runFixLlm([repo, '--skip-gates', '--fail-on', 'tierB']);
    expect(exitCode).toBe(1);
  }, 120_000);

  it('accepts "blocked" as a deprecated alias for tierB, and says so on stderr', async () => {
    const repo = makeRepo();
    const { exitCode, stderr } = await runFixLlm([repo, '--skip-gates', '--fail-on', 'blocked']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--fail-on blocked is deprecated');
    expect(stderr).toContain('--fail-on tierB');
  }, 120_000);

  it('rejects an unknown class, naming the accepted ones', async () => {
    const repo = makeRepo();
    const { exitCode, stderr } = await runFixLlm([repo, '--skip-gates', '--fail-on', 'tierZ']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('expected tierA, tierB, or none');
  }, 120_000);
});

describe('the registry footer', () => {
  it('separates the catalog recheck from the per-entry verdicts', async () => {
    const repo = makeRepo();
    const { stdout } = await runFixLlm([repo, '--skip-gates']);
    expect(stdout).toMatch(/registry: \d+ active entries/);
    expect(stdout).toMatch(/catalog recheck: \d{4}-\d{2}-\d{2}/);
    expect(stdout).toMatch(/entry verification: \d+ verified.*mendr evidence <id>/);
    // The blanket claim is gone.
    expect(stdout).not.toMatch(/registry: \d+ entries, verified/);
  }, 120_000);
});
