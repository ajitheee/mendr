import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRepoEval } from './runEval.js';

// Hermetic tests for the eval gate. Each builds a throwaway "repo" in the OS
// temp dir whose eval command is a plain `node eval.js` script — no network, no
// installed dependencies, and (deliberately) no node_modules, which is also the
// case that proves the eval gate does not require one.

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

/** Throwaway repo dir holding an `eval.js` with the supplied body. */
function makeRepo(evalScript: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-eval-test-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'eval-fixture' }, null, 2));
  writeFileSync(join(dir, 'eval.js'), evalScript);
  return dir;
}

describe('runRepoEval (the behavioral gate)', () => {
  it('is not-configured when no command was supplied -- never a silent pass', async () => {
    const repo = makeRepo('process.exit(0)');
    expect(await runRepoEval(repo, [], {})).toEqual({ status: 'not-configured' });
    // A blank/whitespace command is the same fact, not an empty shell line.
    expect(await runRepoEval(repo, [], { command: '   ' })).toEqual({ status: 'not-configured' });
  });

  it('passes when the configured command exits 0, echoing the command and code', async () => {
    const repo = makeRepo('console.log("eval ok"); process.exit(0)');
    const result = await runRepoEval(repo, [], { command: 'node eval.js' });
    expect(result.status).toBe('pass');
    expect(result.command).toBe('node eval.js');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('eval ok');
  });

  it('fails when the configured command exits non-zero', async () => {
    const repo = makeRepo('console.log("quality regressed"); process.exit(3)');
    const result = await runRepoEval(repo, [], { command: 'node eval.js' });
    expect(result.status).toBe('fail');
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('quality regressed');
  });

  it('runs against the PATCHED copy, not the working tree', async () => {
    // The eval asserts the model id in model.js is the REPLACEMENT. That text
    // exists only in the overlay, so a pass proves the patch reached the
    // sandbox — and the untouched original proves the tree was not mutated.
    const repo = makeRepo(
      'const t = require("fs").readFileSync("model.js", "utf8");' +
        'process.exit(t.includes("gpt-5.6-sol") ? 0 : 1)',
    );
    const modelPath = join(repo, 'model.js');
    writeFileSync(modelPath, 'module.exports = "gpt-4-0613";\n');

    const result = await runRepoEval(repo, [{ absPath: modelPath, newText: 'module.exports = "gpt-5.6-sol";\n' }], {
      command: 'node eval.js',
    });
    expect(result.status).toBe('pass');
    expect(readFileSync(modelPath, 'utf8')).toContain('gpt-4-0613');
  });

  it('patches a READ-ONLY source file instead of losing the whole gate', async () => {
    // REGRESSION: cpSync preserves the read-only bit, so the overlay write in
    // the sandbox threw EPERM and the gate came back `inconclusive` -- i.e. a
    // user with one read-only file in their tree silently got no eval at all.
    // One read-only file in a repo is ordinary (unzipped source, some VCS
    // checkouts), so the gate must patch over it in the throwaway copy.
    const repo = makeRepo(
      'const t = require("fs").readFileSync("model.js", "utf8");' +
        'process.exit(t.includes("gpt-5.6-sol") ? 0 : 1)',
    );
    const modelPath = join(repo, 'model.js');
    writeFileSync(modelPath, 'module.exports = "gpt-4-0613";\n');
    chmodSync(modelPath, 0o444); // read-only on POSIX; sets FILE_ATTRIBUTE_READONLY on Windows

    const result = await runRepoEval(
      repo,
      [{ absPath: modelPath, newText: 'module.exports = "gpt-5.6-sol";\n' }],
      { command: 'node eval.js' },
    );
    expect(result.status).toBe('pass');
    // Still never mutated: the read-only original is exactly as it was.
    expect(readFileSync(modelPath, 'utf8')).toContain('gpt-4-0613');

    chmodSync(modelPath, 0o666); // so afterEach can remove the fixture
  });

  it('is inconclusive (never fail) when the command times out', { timeout: 30_000 }, async () => {
    // A cut-off eval proves nothing. Reporting it as `fail` would block a good
    // fix on a slow machine; reporting it as `pass` would claim a run that
    // never finished. The message must point at the knob that fixes it.
    const repo = makeRepo('setTimeout(() => process.exit(0), 60000)');
    const result = await runRepoEval(repo, [], { command: 'node eval.js', timeoutMs: 750 });
    expect(result.status).toBe('inconclusive');
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toMatch(/timed out after 750ms/);
    expect(result.output).toMatch(/evalTimeoutMs/);
  });

  it('is inconclusive when the repo path does not exist (infra, not a verdict)', async () => {
    const missing = join(tmpdir(), 'mendr-eval-test-does-not-exist-12345');
    const result = await runRepoEval(missing, [], { command: 'node eval.js' });
    expect(result.status).toBe('inconclusive');
    expect(result.output).toMatch(/eval gate infra error/);
  });

  it('runs a shell command line, not a bare argv (npm-style commands work)', async () => {
    const repo = makeRepo('process.exit(process.argv[2] === "--strict" ? 0 : 1)');
    const result = await runRepoEval(repo, [], { command: 'node eval.js --strict' });
    expect(result.status).toBe('pass');
  });
});
