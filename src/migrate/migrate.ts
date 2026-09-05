import { basename } from 'node:path';
import { relative } from 'node:path';
import type { LlmRegistry } from '../types.js';
import { loadProject } from '../usage/scanRepo.js';
import { applyLlmFixesToProject } from '../fix/llmFix.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { isVerified } from '../usage/llmRegistry.js';
import { collectPythonFiles, readPythonSources } from '../python/scanPy.js';
import { applyPyModelIdFixesToSources } from '../python/fixPy.js';
import { checkTypes } from '../gates/typecheck.js';
import { runRepoTests } from '../gates/runTests.js';
import { runRepoEval } from '../gates/runEval.js';
import { runRepoBuild } from '../gates/runBuild.js';
import type { PatchedFile } from '../gates/sandbox.js';

// THE MIGRATION SANDBOX.
//
// A migration is the set of verified Tier-A model-id swaps fix-llm would make.
// This module PROVES one in an isolated sandbox — build it, run the repo's
// tests, run an optional eval — WITHOUT ever touching the working tree, and
// emits ONE self-contained artifact (`mendr-migration/v1`): the diff, every
// model swap, each gate's outcome, an overall verdict, and whether it is
// ready to open as a human-approved PR. This is the input to `open a PR`
// (next) and to post-merge monitoring, so the verification lives here once,
// not re-derived by each consumer.
//
// It reuses fix-llm's swap ENGINE and the gate SANDBOX unchanged: same
// verified-only registry gate, same "config is never patched", same
// all-or-nothing safety. It only rewrites Tier-A code call sites.

export const MIGRATION_SCHEMA = 'mendr-migration/v1';

/** One model that would be migrated, and where. */
export interface ModelMigration {
  provider: string;
  model: string;
  from: string;
  to: string;
  language: 'ts' | 'py';
  /** Number of call sites swapped for this model. */
  sites: number;
  /** Repo-relative files this model's swap touches. */
  files: string[];
}

export type GateStatus = 'pass' | 'fail' | 'inconclusive' | 'not-configured';

export interface GateOutcome {
  status: GateStatus;
  detail?: string;
  command?: string;
}

export type MigrationVerdict = 'verified' | 'failed' | 'inconclusive' | 'no_migration';

export interface MigrationVerification {
  /** Baseline-relative in-memory type-check (TS/JS). */
  typeCheck: GateOutcome;
  /** The repo's own build, run in the sandbox, baseline-relative. */
  build: GateOutcome;
  /** The repo's own test command, run against the patched copy. */
  tests: GateOutcome;
  /** An optional evaluation command — the only BEHAVIORAL signal. */
  eval: GateOutcome;
  /** True only when an eval command actually passed. Code gates never set this. */
  behavioralTested: boolean;
  verdict: MigrationVerdict;
}

export interface MigrationResult {
  schema: typeof MIGRATION_SCHEMA;
  generatedBy: 'mendr';
  repo: string;
  generatedAt: string;
  sha: string | null;
  migrated: boolean;
  migrations: ModelMigration[];
  changedFiles: string[];
  /** The combined, git-applyable unified diff (empty when nothing migrates). */
  diff: string;
  verification: MigrationVerification;
  /** Safe to open as a reviewed PR: verified, and no gate failed. Never auto-merged. */
  prReady: boolean;
  /** Honest caveats a reader must see (behavioral untested, build not configured, …). */
  notes: string[];
}

export interface MigrateOptions {
  sha?: string | null;
  evalCommand?: string;
  /** Skip the sandbox verification (plan + diff only). */
  skipVerify?: boolean;
  buildTimeoutMs?: number;
}

interface PlannedMigration {
  patchedFiles: PatchedFile[];
  changedFiles: string[];
  diff: string;
  migrations: ModelMigration[];
  /** Kept for the type-check gate. */
  baselineProject: ReturnType<typeof loadProject>;
  patchedProject: ReturnType<typeof loadProject>;
}

function tsMigrations(baselineProject: ReturnType<typeof loadProject>, registry: LlmRegistry, repoPath: string): ModelMigration[] {
  // The SAME predicate the codemod uses (fix/modelId.ts): only model_arg
  // positions with a verified successor and a real change.
  const swaps = findModelIdLiterals(baselineProject, registry).filter(
    (m) => m.position === 'model_arg' && isVerified(m.deprecation) && m.value !== m.deprecation.replacement,
  );
  return groupMigrations(
    swaps.map((m) => ({
      provider: m.deprecation.provider,
      from: m.deprecation.deprecated,
      to: m.deprecation.replacement,
      file: relative(repoPath, m.location.file).replace(/\\/g, '/'),
    })),
    'ts',
  );
}

function groupMigrations(
  rows: { provider: string; from: string; to: string; file: string }[],
  language: 'ts' | 'py',
): ModelMigration[] {
  const byKey = new Map<string, ModelMigration>();
  for (const r of rows) {
    const key = `${r.provider}|${r.from}|${r.to}`;
    let mig = byKey.get(key);
    if (!mig) {
      mig = { provider: r.provider, model: r.from, from: r.from, to: r.to, language, sites: 0, files: [] };
      byKey.set(key, mig);
    }
    mig.sites++;
    if (!mig.files.includes(r.file)) mig.files.push(r.file);
  }
  return [...byKey.values()];
}

async function plan(repoPath: string, registry: LlmRegistry): Promise<PlannedMigration> {
  // TS/JS: a fresh baseline and a patched load (the type-check gate needs both).
  const baselineProject = loadProject(repoPath);
  const patchedProject = loadProject(repoPath);
  const tsResult = applyLlmFixesToProject(patchedProject, registry, repoPath);
  const tsPatchedFiles: PatchedFile[] = tsResult.changedFiles.map((absPath) => ({
    absPath,
    newText: patchedProject.getSourceFileOrThrow(absPath).getFullText(),
  }));
  const migrations = tsMigrations(baselineProject, registry, repoPath);

  // Python: read sources and apply the same verified-only swap set.
  const pySources = readPythonSources(collectPythonFiles(repoPath));
  const pyResult = await applyPyModelIdFixesToSources(pySources, registry, repoPath);
  const pyApplies = pyResult.syntaxGate.passed;
  const pyPatchedFiles: PatchedFile[] = pyApplies ? pyResult.patchedFiles : [];
  const pyMigrations = pyApplies
    ? groupMigrations(
        pyResult.swapMatches.map((m) => ({
          provider: m.deprecation.provider,
          from: m.deprecation.deprecated,
          to: m.deprecation.replacement,
          file: relative(repoPath, m.location.file).replace(/\\/g, '/'),
        })),
        'py',
      )
    : [];

  const patchedFiles = [...tsPatchedFiles, ...pyPatchedFiles];
  const changedFiles = patchedFiles.map((f) => relative(repoPath, f.absPath).replace(/\\/g, '/'));
  const diff = [tsResult.diff, pyApplies ? pyResult.diff : ''].filter(Boolean).join('\n');
  return { patchedFiles, changedFiles, diff, migrations: [...migrations, ...pyMigrations], baselineProject, patchedProject };
}

function outcome(status: GateStatus, detail?: string, command?: string): GateOutcome {
  return command ? { status, detail, command } : { status, detail };
}

/**
 * The verdict from the four gate outcomes. A PR-ready `verified` requires a REAL
 * sandbox run to have passed — build, tests, or eval — not just the in-memory
 * type-check (the same weak signal fix-llm already gives). Any failing gate is
 * `failed`; type-check passing while nothing executable ran is `inconclusive`.
 */
export function computeVerdict(typeCheck: GateOutcome, build: GateOutcome, tests: GateOutcome, evalOut: GateOutcome): MigrationVerdict {
  if ([typeCheck, build, tests, evalOut].some((g) => g.status === 'fail')) return 'failed';
  const anyRealPass = build.status === 'pass' || tests.status === 'pass' || evalOut.status === 'pass';
  return anyRealPass && typeCheck.status !== 'fail' ? 'verified' : 'inconclusive';
}

/**
 * Plan and (unless skipped) verify a migration in a sandbox. Never writes the
 * working tree.
 */
export async function runMigration(repoPath: string, registry: LlmRegistry, opts: MigrateOptions = {}): Promise<MigrationResult> {
  const now = new Date();
  const base = {
    schema: MIGRATION_SCHEMA as typeof MIGRATION_SCHEMA,
    generatedBy: 'mendr' as const,
    repo: basename(repoPath),
    generatedAt: now.toISOString(),
    sha: opts.sha ?? null,
  };

  const planned = await plan(repoPath, registry);

  if (planned.patchedFiles.length === 0) {
    return {
      ...base,
      migrated: false,
      migrations: [],
      changedFiles: [],
      diff: '',
      verification: {
        typeCheck: outcome('not-configured'),
        build: outcome('not-configured'),
        tests: outcome('not-configured'),
        eval: outcome('not-configured'),
        behavioralTested: false,
        verdict: 'no_migration',
      },
      prReady: false,
      notes: ['No verified Tier-A migration was found. Nothing to apply and nothing to verify.'],
    };
  }

  if (opts.skipVerify) {
    return {
      ...base,
      migrated: true,
      migrations: planned.migrations,
      changedFiles: planned.changedFiles,
      diff: planned.diff,
      verification: {
        typeCheck: outcome('not-configured'),
        build: outcome('not-configured'),
        tests: outcome('not-configured'),
        eval: outcome('not-configured'),
        behavioralTested: false,
        verdict: 'inconclusive',
      },
      prReady: false,
      notes: ['Verification was skipped (--skip-verify): the diff is shown but NOTHING was proven. Do not open a PR from this run.'],
    };
  }

  // --- verify in the sandbox ---
  const typeResult = checkTypes(planned.baselineProject, planned.patchedProject);
  const typeCheck = outcome(typeResult.passed ? 'pass' : 'fail', typeResult.passed ? undefined : `${typeResult.newDiagnostics.length} new type error(s) introduced by the migration`);

  const buildResult = await runRepoBuild(repoPath, planned.patchedFiles, opts.buildTimeoutMs);
  const build = outcome(buildResult.status, buildResult.output, buildResult.command);

  const testResult = await runRepoTests(repoPath, planned.patchedFiles);
  const tests = outcome(testResult.status === 'pass' ? 'pass' : testResult.status === 'fail' ? 'fail' : 'inconclusive', testResult.output);

  const evalResult = await runRepoEval(repoPath, planned.patchedFiles, { command: opts.evalCommand });
  const evalOut = outcome(evalResult.status, evalResult.output, evalResult.command);
  const behavioralTested = evalResult.status === 'pass';

  const verdict = computeVerdict(typeCheck, build, tests, evalOut);
  const prReady = verdict === 'verified';

  const notes: string[] = [];
  if (!behavioralTested) {
    notes.push(
      'Behavior was NOT verified: the sandbox proves the migration builds and existing tests pass, not that the replacement model matches the old one on quality, latency, cost or response shape. Pass --eval-command to test behavior, and review the swap either way.',
    );
  }
  if (build.status === 'not-configured') notes.push('No build script found (package.json has no `build`); the build gate did not run.');
  if (build.status === 'inconclusive') notes.push('The build gate was inconclusive; see its detail.');
  if (tests.status === 'inconclusive') notes.push('The test gate was inconclusive (no test script, or no installed dependencies to run one).');
  if (verdict === 'inconclusive') {
    notes.push(
      typeCheck.status === 'pass'
        ? 'The in-memory type-check passed, but no build, test or eval actually ran in the sandbox — that alone is not a PR-ready proof. Run this in CI (with dependencies installed) or add a build/test script.'
        : 'No build, test or eval ran in the sandbox, so nothing was proven. Run this in CI with dependencies installed.',
    );
  }
  if (verdict === 'verified') notes.push('This migration is a reviewed PR candidate. Mendr never merges; a human approves.');

  return {
    ...base,
    migrated: true,
    migrations: planned.migrations,
    changedFiles: planned.changedFiles,
    diff: planned.diff,
    verification: { typeCheck, build, tests, eval: evalOut, behavioralTested, verdict },
    prReady,
    notes,
  };
}
