import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// check-pins.mjs had no test at all, which is its own small joke: the script
// that exists because a stale pin looks exactly like a fresh one was itself
// unguarded. These run it as CI runs it — as a process, from the repo root,
// with no dependencies — and read its exit code and output.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-pins.mjs');

function run(): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('check-pins', () => {
  it('passes on the current tree', () => {
    const { code, out } = run();
    expect(out).toContain('check-pins: OK');
    expect(code).toBe(0);
  });

  const version = (): string => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;

  it('anchors every release pin on the version in package.json', () => {
    // The anchor matters: RC's SHA cannot be it, because the release commit's
    // SHA does not exist until the commit is made — yet every tag pin has to be
    // correct INSIDE that commit. `version` is the field the release bumps
    // first, which makes a self-referencing pin correct by construction.
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
    expect(run().out).toContain(`release pins are v${version}`);
  });

  it('reads the two refs that actually decide which action a customer runs', () => {
    // These were on no checklist, and they are the ones that matter:
    // reusable-migrate.yml hardcodes the action ref because GitHub forbids an
    // expression in `uses:`, so they decide everything.
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('.github/workflows/reusable-migrate.yml');
    expect(script).toContain('mendr-action/action.yml');
    expect(script).toContain('app/src/config.ts');
    expect(script).toContain('src/watch/installWorkflow.ts');
  });

  it('fails loudly when a guarded position disappears rather than going quietly green', () => {
    // The failure mode that let `render.yaml` stay on the runbook's bump list
    // for several releases after it stopped carrying a pin at all: a check that
    // finds nothing to check reports success.
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toMatch(/found\.length === 0/);
    expect(script).toMatch(/the position moved or was removed/);
  });

  it('carries the delivery-staleness rule, and does not cry wolf when nothing is undelivered', () => {
    // Rule 3. On main between releases, unreleased work is expected, so this is
    // advisory — it prints rather than exiting non-zero, because a consistency
    // check alone is green while a security fix reaches nobody.
    //
    // THIS TEST USED TO ASSERT THE NOTE WAS ALWAYS PRESENT. It was written the day
    // four commits sat undelivered, so it pinned that moment rather than the rule,
    // and it went red the moment the release it was written for actually shipped —
    // failing on the good state. A guard that only passes while something is broken
    // is not a guard.
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('DELIVERY_PATHS');
    expect(script).toMatch(/mendr-action\//);

    const { code, out } = run();
    expect(code).toBe(0);
    const undelivered = execFileSync('git', ['log', '--oneline', `v${version()}..HEAD`, '--', 'mendr-action/', 'src/cli.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (undelivered) {
      expect(out).toMatch(/NOTE — \d+ commit\(s\) touch/);
    } else {
      // Nothing is undelivered, so there must be no warning to read past.
      expect(out).not.toMatch(/commit\(s\) touch/);
    }
  });
});
