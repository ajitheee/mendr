import { CHECK_LABEL, CHECK_MARK, type CheckStatus } from '../gates/status.js';
import { sanitize, secretValuesFromEnv } from '../redact/sanitize.js';
import type { GateOutcome, MigrationResult, MigrationVerdict } from './migrate.js';

// The human view of a migration result. Verdict first (a reader must see
// "verified" or "failed" before the diff), then the swaps, then each gate's
// outcome, the honest caveats, and finally the diff.

const MARK: Record<CheckStatus, string> = CHECK_MARK;

const VERDICT_LINE: Record<MigrationVerdict, string> = {
  verified: 'VERIFIED — a build and/or the existing tests passed in the sandbox and no gate rejected the migration. Ready to open as a reviewed PR (never auto-merged).',
  failed: 'FAILED — a gate rejected the migration. It is shown for inspection only; do not apply it.',
  inconclusive: 'INCONCLUSIVE — no build, test or eval actually ran in the sandbox, so nothing executable was proven. The diff is shown for review only.',
  no_migration: 'NO MIGRATION — no verified Tier-A swap was found. Nothing to apply.',
};

function gateRow(label: string, g: GateOutcome): string {
  const status = CHECK_LABEL[g.status];
  const detail = g.command ? ` [${g.command}]` : '';
  return `  ${MARK[g.status]} ${label.padEnd(11)} ${status}${detail}`;
}

export function renderMigrationReport(r: MigrationResult): string[] {
  const lines: string[] = ['mendr migrate (preview)', ''];
  if (r.registry) {
    const age = r.registry.ageDays < 0 ? 'age unknown' : `${r.registry.ageDays} days old`;
    lines.push(
      `Registry: ${r.registry.source} ${r.registry.version}${r.registry.publishedAt ? ` published ${r.registry.publishedAt.slice(0, 10)}` : ''} — ${r.registry.freshness.toUpperCase()} (${age}, max ${r.registry.maxAgeDays})`,
      '',
    );
  }

  if (!r.migrated) {
    lines.push(VERDICT_LINE.no_migration);
    for (const note of r.notes) lines.push(`  ${note}`);
    return lines;
  }

  lines.push(`Migration: ${r.migrations.length} model${r.migrations.length === 1 ? '' : 's'} across ${r.changedFiles.length} file${r.changedFiles.length === 1 ? '' : 's'}`);
  for (const m of r.migrations) {
    lines.push(`  ${m.model} -> ${m.to}  (${m.provider}, ${m.language}, ${m.sites} site${m.sites === 1 ? '' : 's'}: ${m.files.join(', ')})`);
  }
  lines.push('');
  lines.push('Verification on a throwaway copy (your working tree was never touched)');
  lines.push(gateRow('type-check', r.verification.typeCheck));
  lines.push(gateRow('build', r.verification.build));
  lines.push(gateRow('tests', r.verification.tests));
  lines.push(gateRow('eval', r.verification.eval));
  lines.push('');
  lines.push(`Verdict: ${VERDICT_LINE[r.verification.verdict]}`);
  lines.push(`PR-ready: ${r.prReady ? 'yes' : 'no'}`);
  for (const note of r.notes) lines.push(`note: ${note}`);

  if (r.diff) {
    lines.push('');
    lines.push('Proposed diff (not applied):');
    lines.push('');
    for (const l of r.diff.split('\n')) lines.push(l);
  }
  // ONE CHOKEPOINT, and the last thing this function does.
  //
  // What this report becomes: mendr-action writes it to a file, then publishes
  // that same file to the Actions log, the job summary AND the body of a public
  // pull request. So everything above — the diff's verbatim source lines and
  // their three lines of context, each gate's captured command output, every
  // note — is published. Sanitizing at the render boundary covers all of it at
  // once, including fields added later by someone who never read this comment.
  //
  // Safe here precisely because this is the HUMAN rendering. The machine copies
  // are untouched: `--patch` and the `--write` path use `r.diff` directly, and
  // a redacted diff would not apply.
  return sanitize(lines.join('\n'), secretValuesFromEnv(process.env)).split('\n');
}
