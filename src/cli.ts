#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { loadSpec } from './detect/fetchSpec.js';
import { diffSpecs } from './detect/diffSpec.js';
import { formatChangeSet } from './detect/changeModel.js';
import { loadProject } from './usage/scanRepo.js';
import { buildUsageMap, formatUsageMap } from './usage/usageMap.js';
import { intersect, formatAffectedSites } from './intersect/intersect.js';
import { applyRenames, applyRenamesToProject } from './fix/apply.js';
import { formatChange } from './detect/changeModel.js';
import { checkTypes, formatDiagnostic } from './gates/typecheck.js';
import { runRepoTests } from './gates/runTests.js';

const program = new Command();

program
  .name('mendr')
  .description('Auto-fix third-party API breaking changes (Stripe first) in a TypeScript repo.')
  .version('0.0.0');

program
  .command('scan')
  .argument('<repoPath>', 'path to the target TypeScript repo')
  .description('(Phase 2) List the Stripe API surface used by a repo.')
  .action((repoPath: string) => {
    const resolved = resolve(repoPath);
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
    const resolved = resolve(opts.repo);
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
    const resolved = resolve(repoPath);

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
