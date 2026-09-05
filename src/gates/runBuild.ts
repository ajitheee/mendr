import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { truncateOutput, withPatchedSandbox, type PatchedFile } from './sandbox.js';

// The BUILD gate: run the repository's own build in a throwaway sandbox copy,
// once WITHOUT the migration and once WITH it, and report BASELINE-RELATIVE —
// "did this change break a build that worked before?" — never an absolute
// verdict. A repo that did not build beforehand yields `inconclusive`, so a
// migration is never blamed for a failure it did not cause. Nothing in the
// customer's working tree is ever touched (see gates/sandbox.ts).

export type BuildStatus = 'pass' | 'fail' | 'inconclusive' | 'not-configured';

export interface BuildGateResult {
  status: BuildStatus;
  /** The command that ran (e.g. `npm run build`), when one was found. */
  command?: string;
  exitCode?: number;
  /** Captured output (truncated), or the reason the gate could not conclude. */
  output?: string;
}

const DEFAULT_BUILD_TIMEOUT_MS = 300_000;

/** The repo's build command, or null when it declares none. */
export function detectBuildCommand(repoPath: string): { cmd: string; args: string[]; label: string } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8'));
    if (pkg?.scripts?.build) {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      return { cmd: npmCmd, args: ['run', 'build'], label: 'npm run build' };
    }
  } catch {
    // no package.json / unreadable: no build command
  }
  return null;
}

export async function runRepoBuild(
  repoPath: string,
  patchedFiles: readonly PatchedFile[],
  timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
): Promise<BuildGateResult> {
  const detected = detectBuildCommand(repoPath);
  if (!detected) return { status: 'not-configured' };
  if (!existsSync(join(repoPath, 'node_modules'))) {
    return { status: 'inconclusive', command: detected.label, output: 'repo has no installed node_modules to link — cannot build' };
  }

  const build = (files: readonly PatchedFile[]) =>
    withPatchedSandbox(repoPath, files, (dir) =>
      execa(detected.cmd, detected.args, {
        cwd: dir,
        reject: false,
        all: true,
        timeout: timeoutMs,
        env: { ...process.env, CI: '1' },
      }),
    );

  // Baseline: does the repo build BEFORE the migration?
  const base = await build([]);
  if (!base.ok) return { status: 'inconclusive', command: detected.label, output: `build gate infra error: ${base.reason}` };
  if (base.value.exitCode !== 0) {
    return {
      status: 'inconclusive',
      command: detected.label,
      output: `repo did not build BEFORE the change; a build failure cannot be attributed to the migration.\n${truncateOutput(base.value.all ?? '')}`,
    };
  }

  // Patched: does it still build WITH the migration?
  const patched = await build(patchedFiles);
  if (!patched.ok) return { status: 'inconclusive', command: detected.label, output: `build gate infra error: ${patched.reason}` };
  return {
    status: patched.value.exitCode === 0 ? 'pass' : 'fail',
    command: detected.label,
    exitCode: patched.value.exitCode,
    output: truncateOutput(patched.value.all ?? ''),
  };
}
