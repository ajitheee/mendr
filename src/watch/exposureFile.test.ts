import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { foldExposure, type ExposedModel, type ExposureMatch } from './exposure.js';
import {
  EXPOSURE_SCHEMA,
  exposureFilePath,
  readExposureFile,
  serializeExposure,
  writeExposureFile,
} from './exposureFile.js';

function models(): ExposedModel[] {
  const m: ExposureMatch = {
    value: 'gpt-4-0314',
    entry: {
      provider: 'openai',
      kind: 'model_id',
      deprecated: 'gpt-4-0314',
      replacement: 'gpt-4.1',
      shutdownDate: '2026-10-23',
      status: 'deprecated',
    },
    file: 'src/app.ts',
    line: 3,
    position: 'model_arg',
  };
  return foldExposure([m]);
}

const REGV = 'sha256:testregistry01';

describe('serializeExposure', () => {
  it('is deterministic and tagged with schema + registry version', () => {
    const a = serializeExposure(models(), REGV);
    const b = serializeExposure(models(), REGV);
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(JSON.parse(a).schema).toBe(EXPOSURE_SCHEMA);
    expect(JSON.parse(a).registryVersion).toBe(REGV);
  });
});

describe('writeExposureFile', () => {
  it('writes on first run and reports the change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-expfile-'));
    const result = writeExposureFile(dir, models(), REGV);
    expect(result.changed).toBe(true);
    expect(result.path).toBe(exposureFilePath(dir));
    const parsed = readExposureFile(dir);
    expect(parsed?.models[0].id).toBe('gpt-4-0314');
  });

  it('is churn-free: an unchanged repo leaves the file byte-identical and untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-expfile-churn-'));
    const first = writeExposureFile(dir, models(), REGV);
    expect(first.changed).toBe(true);
    const before = readFileSync(first.path, 'utf8');
    const mtimeBefore = statSync(first.path).mtimeMs;

    const second = writeExposureFile(dir, models(), REGV);
    expect(second.changed).toBe(false);
    expect(readFileSync(first.path, 'utf8')).toBe(before);
    // Not rewritten, so the mtime is unchanged.
    expect(statSync(first.path).mtimeMs).toBe(mtimeBefore);
  });

  it('rewrites when the registry version changes even if exposure is identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-expfile-regv-'));
    expect(writeExposureFile(dir, models(), REGV).changed).toBe(true);
    expect(writeExposureFile(dir, models(), REGV).changed).toBe(false);
    // A registry update is a meaningful diff, not churn.
    expect(writeExposureFile(dir, models(), 'sha256:testregistry02').changed).toBe(true);
  });

  it('rewrites when the exposure actually changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-expfile-change-'));
    writeExposureFile(dir, models(), REGV);
    const changed = writeExposureFile(dir, [], REGV); // exposure cleared
    expect(changed.changed).toBe(true);
    expect(readExposureFile(dir)?.models).toHaveLength(0);
  });

  it('treats a malformed existing file as absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-expfile-bad-'));
    const path = exposureFilePath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ this is not json');
    expect(readExposureFile(dir)).toBeUndefined();
  });
});
