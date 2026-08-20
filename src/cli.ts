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
  countAnalyzableSourceFiles,
  findUncoveredSourceFiles,
  loadProject,
} from './usage/scanRepo.js';
import { buildUsageMap, formatUsageMap } from './usage/usageMap.js';
import { intersect, formatAffectedSites } from './intersect/intersect.js';
import { applyRenames, applyRenamesToProject } from './fix/apply.js';
import { formatChange } from './detect/changeModel.js';
import { checkTypes, formatDiagnostic } from './gates/typecheck.js';
import { runRepoTests } from './gates/runTests.js';
import { isVerified, loadLlmRegistry, resolveRegistryPath } from './usage/llmRegistry.js';
import {
  findModelIdLiterals,
  type BlockedModelLocate,
  type ModelIdDataLocate,
} from './usage/scanLiterals.js';
import { findParamSites } from './fix/paramFix.js';
import { applyLlmFixesToProject, type LlmFixResult } from './fix/llmFix.js';
import { collectPythonFiles } from './python/scanPy.js';
import { applyPyModelIdFixes } from './python/fixPy.js';
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
  console.log(`Cloning ${url} (shallow, read-only copy)...`);
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

program
  .command('fix-llm')
  .argument('<repoPath>', 'path to the target TypeScript/Python repo, or a GitHub/git URL to scan a copy of')
  .option('--skip-gates', 'skip the type-check + test gates (assert Tier A without verifying)')
  .option('--write', 'apply the VERIFIED Tier A diff to your working tree (default: print only)')
  .option('-o, --output <file>', 'also write the combined diff to a file')
  .description('Find and fix deprecated LLM model ids (prints a verified diff)')
  .action(async (repoPath: string, opts: { skipGates?: boolean; write?: boolean; output?: string }) => {
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
    const scanProject = loadProject(resolved);
    const tsFileCount = countAnalyzableSourceFiles(scanProject);
    const pyFiles = collectPythonFiles(resolved);
    assertAnalyzable(tsFileCount, pyFiles.length, resolved);
    // The per-language breakdown appears as soon as any Python is in scope, so
    // "Scanned 42 source files" never silently means "42 TS files, Python
    // ignored". A TS-only repo keeps the original single-count line.
    const totalFiles = tsFileCount + pyFiles.length;
    console.log(
      pyFiles.length > 0
        ? `Scanned ${totalFiles} source file${totalFiles === 1 ? '' : 's'} (${tsFileCount} ts, ${pyFiles.length} py).`
        : `Scanned ${tsFileCount} source file${tsFileCount === 1 ? '' : 's'}.`,
    );

    // Honesty about coverage: a tsconfig-driven load only sees what `include`
    // matched. Any repo TypeScript OUTSIDE that is invisible to the scan — say
    // so up front instead of letting a partial scan read as a full one.
    const uncovered = findUncoveredSourceFiles(scanProject, resolved);
    if (uncovered.length > 0) {
      const n = uncovered.length;
      console.log(
        `warning: ${n} TypeScript file${n === 1 ? '' : 's'} under this repo ${n === 1 ? 'is' : 'are'} outside tsconfig ` +
          `include and ${n === 1 ? 'was' : 'were'} NOT scanned (first few: ${uncovered.slice(0, 3).join(', ')})`,
      );
    }

    const modelMatches = findModelIdLiterals(scanProject, registry);
    const paramMatches = findParamSites(scanProject, registry);

    // Python pass: scan + swap + syntax gate, all in memory (see fixPy.ts).
    // Run up front (it is cheap) so the nothing-to-fix check covers BOTH
    // languages — a pure-Python repo must not read as "clean" here.
    const pyResult = await applyPyModelIdFixes(pyFiles, registry, resolved);
    const pyHasFindings =
      pyResult.siteCount > 0 ||
      pyResult.dataMatches.length > 0 ||
      pyResult.blockedMatches.length > 0;

    // Split TS model-id matches by AST position AND verification status:
    //   - `model_arg` + verified  -> Tier A swap candidates;
    //   - `model_arg` + NOT verified -> Tier C locate-only (BLOCKED by the gate);
    //   - `data`                  -> Tier C locate-only (never edited).
    const modelArgMatches = modelMatches.filter((m) => m.position === 'model_arg');
    const swapMatches = modelArgMatches.filter((m) => isVerified(m.deprecation));
    const blockedCount = modelArgMatches.length - swapMatches.length;
    const dataMatchCount = modelMatches.length - modelArgMatches.length;
    const tsHasFindings =
      swapMatches.length > 0 || paramMatches.length > 0 || dataMatchCount > 0 || blockedCount > 0;

    if (!tsHasFindings && !pyHasFindings) {
      console.log('No deprecated LLM model ids or model-coupled params found. Nothing to fix.');
      return;
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
    const labels = [...[...swaps.values()].map(swapLabel), ...paramLabelSet].join(', ');

    // Render a per-transform breakdown line from a fix result.
    const breakdown = (r: { modelIdSites: number; paramsRemoved: number; paramsRenamed: number }) =>
      [
        `${r.modelIdSites} model-id swap${r.modelIdSites === 1 ? '' : 's'}`,
        `${r.paramsRemoved} param${r.paramsRemoved === 1 ? '' : 's'} removed`,
        `${r.paramsRenamed} param${r.paramsRenamed === 1 ? '' : 's'} renamed`,
      ].join(', ');

    // Tier C: deprecated model ids that MATCHED but sit in a DATA position (an
    // object key, array element, pricing/encoding/normalization map) rather than
    // a live model argument. These are surfaced for manual review and NEVER
    // edited — the whole point of the call-site-aware swap. `tag` marks which
    // language's scan produced the section (' (python)' or '' for TS).
    const printModelIdDataMatches = (dataMatches: ModelIdDataLocate[], tag = '') => {
      if (dataMatches.length === 0) return;
      console.log('');
      console.log(`=== Tier C${tag}: locate-only -- deprecated model id used as DATA (no patch) ===`);
      for (const d of dataMatches) {
        const display = relative(resolved, d.location.file).replace(/\\/g, '/');
        console.log('');
        console.log(
          `  deprecated model id "${d.value}" used as data at ` +
            `${display}:${d.location.line}:${d.location.column} -- review manually` +
            ` (would map to "${d.replacement}" if it were a live model argument)`,
        );
      }
    };

    // Tier C: deprecated model ids in LIVE model-argument positions whose registry
    // entry is NOT verified (stale/chained/unverifiable/unstamped). The gate
    // refuses to auto-swap these — the replacement is not trustworthy — so they
    // are surfaced for manual review instead of being applied.
    const printBlockedModelArgMatches = (blockedMatches: BlockedModelLocate[], tag = '') => {
      if (blockedMatches.length === 0) return;
      console.log('');
      console.log(
        `=== Tier C${tag}: locate-only -- deprecated model id with an UNVERIFIED replacement (no patch) ===`,
      );
      for (const b of blockedMatches) {
        const display = relative(resolved, b.location.file).replace(/\\/g, '/');
        console.log('');
        console.log(
          `  deprecated model "${b.value}" found at ${display}:${b.location.line}:${b.location.column}, ` +
            `but its replacement "${b.replacement}" is ${b.status} -- review manually` +
            ` (auto-apply withheld by the verification gate)`,
        );
        for (const reason of b.reasons ?? []) console.log(`      - ${reason}`);
      }
    };

    /**
     * Print the Python results under their own "(python)" tier heading and
     * return the tier they earned ('A' = safe to --write; undefined = nothing
     * to swap). Python swaps are NEVER folded into the TS Tier A section:
     * Python's strongest gate is a baseline-relative syntax re-parse, which is
     * strictly weaker than the TS type-check gate, and the separate heading
     * keeps that weaker verification visible instead of blending it away.
     */
    const printPythonSection = async (): Promise<'A' | 'C' | undefined> => {
      let pyTier: 'A' | 'C' | undefined;
      if (pyResult.siteCount > 0) {
        // Best-effort test gate. There is no pytest runner support yet, so it
        // only means anything when the repo has an npm test entrypoint — for
        // pure-Python repos we say "not attempted" rather than pretending.
        let testResult: TestGateResult = {
          status: 'inconclusive',
          output: 'not attempted (python)',
        };
        let testLabel = 'not attempted (python -- pytest runner not supported yet)';
        if (opts.skipGates) {
          testLabel = 'skipped';
        } else if (existsSync(join(resolved, 'package.json'))) {
          testResult = await runRepoTests(resolved, pyResult.patchedFiles);
          testLabel = `${testResult.status} (best-effort)`;
        }

        // The syntax gate ALWAYS ran (inside the fix pass — an in-memory
        // re-parse is essentially free), even under --skip-gates: a patch we
        // KNOW breaks parsing must never be presented as Tier A.
        pyTier = pyResult.syntaxGate.passed && testResult.status !== 'fail' ? 'A' : 'C';

        const heading =
          pyTier === 'A'
            ? opts.skipGates
              ? '=== Tier A (python): auto-fixable model-id codemod ==='
              : '=== Tier A (python): auto-fixable model-id codemod (VERIFIED) ==='
            : '=== Tier A candidate (python) -> DOWNGRADED to Tier C (unverified codemod) ===';
        console.log('');
        console.log(heading);
        console.log('');
        console.log(pyResult.diff);
        console.log('Gate summary:');
        console.log(
          `  syntax-check: ${pyResult.syntaxGate.passed ? 'pass' : 'fail'} ` +
            '(Python has no type gate -- weaker than TS verification)',
        );
        console.log(`  tests:        ${testLabel}`);
        console.log('');

        const pyLabels = pyResult.swapDeprecations.map(swapLabel).join(', ');
        const n = pyResult.siteCount;
        const nf = pyResult.changedFiles.length;
        if (pyTier === 'A') {
          console.log(
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
          console.log(
            `Tier C (python, downgraded): ${n} model-id swap${n === 1 ? '' : 's'} (${pyLabels}) ` +
              `NOT applied -- ${reason}. ` +
              'The diff above is shown for manual review only; it is not trusted.',
          );
        }
      }

      printModelIdDataMatches(pyResult.dataMatches, ' (python)');
      printBlockedModelArgMatches(pyResult.blockedMatches, ' (python)');
      return pyTier;
    };

    if (opts.skipGates) {
      // Fast local mode: assert Tier A without verifying. Reuses the scan
      // project directly — the locators above never mutated it. The TS section
      // is silent when the TS scan found nothing at all (pure-Python repo).
      const result = applyLlmFixesToProject(scanProject, registry, resolved);
      const totalSwaps = result.modelIdSites + result.paramsRemoved + result.paramsRenamed;
      if (tsHasFindings) {
        console.log('=== Tier A: auto-fixable model-id + param codemod ===');
        console.log('');
        console.log(result.diff);
        if (totalSwaps > 0) {
          console.log(
            `Tier A: ${breakdown(result)} (${labels}) across ` +
              `${result.changedFiles.length} file${result.changedFiles.length === 1 ? '' : 's'}. ` +
              `(gates skipped -- tier asserted, not verified)`,
          );
        } else {
          console.log('Tier A: nothing to swap (no live model-argument positions matched).');
        }
        printModelIdDataMatches(result.dataMatches);
        printBlockedModelArgMatches(result.blockedMatches);
      }

      const pyTier = await printPythonSection();
      const pyAsserted = pyTier === 'A' ? pyResult.siteCount : 0;
      const tierCLocateOnly =
        result.dataMatches.length +
        result.blockedMatches.length +
        pyResult.dataMatches.length +
        pyResult.blockedMatches.length +
        (pyTier === 'C' ? pyResult.siteCount : 0);
      console.log('');
      console.log(
        `Summary: ${totalSwaps + pyAsserted} auto-fixed (Tier A), ` +
          `${tierCLocateOnly} flagged for review (Tier C).`,
      );
      // A downgraded (Tier C) python diff failed its syntax gate — never hand
      // a KNOWN-broken patch to a file a user may pipe into `git apply`.
      const combinedDiff = [result.diff, pyTier === 'A' ? pyResult.diff : '']
        .filter(Boolean)
        .join('\n');
      if (opts.output && combinedDiff) {
        writeDiffOrExit(opts.output, combinedDiff);
        console.log(`\nWrote diff to ${opts.output}.`);
      } else if (opts.output && !combinedDiff) {
        console.log(`No auto-fixable changes; did not write ${opts.output}.`);
      }
      if (opts.write) {
        console.log(
          '\nnote: --write applies only the VERIFIED (gated) fix. ' +
            're-run without --skip-gates to write.',
        );
      }
      return;
    }

    // Gated TS pass — only when the TS scan actually found something. Running
    // the gates over an untouched project would burn a full baseline load +
    // type-check + npm-test cycle to verify a no-op (the pure-Python case).
    let tsResult: LlmFixResult | undefined;
    let tsTier: 'A' | 'C' = 'A';
    let tsTotalSites = 0;
    let tsPatchedFiles: { absPath: string; newText: string }[] = [];
    if (tsHasFindings) {
      // Build an unpatched baseline, and reuse the scan project as the PATCHED
      // project (the locators above never mutated it — only the fix passes do).
      // The baseline anchors the type-check gate; the patched project (BOTH
      // passes applied) supplies the combined diff + gate inputs.
      const baselineProject = loadProject(resolved);
      const patchedProject = scanProject;
      const result = applyLlmFixesToProject(patchedProject, registry, resolved);
      const totalSites = result.modelIdSites + result.paramsRemoved + result.paramsRenamed;

      // Gate 1 (REQUIRED): baseline-relative type-check (in-memory, no subprocess).
      const typeResult = checkTypes(baselineProject, patchedProject);

      // Gate 2 (BEST-EFFORT): run the repo's tests against the patched files in a
      // temp copy. A hard test FAILURE downgrades; inconclusive (no script / not
      // installed) does NOT block Tier A, since tests are best-effort here.
      const patchedFiles = result.changedFiles.map((absPath) => ({
        absPath,
        newText: patchedProject.getSourceFileOrThrow(absPath).getFullText(),
      }));
      const testResult = await runRepoTests(resolved, patchedFiles);

      const typeLabel = typeResult.passed ? 'pass' : 'fail';
      const gatesPassed = typeResult.passed && testResult.status !== 'fail';
      const tier: 'A' | 'C' = gatesPassed ? 'A' : 'C';

      let downgradeReason = '';
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

      const heading =
        tier === 'A'
          ? '=== Tier A: auto-fixable model-id + param codemod (VERIFIED) ==='
          : '=== Tier A candidate -> DOWNGRADED to Tier C (unverified codemod) ===';
      console.log(heading);
      console.log('');
      console.log(result.diff);
      console.log('Gate summary:');
      // "pass" here means BASELINE-RELATIVE pass. When the repo already had type
      // errors before the patch, say so — a bare "pass" would overclaim.
      const typeNote =
        typeResult.passed && typeResult.baselineCount > 0
          ? `pass (no new errors; ${typeResult.baselineCount} pre-existing ignored)`
          : `${typeLabel} (required)`;
      console.log(`  type-check: ${typeNote}`);
      console.log(`  tests:      ${testResult.status} (best-effort)`);
      console.log('');

      if (tier === 'A') {
        console.log(
          `Tier A: ${breakdown(result)} (${labels}) across ` +
            `${result.changedFiles.length} file${result.changedFiles.length === 1 ? '' : 's'}. ` +
            `(verified: type-check passes${testResult.status === 'pass' ? ' + tests pass' : ''})`,
        );
      } else {
        console.log(
          `Tier C (downgraded): ${breakdown(result)} (${labels}) NOT applied -- ` +
            `${downgradeReason.replace(/\.+$/, '')}. ` +
            `The diff above is shown for manual review only; it is not trusted.`,
        );
      }

      // Tier C: deprecated model ids in data positions, and ids whose replacement
      // is unverified — always surfaced, never patched, regardless of the gate
      // outcome above.
      printModelIdDataMatches(result.dataMatches);
      printBlockedModelArgMatches(result.blockedMatches);

      tsResult = result;
      tsTier = tier;
      tsTotalSites = totalSites;
      tsPatchedFiles = patchedFiles;
    }

    // Python pass, printed under its own heading with its own (weaker) gate.
    const pyTier = await printPythonSection();

    // Combined cross-language summary.
    const tsApplied = tsTier === 'A' ? tsTotalSites : 0;
    const pyApplied = pyTier === 'A' ? pyResult.siteCount : 0;
    const tierCReview =
      (tsTier === 'C' ? tsTotalSites : 0) +
      (tsResult?.dataMatches.length ?? 0) +
      (tsResult?.blockedMatches.length ?? 0) +
      (pyTier === 'C' ? pyResult.siteCount : 0) +
      pyResult.dataMatches.length +
      pyResult.blockedMatches.length;
    console.log('');
    console.log(
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
      console.log('');
      console.log(`Wrote diff to ${opts.output}.`);
    } else if (opts.output && !combinedDiff) {
      console.log('');
      console.log(`No auto-fixable changes; did not write ${opts.output}.`);
    }

    if (opts.write) {
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
        console.log('');
        console.log(`Applied the verified Tier A fix to ${wrote.join(' + ')} in ${resolved}.`);
      }
      if (downgraded) {
        console.log('');
        console.log(
          'Refusing to --write the downgraded (Tier C) portion: it was not verified. ' +
            'Review its diff above and apply by hand if it is correct.',
        );
      }
      if (wrote.length === 0 && !downgraded) {
        console.log('');
        console.log('Nothing to --write (no verified Tier A changes).');
      }
    } else if ((tsTier === 'A' && tsResult?.diff) || (pyTier === 'A' && pyResult.diff)) {
      console.log('');
      console.log('To apply: re-run with --write, or pipe the diff above into `git apply`.');
    }
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
