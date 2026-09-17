import type { MigrationResult, ModelMigration, SkippedItem } from '../migrate/migrate.js';

// THE PULL REQUEST BODY.
//
// This is the one artifact a customer actually reads. Everything else — the registry, the gates,
// the sandbox — exists so that a person can look at this and decide in a minute.
//
// What it used to say was the swap and four gate statuses. What a reviewer needs to decide is
// four other things, and all of them were already known at the moment the migration was planned
// and then thrown away:
//
//   * IS THIS URGENT? A date, and how far away it is. "Retires in 37 days" and "retired 114 days
//     ago" are different decisions, and the second one means something is already failing.
//   * WHO SAYS SO? The provider's own notice, linked, with the sentence it was read from. Not
//     "Mendr believes"; the vendor's page.
//   * HOW WELL CHECKED IS THE REPLACEMENT? The registry's own verdict, in the open. `verified`
//     and `quarantined` must not look the same in a pull request.
//   * WHAT ELSE CHANGED, AND WHAT DID YOU LEAVE? Coupled parameters move with the model and are
//     invisible in a diff unless named. And a body that lists only what was changed implies that
//     was all there was — which is exactly the impression a scanner must never give.
//
// The rendering lives here, in TypeScript, because it is the part with rules in it. The action
// keeps its own scaffold and simply prints this block.

/** One line per swap, with the evidence a reviewer needs to judge it. */
function swapLines(m: ModelMigration): string[] {
  const head = `- \`${m.from}\` → \`${m.to}\`  (${m.provider}, ${m.language}, ${m.sites} site${m.sites === 1 ? '' : 's'}: ${m.files.join(', ')})`;
  const e = m.evidence;
  if (!e) return [head];
  const out = [head];

  // Urgency first: a date on its own makes a reader do arithmetic.
  if (e.shutdownDate) {
    const when =
      e.daysUntil === null
        ? `shuts down ${e.shutdownDate}`
        : e.daysUntil < 0
          ? `**retired ${Math.abs(e.daysUntil)} days ago** (${e.shutdownDate}) — calls to it are already failing`
          : e.daysUntil === 0
            ? `**shuts down TODAY** (${e.shutdownDate})`
            : `shuts down in **${e.daysUntil} days** (${e.shutdownDate})`;
    out.push(`  - ${when}${e.lifecycle ? ` · provider status: ${e.lifecycle}` : ''}`);
  } else {
    out.push('  - no shutdown date announced yet — this is a deprecation notice, not a deadline');
  }

  if (e.sourceUrl) out.push(`  - provider notice: ${e.sourceUrl}`);

  // The replacement verdict is stated even when it is good, so that a reader learns what the
  // word means here and notices when it is absent.
  if (e.replacementVerdict) {
    const verdict =
      e.replacementVerdict === 'verified'
        ? '`verified` — the replacement is live in a public catalog and uncontradicted'
        : `\`${e.replacementVerdict}\` — **not a recommended swap**; check it before merging`;
    out.push(`  - replacement evidence: ${verdict}`);
  }
  for (const x of e.excerpts) {
    out.push(`  - > ${x.excerpt.replace(/\s+/g, ' ').trim()}`);
  }
  if (e.entryId) out.push(`  - registry entry: \`${e.entryId}\` (\`mendr evidence ${e.entryId}\`)`);
  return out;
}

const GATE_WORD: Record<string, string> = {
  pass: 'passed',
  fail: 'FAILED',
  inconclusive: 'could not run',
  'not-configured': 'not configured',
};

function gateLines(v: MigrationResult['verification']): string[] {
  // Every gate "not configured" means none of them RAN — a --skip-verify run, or one where
  // nothing executable could be built. Printing four identical rows invites the reader to think
  // four checks happened and found nothing to do.
  const all = [v.typeCheck, v.build, v.tests, v.eval];
  if (all.every((g) => g.status === 'not-configured')) {
    return ['- **nothing was verified on this run** — no type-check, no build, no tests, no eval'];
  }
  const row = (label: string, g: { status: string; detail?: string; command?: string }): string =>
    `- ${label}: **${GATE_WORD[g.status] ?? g.status}**` +
    (g.command ? ` (\`${g.command}\`)` : '') +
    (g.detail && g.status !== 'pass' ? ` — ${g.detail}` : '');
  return [
    row('type-check', v.typeCheck),
    row('build', v.build),
    row('your tests', v.tests),
    row('your eval', v.eval),
  ];
}

function skippedLines(skipped: readonly SkippedItem[]): string[] {
  if (skipped.length === 0) return [];
  return [
    '',
    `**Left alone (${skipped.length})** — retiring ids Mendr found and did **not** rewrite:`,
    ...skipped.map((s) => `- \`${s.file}:${s.line}\` \`${s.model}\` — ${s.reason}`),
  ];
}

/**
 * Render the evidence block for a migration pull request.
 *
 * Returns markdown WITHOUT the action's own scaffold (the marker line, the never-merges
 * sentence, the collapsed full report), so the shell keeps owning those and this owns the part
 * with judgement in it.
 */
export function renderPrBody(result: MigrationResult): string {
  const lines: string[] = [];

  lines.push('**Swaps**');
  for (const m of result.migrations) lines.push(...swapLines(m));

  if (result.paramTransforms.length > 0) {
    lines.push('');
    lines.push('**Coupled parameters** — changed with the model, because the new one rejects the old key:');
    for (const p of result.paramTransforms) lines.push(`- ${p}`);
  }

  lines.push('');
  lines.push('**Verification performed** (in this CI, on a throwaway copy — Mendr ran nothing on your machine)');
  lines.push(...gateLines(result.verification));

  // The honest ceiling, always. The gates prove the code still builds and the existing tests
  // still pass; they prove nothing about whether the new model answers the same way.
  if (!result.verification.behavioralTested) {
    lines.push('');
    lines.push(
      '> **Behaviour was not verified.** The gates prove this builds and your existing tests pass, ' +
        'not that the new model matches the old one on quality, latency, cost or response shape. ' +
        'Nothing automated can tell you that — check it before merging, or give Mendr an eval command.',
    );
  }

  lines.push(...skippedLines(result.skipped));

  // The behavioural ceiling is already stated above, as a blockquote, in this module's own
  // words. `notes` carries the CLI's version of the same sentence -- correct in a terminal
  // report where no blockquote exists, redundant here. Printed unfiltered, the first real
  // pull request said it twice, in two voices and two spellings, which reads as a tool that
  // does not know what it already told you.
  const extraNotes = (result.notes ?? []).filter((n) => !/behaviou?r was not verified/i.test(n));
  if (extraNotes.length > 0) {
    lines.push('');
    lines.push('**Also worth knowing**');
    for (const n of extraNotes) lines.push(`- ${n}`);
  }

  return lines.join('\n');
}
