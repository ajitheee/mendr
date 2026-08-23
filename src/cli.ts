#!/usr/bin/env node
import { Command } from 'commander';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import { loadSpec } from './detect/fetchSpec.js';
import { diffSpecs } from './detect/diffSpec.js';
import { formatChangeSet } from './detect/changeModel.js';
import {
  buildRegistryPrefilter,
  loadPrefilteredProject,
  loadProject,
} from './usage/scanRepo.js';
import { buildUsageMap, formatUsageMap } from './usage/usageMap.js';
import { intersect, formatAffectedSites } from './intersect/intersect.js';
import { applyRenames, applyRenamesToProject } from './fix/apply.js';
import { formatChange } from './detect/changeModel.js';
import { checkTypes, formatDiagnostic } from './gates/typecheck.js';
import { runRepoTests } from './gates/runTests.js';
import { runRepoEval, type EvalGateResult } from './gates/runEval.js';
import {
  loadRepoConfig,
  REPO_CONFIG_FILENAME,
  type GateName,
  type RepoConfig,
} from './config/repoConfig.js';
import {
  describeGateBlock,
  gateBlocks,
  resolveGatePolicy,
  type GateBlock,
  type GateEvaluation,
  type GateOutcome,
  type ResolvedGatePolicy,
} from './gates/policy.js';
import {
  effectiveVerificationState,
  isVerified,
  loadLlmRegistry,
  modelIdEntries,
  registryProvenance,
  resolveRegistryPath,
  staleRegistryWarning,
  withheldSwitches,
  type EffectiveVerificationState,
} from './usage/llmRegistry.js';
import { displayEntryId, entryIdFor } from './registry/entryId.js';
import { formatValidation, validateRegistry } from './registry/validateRegistry.js';
import {
  findModelIdLiterals,
  scanProjectAnnotations,
  toAzureDeploymentMatches,
  toBlockedModelArgMatches,
  toModelIdDataMatches,
  AZURE_DEPLOYMENT_REASON,
  TYPE_CAST_REASON,
  USAGE_UNVERIFIED_REASON,
} from './usage/scanLiterals.js';
import {
  formatCatalogLine,
  formatDataFileGroupLine,
  formatDataHitLine,
  formatGateSummary,
  formatRegistryEntryLines,
  formatRegistryProvenanceLines,
  groupDataFindingsByFile,
  registryVerdictRows,
  replacementFamily,
  swapLabel,
  behavioralVerificationNote,
  type BehavioralVerificationView,
  type DataFindingView,
  type GateRow,
} from './report/llmReport.js';
import {
  assertSingleTerminalTier,
  classificationText,
  crossTierCollisions,
  devChecksEnabled,
  formatFoundLines,
  formatSummaryLines,
  formatTierBSection,
  multiTierNotes,
  orderTierB,
  tierBFinding,
  tierBJson,
  usageVerdictState,
  TIER_A_DOWNGRADED_CLASSIFICATION,
  type RegistryVerdict,
  type TierBFinding,
  type TierCounts,
  type TierOccurrence,
} from './report/tiers.js';
import {
  countUniqueOccurrences,
  formatRunFooterLines,
  runMode,
} from './report/runFooter.js';
import {
  writeAllOrNothing,
  type AtomicWriteResult,
  type PendingWrite,
} from './fix/atomicWrite.js';
import { findParamSites } from './fix/paramFix.js';
import { dedupeSwapsByNode } from './fix/modelId.js';
import { applyLlmFixesToProject, type LlmFixResult } from './fix/llmFix.js';
import { collectPythonFiles, readPythonSources, scanPyAnnotations } from './python/scanPy.js';
import { applyPyModelIdFixesToSources } from './python/fixPy.js';
import type { TestGateResult } from './gates/runTests.js';
import { classifyEntry, mergeReasons, verificationSwitches } from './registry/verify.js';
import { fetchOracles } from './registry/oracles.js';
import {
  loadCandidates,
  promoteCandidates,
  resolveCandidatesPath,
  saveCandidates,
} from './registry/candidates.js';
import { resolveEvidenceDir, saveSnapshot, snapshotName } from './registry/evidence.js';
import { canonicalizeId } from './registry/normalize.js';
import {
  DISCOVER_PROVIDERS,
  discoverCandidates,
  PROVIDER_SOURCES,
  type DiscoverProvider,
} from './registry/discover.js';
import type {
  CandidateEntry,
  LlmModelIdDeprecation,
  VerificationStatus,
} from './types.js';
import { computeExposure } from './watch/exposure.js';
import {
  EXPOSURE_RELATIVE_PATH,
  EXPOSURE_SCHEMA,
  writeExposureFile,
  type ExposureWriteResult,
} from './watch/exposureFile.js';
import {
  nearestDeadlineDays,
  renderBadge,
  renderIssueBody,
  renderTextSummary,
} from './watch/issue.js';
import { installWatchWorkflow } from './watch/installWorkflow.js';

const program = new Command();

program
  .name('mendr')
  .description('Auto-fix third-party API breaking changes: deprecated LLM model ids + Stripe renames.')
  .version('0.1.0');

/** Is the target a remote git URL (GitHub link etc.) rather than a local path? */
function isRemoteRepoUrl(target: string): boolean {
  return /^(https?:\/\/|git@)/i.test(target);
}

/**
 * fix-llm accepts a GitHub/git URL as well as a local path. A URL is shallow-
 * cloned into a throwaway temp dir and analyzed there — the real repo is never
 * touched. --write is refused for URLs, since it would only edit the temp copy.
 */
async function cloneRemoteOrExit(url: string): Promise<string> {
  const dest = mkdtempSync(join(tmpdir(), 'mendr-clone-'));
  // Progress goes to STDERR: with --json, stdout must carry only the report.
  console.error(`Cloning ${url} (shallow, read-only copy)...`);
  try {
    await simpleGit().clone(url, dest, ['--depth', '1']);
  } catch (err) {
    console.error(
      `mendr: could not clone ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  return dest;
}

/** Resolve a repo path, exiting non-zero if it is missing or not a directory. */
function resolveRepoOrExit(repoPath: string): string {
  const resolved = resolve(repoPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    console.error(`mendr: path not found or not a directory: ${repoPath}`);
    process.exit(2);
  }
  return resolved;
}

/**
 * Guard the dangerous FALSE-CLEAN case. A mistyped path, a repo in a language
 * we cannot read, or a tsconfig whose `include` matched nothing loads 0
 * analyzable source files — and the old code then printed "Nothing to fix"
 * with a success exit, which a user cannot tell apart from a genuinely clean
 * repo. Fail loudly instead — but only when BOTH languages come up empty: a
 * pure-Python repo has 0 TS files and is perfectly analyzable now.
 */
function assertAnalyzable(tsFileCount: number, pyFileCount: number, resolved: string): void {
  if (tsFileCount === 0 && pyFileCount === 0) {
    console.error(
      `mendr: found no analyzable source files under ${resolved}.\n` +
        `mendr can read TypeScript (.ts/.tsx/.mts/.cts) and Python (.py) — is this the repo root?`,
    );
    process.exit(2);
  }
}

/**
 * The test gate's result, in the vocabulary the policy and the report share.
 *
 * THE THREE NON-PASSING CASES ARE NOT ONE CASE. "the repo declares no test
 * script" is `not-configured` (nothing to run, and nothing broken); "the repo
 * has no installed node_modules" / "the run timed out" is `inconclusive` (there
 * IS a suite and mendr could not run it); a suite that ran and failed is `fail`.
 * They used to share the phrase "not run", which is why a required-tests policy
 * could not be expressed: the one state a team wants to block on was spelled
 * the same as the one they never can.
 */
function testGateEvaluation(result: TestGateResult): GateEvaluation {
  if (result.status === 'inconclusive') {
    return result.output === 'no test script'
      ? { gate: 'tests', outcome: 'not-configured', detail: 'no "test" script in package.json' }
      : { gate: 'tests', outcome: 'inconclusive', detail: result.output };
  }
  const detail = result.counts
    ? `npm test, ${result.counts.passed} passed, ${result.counts.failed} failed`
    : 'npm test, exit code only -- counts not parsed';
  return { gate: 'tests', outcome: result.status, detail };
}

/** Row states for the gate outcomes, one word each — see GateRowState. */
const OUTCOME_STATE = {
  pass: 'passed',
  fail: 'failed',
  inconclusive: 'inconclusive',
  'not-configured': 'not configured',
  'not-applicable': 'n/a',
} as const;

/** Render one gate evaluation as a summary row, tagged when policy requires it. */
function gateRowOf(label: string, evaluation: GateEvaluation, required: boolean): GateRow {
  return {
    label,
    state: OUTCOME_STATE[evaluation.outcome],
    ...(evaluation.detail ? { detail: evaluation.detail } : {}),
    ...(required ? { required } : {}),
  };
}

/**
 * A required gate that did not pass must be visible to a SCRIPT, not just to a
 * reader: the whole point of marking a gate required is that CI stops. A hard
 * failure of a gate the policy did NOT require keeps the old exit code (0) —
 * it downgrades the tier and says so, exactly as before.
 */
function signalRequiredGateFailure(blocks: readonly GateBlock[]): void {
  if (blocks.some((b) => b.required)) process.exitCode = 1;
}

/**
 * Write the `-o <file>` diff, creating parent directories as needed. A
 * filesystem failure (bad drive, permissions, path-is-a-directory) exits with
 * one friendly line instead of an unhandled-exception stack trace.
 */
function writeDiffOrExit(outputPath: string, diff: string): void {
  const resolved = resolve(outputPath);
  try {
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, diff);
  } catch (err) {
    console.error(
      `Cannot write ${outputPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

/**
 * The classes `--fail-on` accepts. `none` (the default) never gates the exit.
 *
 * `blocked` is the DEPRECATED alias for `tierB`. It used to name one surface
 * (a live call with an unverified replacement); that surface is now one reason
 * code inside Tier B, and Tier B is the class a CI job actually wants to gate
 * on. The alias keeps existing workflows exiting non-zero — on a WIDER set
 * than before, which is why using it prints a one-line notice on stderr rather
 * than resolving silently.
 */
const FAIL_ON_CLASSES = new Set(['tierA', 'tierB', 'blocked', 'none']);

program
  .command('fix-llm')
  .argument('<repoPath>', 'path to the target TypeScript/Python repo, or a GitHub/git URL to scan a copy of')
  .option('--skip-gates', 'skip the type-check + test gates (assert Tier A without verifying)')
  .option('--write', 'apply the VERIFIED Tier A diff to your working tree (default: print only)')
  .option('-o, --output <file>', 'also write the combined diff to a file')
  .option('--verbose', 'print every informational data hit (default: one line per file)')
  .option('--json', 'emit a machine-readable JSON report on stdout instead of the human one')
  .option(
    '--fail-on <class>',
    'exit 1 when the named tier is non-empty: tierA | tierB | none (blocked = deprecated alias for tierB)',
    'none',
  )
  .option(
    '--eval-command <cmd>',
    `run YOUR evaluation against the patched code (overrides "evalCommand" in ${REPO_CONFIG_FILENAME})`,
  )
  .description('Find and fix deprecated LLM model ids (prints a verified diff)')
  .action(
    async (
      repoPath: string,
      opts: {
        skipGates?: boolean;
        write?: boolean;
        output?: string;
        verbose?: boolean;
        json?: boolean;
        failOn?: string;
        evalCommand?: string;
      },
    ) => {
    const rawFailOn = opts.failOn ?? 'none';
    if (!FAIL_ON_CLASSES.has(rawFailOn)) {
      console.error(
        `mendr: invalid --fail-on value "${rawFailOn}" (expected tierA, tierB, or none; ` +
          `"blocked" is accepted as a deprecated alias for tierB)`,
      );
      process.exit(2);
    }
    if (rawFailOn === 'blocked') {
      // Stderr, so it survives --json. Naming the WIDENING is the point: a job
      // that only wanted to gate on unverified replacements now also gates on
      // deployment aliases and unproven assignments.
      console.error(
        'mendr: --fail-on blocked is deprecated -- it now means --fail-on tierB, which covers ' +
          'every review-required finding (unverified replacements, platform aliases, ' +
          'usage-unverified assignments, type-cast-masked ids).',
      );
    }
    const failOn = rawFailOn === 'blocked' ? 'tierB' : rawFailOn;
    const json = !!opts.json;
    // In --json mode stdout carries EXCLUSIVELY the JSON document — every human
    // report line goes through say() and is suppressed (warnings use stderr).
    const say = (line = ''): void => {
      if (!json) console.log(line);
    };

    const isRemote = isRemoteRepoUrl(repoPath);
    if (isRemote && opts.write) {
      console.error(
        'mendr: --write is not allowed with a repo URL (it would only edit a temp copy).\n' +
          'clone the repo yourself and run mendr on the local folder to apply the fix.',
      );
      process.exit(2);
    }
    const resolved = isRemote ? await cloneRemoteOrExit(repoPath) : resolveRepoOrExit(repoPath);

    // The TARGET repo's own config (optional). Loaded BEFORE any scanning so a
    // malformed file fails immediately with one line naming it, rather than
    // after a two-minute scan — and never silently, which would leave the user
    // believing an eval ran when it did not. --eval-command beats the file.
    let repoConfig: RepoConfig = {};
    try {
      repoConfig = loadRepoConfig(resolved);
    } catch (err) {
      console.error(`mendr: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
    // WHICH GATES MUST PASS, resolved once for the whole run: the built-in
    // defaults overlaid with the repo's `gates` block (see gates/policy.ts).
    // Nothing below re-derives a requirement — a second opinion about whether
    // tests are mandatory is how the report and the exit code drift apart.
    const policy: ResolvedGatePolicy = resolveGatePolicy(repoConfig, opts.evalCommand);
    const evalCommand = policy.eval.command;

    /**
     * EVERY GATE OUTCOME, kept for the `--json` document. A machine consumer
     * needs the same itemization the human summary gets: which gate, in which
     * language, what it returned, whether policy required it, and whether it is
     * what blocked the fix. Collapsing that to one boolean is the same mistake
     * on the machine side that a single "verified" is on the human side.
     */
    const gateOutcomes: {
      gate: GateName;
      language: 'typescript' | 'python' | 'repo';
      outcome: GateOutcome;
      detail: string | null;
      required: boolean;
      blocking: boolean;
    }[] = [];
    const recordGateOutcomes = (
      language: 'typescript' | 'python' | 'repo',
      evaluations: readonly GateEvaluation[],
      blocks: readonly GateBlock[],
    ): void => {
      const blocked = new Set(blocks.map((b) => b.gate));
      for (const e of evaluations) {
        gateOutcomes.push({
          gate: e.gate,
          language,
          outcome: e.outcome,
          detail: e.detail ?? null,
          required: policy[e.gate].required,
          blocking: blocked.has(e.gate),
        });
      }
    };

    // Registry-driven detect. Three locators run over the repo:
    //   1. TS model-id literals whose value exactly matches a retired model id;
    //   2. TS model-COUPLED param sites (options objects whose resolved model is
    //      in an entry's on_models). A `temperature` on an accepting model is
    //      NOT a site — the coupling is enforced in the locator, not the fixer;
    //   3. PYTHON model-id literals, scanned with tree-sitter (src/python/) and
    //      reported under their own "(python)" tier heading because Python's
    //      gate (syntax re-parse) is weaker than the TS type-check gate.
    const registry = loadLlmRegistry();
    // Freshness guard, on STDERR: visible in --json mode without corrupting
    // its stdout, and never mistaken for a finding in the human report.
    const staleWarning = staleRegistryWarning(registry);
    if (staleWarning) console.error(staleWarning);

    // PRE-FILTER (perf): walk the repo once, text-test every source file
    // against one compiled regex of all registry tokens, and parse ONLY the
    // hits. The walked total keeps the coverage claim honest — every file was
    // visited and tested, even though only the matches paid for an AST. The
    // pre-filter cannot miss a finding: every locator needs a registry token
    // verbatim in the file text (see buildRegistryPrefilter).
    const prefilter = buildRegistryPrefilter(registry);
    const {
      project: scanProject,
      totalFiles: tsFileCount,
      matchedFiles: tsMatched,
    } = loadPrefilteredProject(resolved, prefilter);
    const pyFiles = collectPythonFiles(resolved);
    assertAnalyzable(tsFileCount, pyFiles.length, resolved);

    // Python gets the same text pre-filter: read once, parse only the hits.
    const pySourcesAll = readPythonSources(pyFiles);
    const pySources = prefilter ? pySourcesAll.filter((s) => prefilter.test(s.text)) : [];

    // The per-language breakdown appears as soon as any Python is in scope, so
    // "Scanned 42 source files" never silently means "42 TS files, Python
    // ignored". A TS-only repo keeps the original single-count line.
    const totalFiles = tsFileCount + pyFiles.length;
    const totalMatched = tsMatched + pySources.length;
    say(
      pyFiles.length > 0
        ? `Scanned ${totalFiles} source file${totalFiles === 1 ? '' : 's'} (${tsFileCount} ts, ${pyFiles.length} py; ` +
            `${totalMatched} matched the registry pre-filter and ${totalMatched === 1 ? 'was' : 'were'} parsed).`
        : `Scanned ${tsFileCount} source file${tsFileCount === 1 ? '' : 's'} ` +
            `(${tsMatched} matched the registry pre-filter and ${tsMatched === 1 ? 'was' : 'were'} parsed).`,
    );

    /** Repo-relative display path with forward slashes. */
    const rel = (file: string): string => relative(resolved, file).replace(/\\/g, '/');

    // File-level mendr annotations (both languages): `model-catalog` files
    // collapse to one expected-content line each, `ignore-file` files are
    // skipped entirely and surface only as a count.
    const tsAnnotations = scanProjectAnnotations(scanProject, registry);
    const pyAnnotations = scanPyAnnotations(pySources, registry);
    const catalogFiles = [...tsAnnotations.catalogs, ...pyAnnotations.catalogs].map((c) => ({
      file: rel(c.file),
      ids: c.ids,
    }));
    const ignoredFiles = [...tsAnnotations.ignoredFiles, ...pyAnnotations.ignoredFiles].map(rel);
    if (ignoredFiles.length > 0) {
      say(
        `Skipped ${ignoredFiles.length} file${ignoredFiles.length === 1 ? '' : 's'} ` +
          `annotated 'mendr: ignore-file'.`,
      );
    }

    const modelMatches = findModelIdLiterals(scanProject, registry);
    const paramMatches = findParamSites(scanProject, registry);

    // Python pass: scan + swap + syntax gate, all in memory (see fixPy.ts).
    // Run up front (it is cheap) so the nothing-to-fix check covers BOTH
    // languages — a pure-Python repo must not read as "clean" here.
    const pyResult = await applyPyModelIdFixesToSources(pySources, registry, resolved);

    // Split TS model-id matches by AST position AND verification status into
    // the THREE tiers:
    //   - `model_arg` + verified     -> Tier A, a safe automatic patch;
    //   - `model_arg` + NOT verified -> Tier B, `replacement_unverified`;
    //   - `azure_deployment`         -> Tier B, `platform_blocked`;
    //   - model-like assignment, no sink -> Tier B, `usage_unverified` (py);
    //   - `data` behind an `as` cast -> Tier B, `type_cast_masked`;
    //   - `data` otherwise           -> Tier C, informational (never edited).
    const modelArgMatches = modelMatches.filter((m) => m.position === 'model_arg');
    // findModelIdLiterals emits one match PER MATCHING REGISTRY RECORD (the
    // value->records multimap), so a value with two records surfaces twice at
    // one call site. Collapse those to one physical SITE here — the same way the
    // fixer edits them — so the Tier A count, the occurrence list, and the diff
    // all agree (a no-op on the shipped registry, which has no duplicate values).
    const swapMatches = dedupeSwapsByNode(modelArgMatches.filter((m) => isVerified(m.deprecation)));
    const blockedAll = [...toBlockedModelArgMatches(modelMatches), ...pyResult.blockedMatches];
    const azureAll = [...toAzureDeploymentMatches(modelMatches), ...pyResult.azureMatches];
    // Usage-unverified candidates (Python sink rule): model-like assignments
    // never traced to an in-file sink. Manual review only — never auto-applied.
    const usageUnverifiedAll = pyResult.usageUnverifiedMatches;
    const allDataViews: DataFindingView[] = [
      ...toModelIdDataMatches(modelMatches),
      ...pyResult.dataMatches,
    ].map((d) => ({
      file: rel(d.location.file),
      value: d.value,
      replacement: d.replacement,
      line: d.location.line,
      column: d.location.column,
      purpose: d.purpose,
      reason: d.reason,
    }));
    // The cast guard's matches ride in the DATA stream (the classifier demotes
    // them there so the codemod cannot touch them), but they are not
    // informational: the id is in a live-looking position and only the repo's
    // own type union stands in the way. They are the one data-stream surface
    // that graduates to Tier B; everything else stays Tier C.
    const castMaskedViews = allDataViews.filter((d) => d.reason === TYPE_CAST_REASON);
    const dataViews = allDataViews.filter((d) => d.reason !== TYPE_CAST_REASON);
    const dataGroups = groupDataFindingsByFile(dataViews);

    /**
     * WHAT DID THE REGISTRY RECORD FOR THIS ID? Read from the entry that was
     * actually loaded for this run — the same verdict the engine gate reads to
     * decide whether a swap may be auto-applied, and the same split the footer
     * prints as "98 verified, 3 unverified, 5 unverifiable".
     *
     * NOT a claim that anything was checked during this run: `fix-llm` makes no
     * network call, so the strongest thing that can be said is what the JSON
     * says (see registryVerdictText).
     *
     * PASSED THROUGH, NOT RE-CLASSIFIED. This used to be a switch that named
     * three states and defaulted everything else to `unverified`, which
     * silently renamed the 5 `unverifiable` records — the finding said
     * `unverified`, the footer said `unverifiable`, and `mendr evidence` said
     * `unverifiable`. RegistryVerdict is now the same union
     * effectiveVerificationState returns, so the verdict a reader sees is the
     * state the engine computed, with no second opinion in between.
     *
     * FAIL CLOSED on an id with no entry: that cannot happen (every finding
     * came FROM a registry match), and if it ever did, `unverified` is the only
     * safe thing to say about a mapping whose record we cannot find.
     */
    const modelIdByValue = new Map<string, LlmModelIdDeprecation>();
    for (const entry of modelIdEntries(registry)) {
      if (!modelIdByValue.has(entry.deprecated)) modelIdByValue.set(entry.deprecated, entry);
    }
    const verdictFor = (modelId: string): RegistryVerdict => {
      const state = modelIdByValue.get(modelId);
      return state ? effectiveVerificationState(state) : 'unverified';
    };
    /** The date the registry stamped that verdict, if the entry carries one. */
    const verdictDateFor = (modelId: string): string | undefined =>
      modelIdByValue.get(modelId)?.verification?.checkedAt;
    /**
     * The registry record's stable id, for the `registry entry:` /`evidence:`
     * rows. Undefined only when no entry backs the finding — impossible by
     * construction (every finding came FROM a registry match), and printed as
     * nothing rather than as a guess if it ever happens.
     */
    const entryIdOf = (modelId: string): string | undefined => {
      const entry = modelIdByValue.get(modelId);
      return entry && displayEntryId(entry);
    };
    /** The record's own stated quarantine cause, printed verbatim by the report. */
    const quarantineReasonOf = (modelId: string): string | undefined =>
      modelIdByValue.get(modelId)?.verification?.quarantineReason ?? undefined;
    /** Which structured switches are off, on a `verified` stamp that is withheld. */
    const withheldSwitchesOf = (modelId: string): string[] | undefined => {
      const entry = modelIdByValue.get(modelId);
      if (!entry || effectiveVerificationState(entry) !== 'withheld') return undefined;
      return withheldSwitches(entry);
    };
    /**
     * The extra audit line a HELD-BACK record earns, printed above the
     * registry's own reasons. Without it the detail block reads as a list of
     * caveats under a stamp; with it, the reader knows those caveats are the
     * reason no patch was generated, and which FIELD holds the record back.
     *
     * Note what it no longer does: it used to quote the English fragments that
     * tripped the old regex gate. There is no regex gate any more, so it names
     * the structured field instead — the thing a reviewer edits to change the
     * outcome.
     */
    const heldBackDetail = (status: EffectiveVerificationState | undefined): string[] => {
      if (status === 'quarantined') {
        return [
          'HELD BY MENDR: this record is quarantined in the registry ' +
            '(verification.status = "quarantined"), so it is never auto-applied.',
        ];
      }
      if (status === 'withheld') {
        return [
          'HELD BY MENDR: this record is stamped verified, but a verification switch on it ' +
            'is false, so it is never auto-applied.',
        ];
      }
      return [];
    };

    /**
     * TIER B, assembled from the four EXISTING detection surfaces. Nothing new
     * is detected here — each finding already existed, it just used to be
     * reported under a heading of its own with prose instead of a reason code.
     * Ordering is applied once, in report/tiers.ts, so every surface (human,
     * JSON, --fail-on) sees the same list.
     */
    const tierBFindings: TierBFinding[] = orderTierB([
      ...blockedAll.map((b) =>
        tierBFinding(
          {
            file: rel(b.location.file),
            line: b.location.line,
            column: b.location.column,
            modelId: b.value,
            entryId: entryIdOf(b.value),
            replacement: b.replacement,
            registryVerdict: verdictFor(b.value),
            verdictCheckedAt: verdictDateFor(b.value),
            quarantineReason: quarantineReasonOf(b.value),
            withheldSwitches: withheldSwitchesOf(b.value),
            status: b.status,
            // The verification gate's own audit trail, preserved verbatim --
            // under mendr's own line when the record is held back.
            detail: [...heldBackDetail(b.status), ...(b.reasons ?? [])],
          },
          'replacement_unverified',
        ),
      ),
      ...azureAll.map((a) =>
        tierBFinding(
          {
            file: rel(a.location.file),
            line: a.location.line,
            column: a.location.column,
            modelId: a.value,
            entryId: entryIdOf(a.value),
            replacement: a.replacement,
            registryVerdict: verdictFor(a.value),
            verdictCheckedAt: verdictDateFor(a.value),
            quarantineReason: quarantineReasonOf(a.value),
            withheldSwitches: withheldSwitchesOf(a.value),
          },
          'platform_blocked',
        ),
      ),
      ...usageUnverifiedAll.map((u) =>
        tierBFinding(
          {
            file: rel(u.location.file),
            line: u.location.line,
            column: u.location.column,
            modelId: u.value,
            entryId: entryIdOf(u.value),
            replacement: u.replacement,
            registryVerdict: verdictFor(u.value),
            verdictCheckedAt: verdictDateFor(u.value),
            quarantineReason: quarantineReasonOf(u.value),
            withheldSwitches: withheldSwitchesOf(u.value),
          },
          'usage_unverified',
        ),
      ),
      ...castMaskedViews.map((d) =>
        tierBFinding(
          {
            file: d.file,
            line: d.line,
            column: d.column,
            modelId: d.value,
            entryId: entryIdOf(d.value),
            replacement: d.replacement,
            registryVerdict: verdictFor(d.value),
            verdictCheckedAt: verdictDateFor(d.value),
            quarantineReason: quarantineReasonOf(d.value),
            withheldSwitches: withheldSwitchesOf(d.value),
          },
          'type_cast_masked',
        ),
      ),
    ]);

    const tsSwapCandidates = swapMatches.length + paramMatches.length;
    const autoFixableCount = tsSwapCandidates + pyResult.siteCount;
    /**
     * The three numbers the report prints, derived from the very arrays the
     * sections list. Building them here — once — is what keeps the counts line
     * and the Summary from disagreeing with each other or with the sections.
     */
    const tierCounts: TierCounts = {
      tierA: autoFixableCount,
      tierB: tierBFindings.length,
      tierC: dataViews.length,
    };

    /**
     * EVERY model-id occurrence this scan classified, tagged with the ONE
     * terminal tier it landed in. Two things are built on it:
     *
     *   1. the dev-check below, which proves the "exactly one tier" rule
     *      rather than assuming it (see report/tiers.ts);
     *   2. the clarifying note under the counts, which is only honest BECAUSE
     *      of (1) — "these are different occurrences" is a claim about the
     *      classifier, and it needs to be one that has been checked.
     *
     * Param transforms are deliberately absent: their key would be a PARAM
     * name in the model-id key space, and a collision between the two would be
     * a coincidence of strings rather than a real double classification.
     */
    const tierOccurrences: TierOccurrence[] = [
      ...swapMatches.map((m) => ({
        tier: 'A' as const,
        file: rel(m.location.file),
        line: m.location.line,
        column: m.location.column,
        modelId: m.value,
      })),
      ...pyResult.swapMatches.map((m) => ({
        tier: 'A' as const,
        file: rel(m.location.file),
        line: m.location.line,
        column: m.location.column,
        modelId: m.value,
      })),
      ...tierBFindings.map((f) => ({
        tier: 'B' as const,
        file: f.file,
        line: f.line,
        column: f.column,
        modelId: f.modelId,
      })),
      ...dataViews.map((d) => ({
        tier: 'C' as const,
        file: d.file,
        line: d.line,
        column: d.column,
        modelId: d.value,
      })),
    ];
    // The rule is A > B > C, one tier per (file, line, column, id). A key in
    // two tiers is a classifier bug: fatal under dev-checks so a test can
    // catch it, a loud line in a user's run so a real bug cannot hide but the
    // report they were reading still arrives.
    const tierCollisions = crossTierCollisions(tierOccurrences);
    if (tierCollisions.length > 0) {
      if (devChecksEnabled()) assertSingleTerminalTier(tierOccurrences);
      say(
        `warning: internal tier invariant violated -- ${tierCollisions.length} occurrence` +
          `${tierCollisions.length === 1 ? '' : 's'} classified into more than one tier ` +
          `(${tierCollisions.join('; ')}). Please report this.`,
      );
    }

    /**
     * WHAT THIS RUN COUNTED, checked against the tier counts it printed. The
     * occurrence list above deliberately excludes param transforms (their key
     * would be a param name in the model-id key space), so they are added back
     * by name — see report/runFooter for why an unreconcilable number is worse
     * than no number.
     */
    const uniqueOccurrences = countUniqueOccurrences(
      tierOccurrences,
      paramMatches.length,
      tierCounts,
    );
    /** LOOK unless `--write` was passed. Intent — the outcome is `filesModified`. */
    const mode = runMode(opts.write);

    /**
     * The (g) footer: what this run did + registry provenance + the exact
     * commit that was scanned. Every number is COMPUTED — the registry counts
     * from the registry that was actually loaded (see registryProvenance() for
     * why the old one-line "N entries, verified <date>" was a claim the data
     * did not support), and `filesModified` from the write RESULT, which is why
     * it is a parameter here rather than something this closure infers from
     * `opts.write`. A footer that reported intent would print "files modified:
     * 1" over a refused write.
     */
    const printFooter = async (filesModified: number): Promise<void> => {
      say('');
      for (const line of formatRunFooterLines({
        mode,
        occurrences: uniqueOccurrences,
        filesModified,
      })) {
        say(line);
      }
      for (const line of formatRegistryProvenanceLines(registryProvenance(registry))) say(line);
      // Best-effort commit anchor — a non-git directory skips this silently.
      try {
        const sha = (await simpleGit(resolved).revparse(['--short', 'HEAD'])).trim();
        say(`scanned commit: ${sha}`);
      } catch {
        /* not a git repo — no commit line */
      }
    };

    /**
     * Apply the --fail-on gate (exitCode, not exit, so stdout flushes). Both
     * classes read the SAME counts the report printed — a job that failed must
     * be able to point at the number on screen that failed it.
     */
    const applyFailOn = (): void => {
      if (failOn === 'tierA' && tierCounts.tierA > 0) process.exitCode = 1;
      if (failOn === 'tierB' && tierCounts.tierB > 0) process.exitCode = 1;
    };

    if (tierCounts.tierA === 0 && tierCounts.tierB === 0 && tierCounts.tierC === 0) {
      say('No deprecated LLM model ids or model-coupled params found. Nothing to fix.');
      // Annotated catalogs are still NAMED (expected content, not debt) so a
      // clean repo's report explains where its known ids live.
      if (catalogFiles.length > 0) {
        say('');
        for (const c of catalogFiles) say(formatCatalogLine(c));
      }
      // Nothing was found, so nothing could have been written -- even under
      // --write. The 0 is a fact about this run, not a default.
      await printFooter(0);
      if (json) {
        console.log(
          JSON.stringify(
            {
              summary: {
                tierA: 0,
                tierB: 0,
                tierC: 0,
                // The same three run facts the footer printed.
                mode,
                uniqueOccurrences: uniqueOccurrences.total,
                filesModified: 0,
                // DEPRECATED (see README): kept for one release so existing
                // consumers keep parsing. They are the same zeroes as the tier
                // counts here, and on a non-empty scan they are DERIVED from
                // the tier arrays rather than tallied separately.
                blocked: 0,
                informational: 0,
                usageUnverified: 0,
                filesScanned: totalFiles,
                tsFiles: tsFileCount,
                pyFiles: pyFiles.length,
                // Machine consumers get the same boundary the human report
                // prints: mendr's gates cover code, never model behavior.
                behavioralVerification: 'not-tested',
              },
              tierA: [],
              tierB: [],
              blocked: [],
              azure: [],
              informational: [],
              usageUnverified: [],
              catalogs: catalogFiles,
              ignoredFiles,
              diff: '',
            },
            null,
            2,
          ),
        );
      }
      return;
    }

    // (a) SUMMARY FIRST: the whole scan in 2-3 lines, before any section. The
    // catalog context only appears when catalog-like files hold the majority of
    // the informational hits — a minority catalog would mis-summarize the rest.
    const catalogGroups = dataGroups.filter((g) => g.catalogLike);
    const catalogHits = catalogGroups.reduce((n, g) => n + g.hits, 0);
    const catalogCtx =
      catalogGroups.length > 0 && catalogHits * 2 > dataViews.length
        ? ` -- mostly in ${catalogGroups.length} catalog-like file${catalogGroups.length === 1 ? '' : 's'}`
        : '';
    say('');
    // Three tiers, three numbers, plus the Tier B reason breakdown. The old
    // shape listed "azure deployment aliases" and "usage-unverified
    // candidates" as extra classes alongside the counts; both are now reason
    // codes INSIDE Tier B, so the breakdown line carries them without
    // reintroducing a fourth and fifth top-level bucket.
    for (const line of formatFoundLines(tierCounts, tierBFindings, catalogCtx)) say(line);
    // The same deprecated id can legitimately sit in two tiers at two
    // different positions. Said plainly, once, right under the counts it would
    // otherwise make look wrong — and printed only when it actually happens.
    for (const note of multiTierNotes(tierOccurrences)) say(note);

    // Human labels. Model-id: one per unique deprecated -> replacement swap,
    // counting only swap-safe (`model_arg`) positions. Carry the lifecycle so
    // the label says WHY: already retired, or dying on a known date.
    const swaps = new Map<string, LlmModelIdDeprecation>();
    for (const m of swapMatches) swaps.set(m.deprecation.deprecated, m.deprecation);
    // Params: one per unique transform (removal or rename), tagged with model.
    const paramLabelSet = new Set<string>();
    for (const p of paramMatches) {
      paramLabelSet.add(
        p.deprecation.kind === 'param_removal'
          ? `remove "${p.deprecation.param}" (on ${p.model})`
          : `rename "${p.deprecation.param}" -> "${p.deprecation.replacement}" (on ${p.model})`,
      );
    }
    const allLabels = [...[...swaps.values()].map(swapLabel), ...paramLabelSet];
    const labels =
      allLabels.length > 6
        ? `${allLabels.slice(0, 6).join(', ')}, +${allLabels.length - 6} more`
        : allLabels.join(', ');

    // Per-transform breakdown, NON-ZERO parts only — "0 params renamed ()" is
    // noise, never information.
    const breakdown = (r: { modelIdSites: number; paramsRemoved: number; paramsRenamed: number }) =>
      [
        r.modelIdSites > 0 ? `${r.modelIdSites} model-id swap${r.modelIdSites === 1 ? '' : 's'}` : '',
        r.paramsRemoved > 0 ? `${r.paramsRemoved} param${r.paramsRemoved === 1 ? '' : 's'} removed` : '',
        r.paramsRenamed > 0 ? `${r.paramsRenamed} param${r.paramsRenamed === 1 ? '' : 's'} renamed` : '',
      ]
        .filter(Boolean)
        .join(', ');

    // --- TS fix pass (only when there is actually something to swap: blocked
    // and informational findings need no codemod and no gates). -------------
    let tsResult: LlmFixResult | undefined;
    let tsTier: 'A' | 'C' = 'A';
    // Carries `originalText` as well as the patch: --write is all-or-nothing
    // and needs the exact text the codemod read, to prove at write time that
    // the file on disk has not changed under us since the scan.
    let tsPatchedFiles: PendingWrite[] = [];
    let downgradeReason = '';
    // The measurable gate ROWS, kept as data rather than rendered lines: the
    // behavioral half of the summary is not known until the eval gate has run,
    // and the eval gate cannot run until the code gates below have passed.
    let tsGateRows: GateRow[] | undefined;
    let tsTestsPassed = false;
    if (tsSwapCandidates > 0) {
      if (opts.skipGates) {
        // Fast local mode: assert Tier A without verifying. Reuses the scan
        // project directly — the locators above never mutated it.
        tsResult = applyLlmFixesToProject(scanProject, registry, resolved);
      } else {
        // The GATED path still loads the FULL project — twice. The scan project
        // is a pre-filtered mini-project (fast to build, correct for locating),
        // but the type-check gate must judge the patch against everything the
        // repo compiles, so the baseline AND the patched project are complete
        // tsconfig-driven loads. Slow is fine here: gates only run when there
        // is actually something to swap.
        const baselineProject = loadProject(resolved);
        const patchedProject = loadProject(resolved);
        tsResult = applyLlmFixesToProject(patchedProject, registry, resolved);

        // Gate 1: baseline-relative type-check (in-memory, no subprocess).
        const typeResult = checkTypes(baselineProject, patchedProject);

        // Gate 2: run the repo's tests against the patched files in a temp
        // copy. Whether a test gate that could not RUN blocks Tier A is the
        // repo's policy call (`gates.tests.required`), not a constant here.
        tsPatchedFiles = tsResult.changedFiles.map((absPath) => ({
          absPath,
          newText: patchedProject.getSourceFileOrThrow(absPath).getFullText(),
          // The UNPATCHED baseline load of the same repo IS what the codemod
          // read, so it is the right drift reference — not a fresh disk read,
          // which would happily accept a file someone edited meanwhile.
          originalText: baselineProject.getSourceFileOrThrow(absPath).getFullText(),
        }));
        const testResult = await runRepoTests(resolved, tsPatchedFiles);
        tsTestsPassed = testResult.status === 'pass';

        // "pass" here means BASELINE-RELATIVE pass. When the repo already had
        // type errors before the patch, say so — a bare "pass" would overclaim.
        const firstDiagnostic = typeResult.newDiagnostics[0];
        const newErrors = typeResult.newDiagnostics.length;
        const typeEvaluation: GateEvaluation = {
          gate: 'typecheck',
          outcome: typeResult.passed ? 'pass' : 'fail',
          detail: typeResult.passed
            ? typeResult.baselineCount > 0
              ? `no new errors; ${typeResult.baselineCount} pre-existing ignored`
              : 'no new errors'
            : `${newErrors} new type error${newErrors === 1 ? '' : 's'}` +
              (firstDiagnostic ? ` -- ${formatDiagnostic(firstDiagnostic)}` : ''),
        };
        const testEvaluation = testGateEvaluation(testResult);

        // ONE decision, from the policy: every non-passing gate the policy
        // cares about, in the order they ran. A `fail` always blocks; an
        // `inconclusive` blocks only where the repo said it must pass.
        const blocks = gateBlocks(policy, [typeEvaluation, testEvaluation]);
        recordGateOutcomes('typescript', [typeEvaluation, testEvaluation], blocks);
        tsTier = blocks.length === 0 ? 'A' : 'C';
        if (blocks.length > 0) {
          downgradeReason = blocks.map(describeGateBlock).join('; ');
          signalRequiredGateFailure(blocks);
        }
        // Two NAMED groups: what was checked (code) and what was not
        // (behavior). EVERY check gets its own row and its own outcome word —
        // the tests row carries real parsed counts where the runner's summary
        // allowed, and says `inconclusive` (never `passed`) where it could not
        // run at all.
        tsGateRows = [
          ...registryVerdictRows([...swaps.values()]),
          {
            label: 'usage verdict',
            state: 'confirmed',
            detail: 'live model argument at the call site',
          },
          {
            label: 'syntax',
            state: 'n/a',
            detail: 'typescript -- the type-check gate below subsumes parsing',
          },
          gateRowOf('type-check', typeEvaluation, policy.typecheck.required),
          gateRowOf('tests', testEvaluation, policy.tests.required),
        ];
      }
    }
    const tsTotalSites = tsResult
      ? tsResult.modelIdSites + tsResult.paramsRemoved + tsResult.paramsRenamed
      : 0;

    // --- Python tier resolution (gates run here; printing happens below). ---
    // Python swaps are NEVER folded into the TS Tier A section: Python's
    // strongest gate is a baseline-relative syntax re-parse, strictly weaker
    // than the TS type-check gate, and the separate heading keeps that weaker
    // verification visible instead of blending it away.
    let pyTier: 'A' | 'C' | undefined;
    let pyTestRow: GateRow = {
      label: 'tests',
      state: 'inconclusive',
      detail: 'mendr has no python test runner -- only `npm test` is supported',
    };
    let pyDowngradeReason = '';
    if (pyResult.siteCount > 0) {
      // The test gate. Mendr's only runner today is `npm test`, so a pure-Python
      // repo gets `inconclusive` — there may well be a pytest suite mendr cannot
      // reach, and "not configured" would claim otherwise. When the runner does
      // run, the row carries parsed pass/fail counts where the output allows.
      let testEvaluation: GateEvaluation = {
        gate: 'tests',
        outcome: 'inconclusive',
        detail: 'mendr has no python test runner -- only `npm test` is supported',
      };
      if (opts.skipGates) {
        // No evaluation is recorded: `--skip-gates` asserts the tier instead of
        // earning it, so there is no outcome for the policy to judge.
        pyTestRow = { label: 'tests', state: 'skipped', detail: '--skip-gates' };
      } else if (existsSync(join(resolved, 'package.json'))) {
        const testResult = await runRepoTests(resolved, pyResult.patchedFiles);
        testEvaluation = testGateEvaluation(testResult);
        pyTestRow = gateRowOf('tests', testEvaluation, policy.tests.required);
      } else {
        pyTestRow = gateRowOf('tests', testEvaluation, policy.tests.required);
      }
      // The syntax gate ALWAYS ran (inside the fix pass — an in-memory
      // re-parse is essentially free), even under --skip-gates: a patch we
      // KNOW breaks parsing must never be presented as Tier A. It is not a
      // configurable gate: a patch that does not parse is never fixable.
      const blocks = opts.skipGates ? [] : gateBlocks(policy, [testEvaluation]);
      if (!opts.skipGates) recordGateOutcomes('python', [testEvaluation], blocks);
      pyTier = pyResult.syntaxGate.passed && blocks.length === 0 ? 'A' : 'C';
      if (pyTier === 'C') {
        pyDowngradeReason = !pyResult.syntaxGate.passed
          ? `patched code introduces new syntax errors (${pyResult.syntaxGate.failures[0] ?? 'unknown file'})`
          : blocks.map(describeGateBlock).join('; ');
        signalRequiredGateFailure(blocks);
      }
    }

    // --- THE EVAL GATE: the only check in mendr that touches BEHAVIOR. -------
    //
    // It runs under three conditions, all of them deliberate:
    //   1. ONLY when the team configured a command — mendr never invents a
    //      quality metric, so an unconfigured repo stays honestly "not tested";
    //   2. ONLY after the code gates passed — running someone's eval against a
    //      patch that does not even compile wastes minutes to learn nothing;
    //   3. ONCE, over the union of both languages' patched files, because the
    //      eval judges the repo as a whole, not a language.
    // A FAILING eval downgrades exactly like a failing test gate: the diff is
    // shown, the fix is not applied, --write refuses. A behavioral regression
    // that mendr was told how to detect must never be written to a working tree.
    //
    // THE GATE FAILS CLOSED. A configured eval that did not produce a clean
    // pass — timed out, could not be spawned, died on infra — blocks the write
    // exactly like a failing one. It used to warn on stderr and apply the fix
    // anyway, which is the worst of both worlds: the user asked for behavioral
    // verification, did not get it, and got the write regardless. "I could not
    // check" is not a reason to proceed; it is the reason not to.
    let evalResult: EvalGateResult = { status: 'not-configured' };
    /**
     * Why the eval did not run, when a command WAS configured. Without this the
     * report printed "behavioral evaluation: not configured" over a repo whose
     * config names one — and told the reader to go configure the thing they had
     * already configured.
     */
    let evalNotRunReason: string | undefined;
    const codeGatesPassed =
      (tsTotalSites === 0 || tsTier === 'A') && (pyResult.siteCount === 0 || pyTier === 'A');
    const anyTierA =
      (tsTier === 'A' && tsTotalSites > 0) || (pyTier === 'A' && pyResult.siteCount > 0);
    if (evalCommand && !opts.skipGates && !codeGatesPassed) {
      evalNotRunReason =
        'not started -- the code gates above did not pass, so mendr never ran your eval';
    }
    if (evalCommand && !opts.skipGates && codeGatesPassed && anyTierA) {
      // Progress goes to STDERR (an eval can take minutes, and with --json
      // stdout must carry only the document).
      console.error(`Running your evaluation against the patched code: ${evalCommand}`);
      evalResult = await runRepoEval(
        resolved,
        [...tsPatchedFiles, ...pyResult.patchedFiles],
        { command: evalCommand, timeoutMs: repoConfig.evalTimeoutMs },
      );
    }

    // THE EVAL GATE'S OUTCOME, judged by the same policy as the code gates. A
    // `fail` blocks whatever the policy says (a behavioral regression mendr was
    // told how to detect is never written); `inconclusive` and `not-configured`
    // block only when the eval gate is required — which it is by default the
    // moment a command exists, so the fail-closed behavior is unchanged.
    const evalEvaluation: GateEvaluation = {
      gate: 'eval',
      outcome:
        evalResult.status === 'not-configured'
          ? evalNotRunReason
            ? 'inconclusive'
            : 'not-configured'
          : evalResult.status,
      detail:
        evalResult.status === 'fail'
          ? `${evalResult.command}, exit ${evalResult.exitCode}`
          : // Names the CASE, not just the outcome: "timed out" and "could not
            // be spawned" send a user to completely different fixes, and both
            // are different again from "your model regressed".
            (evalResult.output ?? evalNotRunReason),
    };
    const evalBlocks = opts.skipGates ? [] : gateBlocks(policy, [evalEvaluation]);
    if (!opts.skipGates) recordGateOutcomes('repo', [evalEvaluation], evalBlocks);
    if (evalBlocks.length > 0) {
      const reason = evalBlocks.map(describeGateBlock).join('; ');
      if (tsTotalSites > 0 && tsTier === 'A') {
        tsTier = 'C';
        downgradeReason = reason;
      }
      if (pyResult.siteCount > 0 && pyTier === 'A') {
        pyTier = 'C';
        pyDowngradeReason = reason;
      }
      // Hard signal, with or without --write: a script that ran mendr must be
      // able to see in $? that the fix was not verified and not applied. A
      // failing eval always sets it -- that has never been optional -- and a
      // required-but-unrunnable one now does too.
      process.exitCode = 1;
      if (evalResult.status === 'inconclusive') {
        // Also on stderr, where it survives --json (stdout is the document).
        console.error(`mendr: eval gate could not run -- ${evalResult.output}`);
        console.error('mendr: the fix is NOT applied -- an eval that did not run verifies nothing.');
      } else if (evalResult.status === 'not-configured') {
        console.error(
          `mendr: ${reason}`,
        );
      }
    }

    /**
     * What the report may claim about behavior. Anything short of a completed
     * passing/failing run is `not-tested` — an eval that timed out proves
     * nothing, and must not read as a softer kind of pass.
     */
    const behavioral: BehavioralVerificationView =
      evalResult.status === 'pass' || evalResult.status === 'fail'
        ? { status: evalResult.status, command: evalResult.command, exitCode: evalResult.exitCode }
        : {
            status: 'not-tested',
            // An inconclusive run is still `not-tested` — nothing was verified —
            // but it carries WHY, so the disclaimer does not tell a user who
            // configured an eval to go configure one. Same for a configured
            // eval mendr never started because the code gates had already
            // failed: that is not "not configured" either.
            ...(evalResult.status === 'inconclusive'
              ? { reason: evalResult.output }
              : evalNotRunReason
                ? { reason: evalNotRunReason }
                : {}),
          };
    const gateLines = tsGateRows
      ? formatGateSummary(tsGateRows, behavioral, policy.eval.required)
      : [];

    // --- Section 1 (most urgent): the Tier A diff. --------------------------
    if (tsTotalSites > 0 && tsResult) {
      const heading =
        tsTier === 'A'
          ? opts.skipGates
            ? '=== Tier A: auto-fixable model-id + param codemod ==='
            : '=== Tier A: auto-fixable model-id + param codemod (VERIFIED) ==='
          : // NOT "downgraded to Tier C": under the three-tier vocabulary Tier C
            // means an informational DATA occurrence, and a reader who counted
            // the Tier C findings would never find these among them. A gate
            // failure is a disposition of a Tier A candidate, not a
            // reclassification of what was detected.
            '=== Tier A candidate -> NOT APPLIED (gates failed, review only) ===';
      say('');
      say(heading);
      say('');
      say(tsResult.diff);
      for (const line of gateLines) say(line);
      if (gateLines.length > 0) say('');
      if (tsTier === 'A') {
        say(
          `Tier A: ${breakdown(tsResult)} (${labels}) across ` +
            `${tsResult.changedFiles.length} file${tsResult.changedFiles.length === 1 ? '' : 's'}. ` +
            (opts.skipGates
              ? '(gates skipped -- tier asserted, not verified)'
              : `(verified: type-check passes${tsTestsPassed ? ' + tests pass' : ''}` +
                // The ONLY behavioral phrase Tier A is allowed: the team's own
                // eval passed. Not "the model is equivalent", not "safe to
                // ship" — mendr has no idea what their eval measures.
                `${behavioral.status === 'pass' ? ' + your eval command passed' : ''})`),
        );
      } else {
        say(
          `Tier A (NOT applied): ${breakdown(tsResult)} (${labels}) -- ` +
            `${downgradeReason.replace(/\.+$/, '')}. ` +
            `The diff above is shown for manual review only; it is not trusted.`,
        );
      }
      // WHICH RECORDS AUTHORISED THIS EDIT. Printed under both dispositions:
      // an applied patch and a gate-failed candidate rest on the same records,
      // and the reader of the second one is likelier to want to go check them.
      for (const line of formatRegistryEntryLines(
        [...swaps.values()],
        // The SAME three-row shape Tier B prints, under the disposition this
        // patch actually earned: a gate-failed candidate is still Tier A, and
        // saying "will apply with --write" over it would be false.
        // `mode` is passed because this section renders BEFORE the write is
        // attempted: under --write the row must not promise a future --write.
        tsTier === 'A' ? classificationText('A', mode) : TIER_A_DOWNGRADED_CLASSIFICATION,
      )) {
        say(line);
      }
    }

    // Python Tier A, under its own heading with its own (weaker) gates. The
    // heading never claims VERIFIED: Python's strongest in-process check is a
    // syntax re-parse, so the gate lines below spell out exactly which
    // guarantees were earned instead of one overclaiming word. Every applied
    // Python swap is sink-verified by construction (the sink rule only grants
    // `model_arg` to literals that reach a recognized sink).
    if (pyResult.siteCount > 0 && pyTier) {
      const heading =
        pyTier === 'A'
          ? '=== Tier A (python): auto-fixable model-id codemod ==='
          : '=== Tier A candidate (python) -> NOT APPLIED (gates failed, review only) ===';
      say('');
      say(heading);
      say('');
      say(pyResult.diff);
      for (const line of formatGateSummary(
        [
          ...registryVerdictRows(pyResult.swapDeprecations),
          {
            label: 'usage verdict',
            state: 'confirmed',
            detail: 'recognized model sink (python sink rule)',
          },
          {
            label: 'syntax',
            state: pyResult.syntaxGate.passed ? 'passed' : 'failed',
            detail: 'baseline-relative re-parse of every patched file',
          },
          {
            // NOT "not configured": mendr does not run mypy/pyright at all, so
            // there is no type-check gate here to configure. Calling it n/a is
            // the honest word -- and it is why `gates.typecheck.required` does
            // not block a python-only repo (see gates/policy.ts).
            label: 'type-check',
            state: 'n/a',
            detail: 'mendr runs no type checker for python',
          },
          pyTestRow,
        ],
        behavioral,
        policy.eval.required,
      )) {
        say(line);
      }
      say('');

      const pyLabels = pyResult.swapDeprecations.map(swapLabel).join(', ');
      const n = pyResult.siteCount;
      const nf = pyResult.changedFiles.length;
      if (pyTier === 'A') {
        say(
          `Tier A (python): ${n} model-id swap${n === 1 ? '' : 's'} (${pyLabels}) across ` +
            `${nf} file${nf === 1 ? '' : 's'}. ` +
            (opts.skipGates
              ? '(gates skipped -- tier asserted, not verified; syntax re-parse still ran)'
              : '(gates: verified mapping + sink-verified usage + syntax re-parse -- weaker than the TS type gate' +
                `${behavioral.status === 'pass' ? '; your eval command passed' : ''})`),
        );
      } else {
        say(
          `Tier A (python, NOT applied): ${n} model-id swap${n === 1 ? '' : 's'} (${pyLabels}) ` +
            `-- ${pyDowngradeReason}. ` +
            'The diff above is shown for manual review only; it is not trusted.',
        );
      }
      for (const line of formatRegistryEntryLines(
        pyResult.swapDeprecations,
        pyTier === 'A' ? classificationText('A', mode) : TIER_A_DOWNGRADED_CLASSIFICATION,
      )) {
        say(line);
      }
    }

    // (e) EMPTY Tier A: one honest line — never a VERIFIED header over nothing.
    if (tsTotalSites === 0 && pyResult.siteCount === 0) {
      say('');
      say('Tier A: nothing auto-fixable.');
    }

    // Consistency check: a single migration should not scatter one repo across
    // model FAMILIES (a gpt-4.1 here, a gpt-5.6-sol there). One line, only when
    // the applied swaps actually mix families — aligned repos stay quiet.
    const replacementTargets = new Set<string>([
      ...[...swaps.values()].map((d) => d.replacement),
      ...pyResult.swapDeprecations.map((d) => d.replacement),
    ]);
    const families = new Set([...replacementTargets].map(replacementFamily));
    if (families.size > 1) {
      say('');
      say(
        `note: this repo would get ${replacementTargets.size} different replacement targets ` +
          `(${[...replacementTargets].join(', ')}) -- consider aligning on one before merging.`,
      );
    }

    // --- Section 2: TIER B, the whole middle class in one place. These used
    // to be three sections (blocked model args, azure deployment aliases,
    // usage-unverified assignments) plus a cast-guard line buried in the
    // informational stream. They share one shape — a known dead id, a known
    // replacement, and a specific missing proof — so they share one section,
    // one machine-readable reason code each, and one flat statement that no
    // patch exists. Ordered between Tier A and Tier C by actionability.
    if (tierBFindings.length > 0) {
      say('');
      for (const line of formatTierBSection(tierBFindings)) say(line);
    }

    // --- Section 3 (least urgent, so last + collapsed): TIER C informational
    // data findings, ONE line per file. Full per-hit detail lives behind
    // --verbose; the file list is capped so a catalog-heavy repo cannot flood
    // the report.
    if (dataViews.length > 0) {
      say('');
      say(
        `=== Tier C: informational -- deprecated ids in data positions ` +
          `(${dataViews.length} hit${dataViews.length === 1 ? '' : 's'} ` +
          `in ${dataGroups.length} file${dataGroups.length === 1 ? '' : 's'}; --verbose for every hit) ===`,
      );
      if (opts.verbose) {
        for (const d of dataViews) say(`  ${formatDataHitLine(d)}`);
      } else {
        const MAX_FILES = 10;
        for (const g of dataGroups.slice(0, MAX_FILES)) say(`  ${formatDataFileGroupLine(g)}`);
        if (dataGroups.length > MAX_FILES) {
          say(`  +${dataGroups.length - MAX_FILES} more files -- run with --verbose for the full list`);
        }
      }
    }

    // --- Section 4: annotated migration catalogs — expected registry content,
    // one line per file, no action and no debt claim.
    if (catalogFiles.length > 0) {
      say('');
      say("=== Known migration catalogs (annotated 'mendr: model-catalog') ===");
      for (const c of catalogFiles) say(`  ${formatCatalogLine(c)}`);
    }

    // Combined cross-language summary, in the SAME three-tier vocabulary and
    // carrying the SAME three numbers as the `Found:` block — so a reader can
    // check the top of the report against the bottom and find them equal.
    // Tier A is the only tier with a disposition: its candidates either landed
    // as a verified patch or were downgraded by a failing gate. (The downgraded
    // ones stay Tier A candidates in the count; they are printed under their
    // own DOWNGRADED heading, not folded into Tier B, which is a detection
    // class rather than a gate outcome.)
    const tsApplied = tsTier === 'A' ? tsTotalSites : 0;
    const pyApplied = pyTier === 'A' ? pyResult.siteCount : 0;
    // The tier NUMBER is the locator's count (what `Found:` printed); the
    // disposition splits it. The clamp exists because the gated path re-loads
    // the FULL tsconfig project and tallies applied sites there, while the
    // count came from the pre-filtered scan project — they agree in practice
    // (the pre-filter cannot miss a finding) but the split must never be able
    // to print a negative, or claim a disposition for more sites than were
    // counted.
    const gatedSites = Math.min(tsApplied + pyApplied, tierCounts.tierA);
    // "auto-fixed" means the working tree CHANGED, so it may only be claimed by
    // a run that actually writes: --write, with the gates really run. Without
    // it the patch exists only on screen, and the Summary used to print
    // "N auto-fixed" three lines above "To apply: re-run with --write".
    const thisRunWrites = !!opts.write && !opts.skipGates;

    // --- THE WRITE, RUN BEFORE THE SUMMARY IS COMPUTED ---------------------
    //
    // This used to sit BELOW the Summary block, which meant the summary was
    // computed from the INTENT to write and printed before the write was
    // attempted. A read-only file (or one locked by an editor) aborts the
    // atomic write with zero files changed — and the report still said
    // `Summary: tier A 3 (3 auto-fixed)` over a working tree nobody had
    // touched. Exit code and a stderr line were the only signals that the
    // headline number was wrong.
    //
    // So the transaction happens first and the summary reads its RESULT. The
    // eval-failure path already worked this way (it downgrades the tier before
    // the summary prints); this is the same rule applied to the other way a
    // Tier A fix can fail to land. The user-facing MESSAGES still print in
    // their old position, below the summary, from the outcome recorded here.
    const pyOriginalByPath = new Map(pySources.map((s) => [s.path, s.text]));
    const pending: PendingWrite[] = [];
    const writeLanguages: string[] = [];
    if (thisRunWrites && tsTier === 'A' && tsPatchedFiles.length > 0) {
      pending.push(...tsPatchedFiles);
      writeLanguages.push(`${tsPatchedFiles.length} ts`);
    }
    if (thisRunWrites && pyTier === 'A' && pyResult.patchedFiles.length > 0) {
      // Every patched path came from `pySources` by construction — the fix
      // pass only edits text it was handed.
      for (const f of pyResult.patchedFiles) {
        pending.push({ ...f, originalText: pyOriginalByPath.get(f.absPath)! });
      }
      writeLanguages.push(`${pyResult.patchedFiles.length} py`);
    }
    // Each language still EARNS its own tier separately — a TS downgrade must
    // not block a verified python fix, and vice versa — but the WRITE itself is
    // ONE all-or-nothing transaction across both. A TS+Python repo whose TS
    // files land and whose .py files fail is the half-migrated state that is
    // strictly worse than not running mendr at all (see fix/atomicWrite).
    const writeAttempted = thisRunWrites && pending.length > 0;
    const writeResult: AtomicWriteResult = writeAttempted
      ? writeAllOrNothing(pending)
      : { written: [], rolledBack: false };
    const writeApplied = writeResult.written.length > 0;
    /**
     * WHAT THE WORKING TREE ACTUALLY DID, in the shape the summary and the
     * `--json` document both read. `applied: false` with `attempted: true` is
     * the refusal case: the patch was ready, the gates passed, and NOTHING was
     * written.
     */
    const writeOutcome = {
      attempted: writeAttempted,
      applied: writeApplied,
      filesWritten: writeResult.written.length,
      reason: writeAttempted && !writeApplied ? (writeResult.error ?? 'write failed') : null,
    };

    say('');
    for (const line of formatSummaryLines(tierCounts, {
      // `auto-fixed` is claimable ONLY once the files are on disk.
      applied: writeApplied ? gatedSites : 0,
      // A run that never attempted a write leaves its patches READY; one whose
      // write was refused leaves them unwritten for a different reason, and the
      // two must not share a word.
      ready: thisRunWrites && writeAttempted ? 0 : gatedSites,
      refused: writeAttempted && !writeApplied ? gatedSites : 0,
      downgraded: tierCounts.tierA - gatedSites,
    })) {
      say(line);
    }

    // -o keeps the TS diff regardless of tier (long-standing behavior: the
    // console labels its trust), but a downgraded python diff FAILED its syntax
    // gate — a known-broken patch never lands in a file meant for `git apply`.
    const combinedDiff = [tsResult?.diff ?? '', pyTier === 'A' ? pyResult.diff : '']
      .filter(Boolean)
      .join('\n');
    if (opts.output && combinedDiff) {
      writeDiffOrExit(opts.output, combinedDiff);
      say('');
      say(`Wrote diff to ${opts.output}.`);
    } else if (opts.output && !combinedDiff) {
      say('');
      say(`No auto-fixable changes; did not write ${opts.output}.`);
    }

    if (opts.write && opts.skipGates) {
      say(
        '\nnote: --write applies only the VERIFIED (gated) fix. ' +
          're-run without --skip-gates to write.',
      );
    } else if (opts.write) {
      // The transaction itself already ran, up above the Summary block (see
      // "THE WRITE, RUN BEFORE THE SUMMARY IS COMPUTED"). What is left here is
      // REPORTING it, in the position users have always read it.
      const downgraded = (tsTier === 'C' && tsTotalSites > 0) || pyTier === 'C';

      if (writeApplied) {
        const n = writeResult.written.length;
        say('');
        say(
          `Applied the verified Tier A fix to ${n} file${n === 1 ? '' : 's'} ` +
            `(${writeLanguages.join(' + ')}) in ${resolved} -- all-or-nothing: every file ` +
            `landed, or none would have.`,
        );
        if (writeResult.error) {
          // Fully written, but mendr could not clean up after itself. Warn —
          // do NOT claim failure, because the migration did land.
          console.error(`mendr: ${writeResult.error}`);
        }
      } else if (writeResult.error) {
        // A failed --write is never silent and never partial. STDERR, so the
        // failure is visible in --json mode too (where stdout is the document).
        console.error('');
        console.error(`mendr: --write aborted -- ${writeResult.error}`);
        if (writeResult.restoreFailures?.length) {
          console.error(
            'YOUR WORKING TREE IS IN A MIXED STATE -- restore the files named above ' +
              'from version control before you build or ship.',
          );
        } else {
          console.error('no files were changed.');
        }
        process.exitCode = 1;
      }
      if (downgraded) {
        say('');
        say(
          // "did not pass its gates" rather than the old "was not verified":
          // a FAILING eval or test gate is a verification that came back
          // negative, which "not verified" reads as merely unchecked.
          'Refusing to --write the Tier A candidates that failed their gates ' +
            '(reason above). ' +
            'Review their diff above and apply by hand if it is correct.',
        );
      }
      if (!writeAttempted && !downgraded) {
        say('');
        say('Nothing to --write (no verified Tier A changes).');
      }
    } else if (
      !opts.skipGates &&
      ((tsTier === 'A' && tsResult?.diff) || (pyTier === 'A' && pyResult.diff))
    ) {
      say('');
      say('To apply: re-run with --write, or pipe the diff above into `git apply`.');
    }

    // The boundary, restated once at the very end of a Tier A report. The gate
    // summary already names it, but the summary scrolls past — this is the last
    // thing a reader sees before acting on the diff. Human mode only: machine
    // consumers get the same fact as `summary.behavioralVerification` below.
    //
    // `--skip-gates` gets its OWN sentence: the default one says "mendr
    // verified the CODE only -- see the gate summary above", and under this
    // flag both halves are false (nothing was verified, and the flag suppressed
    // the summary it points at).
    if ((tsTier === 'A' && tsTotalSites > 0) || (pyTier === 'A' && pyResult.siteCount > 0)) {
      say('');
      say(behavioralVerificationNote(behavioral, !!opts.skipGates));
    }

    await printFooter(writeOutcome.filesWritten);

    // (h) machine-readable report: same findings, plain data, diff included.
    if (json) {
      console.log(
        JSON.stringify(
          {
            summary: {
              // The three-tier counts — the same three numbers the human
              // `Found:` and `Summary:` blocks print, from the same object.
              tierA: tierCounts.tierA,
              tierB: tierCounts.tierB,
              tierC: tierCounts.tierC,
              // The three run facts the footer printed, verbatim. `mode` is
              // intent (was --write passed), `filesModified` is outcome (what
              // the write actually returned), and `uniqueOccurrences` is the
              // number that must equal the three counts above it.
              mode,
              uniqueOccurrences: uniqueOccurrences.total,
              filesModified: writeOutcome.filesWritten,
              // DEPRECATED (see README): the pre-three-tier keys, kept for one
              // release so existing consumers keep parsing. They are DERIVED
              // from the tier arrays — filtering `tierB` by reason code and
              // reading `tierC`'s length — rather than tallied independently,
              // so they cannot drift away from the tier counts above.
              blocked: tierBFindings.filter((f) => f.reason === 'replacement_unverified').length,
              informational: tierCounts.tierC,
              usageUnverified: tierBFindings.filter((f) => f.reason === 'usage_unverified').length,
              filesScanned: totalFiles,
              tsFiles: tsFileCount,
              pyFiles: pyFiles.length,
              // The honesty split, machine-readable. Every OTHER gate mendr
              // runs judges CODE (compiles / parses / tests pass); this field
              // is the one behavioral fact, and it is `not-tested` unless the
              // repo configured an eval command that actually completed. No
              // consumer can read Tier A alone as behavioral approval.
              behavioralVerification: behavioral.status,
            },
            /**
             * DID THE WORKING TREE CHANGE? Until this field existed, the only
             * signals that a `--write` run had written nothing were the exit
             * code and a line on stderr — while `summary.tierA` sat there
             * looking like a fix that landed. `attempted` is true whenever
             * `--write` had gated patches to write; `applied` is true only
             * once they are on disk; `reason` carries the abort message
             * verbatim (the same text stderr got), and is null when there is
             * nothing to explain.
             */
            write: writeOutcome,
            /**
             * THE GATES, ITEMIZED. `policy` is what this run required (defaults
             * overlaid with the repo's `gates` block); `outcomes` is what each
             * gate actually returned, with `blocking: true` on the ones that
             * cost the fix its Tier A. An `inconclusive` outcome is never
             * reported as `pass` here either -- the JSON and the printed
             * summary are two renderings of the same records.
             */
            gates: {
              policy: {
                typecheck: { required: policy.typecheck.required },
                tests: { required: policy.tests.required },
                eval: {
                  required: policy.eval.required,
                  command: policy.eval.command ?? null,
                },
              },
              outcomes: gateOutcomes,
            },
            // Every Tier A entry carries the SAME three dimensions the Tier B
            // entries do — `replacementVerdict`, `usageVerdict`, `tier` — so a
            // consumer can read one shape across the report instead of
            // inferring the affirmative case from an array's name.
            // `replacementVerdict` is null on a param transform: that patch
            // rests on no model-id record, and 'verified' over nothing is the
            // overclaim registryVerdictRows already refuses to print.
            tierA: [
              ...swapMatches.map((m) => ({
                file: rel(m.location.file),
                from: m.value,
                to: m.deprecation.replacement,
                status: m.deprecation.status ?? null,
                shutdownDate: m.deprecation.shutdownDate ?? null,
                replacementVerdict: verdictFor(m.value),
                usageVerdict: usageVerdictState('A'),
                tier: 'A' as const,
              })),
              // Param transforms ride in the same array; `status` carries the
              // transform kind since lifecycle does not apply to a param.
              ...paramMatches.map((p) => ({
                file: rel(p.location.file),
                from: p.deprecation.param,
                to: p.deprecation.kind === 'param_rename' ? p.deprecation.replacement : null,
                status: p.deprecation.kind,
                shutdownDate: null,
                replacementVerdict: null,
                usageVerdict: usageVerdictState('A'),
                tier: 'A' as const,
              })),
              ...pyResult.swapMatches.map((m) => ({
                file: rel(m.location.file),
                from: m.value,
                to: m.deprecation.replacement,
                status: m.deprecation.status ?? null,
                shutdownDate: m.deprecation.shutdownDate ?? null,
                replacementVerdict: verdictFor(m.value),
                usageVerdict: usageVerdictState('A'),
                tier: 'A' as const,
              })),
            ],
            // TIER B, first-class: every review-required finding, each with the
            // machine-readable reason code AND its plain-English sentence. This
            // is the array to consume; the three below it are the legacy views.
            tierB: tierBFindings.map(tierBJson),
            // --- DEPRECATED for one release (see README) ---------------------
            // All three are PROJECTIONS of `tierB` (filtered by reason code) or
            // of the Tier C data views — never a second tally. That is what
            // stops the old keys and the new tiers disagreeing about the same
            // repo. New consumers should read `tierB` + `summary.tierB`.
            blocked: tierBFindings
              .filter((f) => f.reason === 'replacement_unverified')
              .map((f) => ({
                file: f.file,
                from: f.modelId,
                to: f.replacement,
                status: f.status,
                line: f.line,
                reasons: f.detail ?? [],
              })),
            azure: tierBFindings
              .filter((f) => f.reason === 'platform_blocked')
              .map((f) => ({
                file: f.file,
                value: f.modelId,
                line: f.line,
                reason: AZURE_DEPLOYMENT_REASON,
              })),
            informational: dataGroups.map((g) => ({
              file: g.file,
              count: g.hits,
              ids: [...g.idLines.keys()],
            })),
            usageUnverified: tierBFindings
              .filter((f) => f.reason === 'usage_unverified')
              .map((f) => ({
                file: f.file,
                from: f.modelId,
                to: f.replacement,
                line: f.line,
                reason: USAGE_UNVERIFIED_REASON,
              })),
            catalogs: catalogFiles,
            ignoredFiles,
            // Present only when the eval gate actually ran, so a consumer can
            // tell "no eval configured" from "the eval was attempted": the
            // inconclusive case still reports behavioralVerification
            // "not-tested", and this object carries the reason it is.
            ...(evalResult.status === 'not-configured'
              ? {}
              : {
                  eval: {
                    command: evalResult.command ?? null,
                    exitCode: evalResult.exitCode ?? null,
                    // `pass` | `fail` | `inconclusive`. The last one is the
                    // fail-closed case: behavioralVerification stays
                    // "not-tested" (nothing was verified) while `reason` says
                    // why, and the fix was NOT applied either way.
                    status: evalResult.status,
                    ...(evalResult.status === 'inconclusive'
                      ? { reason: evalResult.output ?? null }
                      : {}),
                  },
                }),
            diff: combinedDiff,
          },
          null,
          2,
        ),
      );
    }

    applyFailOn();
  });

program
  .command('verify-registry')
  .option('--write', 'stamp the computed verification.status back into the registry JSON')
  .description(
    'Verify every model-id replacement against public catalogs + provider recommendations; print an audit.',
  )
  .action(async (opts: { write?: boolean }) => {
    const registryPath = resolveRegistryPath();
    // Operate on the RAW parsed JSON (not the typed loader) so param entries,
    // ordering, and any unknown fields are preserved verbatim when we --write.
    const raw = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, unknown>[];

    const oracles = await fetchOracles();
    const checkedAt = new Date().toISOString().slice(0, 10);

    console.log('='.repeat(74));
    console.log('MENDR registry verification — public-oracle audit');
    console.log('='.repeat(74));
    console.log(`oracles: ${oracles.notes.join(' | ')}`);
    console.log(`live catalog ids (canonical + family forms): ${oracles.liveIds.size}`);
    console.log('');

    const counts: Record<VerificationStatus, number> = {
      verified: 0,
      quarantined: 0,
      unverified: 0,
      unverifiable: 0,
    };
    const blocked: { status: VerificationStatus; provider: string; from: string; to: string }[] = [];
    /** Entries whose stamp this run CHANGED — the audit's real payload. */
    const flipped: { from: string; was: string; now: VerificationStatus }[] = [];
    let modelEntries = 0;
    let carriedReasons = 0;
    let keptQuarantined = 0;

    for (const entry of raw) {
      if (entry.kind !== 'model_id') continue;
      modelEntries++;
      const model = entry as unknown as LlmModelIdDeprecation;
      const classified = classifyEntry(model, oracles);
      const reasons = classified.reasons;
      const stamped = model.verification?.status ?? 'unstamped';
      // A RECHECK MUST NOT LIFT A QUARANTINE. The classifier answers ONE
      // question -- is the replacement live and uncontradicted in the public
      // catalogs -- and a quarantine is a judgement about something else: that
      // this record is not to be trusted until a human resolves a named
      // problem. Letting a fresh `verified` catalog verdict overwrite
      // `quarantined` would re-open every held record on the next weekly run,
      // which is the exact failure that put those records in quarantine.
      const status: VerificationStatus = stamped === 'quarantined' ? 'quarantined' : classified.status;
      if (status === 'quarantined') keptQuarantined++;
      counts[status]++;
      if (stamped !== status) flipped.push({ from: model.deprecated, was: stamped, now: status });

      console.log(`[${status.toUpperCase().padEnd(12)}] ${model.provider}: ${model.deprecated} -> ${model.replacement}`);
      for (const reason of reasons) console.log(`               - ${reason}`);
      if (status === 'quarantined') {
        console.log(
          `               ! quarantined in the registry -- ` +
            `${model.verification?.quarantineReason ?? 'no reason recorded'}`,
        );
        console.log(
          `               ! catalog verdict this run was "${classified.status}"; the ` +
            'quarantine stands until a human clears it',
        );
      }

      if (status !== 'verified') {
        blocked.push({ status, provider: model.provider, from: model.deprecated, to: model.replacement });
      }
      // A RECHECK MUST NOT ERASE THE RESEARCH either. The classifier's verdict
      // replaces the classifier's PREVIOUS verdict; every hand-written reason
      // is carried through verbatim (see mergeReasons).
      const merged = mergeReasons(reasons, model.verification?.reasons);
      carriedReasons += merged.length - reasons.length;
      if (opts.write) {
        // The three switches come from ONE derivation shared with the
        // migration and the promote gate (see verificationSwitches). A
        // quarantined record is written with auto-apply forced off, so the
        // stamp on disk and the engine's behaviour cannot disagree.
        entry.entryId = entryIdFor(model);
        entry.verification = {
          status,
          ...verificationSwitches(model, classified.status, status === 'quarantined'),
          quarantineReason: status === 'quarantined'
            ? (model.verification?.quarantineReason ?? null)
            : null,
          checkedAt,
          sources: oracles.sources,
          reasons: merged,
        };
      }
    }

    console.log('');
    console.log('-'.repeat(74));
    console.log(`model_id entries: ${modelEntries}`);
    console.log(`  verified     : ${counts.verified}  (auto-apply eligible — Tier A)`);
    // NOT "held by a human". All twelve shipped quarantineReasons come from one
    // of two templates written by the P0 migration, which found them by
    // matching caveat markers in `reasons` -- no person typed any of them. What
    // is true, and what this line is for, is that the hold lives in the FILE
    // and this recheck does not lift it.
    console.log(
      `  quarantined  : ${counts.quarantined}  (held in the registry file; a catalog recheck does not clear one — BLOCKED)`,
    );
    console.log(`  unverified   : ${counts.unverified}  (live but stale/chained/superseded — BLOCKED)`);
    console.log(`  unverifiable : ${counts.unverifiable}  (out-of-class moderation/image/audio/tts — BLOCKED)`);

    if (keptQuarantined > 0) {
      console.log(
        `  (${keptQuarantined} quarantined record${keptQuarantined === 1 ? '' : 's'} kept their ` +
          'quarantine through this recheck — a catalog verdict does not clear one)',
      );
    }

    if (blocked.length > 0) {
      console.log('');
      console.log('BLOCKED from auto-apply (verification gate withholds Tier A):');
      for (const b of blocked) {
        console.log(`  * [${b.status}] ${b.provider}: ${b.from} -> ${b.to}`);
      }
    }

    // WHAT MOVED. The per-entry list above is the audit; this is the DIFF
    // against what shipped, which is the part a reviewer has to sign off on.
    console.log('');
    if (flipped.length === 0) {
      console.log('shipped stamps agree with the live catalogs on every entry.');
    } else {
      console.log(
        `shipped stamps DISAGREE with the live catalogs on ${flipped.length} ` +
          `entr${flipped.length === 1 ? 'y' : 'ies'}:`,
      );
      for (const f of flipped) {
        // The unsafe direction is named as such: a shipped `verified` that live
        // data cannot support is one users may already have auto-applied.
        const unsafe = f.was === 'verified' ? '   <-- shipped verified, live says otherwise' : '';
        console.log(`  ${f.from}: ${f.was} -> ${f.now}${unsafe}`);
      }
    }

    if (opts.write) {
      writeFileSync(registryPath, `${JSON.stringify(raw, null, 2)}\n`);
      console.log('');
      console.log(
        `Stamped verification.status into ${modelEntries} model_id entries ` +
          `(checkedAt ${checkedAt}; kept ${carriedReasons} hand-written reason` +
          `${carriedReasons === 1 ? '' : 's'}) -> ${registryPath}`,
      );
    }
  });

program
  .command('validate-registry')
  .option(
    '--registry <path>',
    'validate a registry at an explicit path (default: the shipped registry)',
  )
  .description('Check the registry for internal contradictions; exit non-zero on any violation.')
  .action((opts: { registry?: string }) => {
    // OFFLINE BY DESIGN. `verify-registry` asks the public catalogs what is
    // true; this asks whether the file contradicts ITSELF, which needs no
    // network and must therefore run on every CI job, not just the weekly one
    // that can be knocked over by a rate limit.
    const registryPath = opts.registry ? resolve(opts.registry) : resolveRegistryPath();
    let registry;
    try {
      registry = loadLlmRegistry(registryPath);
    } catch (err) {
      // A registry that will not LOAD is the most severe violation there is --
      // the loader's own shape rules are part of the contract this command
      // enforces, so a parse failure exits non-zero like any other.
      console.error(`registry INVALID: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    const result = validateRegistry(registry);
    for (const line of formatValidation(result)) console.log(line);
    console.log(`registry: ${registryPath}`);
    if (result.violations.length > 0) process.exitCode = 1;
  });

// --- Provenance + the human gate -----------------------------------------
// Three commands that share ONE invariant: research produces CANDIDATES; only a
// human promotes a candidate into the active registry. `evidence` shows why an
// active entry is believed, `candidates` is the queue and its gate, `discover`
// fills the queue and can touch nothing else.

program
  .command('evidence')
  .argument('<id>', 'a registry entryId, or a deprecated model id present in the registry')
  .description('Show the provenance behind a registry entry: sources, hashes, and quoted excerpts.')
  .action((id: string) => {
    const registry = loadLlmRegistry();
    const entries = modelIdEntries(registry);
    // FOUR ways to name the same record, most specific first:
    //   1. the stamped entryId -- what every finding now prints;
    //   2. the DERIVED entryId, so an id copied off a finding still resolves
    //      against a registry whose records have not been stamped yet;
    //   3. the bare deprecated model id, which is what people typed before
    //      entryIds existed and what they will keep typing;
    //   4. its canonical form, so `GPT-4` or `openai/gpt-4` land on the same
    //      record without ever matching a DIFFERENT model.
    const entry =
      entries.find((e) => e.entryId === id) ??
      entries.find((e) => entryIdFor(e) === id) ??
      entries.find((e) => e.deprecated === id) ??
      entries.find((e) => canonicalizeId(e.deprecated) === canonicalizeId(id));
    if (!entry) {
      console.error(
        `mendr: no registry entry for "${id}" -- expected an entryId ` +
          `(e.g. openai.gpt-4.retirement-2026-10-23) or a deprecated model id ` +
          `(${entries.length} model_id entries loaded from ${resolveRegistryPath()}).`,
      );
      process.exit(2);
    }

    console.log(`${entry.provider}: ${entry.deprecated} -> ${entry.replacement}`);
    console.log(`  registry entry: ${displayEntryId(entry)}`);
    console.log(`  lifecycle    : ${entry.status ?? 'unknown (never claimed dead)'}`);
    console.log(`  shutdown date: ${entry.shutdownDate ?? 'none published'}`);
    console.log(`  source url   : ${entry.sourceUrl ?? 'none recorded'}`);
    const verification = entry.verification;
    console.log(`  verification : ${verification?.status ?? 'unstamped (blocked from auto-apply)'}`);
    // THE FOUR FIELDS THE GATE ACTUALLY READS, shown as fields. This is the
    // page a reader lands on from a finding that says "not auto-applied", and
    // the honest answer to "why" is now a boolean they can look at, not a
    // sentence somebody has to interpret.
    if (verification) {
      const mark = (on: boolean): string => (on ? 'yes' : 'NO');
      console.log(
        `    official source confirmed : ${mark(verification.officialSourceConfirmed)}`,
      );
      console.log(`    replacement confirmed     : ${mark(verification.replacementConfirmed)}`);
      console.log(`    auto-apply allowed        : ${mark(verification.autoApplyAllowed)}`);
    }
    console.log(
      `  engine gate  : ${
        isVerified(entry)
          ? 'PASS -- eligible for a Tier A automatic patch'
          : `HELD -- mendr will not auto-apply this record (${effectiveVerificationState(entry)})`
      }`,
    );
    if (verification?.quarantineReason) {
      console.log(`  quarantined  : ${verification.quarantineReason}`);
    }
    if (verification?.checkedAt) console.log(`    checked at : ${verification.checkedAt}`);
    if (verification?.sources?.length) console.log(`    oracles    : ${verification.sources.join(', ')}`);
    // DOCUMENTATION, not the gate. Said out loud here because this is the one
    // screen where a reader sees the booleans and the prose together, and the
    // old behaviour -- prose overriding the stamp -- is exactly what they
    // might assume is still happening.
    if (verification?.reasons?.length) {
      console.log('  reasons (documentation only -- the gate reads the fields above):');
    }
    for (const reason of verification?.reasons ?? []) console.log(`    - ${reason}`);

    console.log('');
    const evidence = entry.evidence ?? [];
    if (evidence.length === 0) {
      // The honest answer to "why do you believe this?" is sometimes "a person
      // typed it". Saying so is the point of the command.
      console.log('no evidence captured for this entry -- it was hand-seeded.');
      return;
    }
    console.log(`evidence (${evidence.length} captured document${evidence.length === 1 ? '' : 's'}):`);
    const evidenceDir = resolveEvidenceDir();
    for (const ref of evidence) {
      console.log('');
      console.log(`  url        : ${ref.sourceUrl}`);
      console.log(`  retrieved  : ${ref.retrievedAt}`);
      console.log(`  hash       : ${ref.contentHash}`);
      // Say whether the snapshot IS THERE, never just where it would live. A
      // bare path reads as "the audit trail exists, go open it" -- and an
      // entry can carry a ref whose document was never captured (hand-added
      // evidence, or a snapshot that was not committed). That gap is the whole
      // thing this command exists to expose, so it must not be papered over.
      const snapshotPath = join(evidenceDir, snapshotName(ref));
      console.log(
        `  snapshot   : ${
          existsSync(snapshotPath)
            ? snapshotPath
            : `NOT STORED -- no snapshot on disk for this hash (expected ${snapshotPath}); ` +
              'the ref is unbacked, so it cannot be checked offline'
        }`,
      );
      if (ref.excerpt) console.log(`  excerpt    : "${ref.excerpt}"`);
    }
  });

const candidates = program
  .command('candidates')
  .description('Inspect and promote proposed registry entries (the human gate).');

/**
 * The promote gate in one paragraph, reused wherever a surface describes it.
 * ONE wording, because a gate described two ways is a gate nobody can hold to
 * its word — and the second sentence is the one that must never go missing.
 */
const PROMOTE_GATE_SUMMARY =
  'promote verifies that the replacement is live in a public catalog and that the ' +
  'deprecation claim is self-consistent and quote-backed (stated lifecycle, no ' +
  'contradiction with the live catalogs, shutdown date, an excerpt naming the model, ' +
  'a stored snapshot). It does NOT independently confirm the provider retired the model.';

/** Load the queue, exiting with one friendly line instead of a stack trace. */
function loadCandidatesOrExit(): CandidateEntry[] {
  try {
    return loadCandidates();
  } catch (err) {
    console.error(`mendr: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

candidates
  .command('list')
  .description('List pending candidates and the verification status each would carry.')
  .action(() => {
    const queue = loadCandidatesOrExit();
    if (queue.length === 0) {
      console.log(`No pending candidates (${resolveCandidatesPath()} is empty).`);
      return;
    }
    console.log(`${queue.length} pending candidate${queue.length === 1 ? '' : 's'} -- none is active until promoted.`);
    console.log('');
    for (const c of queue) {
      // The status shown is whatever is RECORDED IN THE QUEUE FILE. It is not
      // recomputed here (`list` must stay offline and instant), and — this is
      // the part worth stating — the queue is written by proposers, so a
      // `verified` here may be one an LLM research run typed rather than one
      // `candidates verify` computed. Nothing distinguishes the two on disk, so
      // the line says "as recorded" and points at the gate that re-checks it.
      // Promotion is unaffected either way: promoteCandidates() discards the
      // recorded block and classifies against live oracles itself.
      const status = c.verification
        ? `${c.verification.status} (as recorded in the queue -- re-checked at promote)`
        : 'not yet verified (run: mendr candidates verify)';
      const evidence = c.evidence?.length ?? 0;
      console.log(`  ${c.candidateId}`);
      console.log(`      ${c.provider}: ${c.deprecated} -> ${c.replacement}`);
      console.log(`      would-be status : ${status}`);
      console.log(`      evidence        : ${evidence === 0 ? 'NONE (cannot be promoted)' : `${evidence} ref(s)`}`);
      console.log(`      proposed        : ${c.proposedBy} at ${c.proposedAt}`);
    }
    console.log('');
    console.log('To promote: mendr candidates promote <candidateId...> (explicit ids only).');
    console.log(PROMOTE_GATE_SUMMARY);
  });

candidates
  .command('verify')
  .description('Classify every pending candidate against live oracles and stamp the result.')
  .action(async () => {
    const queue = loadCandidatesOrExit();
    if (queue.length === 0) {
      console.log('No pending candidates to verify.');
      return;
    }
    const oracles = await fetchOracles();
    const checkedAt = new Date().toISOString().slice(0, 10);
    console.log(`oracles: ${oracles.notes.join(' | ')}`);
    console.log('');

    const stamped = queue.map((c) => {
      const { status, reasons } = classifyEntry(c, oracles);
      console.log(`[${status.toUpperCase().padEnd(12)}] ${c.candidateId}: ${c.deprecated} -> ${c.replacement}`);
      for (const reason of reasons) console.log(`               - ${reason}`);
      // The candidate's stamp carries the SAME structured switches the active
      // registry uses, derived by the same helper. A candidate is never
      // auto-appliable (the fix engine does not read this file at all), but a
      // block whose shape differs from the registry's would have to be
      // rebuilt at promotion time -- and a rebuild is a place to get it wrong.
      return {
        ...c,
        verification: {
          status,
          ...verificationSwitches(c, status),
          quarantineReason: null,
          checkedAt,
          sources: oracles.sources,
          reasons,
        },
      };
    });

    const path = saveCandidates(stamped);
    console.log('');
    console.log(`Stamped ${stamped.length} candidate${stamped.length === 1 ? '' : 's'} -> ${path}`);
    console.log('Stamping changes NOTHING about what the fix engine does. Promotion is still manual.');
    // `verify` runs classifyEntry, which only ever looks at the REPLACEMENT. A
    // `verified` stamp here is half the gate, and a reader who thinks it is the
    // whole gate is exactly how a live model gets promoted as retired.
    console.log(
      'Note: this classifies the REPLACEMENT only. The deprecation claim itself ' +
        '(lifecycle, shutdown date, an excerpt naming the model, a stored snapshot) is ' +
        'checked at promote.',
    );
  });

candidates
  .command('promote')
  .argument('<candidateId...>', 'the candidateIds to promote (explicit -- there is no "promote all")')
  .description('Move VERIFIED, evidence-backed candidates into the active registry.')
  // What the gate checks, stated where a user meets it. Both halves, and the
  // boundary: mendr has no oracle for "did the provider retire this", so it
  // never claims one.
  .addHelpText(
    'after',
    `\nThe gate verifies that the REPLACEMENT is live in a public catalog and not\n` +
      `contradicted by the provider's recommendation table, AND that the DEPRECATION\n` +
      `CLAIM is self-consistent and quote-backed: a stated lifecycle, no contradiction\n` +
      `with the live catalogs, a shutdown date behind an announced deprecation, an\n` +
      `excerpt that names the model, and a stored snapshot behind every evidence ref.\n` +
      `It does NOT independently confirm that the provider retired the model -- no\n` +
      `public oracle answers that. Refusals print their reason.\n`,
  )
  .action(async (ids: string[]) => {
    const queue = loadCandidatesOrExit();
    const registryPath = resolveRegistryPath();
    // Operate on the RAW parsed JSON so existing entries (including the param
    // kinds and any field the typed loader drops) survive the rewrite verbatim.
    const raw = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, unknown>[];

    const oracles = await fetchOracles();
    const result = promoteCandidates(queue, loadLlmRegistry(), {
      ids,
      oracles,
      // The snapshot dir is a GATE INPUT, not a convenience: a candidate whose
      // evidence has no stored snapshot here cannot be read back offline and is
      // refused (see registry/claimCheck.ts rule (e)).
      snapshotDir: resolveEvidenceDir(),
      checkedAt: new Date().toISOString().slice(0, 10),
      sources: oracles.sources,
    });

    for (const refusal of result.refused) {
      console.log(`REFUSED  ${refusal.id}`);
      console.log(`         ${refusal.reason}`);
    }
    if (result.refused.length > 0 && result.promoted.length > 0) console.log('');
    for (const entry of result.promoted) {
      console.log(`PROMOTED ${entry.provider}: ${entry.deprecated} -> ${entry.replacement}`);
    }

    if (result.promoted.length > 0) {
      // Registry FIRST, queue second. If the second write fails, the candidate
      // is merely still queued and the next promote refuses it as a duplicate —
      // recoverable. The other order would lose the entry entirely.
      raw.push(...(result.promoted as unknown as Record<string, unknown>[]));
      writeFileSync(registryPath, `${JSON.stringify(raw, null, 2)}\n`);
      saveCandidates(result.nextCandidates);
    }

    console.log('');
    console.log(
      `Promoted ${result.promoted.length}, refused ${result.refused.length}. ` +
        `${result.nextCandidates.length} candidate${result.nextCandidates.length === 1 ? '' : 's'} still pending.`,
    );
    if (result.promoted.length > 0) {
      // A promoted entry is one the fix engine will auto-apply, so the last
      // line a promoter reads is the exact shape of what was checked -- and the
      // part that was not. Overstating this here is how a live model ends up
      // rewritten under a VERIFIED label.
      console.log(
        'What that verified: the replacement is live in a public catalog and uncontradicted, ' +
          'and the deprecation claim is self-consistent + quote-backed by a stored snapshot. ' +
          'It did NOT independently confirm with the provider that these ids are retired.',
      );
    }
    // A refusal is the gate working, not a crash — but it must not read as
    // success to a script either.
    if (result.refused.length > 0) process.exitCode = 1;
  });

program
  .command('discover')
  .option('--provider <p>', `only this provider: ${DISCOVER_PROVIDERS.join(' | ')}`)
  .option('--write', 'append what was found to registries/candidates.json (NOTHING else)')
  .description('Scan provider deprecation pages for candidate entries (never touches the active registry).')
  .action(async (opts: { provider?: string; write?: boolean }) => {
    let providers: readonly DiscoverProvider[] = DISCOVER_PROVIDERS;
    if (opts.provider) {
      if (!(DISCOVER_PROVIDERS as readonly string[]).includes(opts.provider)) {
        console.error(
          `mendr: unknown provider "${opts.provider}" (expected ${DISCOVER_PROVIDERS.join(', ')})`,
        );
        process.exit(2);
      }
      providers = [opts.provider as DiscoverProvider];
    }

    const existing = loadCandidatesOrExit();
    const result = await discoverCandidates(providers, {
      // Dedupe corpus only. discover.ts holds no filesystem API and no
      // reference to the registry file; the active registry reaches it as
      // read-only DATA and leaves again as nothing.
      activeRegistry: loadLlmRegistry(),
      existingCandidates: existing,
    });

    for (const provider of providers) console.log(`source: ${provider} -> ${PROVIDER_SOURCES[provider]}`);
    for (const note of result.notes) console.log(`  ${note}`);
    console.log('');

    if (result.candidates.length === 0) {
      console.log('No new candidates found (everything readable is already in the registry or the queue).');
    } else {
      console.log(`${result.candidates.length} new candidate${result.candidates.length === 1 ? '' : 's'}:`);
      for (const c of result.candidates) {
        console.log(`  ${c.candidateId}: ${c.deprecated} -> ${c.replacement}` +
          (c.shutdownDate ? ` (shutdown ${c.shutdownDate})` : ''));
      }
    }
    if (result.skipped.length > 0) {
      console.log('');
      console.log(`Skipped ${result.skipped.length} row(s) that could not be read confidently (never guessed):`);
      const MAX_SKIPS = 12;
      for (const skip of result.skipped.slice(0, MAX_SKIPS)) {
        console.log(`  [${skip.provider}] ${skip.reason}`);
      }
      if (result.skipped.length > MAX_SKIPS) {
        console.log(`  +${result.skipped.length - MAX_SKIPS} more`);
      }
    }

    if (!opts.write) {
      console.log('');
      console.log('Dry run. Re-run with --write to append these to registries/candidates.json.');
      return;
    }

    // The ONLY write this command performs, plus the evidence snapshots that
    // back it. The active registry has no write path from here — by design,
    // that path exists only inside `candidates promote`.
    const evidenceDir = resolveEvidenceDir();
    for (const doc of result.documents) {
      // Hand the snapshot writer the rows THIS document was cited for, so a
      // page too big to store whole still keeps the region around every quoted
      // row. Without it, a cited row deep in a long page is the first thing a
      // head-only truncation throws away — see evidence.ts#buildSnapshotBody.
      const excerpts = result.candidates
        .flatMap((c) => c.evidence ?? [])
        .filter((ref) => ref.contentHash === doc.ref.contentHash)
        .map((ref) => ref.excerpt)
        .filter((excerpt): excerpt is string => excerpt !== undefined);
      saveSnapshot(evidenceDir, doc.ref, doc.text, { excerpts });
    }
    const path = saveCandidates([...existing, ...result.candidates]);
    console.log('');
    console.log(
      `Wrote ${result.candidates.length} candidate${result.candidates.length === 1 ? '' : 's'} + ` +
        `${result.documents.length} evidence snapshot${result.documents.length === 1 ? '' : 's'} -> ${path}`,
    );
    console.log('Nothing is active until a human runs `mendr candidates promote <candidateId...>`.');
  });

program
  .command('scan')
  .argument('<repoPath>', 'path to the target TypeScript repo')
  .description('List the Stripe API surface used by a repo.')
  .action((repoPath: string) => {
    const resolved = resolveRepoOrExit(repoPath);
    const project = loadProject(resolved);
    const usage = buildUsageMap(project);
    console.log(formatUsageMap(usage));
  });

program
  .command('check')
  .requiredOption('--from <specA>', 'path to the "from" Stripe spec snapshot')
  .requiredOption('--to <specB>', 'path to the "to" Stripe spec snapshot')
  .option(
    '--repo <path>',
    'optional path to a target repo; only report changes that repo actually uses',
  )
  .description('List breaking changes between two Stripe spec snapshots.')
  .action(async (opts: { from: string; to: string; repo?: string }) => {
    const [specA, specB] = await Promise.all([loadSpec(opts.from), loadSpec(opts.to)]);
    const changes = diffSpecs(specA, specB);

    // Without --repo, keep the plain Phase-1 listing of every detected change.
    if (!opts.repo) {
      console.log(formatChangeSet(changes));
      return;
    }

    // With --repo, run the Phase-2 usage scan and intersect: report only the
    // changes the repo actually touches, plus how many were dropped as unused.
    const resolved = resolveRepoOrExit(opts.repo);
    const usage = buildUsageMap(loadProject(resolved));
    const affected = intersect(changes, usage);
    console.log(formatAffectedSites(changes, affected));
  });

program
  .command('fix')
  .argument('<repoPath>', 'path to the target TypeScript repo')
  .requiredOption('--from <specA>', 'path to the "from" Stripe spec snapshot')
  .requiredOption('--to <specB>', 'path to the "to" Stripe spec snapshot')
  .option('--skip-gates', 'skip the type-check + test gates (assert Tier A without verifying)')
  .description('Output a GATED rename codemod diff + earned confidence tier.')
  .action(async (repoPath: string, opts: { from: string; to: string; skipGates?: boolean }) => {
    const resolved = resolveRepoOrExit(repoPath);

    // detect -> scan -> intersect: only the changes this repo actually touches.
    const [specA, specB] = await Promise.all([loadSpec(opts.from), loadSpec(opts.to)]);
    const changes = diffSpecs(specA, specB);
    const usage = buildUsageMap(loadProject(resolved));
    const affected = intersect(changes, usage);

    if (affected.length === 0) {
      console.log('No breaking changes affect this repo. Nothing to fix.');
      return;
    }

    // Split into candidate auto-fixable renames vs everything else (always
    // Tier C, locate-only — we surface the sites but never patch them).
    const renames = affected.filter((s) => s.change.kind === 'field_rename');
    const others = affected.filter((s) => s.change.kind !== 'field_rename');

    // A rename is a Tier A CANDIDATE. It only KEEPS Tier A if the patched code
    // still type-checks (baseline-relative) AND the repo's tests still pass;
    // otherwise it is downgraded to Tier C (locate-only) with the reason.
    let renameTier: 'A' | 'C' = 'A';
    let downgradeReason = '';

    if (renames.length > 0) {
      const renameLabels = renames.map((s) => `${s.change.path} -> ${s.change.to}`).join(', ');

      if (opts.skipGates) {
        // Fast local mode: assert Tier A without verifying (old behavior).
        const { diff, changedFiles, siteCount } = applyRenames(resolved, renames);
        console.log('=== Tier A: auto-fixable renames (codemod) ===');
        console.log('');
        console.log(diff);
        console.log(
          `Tier A: ${renames.length} rename${renames.length === 1 ? '' : 's'} ` +
            `(${renameLabels}) applied at ${siteCount} site${siteCount === 1 ? '' : 's'} ` +
            `across ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}. ` +
            `(gates skipped — tier asserted, not verified)`,
        );
      } else {
        // Build BOTH an unpatched baseline project and a patched project from
        // the same repo, in-memory. The baseline gives the gate its reference
        // point; the patched project supplies the diff + gate inputs.
        const baselineProject = loadProject(resolved);
        const patchedProject = loadProject(resolved);
        const { diff, changedFiles, siteCount } = applyRenamesToProject(
          patchedProject,
          renames,
          resolved,
        );

        // Gate 1: baseline-relative type-check (in-memory, no subprocess).
        const typeResult = checkTypes(baselineProject, patchedProject);

        // Gate 2: run the repo's tests against the patched files in a temp copy.
        const patchedFiles = changedFiles.map((absPath) => ({
          absPath,
          newText: patchedProject.getSourceFileOrThrow(absPath).getFullText(),
        }));
        const testResult = await runRepoTests(resolved, patchedFiles);

        const typeLabel = typeResult.passed ? 'pass' : 'fail';
        const gatesPassed = typeResult.passed && testResult.status === 'pass';
        renameTier = gatesPassed ? 'A' : 'C';

        if (!gatesPassed) {
          if (!typeResult.passed) {
            const n = typeResult.newDiagnostics.length;
            const first = typeResult.newDiagnostics[0];
            downgradeReason =
              `patched code introduces ${n} new type error${n === 1 ? '' : 's'}` +
              (first ? `: ${formatDiagnostic(first)}` : '');
          } else if (testResult.status === 'fail') {
            downgradeReason = 'repo tests failed against the patched code';
          } else if (testResult.output === 'no test script') {
            downgradeReason = 'no test script — could not verify';
          } else {
            downgradeReason = `could not verify tests (${testResult.output})`;
          }
        }

        const heading =
          renameTier === 'A'
            ? '=== Tier A: auto-fixable renames (VERIFIED codemod) ==='
            : '=== Tier A candidate -> DOWNGRADED to Tier C (unverified codemod) ===';
        console.log(heading);
        console.log('');
        console.log(diff);
        console.log('Gate summary:');
        console.log(`  type-check: ${typeLabel}`);
        console.log(`  tests:      ${testResult.status}`);
        console.log('');

        if (renameTier === 'A') {
          console.log(
            `Tier A: ${renames.length} rename${renames.length === 1 ? '' : 's'} ` +
              `(${renameLabels}) applied at ${siteCount} site${siteCount === 1 ? '' : 's'} ` +
              `across ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}. ` +
              `(verified: type-check + tests pass)`,
          );
        } else {
          console.log(
            `Tier C (downgraded): ${renames.length} rename${renames.length === 1 ? '' : 's'} ` +
              `(${renameLabels}) NOT applied — ${downgradeReason.replace(/\.+$/, '')}. ` +
              `The diff above is shown for manual review only; it is not trusted.`,
          );
        }
      }
    }

    // Tier C: locate-only. List each non-rename change and its sites; no patch.
    if (others.length > 0) {
      console.log('');
      console.log('=== Tier C: locate-only (manual review, no patch) ===');
      for (const site of others) {
        console.log('');
        console.log(formatChange(site.change));
        for (const loc of site.locations) {
          console.log(`    ${loc.file}:${loc.line}:${loc.column}`);
        }
      }
    }

    // Summary / tier breakdown.
    const tierA = renameTier === 'A' ? renames.length : 0;
    const tierC = others.length + (renameTier === 'C' ? renames.length : 0);
    console.log('');
    console.log(
      `Summary: ${tierA} auto-fixed (Tier A), ` +
        `${tierC} flagged for review (Tier C).`,
    );
  });

program
  .command('watch')
  .argument('[repoPath]', 'path to the repo to watch (default: current directory)', '.')
  .option('--install', 'scaffold the GitHub Actions workflow that maintains the watch issue in CI')
  .option('--force', 'with --install, overwrite an existing workflow file')
  .option('--issue-body <file>', 'also write the rendered GitHub issue markdown to a file')
  .option('--json', 'emit a machine-readable JSON summary on stdout (for CI)')
  .option('--no-exposure-file', `skip writing ${EXPOSURE_RELATIVE_PATH} (used by CI)`)
  .description('Standing Watch: list the deprecated model ids this repo touches, by deadline')
  .action(
    async (
      repoPath: string,
      opts: {
        install?: boolean;
        force?: boolean;
        issueBody?: string;
        json?: boolean;
        exposureFile?: boolean; // false only when --no-exposure-file is passed
      },
    ) => {
      const resolved = resolveRepoOrExit(repoPath);

      // --install: scaffold the CI workflow and stop. No scan, no scan output.
      if (opts.install) {
        let result;
        try {
          result = installWatchWorkflow(resolved, opts.force ?? false);
        } catch (err) {
          // A filesystem failure (permission denied, read-only path, running in
          // a system directory) exits with one friendly line, not a raw stack.
          console.error(
            `mendr: could not scaffold the watch workflow under ${repoPath}: ` +
              `${err instanceof Error ? err.message : String(err)}\n` +
              `run this from the root of a project directory you can write to.`,
          );
          process.exit(1);
        }
        const relPath = relative(resolved, result.path).replace(/\\/g, '/');
        if (result.action === 'exists') {
          console.error(`mendr: ${relPath} already exists. Re-run with --force to overwrite it.`);
          process.exitCode = 1;
          return;
        }
        console.log(`Mendr Watch workflow ${result.action}: ${relPath}`);
        console.log('');
        console.log('Next:');
        console.log(`  1. commit ${relPath}`);
        console.log(
          '  2. pin it: set a repository variable MENDR_SPEC to a Mendr release tag or commit',
        );
        console.log(
          '     SHA (never a branch) — the workflow refuses to run unpinned, so upstream code',
        );
        console.log('     cannot execute in your CI without review');
        console.log('  3. push it (runs on a daily schedule and on pushes to the default branch)');
        console.log('  4. it maintains ONE self-updating issue: your deprecated model ids, by deadline');
        console.log('');
        console.log('Least privilege: issues:write + contents:read only. Opens no PRs, pushes no commits.');
        return;
      }

      const registry = loadLlmRegistry();
      const now = new Date();
      const exposure = await computeExposure(resolved, registry);

      // Provenance: which registry produced these facts (a content hash of the
      // bundled registry file — stable, changes only when the registry does, so
      // it never churns the committed file), and which commit was scanned (read
      // best-effort; null outside a git repo). The scanned commit rides in the
      // machine `--json` output only — a per-commit value must not land in the
      // committed .mendr/exposure.json or every commit would diff it.
      const registryVersion =
        'sha256:' +
        createHash('sha256').update(readFileSync(resolveRegistryPath())).digest('hex').slice(0, 16);
      let scannedCommit: string | null = null;
      try {
        scannedCommit = (await simpleGit(resolved).revparse(['HEAD'])).trim();
      } catch {
        // Not a git repo (or git absent): provenance simply omits the commit.
      }

      // A scan that saw no source files is almost always the wrong directory
      // (e.g. run outside a repo). Hint on stderr so --json/--issue-body stdout
      // stays clean.
      if (exposure.filesScanned === 0) {
        console.error(
          `mendr: scanned 0 source files under ${repoPath} — is this a project directory? ` +
            `run mendr watch from the root of your repo.`,
        );
      }

      // Write the churn-free exposure record unless CI suppressed it. A write
      // failure is NON-FATAL: the scan already succeeded, so warn and still show
      // the summary rather than crashing on a read-only or protected directory.
      let written: ExposureWriteResult | undefined;
      if (opts.exposureFile !== false) {
        try {
          written = writeExposureFile(resolved, exposure.models, registryVersion);
        } catch (err) {
          console.error(
            `mendr: computed your exposure but could not write ${EXPOSURE_RELATIVE_PATH} ` +
              `(${err instanceof Error ? err.message : String(err)}) — showing the summary anyway.`,
          );
        }
      }

      // The rendered issue body (the CI workflow feeds this to github-script).
      if (opts.issueBody) {
        writeDiffOrExit(opts.issueBody, renderIssueBody(exposure, registry, now));
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              schema: EXPOSURE_SCHEMA,
              registryVersion,
              scannedCommit,
              hasExposure: exposure.models.length > 0,
              modelCount: exposure.models.length,
              nearestDeadlineDays: nearestDeadlineDays(exposure.models, now),
              filesScanned: exposure.filesScanned,
              filesMatched: exposure.filesMatched,
              models: exposure.models,
              badge: renderBadge(exposure, now),
            },
            null,
            2,
          ),
        );
        return;
      }

      // Human output: the summary, the file status, an optional badge, the CTA.
      console.log(renderTextSummary(exposure, registry, now));
      console.log('');
      if (written) {
        const rel = relative(resolved, written.path).replace(/\\/g, '/');
        console.log(
          written.changed
            ? `Wrote ${rel} — commit it to track your exposure in git.`
            : `${rel} is already up to date.`,
        );
      }
      if (exposure.models.length > 0) {
        console.log('');
        console.log('Optional README badge (a snapshot — re-run this command to refresh it):');
        console.log(`  ${renderBadge(exposure, now)}`);
      }
      console.log('');
      console.log('Make it resident — scaffold a GitHub Action that keeps one self-updating issue');
      console.log('current (no server, runs in your own CI):');
      console.log('  npx github:ajitheee/mendr watch . --install');
      console.log('  (or `mendr watch --install` if mendr is installed globally)');
    },
  );

program.parse();
