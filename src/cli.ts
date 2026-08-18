#!/usr/bin/env node
import { Command } from 'commander';
import type { Project } from 'ts-morph';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { loadSpec } from './detect/fetchSpec.js';
import { diffSpecs } from './detect/diffSpec.js';
import { formatChangeSet } from './detect/changeModel.js';
import { countAnalyzableSourceFiles, loadProject } from './usage/scanRepo.js';
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
import { applyLlmFixesToProject } from './fix/llmFix.js';
import { classifyEntry } from './registry/verify.js';
import { fetchOracles } from './registry/oracles.js';
import type { LlmModelIdDeprecation, VerificationStatus } from './types.js';

const program = new Command();

program
  .name('mendr')
  .description('Auto-fix third-party API breaking changes: deprecated LLM model ids + Stripe renames.')
  .version('0.1.0');

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
 * Guard the dangerous FALSE-CLEAN case. A mistyped path, a pure-JS repo, or a
 * tsconfig whose `include` matched nothing loads 0 analyzable source files — and
 * the old code then printed "Nothing to fix" with a success exit, which a user
 * cannot tell apart from a genuinely clean repo. Fail loudly instead, and return
 * the count so a real "clean" can say how many files it actually scanned.
 */
function assertAnalyzable(project: Project, resolved: string): number {
  const fileCount = countAnalyzableSourceFiles(project);
  if (fileCount === 0) {
    console.error(
      `mendr: found no analyzable .ts/.tsx/.mts/.cts files under ${resolved}.\n` +
        `is this the repo root? pure-JS repos are not supported yet (TypeScript only for now).`,
    );
    process.exit(2);
  }
  return fileCount;
}

program
  .command('scan')
  .argument('<repoPath>', 'path to the target TypeScript repo')
  .description('(Phase 2) List the Stripe API surface used by a repo.')
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
  .description('(Phase 1/3) List breaking changes between two Stripe spec snapshots.')
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
  .description('(Phase 5) Output a GATED rename codemod diff + earned confidence tier.')
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
  .command('fix-llm')
  .argument('<repoPath>', 'path to the target TypeScript repo')
  .option('--skip-gates', 'skip the type-check + test gates (assert Tier A without verifying)')
  .option('--write', 'apply the VERIFIED Tier A diff to your working tree (default: print only)')
  .option('-o, --output <file>', 'also write the combined diff to a file')
  .description('(LLM mode) Output a GATED model-id + param codemod diff + earned confidence tier.')
  .action(async (repoPath: string, opts: { skipGates?: boolean; write?: boolean; output?: string }) => {
    const resolved = resolveRepoOrExit(repoPath);

    // Registry-driven detect. Two locators run over the same scan project:
    //   1. model-id literals whose value exactly matches a retired model id;
    //   2. model-COUPLED param sites (options objects whose resolved model is in
    //      an entry's on_models). A `temperature` on an accepting model is NOT a
    //      site — the coupling is enforced in the locator, not just the fixer.
    const registry = loadLlmRegistry();
    const scanProject = loadProject(resolved);
    const fileCount = assertAnalyzable(scanProject, resolved);
    const modelMatches = findModelIdLiterals(scanProject, registry);
    const paramMatches = findParamSites(scanProject, registry);

    // Split model-id matches by AST position AND verification status:
    //   - `model_arg` + verified  -> Tier A swap candidates;
    //   - `model_arg` + NOT verified -> Tier C locate-only (BLOCKED by the gate);
    //   - `data`                  -> Tier C locate-only (never edited).
    const modelArgMatches = modelMatches.filter((m) => m.position === 'model_arg');
    const swapMatches = modelArgMatches.filter((m) => isVerified(m.deprecation));
    const blockedCount = modelArgMatches.length - swapMatches.length;
    const dataMatchCount = modelMatches.length - modelArgMatches.length;

    if (
      swapMatches.length === 0 &&
      paramMatches.length === 0 &&
      dataMatchCount === 0 &&
      blockedCount === 0
    ) {
      console.log(
        `Scanned ${fileCount} source file${fileCount === 1 ? '' : 's'}. ` +
          'No deprecated LLM model ids or model-coupled params found. Nothing to fix.',
      );
      return;
    }

    // Human labels. Model-id: one per unique deprecated -> replacement swap,
    // counting only swap-safe (`model_arg`) positions.
    const swaps = new Map<string, string>();
    for (const m of swapMatches) swaps.set(m.deprecation.deprecated, m.deprecation.replacement);
    // Params: one per unique transform (removal or rename), tagged with model.
    const paramLabelSet = new Set<string>();
    for (const p of paramMatches) {
      paramLabelSet.add(
        p.deprecation.kind === 'param_removal'
          ? `remove "${p.deprecation.param}" (on ${p.model})`
          : `rename "${p.deprecation.param}" -> "${p.deprecation.replacement}" (on ${p.model})`,
      );
    }
    const labels = [
      ...[...swaps].map(([from, to]) => `"${from}" -> "${to}"`),
      ...paramLabelSet,
    ].join(', ');

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
    // edited — the whole point of the call-site-aware swap.
    const printModelIdDataMatches = (dataMatches: ModelIdDataLocate[]) => {
      if (dataMatches.length === 0) return;
      console.log('');
      console.log('=== Tier C: locate-only — deprecated model id used as DATA (no patch) ===');
      for (const d of dataMatches) {
        const display = relative(resolved, d.location.file).replace(/\\/g, '/');
        console.log('');
        console.log(
          `  deprecated model id "${d.value}" used as data at ` +
            `${display}:${d.location.line}:${d.location.column} — review manually` +
            ` (would map to "${d.replacement}" if it were a live model argument)`,
        );
      }
    };

    // Tier C: deprecated model ids in LIVE model-argument positions whose registry
    // entry is NOT verified (stale/chained/unverifiable/unstamped). The gate
    // refuses to auto-swap these — the replacement is not trustworthy — so they
    // are surfaced for manual review instead of being applied.
    const printBlockedModelArgMatches = (blockedMatches: BlockedModelLocate[]) => {
      if (blockedMatches.length === 0) return;
      console.log('');
      console.log(
        '=== Tier C: locate-only — deprecated model id with an UNVERIFIED replacement (no patch) ===',
      );
      for (const b of blockedMatches) {
        const display = relative(resolved, b.location.file).replace(/\\/g, '/');
        console.log('');
        console.log(
          `  deprecated model "${b.value}" found at ${display}:${b.location.line}:${b.location.column}, ` +
            `but its replacement "${b.replacement}" is ${b.status} — review manually` +
            ` (auto-apply withheld by the verification gate)`,
        );
        for (const reason of b.reasons ?? []) console.log(`      - ${reason}`);
      }
    };

    if (opts.skipGates) {
      // Fast local mode: assert Tier A without verifying.
      const result = applyLlmFixesToProject(loadProject(resolved), registry, resolved);
      const totalSwaps = result.modelIdSites + result.paramsRemoved + result.paramsRenamed;
      console.log('=== Tier A: auto-fixable model-id + param codemod ===');
      console.log('');
      console.log(result.diff);
      if (totalSwaps > 0) {
        console.log(
          `Tier A: ${breakdown(result)} (${labels}) across ` +
            `${result.changedFiles.length} file${result.changedFiles.length === 1 ? '' : 's'}. ` +
            `(gates skipped — tier asserted, not verified)`,
        );
      } else {
        console.log('Tier A: nothing to swap (no live model-argument positions matched).');
      }
      printModelIdDataMatches(result.dataMatches);
      printBlockedModelArgMatches(result.blockedMatches);
      const tierCLocateOnly = result.dataMatches.length + result.blockedMatches.length;
      console.log('');
      console.log(
        `Summary: ${totalSwaps} auto-fixed (Tier A), ` +
          `${tierCLocateOnly} flagged for review (Tier C).`,
      );
      if (opts.output && result.diff) {
        writeFileSync(resolve(opts.output), result.diff);
        console.log(`\nWrote diff to ${opts.output}.`);
      }
      if (opts.write) {
        console.log(
          '\nnote: --write applies only the VERIFIED (gated) fix. ' +
            're-run without --skip-gates to write.',
        );
      }
      return;
    }

    // Build an unpatched baseline + a patched project from the same repo,
    // in-memory. The baseline anchors the type-check gate; the patched project
    // (BOTH passes applied) supplies the combined diff + gate inputs.
    const baselineProject = loadProject(resolved);
    const patchedProject = loadProject(resolved);
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
    console.log(`  type-check: ${typeLabel} (required)`);
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
        `Tier C (downgraded): ${breakdown(result)} (${labels}) NOT applied — ` +
          `${downgradeReason.replace(/\.+$/, '')}. ` +
          `The diff above is shown for manual review only; it is not trusted.`,
      );
    }

    // Tier C: deprecated model ids in data positions, and ids whose replacement
    // is unverified — always surfaced, never patched, regardless of the gate
    // outcome above.
    printModelIdDataMatches(result.dataMatches);
    printBlockedModelArgMatches(result.blockedMatches);

    const tierCReview =
      (tier === 'C' ? totalSites : 0) + result.dataMatches.length + result.blockedMatches.length;
    console.log('');
    console.log(
      `Summary: ${tier === 'A' ? totalSites : 0} auto-fixed (Tier A), ` +
        `${tierCReview} flagged for review (Tier C).`,
    );

    if (opts.output && result.diff) {
      writeFileSync(resolve(opts.output), result.diff);
      console.log('');
      console.log(`Wrote diff to ${opts.output}.`);
    }

    if (opts.write) {
      if (tier === 'A' && patchedFiles.length > 0) {
        for (const f of patchedFiles) writeFileSync(f.absPath, f.newText);
        console.log('');
        console.log(
          `Applied the verified Tier A fix to ${patchedFiles.length} ` +
            `file${patchedFiles.length === 1 ? '' : 's'} in ${resolved}.`,
        );
      } else if (tier === 'C') {
        console.log('');
        console.log(
          'Refusing to --write: the fix was downgraded to Tier C (not verified). ' +
            'Review the diff above and apply by hand if it is correct.',
        );
      } else {
        console.log('');
        console.log('Nothing to --write (no verified Tier A changes).');
      }
    } else if (tier === 'A' && result.diff) {
      console.log('');
      console.log('To apply: re-run with --write, or pipe the diff above into `git apply`.');
    }
  });

program
  .command('verify-registry')
  .option('--write', 'stamp the computed verification.status back into the registry JSON')
  .description(
    '(LLM mode) Verify every model-id replacement against public catalogs + provider recommendations; print an audit.',
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

program.parse();
