import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

// THE --write SAFETY GATE.
//
// Everything upstream of this module is in-memory: the codemod builds patched
// text, the gates judge it, and nothing touches disk until `--write`. That last
// step used to be a plain `for (...) writeFileSync(...)` loop, which has one
// failure mode that is worse than doing nothing at all: if file 3 of 5 fails
// (read-only attribute, disk full, file locked by an editor or a watcher, path
// removed between the scan and the write), the repo is left HALF-MIGRATED with
// no undo. Two files speak the new model id, three speak the old one, and the
// user has no record of which is which.
//
// So writes are ALL-OR-NOTHING:
//
//   1. PRE-FLIGHT every target before touching anything — exists, is a regular
//      file, is writable, and its CURRENT bytes are exactly what the codemod
//      read. A single failure aborts with ZERO writes.
//   2. SNAPSHOT the originals (free — the caller already has them, since the
//      diff was computed against them).
//   3. WRITE via temp-file + rename in the SAME directory. A same-directory
//      rename is atomic on both NTFS and POSIX, so no individual file can ever
//      be observed truncated or half-written, even if the process dies mid-run.
//   4. ROLL BACK on any mid-sequence failure: restore every already-written
//      file from its snapshot, sweep the temp files, report {written: []}.
//   5. Sweep temp files on success too.
//
// The one case this module cannot make safe is a FAILED ROLLBACK (the restore
// write itself throws). That leaves a genuinely mixed repo, and the only honest
// response is to say so loudly and name every file left in the new state —
// never to swallow it behind a generic "write failed".

/** One file the caller wants written, with the text the codemod started from. */
export interface PendingWrite {
  /** Absolute path of the target file. */
  absPath: string;
  /** The patched contents to write. */
  newText: string;
  /**
   * The EXACT text the codemod read for this file. Pre-flight compares it to
   * what is on disk right now: a mismatch means the file changed under us
   * between the scan and the write (another editor, a rebase, a watcher), so
   * the patched text was computed against a source that no longer exists and
   * the whole write is abandoned.
   */
  originalText: string;
}

/** Outcome of an all-or-nothing write. */
export interface AtomicWriteResult {
  /** Absolute paths actually written. Empty whenever the write did not fully succeed. */
  written: string[];
  /** True when writes had started and were undone (or attempted to be undone). */
  rolledBack: boolean;
  /** Why the write was abandoned. Absent on success. */
  error?: string;
  /**
   * Files that could NOT be restored during rollback — the repo is in a MIXED
   * state and these paths hold PATCHED content. Present only in that
   * pathological case; the caller must surface it, never treat it as "clean".
   */
  restoreFailures?: string[];
}

/** Suffix of the same-directory staging file. Never left behind on any path. */
const TMP_SUFFIX = '.mendr-tmp';

/** The staging path for a target: same directory, so the rename stays atomic. */
function tempPathFor(absPath: string): string {
  return `${absPath}${TMP_SUFFIX}`;
}

/**
 * Drop a leading BOM before comparing file contents. The parsers upstream
 * (ts-morph, the Python reader) hand back text with the BOM already stripped,
 * so a byte-exact comparison against disk would flag every BOM'd file as
 * "changed under us" and abort a perfectly valid write. Only the LEADING mark
 * is ignored — everything after it is compared exactly.
 */
function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** A message describing why one target failed pre-flight, or undefined if it passed. */
function preflightFailure(write: PendingWrite): string | undefined {
  const { absPath, originalText } = write;

  if (!existsSync(absPath)) {
    return `${absPath}: file no longer exists (it was removed between the scan and the write)`;
  }

  // lstat, not stat: a SYMLINK passes `stat().isFile()` but the temp+rename
  // dance would replace the LINK with a regular file and silently break it.
  // Refusing is the safe half of that trade — a link is rare in a source tree
  // and the user can apply the printed diff by hand.
  let stats;
  try {
    stats = lstatSync(absPath);
  } catch (err) {
    return `${absPath}: cannot stat file (${err instanceof Error ? err.message : String(err)})`;
  }
  if (stats.isSymbolicLink()) {
    return `${absPath}: is a symbolic link (mendr will not replace a link with a regular file)`;
  }
  if (!stats.isFile()) {
    return `${absPath}: not a regular file`;
  }

  // Writability. On Windows this reports the read-only ATTRIBUTE; on POSIX it
  // is the permission bits. Either way a failure here means the write would
  // have thrown mid-sequence, which is exactly what pre-flight exists to
  // prevent. (It is not a race-free guarantee — a lock can appear a
  // microsecond later — which is why the rollback path exists behind it.)
  try {
    accessSync(absPath, constants.W_OK);
  } catch {
    return `${absPath}: not writable (read-only file or insufficient permissions)`;
  }

  // Content drift: the patched text was computed from `originalText`, so if
  // disk no longer holds that text the patch does not belong to this file.
  let current: string;
  try {
    current = readFileSync(absPath, 'utf8');
  } catch (err) {
    return `${absPath}: cannot read current contents (${err instanceof Error ? err.message : String(err)})`;
  }
  if (withoutBom(current) !== withoutBom(originalText)) {
    return (
      `${absPath}: file changed on disk since mendr read it ` +
      `(the patch was computed against different content -- re-run mendr)`
    );
  }

  return undefined;
}

/**
 * Best-effort sweep of every staging file. Returns the paths that could NOT be
 * removed so the caller can name them: a stray `.mendr-tmp` is harmless to the
 * build but it is litter mendr created, and silently leaving it would be the
 * same class of dishonesty as a silent partial write.
 */
function sweepTempFiles(writes: PendingWrite[]): string[] {
  const stray: string[] = [];
  for (const write of writes) {
    const tmp = tempPathFor(write.absPath);
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      stray.push(tmp);
    }
  }
  return stray;
}

/**
 * Write every file, or none of them. See the file header for the full
 * contract. Never throws: every failure comes back as a populated `error`.
 */
export function writeAllOrNothing(writes: PendingWrite[]): AtomicWriteResult {
  if (writes.length === 0) return { written: [], rolledBack: false };

  // Guard the caller's own bug before the filesystem's: two entries for one
  // path would make the second snapshot the FIRST one's patched text, so a
  // rollback would "restore" the wrong bytes.
  const seen = new Set<string>();
  for (const write of writes) {
    if (seen.has(write.absPath)) {
      return {
        written: [],
        rolledBack: false,
        error: `${write.absPath}: listed twice in one write batch (refusing an ambiguous write)`,
      };
    }
    seen.add(write.absPath);
  }

  // 1. PRE-FLIGHT EVERYTHING FIRST. Nothing below this loop runs unless every
  //    single target is writable and still holds the text we patched.
  for (const write of writes) {
    const failure = preflightFailure(write);
    if (failure) {
      return {
        written: [],
        rolledBack: false,
        error: `pre-flight check failed for ${failure}`,
      };
    }
  }

  // 2. SNAPSHOT. The originals are already in hand — pre-flight just proved
  //    each one matches disk byte-for-byte.
  const snapshots = new Map(writes.map((w) => [w.absPath, w.originalText]));

  // 3. WRITE: stage beside the target, then rename over it.
  const written: string[] = [];
  try {
    for (const write of writes) {
      const tmp = tempPathFor(write.absPath);
      writeFileSync(tmp, write.newText);
      renameSync(tmp, write.absPath);
      written.push(write.absPath);
    }
  } catch (err) {
    // 4. ROLL BACK. Restore in place (a plain write, not another rename —
    //    fewer moving parts on the path that is already handling a failure).
    const cause = err instanceof Error ? err.message : String(err);
    const restoreFailures: string[] = [];
    for (const absPath of written) {
      try {
        writeFileSync(absPath, snapshots.get(absPath)!);
      } catch (restoreErr) {
        restoreFailures.push(
          `${absPath} (${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)})`,
        );
      }
    }
    const stray = sweepTempFiles(writes);

    if (restoreFailures.length > 0) {
      // THE PATHOLOGICAL CASE. Never soften this: the repo is genuinely mixed
      // and the user has to know which files hold patched content.
      return {
        written: [],
        rolledBack: true,
        restoreFailures,
        error:
          `write failed (${cause}) AND ROLLBACK FAILED. ` +
          `THE REPO IS IN A MIXED STATE: ${restoreFailures.length} file` +
          `${restoreFailures.length === 1 ? '' : 's'} could not be restored and still ` +
          `hold mendr's PATCHED content -- ${restoreFailures.join('; ')}. ` +
          `Restore ${restoreFailures.length === 1 ? 'it' : 'them'} from version control before building.` +
          (stray.length > 0 ? ` Stray temp files left behind: ${stray.join(', ')}.` : ''),
      };
    }

    return {
      written: [],
      rolledBack: true,
      error:
        `write failed (${cause}); rolled back ${written.length} already-written file` +
        `${written.length === 1 ? '' : 's'} to their original contents` +
        (stray.length > 0 ? `. Stray temp files left behind: ${stray.join(', ')}` : ''),
    };
  }

  // 5. Success. Every rename consumed its own temp file, but sweep anyway —
  //    the cost is one existsSync per file and it closes the window where a
  //    write succeeded and its rename did not.
  const stray = sweepTempFiles(writes);
  return stray.length > 0
    ? {
        written,
        rolledBack: false,
        error: `all files written, but stray temp files could not be removed: ${stray.join(', ')}`,
      }
    : { written, rolledBack: false };
}
