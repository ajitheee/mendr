import { execa } from 'execa';
import { DEFAULT_EVAL_TIMEOUT_MS } from '../config/repoConfig.js';
import { truncateOutput, withPatchedSandbox, type PatchedFile } from './sandbox.js';

// The eval gate — the ONLY gate in mendr that can say anything about BEHAVIOR.
//
// It does not know what "behaves the same" means and never guesses: it runs the
// command the target repo configured (mendr.config.json `evalCommand`, or
// --eval-command) against the PATCHED copy, and reports the exit code. Exit 0
// is the whole claim — "your eval command passed" — and the report is forbidden
// from stretching it into "the replacement model is equivalent".
//
// Isolation is the test gate's, verbatim: the command runs in the throwaway
// patched copy from gates/sandbox.ts, never in the user's working tree. An eval
// that writes files, installs things, or corrupts a fixture damages a temp dir
// that is deleted seconds later.
//
// The command is spawned THROUGH A SHELL, because a configured command is a
// command line ("npm run eval", "pytest evals/ -q"), not an argv. That is the
// same trust level as the `npm test` the test gate already runs from the repo's
// own package.json: mendr executes what the repo asked for.

/**
 * Outcome of the eval gate.
 *   pass           — the configured command exited 0
 *   fail           — it exited non-zero: a behavioral regression, which blocks
 *                    the fix exactly like a failed test gate
 *   not-configured — no evalCommand: the honest default, never a pass
 *   inconclusive   — the gate could not run it (timeout, spawn/copy failure)
 */
export type EvalStatus = 'pass' | 'fail' | 'not-configured' | 'inconclusive';

/** Result of the eval gate. */
export interface EvalGateResult {
  status: EvalStatus;
  /** The command that was run, echoed back for the report (absent when unconfigured). */
  command?: string;
  /** Exit code, present only when the command actually ran to completion. */
  exitCode?: number;
  /** Captured output (truncated), or the reason the gate was inconclusive. */
  output?: string;
}

/**
 * MENDR ENFORCES THE DEADLINE ITSELF — it does NOT use execa's `timeout`.
 *
 * With `shell: true` on Windows, execa spawns `cmd.exe /c <command>` and
 * cmd.exe spawns the real program. execa's timeout kills cmd.exe only; the
 * grandchild survives, keeps the captured stdout pipe open, and the await does
 * not settle until the eval finishes on its own — a 10-minute budget that a
 * hung eval ignores completely (measured: a 60s child outlived a 750ms timeout
 * by the full 60s). Killing the tree AFTER cmd.exe has already exited is too
 * late: `taskkill /T` walks children of a LIVE pid, and there is nothing left
 * to walk from.
 *
 * So the timer fires while the shell is still alive and takes the whole tree
 * down in one call. On POSIX `sh -c` execs a simple command in place, so the
 * signal reaches the real program without any of this.
 *
 * Returns the subprocess result plus whether OUR deadline is what ended it —
 * the caller needs that distinction, since a killed run is `inconclusive`,
 * never a behavioral `fail`.
 */
async function runWithDeadline<T>(
  subprocess: PromiseLike<T> & { pid?: number; kill: (signal?: NodeJS.Signals) => unknown },
  timeoutMs: number,
): Promise<{ result: T; timedOut: boolean }> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32' && subprocess.pid) {
      // Best effort: taskkill exits non-zero when the tree is already gone,
      // which is the normal race and not an error worth surfacing.
      void execa('taskkill', ['/pid', String(subprocess.pid), '/T', '/F'], {
        reject: false,
        windowsHide: true,
      }).catch(() => undefined);
    } else {
      subprocess.kill('SIGKILL');
    }
  }, timeoutMs);
  timer.unref();
  try {
    return { result: await subprocess, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** What the caller resolved from config + CLI flag. */
export interface EvalGateOptions {
  /** The configured command. Absent/blank => `not-configured`. */
  command?: string;
  /** Wall-clock budget; defaults to DEFAULT_EVAL_TIMEOUT_MS (10 min). */
  timeoutMs?: number;
}

/**
 * Run the repo's own evaluation against `patchedFiles` in an isolated temp
 * copy. Never touches the original working tree.
 *
 * Unlike the test gate this does NOT require an installed node_modules: an eval
 * command may be `pytest`, `make eval`, or a shell script. When the repo does
 * have one it is junctioned in, so `npm run eval` works without reinstalling.
 */
export async function runRepoEval(
  repoPath: string,
  patchedFiles: readonly PatchedFile[],
  opts: EvalGateOptions,
): Promise<EvalGateResult> {
  const command = opts.command?.trim();
  if (!command) return { status: 'not-configured' };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
  const sandbox = await withPatchedSandbox(repoPath, patchedFiles, (dir) =>
    runWithDeadline(
      execa(command, {
        cwd: dir,
        shell: true,
        reject: false,
        all: true,
        windowsHide: true,
      }),
      timeoutMs,
    ),
  );

  // An infra failure is NOT a behavioral verdict. Reporting it as `fail` would
  // block a perfectly good fix because a temp copy failed; reporting it as
  // `pass` would claim an eval that never ran. It is inconclusive.
  if (!sandbox.ok) {
    return { status: 'inconclusive', command, output: `eval gate infra error: ${sandbox.reason}` };
  }
  const { result, timedOut } = sandbox.value;
  if (timedOut) {
    // A timeout is likewise inconclusive, not a regression: the eval was cut
    // off, so nobody knows what it would have said. Raise evalTimeoutMs.
    return {
      status: 'inconclusive',
      command,
      output:
        `eval command timed out after ${timeoutMs}ms ` +
        `(raise "evalTimeoutMs" in mendr.config.json if your eval needs longer)`,
    };
  }

  const output = truncateOutput(result.all ?? `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  // execa reports a null/undefined exit code only for signals, which `timedOut`
  // above already covers; anything else that got here without a 0 is a failure.
  const exitCode = result.exitCode ?? 1;
  return { status: exitCode === 0 ? 'pass' : 'fail', command, exitCode, output };
}
