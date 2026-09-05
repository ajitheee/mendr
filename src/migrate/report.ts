import type { GateOutcome, MigrationResult, MigrationVerdict } from './migrate.js';

// The human view of a migration result. Verdict first (a reader must see
// "verified" or "failed" before the diff), then the swaps, then each gate's
// outcome, the honest caveats, and finally the diff.

const MARK: Record<GateOutcome['status'], string> = {
  pass: '✓',
  fail: '✗',
  inconclusive: '○',
  'not-configured': '·',
};

const VERDICT_LINE: Record<MigrationVerdict, string> = {
  verified: 'VERIFIED — a build and/or the existing tests passed in the sandbox and no gate rejected the migration. Ready to open as a reviewed PR (never auto-merged).',
  failed: 'FAILED — a gate rejected the migration. It is shown for inspection only; do not apply it.',
  inconclusive: 'INCONCLUSIVE — no build, test or eval actually ran in the sandbox, so nothing executable was proven. The diff is shown for review only.',
  no_migration: 'NO MIGRATION — no verified Tier-A swap was found. Nothing to apply.',
};

function gateRow(label: string, g: GateOutcome): string {
  const status = g.status === 'not-configured' ? 'not configured' : g.status;
  const detail = g.command ? ` [${g.command}]` : '';
  return `  ${MARK[g.status]} ${label.padEnd(11)} ${status}${detail}`;
}

export function renderMigrationReport(r: MigrationResult): string[] {
  const lines: string[] = ['mendr migrate (preview)', ''];

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
  lines.push('Sandbox verification (your working tree was never touched)');
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
  return lines;
}
