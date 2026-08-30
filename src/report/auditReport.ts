// Human render for the `audit` command.
//
// The default audit needs NO KEY: source + config + registry stand alone, and the
// report says plainly that production usage is unknown rather than implying the
// model is unused. Runtime evidence, when the customer chooses to connect it,
// upgrades "Production usage: not measured" to observed/not observed.
//
// This renderer NEVER prints an instruction to change code, and it prints the
// coverage report on every run. A general "clean" is unreachable — the conclusion
// comes from concludeAudit, which is the single gate.

import {
  concludeAudit,
  coverageGaps,
  type AuditCoverage,
  type LocationRef,
  type ModelInvestigation,
} from '../audit/investigation.js';
import { RUNTIME_SOURCE_LABEL } from '../runtime/evidence.js';

export interface AuditMeta {
  /** Only set when a runtime window applies (a provider/export read). */
  from: string | null;
  to: string | null;
  coverage: AuditCoverage;
}

const int = (n: number): string => n.toLocaleString('en-US');
const usd = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function deadline(status: string | null, days: number | null, shutdownDate: string | null): string {
  const life = status ?? 'listed';
  let when: string;
  if (days === null) when = shutdownDate ? `shuts ${shutdownDate}` : 'no dated deadline';
  else if (days < 0) when = `${-days}d OVERDUE`;
  else if (days === 0) when = 'due TODAY';
  else when = `${days}d left`;
  return `${life} — ${when}${shutdownDate && days !== null ? ` (${shutdownDate})` : ''}`;
}

const roleLabel = (r: LocationRef['role']): string =>
  r === 'runtime_selector_candidate' ? 'config runtime selector candidate'
    : r === 'catalog_definition' ? 'config catalog definition'
      : r === 'test_fixture' ? 'test/data fixture (not a selector)'
        : r === 'code_call_site' ? 'code call site (model argument)'
          : r === 'code_candidate' ? 'code model literal (use not proven)'
            : r === 'code_reference' ? 'code data reference'
              : 'config catalog reference';

const locationPhrase = (l: LocationRef): string =>
  `${l.file}:${l.line} — ${roleLabel(l.role)}${l.providerSurface ? ` (surface: ${l.providerSurface})` : ''}`;

/** The "Production usage:" line — the honest default is "not measured". */
function productionUsageLine(inv: ModelInvestigation): string {
  const u = inv.productionUsage;
  if (!u.measured) return 'Production usage: not measured';
  if (!u.observed) return 'Production usage: not observed in the connected source (which covers only what it records)';
  const bits: string[] = [];
  if (u.requestsReported && u.requests > 0) bits.push(`${int(u.requests)} requests`);
  else bits.push('requests not reported by this source');
  if (u.lastSeen) bits.push(`last seen ${u.lastSeen}`);
  if (u.services.length) bits.push(`service ${u.services.join(', ')}`);
  if (u.environments.length) bits.push(`env ${u.environments.join(', ')}`);
  if (u.failures > 0) bits.push(`${int(u.failures)} failed`);
  if (u.costUsd !== null && u.costUsd > 0) bits.push(usd(u.costUsd));
  return `Production usage: OBSERVED — ${bits.join(', ')}`;
}

const pad = (s: string, n = 18): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/**
 * The coverage report — printed on EVERY run so the reader always sees which
 * surfaces ran. `✓` completed, `○` not run / not proven, `✗` attempted and failed.
 */
export function coverageReport(meta: AuditMeta): string[] {
  const c = meta.coverage;
  const row = (mark: string, label: string, detail: string): string => `${mark} ${pad(label + ':')} ${detail}`;
  const lines = ['Audit coverage', ''];

  const src = c.source;
  lines.push(
    src.failed
      ? row('✗', 'Source code', `scan FAILED${src.note ? ` — ${src.note}` : ''}`)
      : !src.analyzed
        ? row('○', 'Source code', `not scanned${src.note ? ` — ${src.note}` : ''}`)
        : row('✓', 'Source code', `${int(src.tsFiles + src.pyFiles)} files scanned (${int(src.tsFiles)} TS/TSX, ${int(src.pyFiles)} Python)`),
  );
  lines.push(
    c.config.failed
      ? row('✗', 'Configuration', 'scan FAILED')
      : row('✓', 'Configuration', `${int(c.config.filesScanned)} files scanned`),
  );
  lines.push(row('✓', 'Registry', c.registry.providers.join(', ') || 'none'));

  const rt = c.runtime;
  const window = meta.from && meta.to ? `, ${meta.from} to ${meta.to}` : '';
  lines.push(
    rt.failed
      ? row('✗', 'Runtime usage', `read FAILED${rt.note ? ` — ${rt.note}` : ''}`)
      : rt.connected
        ? row('✓', 'Runtime usage', `${RUNTIME_SOURCE_LABEL[rt.source ?? 'usage_export']}${window}`)
        : row('○', 'Runtime usage', 'not measured — no runtime source connected (optional)'),
  );
  lines.push(row('○', 'Reader tie-back', 'not proven'));

  for (const note of rt.notes ?? []) lines.push(`    · ${note}`);
  return lines;
}

const CONCLUSION_LINE: Record<string, string> = {
  exposure_detected: 'EXPOSURE DETECTED',
  no_exposure_in_completed_surfaces: 'NO EXPOSURE IN COMPLETED SURFACES',
  inconclusive: 'INCONCLUSIVE',
  audit_failed: 'AUDIT FAILED',
};

/** Plain-language plural: "one is", "two are". */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n: number): string => (n < WORDS.length ? WORDS[n] : String(n));

/**
 * The plain-language summary a customer reads first: how many, what kind, whether
 * runtime was measured, and that nothing was changed.
 */
export function plainSummary(investigations: readonly ModelInvestigation[], coverage: AuditCoverage): string[] {
  const n = investigations.length;
  if (n === 0) return [];
  const lines = [`We found ${word(n)} retiring AI ${n === 1 ? 'dependency' : 'dependencies'}.`, ''];

  const kind = (inv: ModelInvestigation): string => {
    if (inv.productionUsage.observed) return 'receiving production traffic';
    if (inv.locations.selectors.some((s) => s.role === 'code_call_site')) return 'a proven production call site';
    if (inv.locations.selectors.some((s) => s.role === 'code_candidate')) return 'a possible code call';
    if (inv.locations.selectors.some((s) => s.surface === 'config')) return 'a possible configuration selector';
    if (inv.locations.catalog.some((c) => c.role === 'test_fixture')) return 'test data';
    return 'informational only';
  };
  const buckets = new Map<string, number>();
  for (const inv of investigations) buckets.set(kind(inv), (buckets.get(kind(inv)) ?? 0) + 1);
  for (const [k, count] of buckets) {
    lines.push(`${word(count).replace(/^\w/, (c) => c.toUpperCase())} ${count === 1 ? 'is' : 'are'} ${k}.`);
  }

  lines.push('');
  lines.push(
    coverage.runtime.connected
      ? `Runtime measurement: ${RUNTIME_SOURCE_LABEL[coverage.runtime.source ?? 'usage_export']}.`
      : 'Runtime measurement was not enabled.',
  );
  lines.push('No changes were applied.');
  return lines;
}

/** Render the combined audit for a terminal. */
export function renderAuditReport(investigations: readonly ModelInvestigation[], meta: AuditMeta): string[] {
  const lines: string[] = ['mendr audit (preview)', ''];
  for (const line of coverageReport(meta)) lines.push(line);
  lines.push('');

  const count = (d: string): number => investigations.filter((i) => i.decision === d).length;
  const conclusion = concludeAudit(meta.coverage, investigations.length);
  lines.push(`Conclusion: ${CONCLUSION_LINE[conclusion]}`);

  if (investigations.length === 0) {
    lines.push('');
    if (conclusion === 'no_exposure_in_completed_surfaces') {
      lines.push('No deprecated model ids were found in the surfaces that completed.');
      lines.push('This is not a general all-clear — surfaces mendr does not analyze are not covered.');
      for (const gap of coverageGaps(meta.coverage)) lines.push(`  • ${gap}`);
    } else if (conclusion === 'audit_failed') {
      lines.push('A surface was attempted and FAILED — these results are unreliable and prove nothing.');
      for (const gap of coverageGaps(meta.coverage)) lines.push(`  • ${gap}`);
    } else {
      lines.push('Zero findings here does NOT mean zero exposure — the core surface did not complete:');
      for (const gap of coverageGaps(meta.coverage)) lines.push(`  • ${gap}`);
    }
    lines.push('');
    lines.push(footer());
    return lines;
  }

  lines.push('');
  for (const line of plainSummary(investigations, meta.coverage)) lines.push(line);
  lines.push('');
  lines.push(`${investigations.length} deprecated model(s): ${count('patch')} patch, ${count('review')} review, ${count('monitor')} monitor`);

  for (const inv of investigations) {
    const r = inv.retirementEvidence;
    lines.push('');
    lines.push('Deprecated model dependency located');
    lines.push('');
    lines.push(`Model: ${inv.model}  (${inv.provider})`);

    const locs = [...inv.locations.selectors, ...inv.locations.catalog];
    if (locs.length > 0) {
      lines.push(`Location: ${locationPhrase(locs[0])}`);
      for (const extra of locs.slice(1, 5)) lines.push(`          ${locationPhrase(extra)}`);
      if (locs.length > 5) lines.push(`          … and ${locs.length - 5} more`);
    } else {
      lines.push('Location: not located in code or config (may be a datastore, a flag, or an unscanned runtime)');
    }

    lines.push(`Retirement: ${deadline(r.status, r.daysUntil, r.shutdownDate)}${r.sourceUrl ? `  [source: ${r.sourceUrl}]` : ''}`);
    if (r.replacement) {
      const verdict = r.replacementVerdict ?? 'unstamped';
      const note =
        verdict === 'verified'
          ? 'evidence only — not applied here'
          : `${verdict} — not a recommended swap`;
      lines.push(`Migration evidence: ${r.replacement} [registry: ${verdict}] (${note})`);
    }
    lines.push(productionUsageLine(inv));
    lines.push(`Reader tie-back: ${inv.verification.readerTieBackProven ? 'proven' : 'not proven'}`);
    lines.push(`Decision: ${inv.decision === 'review' ? 'review required' : inv.decision}`);
    lines.push(`Reason: ${inv.reason}`);
  }

  const gaps = coverageGaps(meta.coverage);
  if (gaps.length > 0) {
    lines.push('');
    lines.push('Limits of this run:');
    for (const gap of gaps) lines.push(`  • ${gap}`);
    if (!meta.coverage.runtime.connected) {
      lines.push('  To verify which of these are live, connect a runtime source (OpenTelemetry, a sanitized');
      lines.push('  usage export, your own provider key kept in your CI, or gateway/app logs). All optional.');
    }
  }

  lines.push('');
  lines.push(footer());
  return lines;
}

function footer(): string {
  return (
    'mendr locates retiring AI dependencies and, when you choose to connect runtime evidence, verifies which\n' +
    'are live. It does not prove that a config location controls runtime selection (no reader tie-back yet),\n' +
    'so every change stays under human review. No changes were applied. This command is a preview.'
  );
}
