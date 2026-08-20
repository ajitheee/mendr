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
import {
  isVerified,
  loadLlmRegistry,
  modelIdEntries,
  resolveRegistryPath,
  staleRegistryWarning,
  REGISTRY_VERIFIED_AT,
} from './usage/llmRegistry.js';
import {
  findModelIdLiterals,
  toAzureDeploymentMatches,
  toBlockedModelArgMatches,
  toModelIdDataMatches,
  AZURE_DEPLOYMENT_REASON,
} from './usage/scanLiterals.js';
import {
  formatDataFileGroupLine,
  formatDataHitLine,
  groupDataFindingsByFile,
  replacementFamily,
  type DataFindingView,
} from './report/llmReport.js';
import { findParamSites } from './fix/paramFix.js';
import { applyLlmFixesToProject, type LlmFixResult } from './fix/llmFix.js';
import { collectPythonFiles, readPythonSources } from './python/scanPy.js';
import { applyPyModelIdFixesToSources } from './python/fixPy.js';
import type { TestGateResult } from './gates/runTests.js';
import { classifyEntry } from './registry/verify.js';
import { fetchOracles } from './registry/oracles.js';
import type { LlmModelIdDeprecation, VerificationStatus } from './types.js';

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

/** Human label for one model-id swap, carrying WHY: retired, or dying on a date. */
function swapLabel(d: LlmModelIdDeprecation): string {
  const when =
    d.status === 'retired'
      ? ' [retired]'
      : d.status === 'deprecated' && d.shutdownDate
        ? ` [shuts down ${d.shutdownDate}]`
        : '';
  return `"${d.deprecated}" -> "${d.replacement}"${when}`;
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

/** The classes `--fail-on` accepts. `none` (the default) never gates the exit. */
const FAIL_ON_CLASSES = new Set(['tierA', 'blocked', 'none']);

program
  .command('fix-llm')
  .argument('<repoPath>', 'path to the target TypeScript/Python repo, or a GitHub/git URL to scan a copy of')
  .option('--skip-gates', 'skip the type-check + test gates (assert Tier A without verifying)')
  .option('--write', 'apply the VERIFIED Tier A diff to your working tree (default: print only)')
  .option('-o, --output <file>', 'also write the combined diff to a file')
  .option('--verbose', 'print every informational data hit (default: one line per file)')
  .option('--json', 'emit a machine-readable JSON report on stdout instead of the human one')
  .option('--fail-on <class>', 'exit 1 when the named finding class is non-empty: tierA | blocked | none', 'none')
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
      },
    ) => {
    const failOn = opts.failOn ?? 'none';
    if (!FAIL_ON_CLASSES.has(failOn)) {
      console.error(`mendr: invalid --fail-on value "${failOn}" (expected tierA, blocked, or none)`);
      process.exit(2);
    }
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

    const modelMatches = findModelIdLiterals(scanProject, registry);
    const paramMatches = findParamSites(scanProject, registry);

    // Python pass: scan + swap + syntax gate, all in memory (see fixPy.ts).
    // Run up front (it is cheap) so the nothing-to-fix check covers BOTH
    // languages — a pure-Python repo must not read as "clean" here.
    const pyResult = await applyPyModelIdFixesToSources(pySources, registry, resolved);

    // Split TS model-id matches by AST position AND verification status:
    //   - `model_arg` + verified  -> Tier A swap candidates;
    //   - `model_arg` + NOT verified -> Tier C locate-only (BLOCKED by the gate);
    //   - `data`                  -> informational locate-only (never edited).
    const modelArgMatches = modelMatches.filter((m) => m.position === 'model_arg');
    const swapMatches = modelArgMatches.filter((m) => isVerified(m.deprecation));
    const blockedAll = [...toBlockedModelArgMatches(modelMatches), ...pyResult.blockedMatches];
    const azureAll = [...toAzureDeploymentMatches(modelMatches), ...pyResult.azureMatches];
    const dataViews: DataFindingView[] = [
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
    const dataGroups = groupDataFindingsByFile(dataViews);

    const tsSwapCandidates = swapMatches.length + paramMatches.length;
    const autoFixableCount = tsSwapCandidates + pyResult.siteCount;

    /** The (g) footer: registry provenance + the exact commit that was scanned. */
    const printFooter = async (): Promise<void> => {
      say('');
      say(`registry: ${modelIdEntries(registry).length} entries, verified ${REGISTRY_VERIFIED_AT}`);
      // Best-effort commit anchor — a non-git directory skips this silently.
      try {
        const sha = (await simpleGit(resolved).revparse(['--short', 'HEAD'])).trim();
        say(`scanned commit: ${sha}`);
      } catch {
        /* not a git repo — no commit line */
      }
    };

    /** Apply the --fail-on gate (exitCode, not exit, so stdout flushes). */
    const applyFailOn = (): void => {
      if (failOn === 'tierA' && autoFixableCount > 0) process.exitCode = 1;
      if (failOn === 'blocked' && blockedAll.length > 0) process.exitCode = 1;
    };

    if (
      autoFixableCount === 0 &&
      blockedAll.length === 0 &&
      dataViews.length === 0 &&
      azureAll.length === 0
    ) {
      say('No deprecated LLM model ids or model-coupled params found. Nothing to fix.');
      await printFooter();
      if (json) {
        console.log(
          JSON.stringify(
            {
              summary: {
                tierA: 0,
                blocked: 0,
                informational: 0,
                filesScanned: totalFiles,
                tsFiles: tsFileCount,
                pyFiles: pyFiles.length,
              },
              tierA: [],
              blocked: [],
              azure: [],
              informational: [],
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
    say(
      `Found: ${autoFixableCount} auto-fixable (verified replacement), ` +
        `${blockedAll.length} blocked (live call, unverified replacement),`,
    );
    say(`       ${dataViews.length} informational (deprecated ids in data positions${catalogCtx}).`);
    if (azureAll.length > 0) {
      say(
        `       ${azureAll.length} azure deployment alias${azureAll.length === 1 ? '' : 'es'} (never auto-swapped).`,
      );
    }

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
    let tsPatchedFiles: { absPath: string; newText: string }[] = [];
    let downgradeReason = '';
    let gateLines: string[] = [];
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
        gateLines = [
          'Gate summary:',
          `  type-check: ${typeNote}`,
          `  tests:      ${testResult.status} (best-effort)`,
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
    let pyTestLabel = 'not attempted (python -- pytest runner not supported yet)';
    if (pyResult.siteCount > 0) {
      // Best-effort test gate. There is no pytest runner support yet, so it
      // only means anything when the repo has an npm test entrypoint — for
      // pure-Python repos we say "not attempted" rather than pretending.
      let testResult: TestGateResult = {
        status: 'inconclusive',
        output: 'not attempted (python)',
      };
      if (opts.skipGates) {
        pyTestLabel = 'skipped';
      } else if (existsSync(join(resolved, 'package.json'))) {
        testResult = await runRepoTests(resolved, pyResult.patchedFiles);
        pyTestLabel = `${testResult.status} (best-effort)`;
      }
      // The syntax gate ALWAYS ran (inside the fix pass — an in-memory
      // re-parse is essentially free), even under --skip-gates: a patch we
      // KNOW breaks parsing must never be presented as Tier A.
      pyTier = pyResult.syntaxGate.passed && testResult.status !== 'fail' ? 'A' : 'C';
    }

    // --- Section 1 (most urgent): the Tier A diff. --------------------------
    if (tsTotalSites > 0 && tsResult) {
      const heading =
        tsTier === 'A'
          ? opts.skipGates
            ? '=== Tier A: auto-fixable model-id + param codemod ==='
            : '=== Tier A: auto-fixable model-id + param codemod (VERIFIED) ==='
          : '=== Tier A candidate -> DOWNGRADED to Tier C (unverified codemod) ===';
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
              : `(verified: type-check passes${tsTestsPassed ? ' + tests pass' : ''})`),
        );
      } else {
        say(
          `Tier C (downgraded): ${breakdown(tsResult)} (${labels}) NOT applied -- ` +
            `${downgradeReason.replace(/\.+$/, '')}. ` +
            `The diff above is shown for manual review only; it is not trusted.`,
        );
      }
    }

    // Python Tier A, under its own heading with its own (weaker) gate.
    if (pyResult.siteCount > 0 && pyTier) {
      const heading =
        pyTier === 'A'
          ? opts.skipGates
            ? '=== Tier A (python): auto-fixable model-id codemod ==='
            : '=== Tier A (python): auto-fixable model-id codemod (VERIFIED) ==='
          : '=== Tier A candidate (python) -> DOWNGRADED to Tier C (unverified codemod) ===';
      say('');
      say(heading);
      say('');
      say(pyResult.diff);
      say('Gate summary:');
      say(
        `  syntax-check: ${pyResult.syntaxGate.passed ? 'pass' : 'fail'} ` +
          '(Python has no type gate -- weaker than TS verification)',
      );
      say(`  tests:        ${pyTestLabel}`);
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
              : '(verified: syntax re-parse only -- weaker than the TS type gate)'),
        );
      } else {
        const reason = !pyResult.syntaxGate.passed
          ? `patched code introduces new syntax errors (${pyResult.syntaxGate.failures[0] ?? 'unknown file'})`
          : 'repo tests failed against the patched code';
        say(
          `Tier C (python, downgraded): ${n} model-id swap${n === 1 ? '' : 's'} (${pyLabels}) ` +
            `NOT applied -- ${reason}. ` +
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

    // --- Section 2: blocked model-args (the most valuable manual findings —
    // live call positions whose replacement the gate refuses to trust). ------
    if (blockedAll.length > 0) {
      say('');
      say('=== Blocked: live model args with an UNVERIFIED replacement (review first -- no patch) ===');
      for (const b of blockedAll) {
        say('');
        say(
          `  deprecated model "${b.value}" found at ${rel(b.location.file)}:${b.location.line}:${b.location.column}, ` +
            `but its replacement "${b.replacement}" is ${b.status} -- review manually` +
            ` (auto-apply withheld by the verification gate)`,
        );
        for (const reason of b.reasons ?? []) say(`      - ${reason}`);
      }
    }

    // --- Section 2b: Azure deployment aliases — reported like blocked matches
    // (they need a human), but with a provisioning story, not a verification one.
    if (azureAll.length > 0) {
      say('');
      say('=== Azure deployment aliases (never auto-swapped -- no patch) ===');
      for (const a of azureAll) {
        say('');
        say(
          `  deprecated-looking value "${a.value}" under a deployment key at ` +
            `${rel(a.location.file)}:${a.location.line}:${a.location.column}`,
        );
        say(`      - ${AZURE_DEPLOYMENT_REASON}`);
      }
    }

    // --- Section 3 (least urgent, so last + collapsed): informational data
    // findings, ONE line per file. Full per-hit detail lives behind --verbose;
    // the file list is capped so a catalog-heavy repo cannot flood the report.
    if (dataViews.length > 0) {
      say('');
      say(
        `=== Informational: deprecated ids in data positions (${dataViews.length} hit${dataViews.length === 1 ? '' : 's'} ` +
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

    // Combined cross-language summary.
    const tsApplied = tsTier === 'A' ? tsTotalSites : 0;
    const pyApplied = pyTier === 'A' ? pyResult.siteCount : 0;
    const tierCReview =
      (tsTier === 'C' ? tsTotalSites : 0) +
      (pyTier === 'C' ? pyResult.siteCount : 0) +
      blockedAll.length +
      azureAll.length +
      dataViews.length;
    say('');
    say(
      `Summary: ${tsApplied + pyApplied} auto-fixed (Tier A), ` +
        `${tierCReview} flagged for review (Tier C).`,
    );

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
      // Each language writes on ITS OWN earned tier: a TS downgrade must not
      // block a verified python fix, and vice versa.
      const wrote: string[] = [];
      if (tsTier === 'A' && tsPatchedFiles.length > 0) {
        for (const f of tsPatchedFiles) writeFileSync(f.absPath, f.newText);
        wrote.push(`${tsPatchedFiles.length} ts file${tsPatchedFiles.length === 1 ? '' : 's'}`);
      }
      if (pyTier === 'A' && pyResult.patchedFiles.length > 0) {
        for (const f of pyResult.patchedFiles) writeFileSync(f.absPath, f.newText);
        wrote.push(
          `${pyResult.patchedFiles.length} py file${pyResult.patchedFiles.length === 1 ? '' : 's'}`,
        );
      }
      const downgraded = (tsTier === 'C' && tsTotalSites > 0) || pyTier === 'C';
      if (wrote.length > 0) {
        say('');
        say(`Applied the verified Tier A fix to ${wrote.join(' + ')} in ${resolved}.`);
      }
      if (downgraded) {
        say('');
        say(
          'Refusing to --write the downgraded (Tier C) portion: it was not verified. ' +
            'Review its diff above and apply by hand if it is correct.',
        );
      }
      if (wrote.length === 0 && !downgraded) {
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

    await printFooter();

    // (h) machine-readable report: same findings, plain data, diff included.
    if (json) {
      console.log(
        JSON.stringify(
          {
            summary: {
              tierA: autoFixableCount,
              blocked: blockedAll.length,
              informational: dataViews.length,
              filesScanned: totalFiles,
              tsFiles: tsFileCount,
              pyFiles: pyFiles.length,
            },
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
            blocked: blockedAll.map((b) => ({
              file: rel(b.location.file),
              from: b.value,
              to: b.replacement,
              status: b.status,
              line: b.location.line,
              reasons: b.reasons ?? [],
            })),
            azure: azureAll.map((a) => ({
              file: rel(a.location.file),
              value: a.value,
              line: a.location.line,
              reason: AZURE_DEPLOYMENT_REASON,
            })),
            informational: dataGroups.map((g) => ({
              file: g.file,
              count: g.hits,
              ids: [...g.idCounts.keys()],
            })),
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
    let modelEntries = 0;

    for (const entry of raw) {
      if (entry.kind !== 'model_id') continue;
      modelEntries++;
      const model = entry as unknown as LlmModelIdDeprecation;
      const { status, reasons } = classifyEntry(model, oracles);
      counts[status]++;

      console.log(`[${status.toUpperCase().padEnd(12)}] ${model.provider}: ${model.deprecated} -> ${model.replacement}`);
      for (const reason of reasons) console.log(`               - ${reason}`);

      if (status !== 'verified') {
        blocked.push({ status, provider: model.provider, from: model.deprecated, to: model.replacement });
      }
      if (opts.write) {
        entry.verification = { status, checkedAt, sources: oracles.sources, reasons };
      }
    }

    console.log('');
    console.log('-'.repeat(74));
    console.log(`model_id entries: ${modelEntries}`);
    console.log(`  verified     : ${counts.verified}  (auto-apply eligible — Tier A)`);
    console.log(`  unverified   : ${counts.unverified}  (live but stale/chained/superseded — BLOCKED)`);
    console.log(`  unverifiable : ${counts.unverifiable}  (out-of-class moderation/image/audio/tts — BLOCKED)`);

    if (blocked.length > 0) {
      console.log('');
      console.log('BLOCKED from auto-apply (verification gate withholds Tier A):');
      for (const b of blocked) {
        console.log(`  * [${b.status}] ${b.provider}: ${b.from} -> ${b.to}`);
      }
    }

    if (opts.write) {
      writeFileSync(registryPath, `${JSON.stringify(raw, null, 2)}\n`);
      console.log('');
      console.log(`Stamped verification.status into ${modelEntries} model_id entries -> ${registryPath}`);
    }
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
