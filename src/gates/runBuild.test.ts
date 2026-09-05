import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { detectBuildCommand, runRepoBuild } from './runBuild.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function repo(pkg: object | null, withNodeModules = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-build-'));
  dirs.push(dir);
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  if (withNodeModules) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.keep'), '');
  }
  return dir;
}

describe('detectBuildCommand', () => {
  it('finds npm run build only when a build script exists', () => {
    expect(detectBuildCommand(repo({ scripts: { build: 'tsc' } }))?.label).toBe('npm run build');
    expect(detectBuildCommand(repo({ scripts: { test: 'vitest' } }))).toBeNull();
    expect(detectBuildCommand(repo(null))).toBeNull();
  });
});

describe('runRepoBuild', () => {
  it('is not-configured when the repo declares no build', async () => {
    const r = await runRepoBuild(repo({ name: 't' }, true), []);
    expect(r.status).toBe('not-configured');
  });

  it('is inconclusive when there are no installed dependencies to link', async () => {
    const r = await runRepoBuild(repo({ scripts: { build: 'node -e "process.exit(0)"' } }, false), []);
    expect(r.status).toBe('inconclusive');
    expect(r.output).toContain('node_modules');
  });

  it('passes when the build succeeds with the migration applied', async () => {
    const dir = repo({ scripts: { build: 'node -e "process.exit(0)"' } }, true);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    const r = await runRepoBuild(dir, [{ absPath: join(dir, 'a.ts'), newText: 'export const x = 2;\n' }]);
    expect(r.status).toBe('pass');
  }, 120_000);

  it('is inconclusive (not fail) when the repo did not build even BEFORE the change', async () => {
    // Baseline build fails, so a failure cannot be attributed to the migration.
    const dir = repo({ scripts: { build: 'node -e "process.exit(1)"' } }, true);
    const r = await runRepoBuild(dir, []);
    expect(r.status).toBe('inconclusive');
    expect(r.output).toContain('did not build BEFORE');
  }, 120_000);
});
