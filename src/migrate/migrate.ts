import type { CheckStatus } from '../gates/status.js';
import { existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { loadProject } from '../usage/scanRepo.js';
import { applyLlmFixesToProject } from '../fix/llmFix.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { isVerified } from '../usage/llmRegistry.js';
import { normalizePath } from '../audit/fingerprint.js';
import { collectPythonFiles, readPythonSources } from '../python/scanPy.js';
import { applyPyModelIdFixesToSources } from '../python/fixPy.js';
import { checkTypes, NO_TYPE_CHECK, unresolvedScopeNote } from '../gates/typecheck.js';
import { runRepoTests } from '../gates/runTests.js';
import { runRepoEval } from '../gates/runEval.js';
import { runRepoBuild } from '../gates/runBuild.js';
import type { PatchedFile } from '../gates/sandbox.js';
import { writeAllOrNothing, type PendingWrite } from '../fix/atomicWrite.js';

// THE MIGRATION SANDBOX.
//
// A migration is the set of verified Tier-A model-id swaps fix-llm would make.
// This module PROVES one in a secret-sanitized verification environment — build it, run the repo's
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
  /**
   * THE EVIDENCE BEHIND THE SWAP, carried into the artifact so a reviewer can decide without
   * leaving the pull request.
   *
   * All of it was already on the registry entry at the moment the swap was planned and was
   * simply dropped on the floor, so the pull request said "gpt-4-0613 -> gpt-5.6-sol" and left
   * the reader to go and find out whether that was urgent, who said so, and how well checked the
   * replacement was.
   */
  evidence?: MigrationEvidence;
}

export interface MigrationEvidence {
  /** The registry record this swap derives its authority from. */
  entryId: string | null;
  /** `deprecated` or `retired` — a retired id is already failing, not about to. */
  lifecycle: string | null;
  /** ISO date the provider shuts it down. */
  shutdownDate: string | null;
  /** Days from the run to that date. Negative means it is already past. */
  daysUntil: number | null;
  /** The provider's own notice. */
  sourceUrl: string | null;
  /** How well checked the replacement mapping is: verified / quarantined / unverified. */
  replacementVerdict: string | null;
  /** Quoted excerpts from the captured provider page, where the entry carries them. */
  excerpts: { sourceUrl: string; excerpt: string }[];
}

/** {@link CheckStatus}. Was a fourth private union that disagreed with fix-llm's. */
export type GateStatus = CheckStatus;

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

/** Which registry the migration was planned against, and how current it was. */
export interface MigrationRegistryInfo {
  source: 'snapshot' | 'file' | 'bundled';
  version: string;
  publishedAt: string | null;
  /** Days old at planning time; -1 = unknown. */
  ageDays: number;
  maxAgeDays: number;
  freshness: 'fresh' | 'stale';
}

export interface MigrationResult {
  schema: typeof MIGRATION_SCHEMA;
  generatedBy: 'mendr';
  repo: string;
  generatedAt: string;
  sha: string | null;
  migrated: boolean;
  migrations: ModelMigration[];
  /**
   * Parameter transforms applied ALONGSIDE the model swaps, one label per unique transform.
   *
   * Swapping the id is the easy half. `max_tokens` becomes `max_completion_tokens` on the gpt-5.x
   * and o-series lines; `temperature`, `top_p` and `top_k` are rejected outright on recent Claude
   * Opus. A pull request that changed those and did not say so is asking a reviewer to notice it
   * in the diff.
   */
  paramTransforms: string[];
  /**
   * What this migration deliberately did NOT touch, and why.
   *
   * The most dangerous thing a migration PR can imply is completeness. A repo can have a verified
   * swap in one file and four retiring ids nobody may auto-rewrite in others, and a body that
   * lists only the swap reads as "that was all of it".
   */
  skipped: SkippedItem[];
  changedFiles: string[];
  /** The combined, git-applyable unified diff (empty when nothing migrates). */
  diff: string;
  verification: MigrationVerification;
  /** Safe to open as a reviewed PR: verified, and no gate failed. Never auto-merged. */
  prReady: boolean;
  /** Honest caveats a reader must see (behavioral untested, build not configured, …). */
  notes: string[];
  /**
   * With `--write`: repo-relative files actually written to the working tree.
   * Only ever non-empty when the verdict is `verified`. Absent without `--write`.
   */
  applied?: string[];
  /** Which registry the plan used and how current it was (absent when the caller did not say). */
  registry?: MigrationRegistryInfo;
}

export interface MigrateOptions {
  sha?: string | null;
  evalCommand?: string;
  /** Skip the sandbox verification (plan + diff only). */
  skipVerify?: boolean;
  buildTimeoutMs?: number;
  /**
   * Apply the migration to the working tree — but ONLY when the sandbox verdict
   * is `verified`. Any other verdict writes nothing. The write is atomic and
   * drift-checked (fix/atomicWrite).
   */
  write?: boolean;
  /**
   * Migrate ONLY these models — `provider/model` or bare model ids, as a person
   * approved them in the Mendr App. Every other retiring model is left exactly
   * as it is. Empty or absent = every verified swap, as before.
   */
  only?: string[];
  /** Provenance of the registry the plan uses (from the fresh-registry loader); recorded in the artifact. */
  registry?: MigrationRegistryInfo;
}

/**
 * The registry restricted to the named model-id entries. Param-transform
 * entries are kept: they are coupled to the model a swap moves TO, and only
 * apply when that swap happens.
 */
export function restrictRegistry(registry: LlmRegistry, only: string[] | undefined): LlmRegistry {
  const wanted = new Set((only ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (!wanted.size) return registry;
  return registry.filter((e) => e.kind !== 'model_id' || wanted.has(`${e.provider}/${e.deprecated}`.toLowerCase()) || wanted.has(e.deprecated.toLowerCase()));
}

/** One thing the migration saw and left alone, with the reason a reviewer needs. */
export interface SkippedItem {
  file: string;
  line: number;
  model: string;
  /** Why it was not rewritten, in the reader's terms. */
  reason: string;
}

interface PlannedMigration {
  patchedFiles: PatchedFile[];
  /**
   * The TypeScript/JavaScript half of `patchedFiles`, kept separate because it
   * is the ONLY honest signal for whether the type-check gate has anything to
   * judge.
   *
   * `migrations[].language` is NOT that signal: a parameter transform patches a
   * .ts file without producing a ModelMigration row, so a guard written against
   * it would skip a type-check that was genuinely needed — a worse bug than the
   * one it set out to fix.
   */
  tsPatchedFiles: PatchedFile[];
  /** The same files with their pre-migration text, for a drift-checked --write. */
  writes: PendingWrite[];
  changedFiles: string[];
  diff: string;
  migrations: ModelMigration[];
  paramTransforms: string[];
  skipped: SkippedItem[];
  /** Kept for the type-check gate. */
  baselineProject: ReturnType<typeof loadProject>;
  patchedProject: ReturnType<typeof loadProject>;
}

function tsMigrations(baselineProject: ReturnType<typeof loadProject>, registry: LlmRegistry, repoPath: string, now: Date): ModelMigration[] {
  // The SAME predicate the codemod uses (fix/modelId.ts): only model_arg
  // positions with a verified successor and a real change.
  const swaps = findModelIdLiterals(baselineProject, registry, repoPath).filter(
    (m) => m.position === 'model_arg' && isVerified(m.deprecation) && m.value !== m.deprecation.replacement,
  );
  return groupMigrations(
    swaps.map((m) => ({
      provider: m.deprecation.provider,
      from: m.deprecation.deprecated,
      to: m.deprecation.replacement,
      file: relative(repoPath, m.location.file).replace(/\\/g, '/'),
      evidence: evidenceOf(m.deprecation, now),
    })),
    'ts',
  );
}

function groupMigrations(
  rows: { provider: string; from: string; to: string; file: string; evidence?: MigrationEvidence }[],
  language: 'ts' | 'py',
): ModelMigration[] {
  const byKey = new Map<string, ModelMigration>();
  for (const r of rows) {
    const key = `${r.provider}|${r.from}|${r.to}`;
    let mig = byKey.get(key);
    if (!mig) {
      mig = { provider: r.provider, model: r.from, from: r.from, to: r.to, language, sites: 0, files: [] };
      if (r.evidence) mig.evidence = r.evidence;
      byKey.set(key, mig);
    }
    mig.sites++;
    if (!mig.files.includes(r.file)) mig.files.push(r.file);
  }
  return [...byKey.values()];
}

/** Pull the evidence off the registry entry that authorised this swap. */
export function evidenceOf(entry: LlmModelIdDeprecation, now: Date): MigrationEvidence {
  const shutdownDate = entry.shutdownDate ? entry.shutdownDate.slice(0, 10) : null;
  let daysUntil: number | null = null;
  if (shutdownDate) {
    const then = Date.parse(`${shutdownDate}T00:00:00Z`);
    if (!Number.isNaN(then)) {
      daysUntil = Math.round((then - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);
    }
  }
  const refs = Array.isArray((entry as { evidence?: unknown }).evidence)
    ? ((entry as { evidence: { sourceUrl?: string; excerpt?: string }[] }).evidence ?? [])
    : [];
  return {
    entryId: (entry as { entryId?: string }).entryId ?? null,
    lifecycle: entry.status ?? null,
    shutdownDate,
    daysUntil,
    sourceUrl: entry.sourceUrl ?? null,
    replacementVerdict: entry.verification?.status ?? null,
    excerpts: refs
      .filter((r) => r.sourceUrl && r.excerpt)
      .slice(0, 3)
      .map((r) => ({ sourceUrl: r.sourceUrl as string, excerpt: r.excerpt as string })),
  };
}

async function plan(repoPath: string, registry: LlmRegistry, now: Date): Promise<PlannedMigration> {
  // TS/JS: a fresh baseline and a patched load (the type-check gate needs both).
  const baselineProject = loadProject(repoPath);
  const patchedProject = loadProject(repoPath);
  const tsResult = applyLlmFixesToProject(patchedProject, registry, repoPath);
  const tsWrites: PendingWrite[] = tsResult.changedFiles.map((absPath) => ({
    absPath,
    newText: patchedProject.getSourceFileOrThrow(absPath).getFullText(),
    // The unpatched baseline load is exactly what the codemod read, so it is the
    // right drift reference for a --write (not a fresh disk read).
    originalText: baselineProject.getSourceFileOrThrow(absPath).getFullText(),
  }));
  const tsPatchedFiles: PatchedFile[] = tsWrites.map(({ absPath, newText }) => ({ absPath, newText }));
  const migrations = tsMigrations(baselineProject, registry, repoPath, now);

  // Python: read sources and apply the same verified-only swap set.
  const pySources = readPythonSources(collectPythonFiles(repoPath));
  const pyOriginalByPath = new Map(pySources.map((s) => [s.path, s.text]));
  const pyResult = await applyPyModelIdFixesToSources(pySources, registry, repoPath);
  const pyApplies = pyResult.syntaxGate.passed;
  const pyPatchedFiles: PatchedFile[] = pyApplies ? pyResult.patchedFiles : [];
  const pyWrites: PendingWrite[] = pyApplies
    ? pyResult.patchedFiles.map((f) => ({ absPath: f.absPath, newText: f.newText, originalText: pyOriginalByPath.get(f.absPath) ?? '' }))
    : [];
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
  const writes = [...tsWrites, ...pyWrites];
  const changedFiles = patchedFiles.map((f) => relative(repoPath, f.absPath).replace(/\\/g, '/'));
  const diff = [tsResult.diff, pyApplies ? pyResult.diff : ''].filter(Boolean).join('\n');
  // Everything the codemod saw and left alone, in the reader's terms. `blockedMatches` are live
  // model-arg positions whose replacement the registry will not vouch for; `azureMatches` are
  // deployment aliases that are never safe to rewrite blind.
  const skipped: SkippedItem[] = [
    ...tsResult.blockedMatches.map((b) => ({
      file: normalizePath(relative(repoPath, b.location.file)),
      line: b.location.line,
      model: b.value,
      reason:
        `the registry will not vouch for "${b.replacement}" as its replacement ` +
        `(${b.status}) — human review, never an automatic rewrite`,
    })),
    ...tsResult.azureMatches.map((a) => ({
      file: normalizePath(relative(repoPath, a.location.file)),
      line: a.location.line,
      model: a.value,
      reason: "an Azure deployment alias - the name is yours, not the provider's, so it is never rewritten",
    })),
  ];
  return {
    patchedFiles,
    tsPatchedFiles,
    writes,
    changedFiles,
    diff,
    migrations: [...migrations, ...pyMigrations],
    paramTransforms: tsResult.paramLabels,
    skipped,
    baselineProject,
    patchedProject,
  };
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
  if ([typeCheck, build, tests, evalOut].some((g) => g.status === 'failed')) return 'failed';
  const anyRealPass = build.status === 'passed' || tests.status === 'passed' || evalOut.status === 'passed';
  return anyRealPass && typeCheck.status !== 'failed' ? 'verified' : 'inconclusive';
}

/**
 * Plan and (unless skipped) verify a migration in a throwaway copy. Never writes the
 * working tree.
 */
/** A stale registry is said out loud: a newer retirement or replacement may exist. */
function registryNote(info: MigrationRegistryInfo | undefined): string[] {
  if (!info || info.freshness === 'fresh') return [];
  const age = info.ageDays < 0 ? 'of unknown age' : `${info.ageDays} days old (max ${info.maxAgeDays})`;
  return [
    `The registry this plan used (${info.source}) is ${age} — STALE: a newer retirement or replacement may exist. Run with --refresh-registry (or MENDR_REGISTRY_REFRESH=on) to plan against the latest signed snapshot.`,
  ];
}

export async function runMigration(repoPath: string, registry: LlmRegistry, opts: MigrateOptions = {}): Promise<MigrationResult> {
  const now = new Date();
  const base = {
    schema: MIGRATION_SCHEMA as typeof MIGRATION_SCHEMA,
    generatedBy: 'mendr' as const,
    repo: basename(repoPath),
    generatedAt: now.toISOString(),
    sha: opts.sha ?? null,
    ...(opts.registry ? { registry: opts.registry } : {}),
  };
  const registryNotes = registryNote(opts.registry);

  const only = (opts.only ?? []).map((s) => s.trim()).filter(Boolean);
  const onlyNote = only.length ? [`Restricted to ${only.join(', ')} (--only); every other retiring model was left untouched.`] : [];
  const planned = await plan(repoPath, restrictRegistry(registry, only), now);

  if (planned.patchedFiles.length === 0) {
    return {
      ...base,
      migrated: false,
      migrations: [],
      paramTransforms: [],
      skipped: planned.skipped,
      changedFiles: [],
      diff: '',
      verification: {
        typeCheck: outcome('not_run'),
        build: outcome('not_run'),
        tests: outcome('not_run'),
        eval: outcome('not_run'),
        behavioralTested: false,
        verdict: 'no_migration',
      },
      prReady: false,
      notes: [...onlyNote, 'No verified Tier-A migration was found. Nothing to apply and nothing to verify.', ...registryNotes],
    };
  }

  if (opts.skipVerify) {
    return {
      ...base,
      migrated: true,
      migrations: planned.migrations,
      paramTransforms: planned.paramTransforms,
      skipped: planned.skipped,
      changedFiles: planned.changedFiles,
      diff: planned.diff,
      verification: {
        typeCheck: outcome('not_run'),
        build: outcome('not_run'),
        tests: outcome('not_run'),
        eval: outcome('not_run'),
        behavioralTested: false,
        verdict: 'inconclusive',
      },
      prReady: false,
      notes: [
        ...onlyNote,
        'Verification was skipped (--skip-verify): the diff is shown but NOTHING was proven. Do not open a PR from this run.',
        ...(opts.write ? ['--write was ignored: nothing is applied without verification.'] : []),
        ...registryNotes,
      ],
      ...(opts.write ? { applied: [] as string[] } : {}),
    };
  }

  // --- verify in the sandbox ---

  // A TYPE-CHECK THAT HAD NOTHING TO CHECK IS NOT A PASS.
  //
  // checkTypes compares two ts-morph projects. When the migration patched no
  // .ts/.js file they are the SAME project — often an empty one — so it
  // returned `passed` with zero new diagnostics, and prBody published
  // "type-check: **passed**" into the body of a public pull request for a
  // repository containing no TypeScript at all. `fix-llm` said `skipped` for
  // the very same repository.
  //
  // THE SIGNAL IS THE PATCH, NOT THE REPOSITORY. In a repo holding both
  // languages whose swap happens to be Python-only, the TS project is
  // unchanged and the gate manufactures the same empty pass — so asking "does
  // this repo contain TypeScript" would leave the bug in place for exactly the
  // mixed repositories the ICP has most of.
  const hasTsPatch = planned.tsPatchedFiles.length > 0;
  const typeResult = hasTsPatch
    ? checkTypes(planned.baselineProject, planned.patchedProject)
    : { passed: false, newDiagnostics: [], baselineCount: 0, unresolvedModules: [] };
  // A pass earns its detail too when the gate ran blind: with the SDK absent,
  // the model argument is `any` and an id the SDK would reject cannot fail
  // this check. This sentence travels into the pull-request body, which is
  // where overclaiming would cost a reviewer's trust rather than ours.
  const typeScope = unresolvedScopeNote(typeResult);
  // A BLIND TYPE-CHECK IS INCONCLUSIVE HERE TOO.
  //
  // Applying this rule on the fix-llm path alone is how the two paths came to
  // print opposite verdicts for the same repository — the defect the single
  // vocabulary exists to close. The scope used to live only in the detail
  // string, which is the surface that gets dropped downstream: suppressed on
  // the PR-body gate row, discarded entirely by the App.
  const ranBlind = typeResult.passed && typeResult.unresolvedModules.length > 0;
  const typeCheck = !hasTsPatch
    ? outcome(NO_TYPE_CHECK.status, NO_TYPE_CHECK.detail)
    : outcome(
        typeResult.passed ? (ranBlind ? 'inconclusive' : 'passed') : 'failed',
        ranBlind
          ? `ran without the types that would reject a bad model id -- ${typeScope}`
          : typeResult.passed
            ? typeScope
            : `${typeResult.newDiagnostics.length} new type error(s) introduced by the migration`,
      );

  const buildResult = await runRepoBuild(repoPath, planned.patchedFiles, opts.buildTimeoutMs);
  const build = outcome(buildResult.status, buildResult.output, buildResult.command);

  const testResult = await runRepoTests(repoPath, planned.patchedFiles);
  const tests = outcome(testResult.status, testResult.note ?? testResult.output);

  const evalResult = await runRepoEval(repoPath, planned.patchedFiles, { command: opts.evalCommand });
  const evalOut = outcome(evalResult.status, evalResult.output, evalResult.command);
  const behavioralTested = evalResult.status === 'passed';

  const verdict = computeVerdict(typeCheck, build, tests, evalOut);
  const prReady = verdict === 'verified';

  const notes: string[] = [...onlyNote];
  if (!behavioralTested) {
    notes.push(
      'Behaviour was NOT verified: the throwaway copy proves the migration builds and existing tests pass, not that the replacement model matches the old one on quality, latency, cost or response shape. Pass --eval-command to test behaviour, and review the swap either way.',
    );
  }
  if (typeScope) {
    notes.push(
      `The type-check ran against a copy where ${typeScope}. A model id the SDK itself would ` +
        'reject is exactly the error those types would have caught, so install dependencies and ' +
        're-run to strengthen this gate.',
    );
  }
  if (typeCheck.status === 'skipped') {
    // `typeScope` is undefined when the gate did not run, so the note above
    // correctly disappears — and this one has to replace it, or the reader of
    // a Python migration sees a dash beside "type-check" and no reason for it.
    notes.push(
      'No type-check was run: this migration patched no TypeScript or JavaScript file, and mendr ' +
        'has no type checker for python. What stands behind a python swap is the registry mapping, ' +
        'the recognized model sink, and a baseline-relative syntax re-parse -- not a type check.',
    );
  }
  // These two used to assert a package.json that may not exist. On a repo that
  // is not a Node project at all, "package.json has no `build`" sends the
  // reader looking for a key in a file they do not have — and the test gate can
  // now reach `not_run` on exactly that repo, because a missing package.json
  // used to come back as an inconclusive carrying a raw ENOENT.
  const hasPackageJson = existsSync(join(repoPath, 'package.json'));
  if (build.status === 'not_run') {
    notes.push(
      hasPackageJson
        ? 'No build script found (package.json has no `build`); the build gate did not run.'
        : 'No package.json in this repository, so there was no `npm run build` for the build gate to run.',
    );
  }
  if (build.status === 'inconclusive') notes.push('The build gate was inconclusive; see its detail.');
  if (tests.status === 'not_run') notes.push('No test script found (package.json has no `test`); the test gate did not run.');
  if (tests.status === 'inconclusive') notes.push('The test gate was inconclusive; see its detail.');
  if (verdict === 'inconclusive') {
    notes.push(
      typeCheck.status === 'passed'
        ? 'The in-memory type-check passed, but no build, test or eval actually ran in the sandbox — that alone is not a PR-ready proof. Run this in CI (with dependencies installed) or add a build/test script.'
        : typeCheck.status === 'skipped'
          ? // "Run this in CI with dependencies installed" would not change the
            // outcome here: the missing gate is one mendr does not have.
            'Nothing executable ran and there was no type-check to run, so NOTHING about this code was verified on this run. Pass --eval-command with a command mendr can run against the patched copy to earn more than the registry mapping.'
          : 'No build, test or eval ran in the sandbox, so nothing was proven. Run this in CI with dependencies installed.',
    );
  }
  if (verdict === 'verified') notes.push('This migration is a reviewed PR candidate. Mendr never merges; a human approves.');
  notes.push(...registryNotes);

  // --- apply, ONLY when verified (--write) -----------------------------------
  let applied: string[] | undefined;
  if (opts.write) {
    if (verdict !== 'verified') {
      applied = [];
      notes.push(`Nothing was written: --write applies only a VERIFIED migration, and this run is ${verdict}.`);
    } else {
      const result = writeAllOrNothing(planned.writes);
      if (result.error) {
        applied = [];
        notes.push(`Nothing was written: ${result.error}`);
        if (result.restoreFailures?.length) {
          notes.push(`MIXED STATE — these files could not be restored and hold PATCHED content: ${result.restoreFailures.map((p) => relativeSafe(repoPath, p)).join(', ')}`);
        }
      } else {
        applied = result.written.map((p) => relativeSafe(repoPath, p));
        notes.push(`Applied the verified migration to ${applied.length} file${applied.length === 1 ? "" : "s"} in this checkout.`);
      }
    }
  }

  return {
    ...base,
    migrated: true,
    migrations: planned.migrations,
    paramTransforms: planned.paramTransforms,
    skipped: planned.skipped,
    changedFiles: planned.changedFiles,
    diff: planned.diff,
    verification: { typeCheck, build, tests, eval: evalOut, behavioralTested, verdict },
    prReady,
    notes,
    ...(applied !== undefined ? { applied } : {}),
  };
}

function relativeSafe(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, '/');
}
