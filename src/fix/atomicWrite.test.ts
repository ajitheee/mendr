import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeAllOrNothing, type PendingWrite } from './atomicWrite.js';

// THE --write SAFETY GATE, exercised against a REAL filesystem. Nothing here is
// mocked: a half-written repo is a filesystem outcome, so the proof has to be a
// filesystem one. Every test asserts BOTH halves of the contract — the files
// that should have changed, and (just as important) that nothing else did and
// that no `.mendr-tmp` litter survives.

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'mendr-atomic-'));
});

afterEach(() => {
  // The read-only target from the permission test would block teardown on
  // Windows, so restore write permission on every entry before removing.
  try {
    for (const entry of readdirSync(repo, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        chmodSync(join(repo, entry.name), 0o666);
      } catch {
        /* already writable */
      }
    }
  } catch {
    /* already gone */
  }
  rmSync(repo, { recursive: true, force: true });
});

/** Create a file holding `original` and return the PendingWrite that patches it. */
function seed(name: string, original: string, patched: string): PendingWrite {
  const absPath = join(repo, name);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, original);
  return { absPath, newText: patched, originalText: original };
}

/** Every `.mendr-tmp` FILE anywhere under the temp repo (must always be zero). */
function strayTempFiles(dir = repo): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...strayTempFiles(full));
    else if (entry.name.endsWith('.mendr-tmp')) out.push(full);
  }
  return out;
}

const read = (p: string): string => readFileSync(p, 'utf8');

describe('writeAllOrNothing — happy path', () => {
  it('writes every file and leaves no temp files behind', () => {
    const a = seed('a.ts', 'model: "old-a"', 'model: "new-a"');
    const b = seed('nested/b.py', 'model = "old-b"', 'model = "new-b"');

    const result = writeAllOrNothing([a, b]);

    expect(result.error).toBeUndefined();
    expect(result.rolledBack).toBe(false);
    expect(result.written).toEqual([a.absPath, b.absPath]);
    expect(read(a.absPath)).toBe('model: "new-a"');
    expect(read(b.absPath)).toBe('model = "new-b"');
    expect(strayTempFiles()).toEqual([]);
  });

  it('an empty batch is a no-op success', () => {
    expect(writeAllOrNothing([])).toEqual({ written: [], rolledBack: false });
  });

  it('refuses a batch that lists the same path twice (ambiguous rollback)', () => {
    const a = seed('dup.ts', 'original', 'patched');

    const result = writeAllOrNothing([a, { ...a, newText: 'other' }]);

    expect(result.written).toEqual([]);
    expect(result.error).toMatch(/listed twice/);
    expect(read(a.absPath)).toBe('original');
  });
});

describe('writeAllOrNothing — pre-flight aborts with ZERO writes', () => {
  it('aborts when a target is not writable, leaving every file untouched', () => {
    const good = seed('good.ts', 'original-good', 'patched-good');
    const locked = seed('locked.ts', 'original-locked', 'patched-locked');
    // On Windows this sets FILE_ATTRIBUTE_READONLY, which fs.accessSync(W_OK)
    // reports for files — the same signal as POSIX permission bits.
    chmodSync(locked.absPath, 0o444);

    const result = writeAllOrNothing([good, locked]);

    expect(result.written).toEqual([]);
    expect(result.rolledBack).toBe(false);
    expect(result.error).toMatch(/not writable/);
    expect(result.error).toContain('locked.ts');
    // A naive loop would already have written the FIRST file by the time it
    // hit the locked one — pre-flight is the whole point, so assert it is
    // byte-identical.
    expect(read(good.absPath)).toBe('original-good');
    expect(read(locked.absPath)).toBe('original-locked');
    expect(strayTempFiles()).toEqual([]);
  });

  it('aborts when a target no longer exists', () => {
    const good = seed('good.ts', 'original-good', 'patched-good');
    const gone: PendingWrite = {
      absPath: join(repo, 'vanished.ts'),
      newText: 'patched',
      originalText: 'original',
    };

    const result = writeAllOrNothing([good, gone]);

    expect(result.written).toEqual([]);
    expect(result.error).toMatch(/no longer exists/);
    expect(read(good.absPath)).toBe('original-good');
    expect(strayTempFiles()).toEqual([]);
  });

  it('aborts on CONTENT DRIFT — the file changed since the codemod read it', () => {
    const good = seed('good.ts', 'original-good', 'patched-good');
    const drifted = seed('drifted.ts', 'original-drifted', 'patched-drifted');
    // Somebody edits the file between mendr's scan and the --write.
    writeFileSync(drifted.absPath, 'edited by a human at 3am');

    const result = writeAllOrNothing([good, drifted]);

    expect(result.written).toEqual([]);
    expect(result.rolledBack).toBe(false);
    expect(result.error).toMatch(/changed on disk/);
    expect(result.error).toContain('drifted.ts');
    // Neither the innocent file nor the drifted one is touched.
    expect(read(good.absPath)).toBe('original-good');
    expect(read(drifted.absPath)).toBe('edited by a human at 3am');
    expect(strayTempFiles()).toEqual([]);
  });

  it('aborts when a target is a directory rather than a regular file', () => {
    const good = seed('good.ts', 'original-good', 'patched-good');
    const dirPath = join(repo, 'a-directory');
    mkdirSync(dirPath);

    const result = writeAllOrNothing([
      good,
      { absPath: dirPath, newText: 'patched', originalText: 'original' },
    ]);

    expect(result.written).toEqual([]);
    expect(result.error).toMatch(/not a regular file/);
    expect(read(good.absPath)).toBe('original-good');
  });

  it('tolerates a BOM: BOM-stripped originalText is not treated as drift', () => {
    // ts-morph and the Python reader both hand back BOM-stripped text, so a
    // byte-exact drift check would abort every write to a BOM'd file.
    const absPath = join(repo, 'bom.ts');
    writeFileSync(absPath, '﻿model: "old"');

    const result = writeAllOrNothing([
      { absPath, newText: 'model: "new"', originalText: 'model: "old"' },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.written).toEqual([absPath]);
    expect(read(absPath)).toBe('model: "new"');
  });
});

describe('writeAllOrNothing — mid-sequence failure rolls back', () => {
  it('restores already-written files to their ORIGINAL bytes', () => {
    const first = seed('first.ts', 'original-first', 'patched-first');
    const second = seed('second.ts', 'original-second', 'patched-second');
    const third = seed('third.ts', 'original-third', 'patched-third');

    // Force a failure PRE-FLIGHT CANNOT SEE. The third target is a perfectly
    // normal writable file; its STAGING path is occupied by a directory, so
    // the staging write throws once the sequence reaches it. Pre-flight can
    // never be race-free (an editor lock, a full disk, a permission flip can
    // all land between the check and the write) — this stands in for that.
    const blocker = `${third.absPath}.mendr-tmp`;
    mkdirSync(blocker);

    const result = writeAllOrNothing([first, second, third]);

    expect(result.rolledBack).toBe(true);
    expect(result.written).toEqual([]);
    // Rollback SUCCEEDED, so no mixed-state report.
    expect(result.restoreFailures).toBeUndefined();
    expect(result.error).toMatch(/write failed/);
    expect(result.error).toMatch(/rolled back 2 already-written files/);

    // THE ASSERTION THAT MATTERS: the two files a naive loop would have left
    // patched are byte-identical to their originals, and the third never
    // changed at all.
    expect(read(first.absPath)).toBe('original-first');
    expect(read(second.absPath)).toBe('original-second');
    expect(read(third.absPath)).toBe('original-third');

    // The test's own blocker is not mendr's litter — remove it, then assert
    // mendr left no staging file of its own anywhere.
    rmSync(blocker, { recursive: true, force: true });
    expect(strayTempFiles()).toEqual([]);
  });

  // THE MINIMAL CASE, stated on its own because it is the one a reader
  // pictures: two files, the second fails, does the first come back? The
  // three-file case above is strictly harder, but "restored 2 of 3" and
  // "restored 1 of 2" exercise different plural branches in the message and
  // different loop boundaries in the rollback, and a batch of two is what a
  // real model migration usually is.
  it('restores the FIRST file when the SECOND file write fails', () => {
    const first = seed('one.ts', 'ORIGINAL-ONE', 'PATCHED-ONE');
    const second = seed('two.ts', 'ORIGINAL-TWO', 'PATCHED-TWO');
    const blocker = `${second.absPath}.mendr-tmp`;
    mkdirSync(blocker);

    const result = writeAllOrNothing([first, second]);

    expect(result.rolledBack).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.restoreFailures).toBeUndefined();
    // Singular, because exactly one file had been written. A message that says
    // "1 file ... to their original contents" reads as a template nobody ran.
    expect(result.error).toContain('rolled back 1 already-written file to its original contents');

    expect(read(first.absPath)).toBe('ORIGINAL-ONE');
    expect(read(second.absPath)).toBe('ORIGINAL-TWO');

    rmSync(blocker, { recursive: true, force: true });
    expect(strayTempFiles()).toEqual([]);
  });
});
