#!/usr/bin/env node
import { Command } from 'commander';
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
import { loadRepoConfig, REPO_CONFIG_FILENAME, type RepoConfig } from './config/repoConfig.js';
import {
  effectiveVerificationState,
  isVerified,
  loadLlmRegistry,
  modelIdEntries,
  registryProvenance,
  resolveRegistryPath,
  selfContradictionMarkersIn,
  staleRegistryWarning,
  type EffectiveVerificationState,
} from './usage/llmRegistry.js';
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
  formatRegistryProvenanceLines,
  groupDataFindingsByFile,
  replacementFamily,
  swapLabel,
  behavioralVerificationNote,
  type BehavioralVerificationView,
  type DataFindingView,
  type GateSummaryFacts,
} from './report/llmReport.js';
import {
  assertSingleTerminalTier,
  crossTierCollisions,
  devChecksEnabled,
  formatFoundLines,
  formatSummaryLines,
  formatTierBSection,
  multiTierNotes,
  orderTierB,
  tierBFinding,
  tierBJson,
  type RegistryVerdict,
  type TierBFinding,
  type TierCounts,
  type TierOccurrence,
} from './report/tiers.js';
import {
  writeAllOrNothing,
  type AtomicWriteResult,
  type PendingWrite,
} from './fix/atomicWrite.js';
import { findParamSites } from './fix/paramFix.js';
import { applyLlmFixesToProject, type LlmFixResult } from './fix/llmFix.js';
import { collectPythonFiles, readPythonSources, scanPyAnnotations } from './python/scanPy.js';
import { applyPyModelIdFixesToSources } from './python/fixPy.js';
import type { TestGateResult } from './gates/runTests.js';
import { classifyEntry, mergeReasons } from './registry/verify.js';
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
 * The measurable tests line for a gate summary: real counts when the runner
 * output was parseable, an honest "not run" otherwise — never a bare
 * feel-good "pass" that cannot be checked.
 */
function testGateLabel(result: TestGateResult): string {
  if (result.status === 'inconclusive') {
    return result.output === 'no test script'
      ? 'not run (no supported test command detected)'
      : `not run (${result.output})`;
  }
  return result.counts
    ? `${result.status} (npm test, ${result.counts.passed} passed, ${result.counts.failed} failed)`
    : `${result.status} (npm test, exit code only -- counts not parsed)`;
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
    const evalCommand = opts.evalCommand?.trim() || repoConfig.evalCommand;

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
    const swapMatches = modelArgMatches.filter((m) => isVerified(m.deprecation));
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
      switch (state && effectiveVerificationState(state)) {
        case 'verified':
          return 'verified';
        case 'self-contradicted':
          return 'self-contradicted';
        default:
          return 'unverified';
      }
    };
    /** The date the registry stamped that verdict, if the entry carries one. */
    const verdictDateFor = (modelId: string): string | undefined =>
      modelIdByValue.get(modelId)?.verification?.checkedAt;
    /**
     * The extra audit line a SELF-CONTRADICTING entry earns, printed above the
     * registry's own reasons. Without it the detail block reads as a list of
     * caveats under a `verified` stamp; with it, the reader knows those caveats
     * are the reason no patch was generated, and which words tripped the gate.
     */
    const selfContradictionDetail = (
      status: EffectiveVerificationState | undefined,
      reasons: string[] | undefined,
    ): string[] => {
      // ONLY for the entries the stamp and the reasons actually disagree
      // about. An entry stamped `unverified` over the same caveats is not
      // contradicting itself -- it is agreeing with itself -- and saying
      // "stamped verified, but..." over it would be a fresh false claim.
      if (status !== 'self-contradicted') return [];
      const markers = selfContradictionMarkersIn(reasons);
      if (markers.length === 0) return [];
      return [
        `HELD BY MENDR: this entry is stamped verified, but its own reasons below say ` +
          `${markers.map((m) => `"${m}"`).join(', ')} -- a stamp that contradicts its own ` +
          `working is never auto-applied.`,
      ];
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
            replacement: b.replacement,
            registryVerdict: verdictFor(b.value),
            verdictCheckedAt: verdictDateFor(b.value),
            status: b.status,
            // The verification gate's own audit trail, preserved verbatim --
            // under mendr's own line when the entry contradicts itself.
            detail: [...selfContradictionDetail(b.status, b.reasons), ...(b.reasons ?? [])],
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
            replacement: a.replacement,
            registryVerdict: verdictFor(a.value),
            verdictCheckedAt: verdictDateFor(a.value),
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
            replacement: u.replacement,
            registryVerdict: verdictFor(u.value),
            verdictCheckedAt: verdictDateFor(u.value),
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
            replacement: d.replacement,
            registryVerdict: verdictFor(d.value),
            verdictCheckedAt: verdictDateFor(d.value),
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
     * The (g) footer: registry provenance + the exact commit that was scanned.
     * Every number is COMPUTED from the registry that was actually loaded for
     * this run — see registryProvenance() for why the old one-line
     * "N entries, verified <date>" was a claim the data did not support.
     */
    const printFooter = async (): Promise<void> => {
      say('');
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
      await printFooter();
      if (json) {
        console.log(
          JSON.stringify(
            {
              summary: {
                tierA: 0,
                tierB: 0,
                tierC: 0,
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
    let tsGateFacts: GateSummaryFacts | undefined;
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

        // Gate 1 (REQUIRED): baseline-relative type-check (in-memory, no subprocess).
        const typeResult = checkTypes(baselineProject, patchedProject);

        // Gate 2 (BEST-EFFORT): run the repo's tests against the patched files in a
        // temp copy. A hard test FAILURE downgrades; inconclusive (no script / not
        // installed) does NOT block Tier A, since tests are best-effort here.
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

        const gatesPassed = typeResult.passed && testResult.status !== 'fail';
        tsTier = gatesPassed ? 'A' : 'C';
        if (!gatesPassed) {
          if (!typeResult.passed) {
            const n = typeResult.newDiagnostics.length;
            const first = typeResult.newDiagnostics[0];
            downgradeReason =
              `patched code introduces ${n} new type error${n === 1 ? '' : 's'}` +
              (first ? `: ${formatDiagnostic(first)}` : '');
          } else {
            downgradeReason = 'repo tests failed against the patched code';
          }
        }
        // "pass" here means BASELINE-RELATIVE pass. When the repo already had
        // type errors before the patch, say so — a bare "pass" would overclaim.
        const typeNote =
          typeResult.passed && typeResult.baselineCount > 0
            ? `pass (no new errors; ${typeResult.baselineCount} pre-existing ignored)`
            : `${typeResult.passed ? 'pass' : 'fail'} (required)`;
        // Two NAMED groups: what was checked (code) and what was not
        // (behavior). The tests row carries real parsed counts wherever the
        // runner's summary allowed — a bare "pass" is not a measurable claim.
        tsGateFacts = {
          usageClassification: 'call-site',
          typeCheck: typeNote,
          tests: testGateLabel(testResult),
        };
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
    let pyTestLabel = 'not run (no supported test command detected)';
    let pyDowngradeReason = '';
    if (pyResult.siteCount > 0) {
      // Best-effort test gate. Mendr's only runner today is `npm test`, so it
      // can only MEASURE anything when the repo has one — a pure-Python repo
      // gets the honest "not run" instead of pretending. When the runner does
      // run, the label carries parsed pass/fail counts where the output allows.
      let testResult: TestGateResult = {
        status: 'inconclusive',
        output: 'no supported test command detected',
      };
      if (opts.skipGates) {
        pyTestLabel = 'skipped';
      } else if (existsSync(join(resolved, 'package.json'))) {
        testResult = await runRepoTests(resolved, pyResult.patchedFiles);
        pyTestLabel = testGateLabel(testResult);
      }
      // The syntax gate ALWAYS ran (inside the fix pass — an in-memory
      // re-parse is essentially free), even under --skip-gates: a patch we
      // KNOW breaks parsing must never be presented as Tier A.
      pyTier = pyResult.syntaxGate.passed && testResult.status !== 'fail' ? 'A' : 'C';
      if (pyTier === 'C') {
        pyDowngradeReason = !pyResult.syntaxGate.passed
          ? `patched code introduces new syntax errors (${pyResult.syntaxGate.failures[0] ?? 'unknown file'})`
          : 'repo tests failed against the patched code';
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
    const codeGatesPassed =
      (tsTotalSites === 0 || tsTier === 'A') && (pyResult.siteCount === 0 || pyTier === 'A');
    const anyTierA =
      (tsTier === 'A' && tsTotalSites > 0) || (pyTier === 'A' && pyResult.siteCount > 0);
    if (evalCommand && !opts.skipGates && codeGatesPassed && anyTierA) {
      // Progress goes to STDERR (an eval can take minutes, and with --json
      // stdout must carry only the document).
      console.error(`Running your evaluation against the patched code: ${evalCommand}`);
      evalResult = await runRepoEval(
        resolved,
        [...tsPatchedFiles, ...pyResult.patchedFiles],
        { command: evalCommand, timeoutMs: repoConfig.evalTimeoutMs },
      );
      if (evalResult.status === 'fail' || evalResult.status === 'inconclusive') {
        const reason =
          evalResult.status === 'fail'
            ? `your eval command failed against the patched code ` +
              `(${evalResult.command}, exit ${evalResult.exitCode})`
            : // Names the CASE, not just the outcome: "timed out" and "could not
              // be spawned" send a user to completely different fixes, and both
              // are different again from "your model regressed".
              `your eval command was configured but did not complete: ${evalResult.output} ` +
              `-- mendr will not apply a fix it could not behaviorally verify`;
        if (tsTotalSites > 0) {
          tsTier = 'C';
          downgradeReason = reason;
        }
        if (pyResult.siteCount > 0) {
          pyTier = 'C';
          pyDowngradeReason = reason;
        }
        // Hard signal, with or without --write: a script that ran mendr must be
        // able to see in $? that the fix was not verified and not applied.
        process.exitCode = 1;
        if (evalResult.status === 'inconclusive') {
          // Also on stderr, where it survives --json (stdout is the document).
          console.error(`mendr: eval gate could not run -- ${evalResult.output}`);
          console.error('mendr: the fix is NOT applied -- an eval that did not run verifies nothing.');
        }
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
            // configured an eval to go configure one.
            ...(evalResult.status === 'inconclusive' ? { reason: evalResult.output } : {}),
          };
    const gateLines = tsGateFacts ? formatGateSummary(tsGateFacts, behavioral) : [];

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
        {
          usageClassification: 'verified-sink',
          syntax: pyResult.syntaxGate.passed ? 'pass' : 'fail',
          staticTypeGate: 'not configured or not detected',
          tests: pyTestLabel,
        },
        behavioral,
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
    if ((tsTier === 'A' && tsTotalSites > 0) || (pyTier === 'A' && pyResult.siteCount > 0)) {
      say('');
      say(behavioralVerificationNote(behavioral));
    }

    await printFooter();

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
            tierA: [
              ...swapMatches.map((m) => ({
                file: rel(m.location.file),
                from: m.value,
                to: m.deprecation.replacement,
                status: m.deprecation.status ?? null,
                shutdownDate: m.deprecation.shutdownDate ?? null,
              })),
              // Param transforms ride in the same array; `status` carries the
              // transform kind since lifecycle does not apply to a param.
              ...paramMatches.map((p) => ({
                file: rel(p.location.file),
                from: p.deprecation.param,
                to: p.deprecation.kind === 'param_rename' ? p.deprecation.replacement : null,
                status: p.deprecation.kind,
                shutdownDate: null,
              })),
              ...pyResult.swapMatches.map((m) => ({
                file: rel(m.location.file),
                from: m.value,
                to: m.deprecation.replacement,
                status: m.deprecation.status ?? null,
                shutdownDate: m.deprecation.shutdownDate ?? null,
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
      unverified: 0,
      unverifiable: 0,
    };
    const blocked: { status: VerificationStatus; provider: string; from: string; to: string }[] = [];
    /** Entries whose stamp this run CHANGED — the audit's real payload. */
    const flipped: { from: string; was: string; now: VerificationStatus }[] = [];
    let modelEntries = 0;
    let carriedReasons = 0;
    let heldByOwnReasons = 0;

    for (const entry of raw) {
      if (entry.kind !== 'model_id') continue;
      modelEntries++;
      const model = entry as unknown as LlmModelIdDeprecation;
      const { status, reasons } = classifyEntry(model, oracles);
      counts[status]++;
      const stamped = model.verification?.status ?? 'unstamped';
      if (stamped !== status) flipped.push({ from: model.deprecated, was: stamped, now: status });

      console.log(`[${status.toUpperCase().padEnd(12)}] ${model.provider}: ${model.deprecated} -> ${model.replacement}`);
      for (const reason of reasons) console.log(`               - ${reason}`);

      if (status !== 'verified') {
        blocked.push({ status, provider: model.provider, from: model.deprecated, to: model.replacement });
      }
      // A RECHECK MUST NOT ERASE THE RESEARCH. The classifier's verdict
      // replaces the classifier's PREVIOUS verdict; every hand-written reason
      // is carried through verbatim (see mergeReasons). Without this, a routine
      // `--write` would delete the caveats that hold a self-contradicting entry
      // out of Tier A -- silently promoting the very entries this gate exists
      // to catch.
      const merged = mergeReasons(reasons, model.verification?.reasons);
      carriedReasons += merged.length - reasons.length;
      if (status === 'verified' && selfContradictionMarkersIn(merged).length > 0) {
        heldByOwnReasons++;
        console.log(
          '               ! stamped verified, but a carried-over reason contradicts it -- ' +
            'the engine gate holds this at Tier B',
        );
      }
      if (opts.write) {
        entry.verification = { status, checkedAt, sources: oracles.sources, reasons: merged };
      }
    }

    console.log('');
    console.log('-'.repeat(74));
    console.log(`model_id entries: ${modelEntries}`);
    console.log(`  verified     : ${counts.verified}  (auto-apply eligible — Tier A)`);
    console.log(`  unverified   : ${counts.unverified}  (live but stale/chained/superseded — BLOCKED)`);
    console.log(`  unverifiable : ${counts.unverifiable}  (out-of-class moderation/image/audio/tts — BLOCKED)`);

    if (heldByOwnReasons > 0) {
      console.log(
        `  (of the verified, ${heldByOwnReasons} carr${heldByOwnReasons === 1 ? 'ies' : 'y'} a ` +
          `recorded reason that contradicts the stamp and stay${heldByOwnReasons === 1 ? 's' : ''} ` +
          'blocked from auto-apply)',
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

// --- Provenance + the human gate -----------------------------------------
// Three commands that share ONE invariant: research produces CANDIDATES; only a
// human promotes a candidate into the active registry. `evidence` shows why an
// active entry is believed, `candidates` is the queue and its gate, `discover`
// fills the queue and can touch nothing else.

program
  .command('evidence')
  .argument('<modelId>', 'a deprecated model id present in the registry')
  .description('Show the provenance behind a registry entry: sources, hashes, and quoted excerpts.')
  .action((modelId: string) => {
    const registry = loadLlmRegistry();
    const entries = modelIdEntries(registry);
    // Exact match first; canonical match second, so `GPT-4` or `openai/gpt-4`
    // still finds the entry without ever matching a DIFFERENT model.
    const entry =
      entries.find((e) => e.deprecated === modelId) ??
      entries.find((e) => canonicalizeId(e.deprecated) === canonicalizeId(modelId));
    if (!entry) {
      console.error(
        `mendr: no registry entry for model id "${modelId}" ` +
          `(${entries.length} model_id entries loaded from ${resolveRegistryPath()}).`,
      );
      process.exit(2);
    }

    console.log(`${entry.provider}: ${entry.deprecated} -> ${entry.replacement}`);
    console.log(`  lifecycle    : ${entry.status ?? 'unknown (never claimed dead)'}`);
    console.log(`  shutdown date: ${entry.shutdownDate ?? 'none published'}`);
    console.log(`  source url   : ${entry.sourceUrl ?? 'none recorded'}`);
    const verification = entry.verification;
    console.log(`  verification : ${verification?.status ?? 'unstamped (blocked from auto-apply)'}`);
    // The stamp is not the last word. When the reasons below contradict it,
    // the engine holds the entry back -- and this command is where a reader
    // sent by a Tier B finding lands, so it must not show a bare `verified`
    // over a mapping mendr just refused to apply.
    if (effectiveVerificationState(entry) === 'self-contradicted') {
      const markers = selfContradictionMarkersIn(verification?.reasons);
      console.log(
        `  engine gate  : HELD -- the reasons below contradict this stamp ` +
          `(${markers.map((m) => `"${m}"`).join(', ')}), so mendr will not auto-apply it`,
      );
    }
    if (verification?.checkedAt) console.log(`    checked at : ${verification.checkedAt}`);
    if (verification?.sources?.length) console.log(`    oracles    : ${verification.sources.join(', ')}`);
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
      return { ...c, verification: { status, checkedAt, sources: oracles.sources, reasons } };
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

program.parse();
