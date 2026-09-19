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
  partitionFindings,
  isExposure as isExposureInv,
  type AuditCoverage,
  type SourceCoverage,
  type LocationRef,
  type ModelInvestigation,
  analyzedIsMinority,
} from '../audit/investigation.js';
import { RUNTIME_SOURCE_LABEL } from '../runtime/evidence.js';
import type { LockedSdkReport } from '../usage/lockedSdks.js';

export interface AuditMeta {
  /** Only set when a runtime window applies (a provider/export read). */
  from: string | null;
  to: string | null;
  coverage: AuditCoverage;
  /** List every informational reference in full (default: a count and the first few). */
  verbose?: boolean;
  /**
   * Provider SDKs locked in the root package-lock.json (plane 2, slice 1). HUMAN REPORT
   * ONLY: it lives here and not in `coverage`, so it cannot reach --json, the App, the
   * issue or the conclusion. Absent = the row is not printed.
   */
  lockedSdks?: LockedSdkReport;
}

/** How many informational references the default report lists in full. */
export const INFORMATIONAL_PREVIEW = 5;

const int = (n: number): string => n.toLocaleString('en-US');
const usd = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function deadline(status: string | null, days: number | null, shutdownDate: string | null, verified: boolean): string {
  // A date with no provider notice on file is a REGISTRY date, not a fact we can
  // call overdue. Partner audits (2026-09-04) read "no provider notice on file —
  // 311d OVERDUE" as an assertion; it is not one.
  if (!verified) {
    if (!shutdownDate || days === null) return `${status ?? 'listed in registry'} — no dated deadline; no provider notice on file`;
    const rel = days < 0 ? `${-days}d past` : days === 0 ? 'today' : `${days}d ahead`;
    return `${status ?? 'listed in registry'} — registry date ${shutdownDate} (${rel}), UNVERIFIED: no provider notice on file`;
  }
  const life = status ?? 'listed in registry';
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
        : r === 'code_call_site' ? 'verified provider SDK call site (model argument)'
          : r === 'code_candidate' ? 'code default or call not traced to a provider request (review)'
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

/**
 * How a decision is spoken to a human. The audit applies nothing, so every branch
 * says so explicitly: `patch` is ELIGIBILITY, not an action that happened.
 */
export function decisionLines(inv: ModelInvestigation): string[] {
  if (inv.decision === 'patch') {
    const eligible = inv.locations.selectors.filter((l) => l.patchEligible).map((l) => `${l.file}:${l.line}`);
    return [
      'Decision: PATCH ELIGIBLE',
      'Status: No change applied',
      `Next action: run \`mendr fix-llm <path>\` to print the verified diff for ${eligible.join(', ') || 'the Tier-A line(s)'}; review it before applying. Only Tier-A lines are rewritten.`,
    ];
  }
  if (inv.decision === 'review') {
    return ['Decision: REVIEW REQUIRED', 'Status: No change applied', 'Next action: Human review before any change'];
  }
  // "Track until the retirement date" is nonsense when there is no date, and
  // worse when the date is already past. Say what the reader can actually do.
  const r = inv.retirementEvidence;
  const informational = inv.locations.selectors.length === 0;
  const dated = r.shutdownDate !== null && r.sourceUrl !== null; // a provider-backed date
  const next = informational
    ? // An informational reference is NOT a dependency: telling the reader to
      // "migrate now" contradicts the label two lines above it (partner audits, 2026-09-04).
      'No migration action required from this reference. Monitor provider status.'
    : r.shutdownDate === null
      ? 'Monitor provider status'
      : !dated
        ? `Verify the retirement date with the provider before acting — the registry date ${r.shutdownDate} has no provider notice on file`
        : r.daysUntil !== null && r.daysUntil < 0
          ? `Migrate now — retired on ${r.shutdownDate} (${-r.daysUntil} days ago); requests using this id fail today`
          : 'Track until the retirement date';
  return ['Decision: MONITOR', 'Status: No change applied', `Next action: ${next}`];
}

const pad = (s: string, n = 18): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/**
 * The "Provider SDKs" row and its per-SDK lines. Every line says it is information only:
 * the conclusion below never reads it. The reason after each SDK is resolveSdk's own, word
 * for word, so this row and `mendr resolve npm:<name>@<version>` cannot disagree.
 */
export function lockedSdkLines(
  r: LockedSdkReport,
  row: (mark: string, label: string, detail: string) => string,
): string[] {
  const LABEL = 'Provider SDKs';
  const INFO = 'information only, never part of the conclusion';
  const lines: string[] = [];
  switch (r.state) {
    case 'absent':
      lines.push(row('○', LABEL, 'not read — no package-lock.json at the repository root'));
      break;
    case 'shrinkwrap':
      lines.push(row('○', LABEL, 'not read — npm-shrinkwrap.json takes precedence over package-lock.json and is not read'));
      break;
    case 'unsupported':
      lines.push(row('○', LABEL, 'not read — package-lock.json is lockfileVersion 1, which this build does not read'));
      break;
    case 'failed':
      lines.push(row('✗', LABEL, `package-lock.json could not be read (${r.note ?? 'unreadable'}) — ${INFO}`));
      break;
    case 'read': {
      // Count what was DECLARED, and say how many of those could not be resolved: a refusal
      // is not a lock.
      const unresolved = r.sdks.filter((s) => s.resolution === null).length;
      lines.push(
        r.sdks.length === 0
          ? row('✓', LABEL, `the root project declares none of the ${r.checked} npm provider SDKs in package-lock.json — ${INFO}`)
          : row(
              '✓',
              LABEL,
              `${r.sdks.length} declared by the root project in package-lock.json${unresolved > 0 ? `, ${unresolved} not resolved` : ''} — ${INFO}`,
            ),
      );
      for (const s of r.sdks) {
        lines.push(`    · ${s.name}${s.version ? ` ${s.version}` : ''}${s.alias ? ` (as ${s.alias})` : ''} — ${s.reason}`);
      }
      break;
    }
  }
  const notRead: string[] = [];
  if (r.localPackagesNotRead > 0) {
    notRead.push(
      `${int(r.localPackagesNotRead)} local package${r.localPackagesNotRead === 1 ? '' : 's'} in package-lock.json (workspaces or linked directories)`,
    );
  }
  for (const [name, n] of Object.entries(r.otherLockfiles).sort(([a], [b]) => a.localeCompare(b))) {
    notRead.push(`${name} (${int(n)})`);
  }
  if (notRead.length > 0) lines.push(`    not read: ${notRead.join(', ')}`);
  return lines;
}


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
        : row(
            '✓',
            'Source code',
            `${int(src.tsFiles + (src.jsFiles ?? 0) + src.pyFiles)} files scanned (` +
              [
                `${int(src.tsFiles)} TS/TSX`,
                ...((src.jsFiles ?? 0) > 0 ? [`${int(src.jsFiles ?? 0)} JS`] : []),
                `${int(src.pyFiles)} Python`,
              ].join(', ') +
              ')' +
              ((src.unanalyzedFiles ?? 0) > 0 ? `; ${int(src.unanalyzedFiles ?? 0)} files in languages not analyzed` : ''),
          ),
  );
  if ((src.testFilesSkipped ?? 0) > 0) {
    lines.push(row('✓', 'Test files', `${int(src.testFilesSkipped ?? 0)} scanned as test-only references — reported informational, never migration candidates`));
  }
  // THE DENOMINATOR. Every file the walker found lands in exactly one of these, so a reader can
  // add them up and see what happened to all of them. "No exposure" is only as good as this
  // account of what was not looked at.
  lines.push(...coverageDenominator(src));
  // A parse failure is the one gap that changes an ANSWER rather than narrowing it. ts-morph is
  // error-tolerant, so a malformed file yields a damaged tree instead of an error: the same live
  // call site reads as "code data reference" instead of "verified provider SDK call site". It
  // gets its own row, and it forces `inconclusive` below.
  if ((src.parseFailures ?? 0) > 0) {
    lines.push(
      row('✗', 'Parse failures', `${int(src.parseFailures ?? 0)} file(s) had syntax errors — what they contain was NOT reliably read`),
    );
    for (const f of (src.parseFailureFiles ?? []).slice(0, 5)) lines.push(`    ${f}`);
  }
  if ((src.unreadableFiles ?? 0) > 0) {
    lines.push(row('✗', 'Unreadable', `${int(src.unreadableFiles ?? 0)} file(s) could not be opened at all`));
  }
  // `✓` is reserved for a surface that actually scanned something. No supported
  // config files at all is NOT APPLICABLE; files present but unreadable is a real
  // gap. Neither may wear a tick.
  const cfgRead = c.config.filesRead ?? c.config.filesScanned;
  lines.push(
    c.config.failed
      ? row('✗', 'Configuration', 'scan FAILED')
      : c.config.filesScanned === 0
        ? row('○', 'Configuration', 'not applicable — no supported configuration files found')
        : cfgRead === 0
          ? row('✗', 'Configuration', `${int(c.config.filesScanned)} files found but NONE could be read`)
          : row('✓', 'Configuration', `${int(cfgRead)} files scanned`),
  );
  if (meta.lockedSdks) lines.push(...lockedSdkLines(meta.lockedSdks, row));
  // The registry row carries its FRESHNESS: silence is only evidence against
  // knowledge that is provably current, so a stale (or undated) registry wears
  // ✗ and the conclusion below is inconclusive. The reason and the fix appear
  // under "limits of this run".
  {
    const r = c.registry;
    const fresh = r.freshness === 'fresh';
    const when = r.publishedAt ? r.publishedAt.slice(0, 10) : 'undated';
    const age = r.ageDays !== undefined && r.ageDays >= 0 ? `${Math.floor(r.ageDays)} d` : 'age unknown';
    const grade = r.freshness === undefined ? 'freshness unknown' : fresh ? `fresh, ${age}` : `STALE ${age}, max ${r.maxAgeDays ?? '?'}`;
    lines.push(
      row(fresh ? '✓' : '✗', 'Registry', `${r.providers.join(', ') || 'none'} · ${r.source ?? 'bundled'} ${when} (${grade})${fresh ? '' : ' → inconclusive'}`),
    );
  }

  const rt = c.runtime;
  const window = meta.from && meta.to ? `, ${meta.from} to ${meta.to}` : '';
  lines.push(
    rt.failed
      ? row('✗', 'Runtime usage', `read FAILED${rt.note ? ` — ${rt.note}` : ''}`)
      : rt.connected
        ? row('✓', 'Runtime usage', `${RUNTIME_SOURCE_LABEL[rt.source ?? 'usage_export']}${window}`)
        : row('○', 'Runtime usage', 'not measured — no runtime source connected (optional)'),
  );
  // Disclose what was deliberately NOT scanned, so an exclusion is visible rather
  // than silently shrinking coverage.
  const skipped = c.config.generatedSkipped ?? 0;
  const exDirs = c.config.excludedDirs ?? [];
  if (skipped > 0 || exDirs.length > 0) {
    const bits: string[] = [];
    if (skipped > 0) bits.push(`${int(skipped)} mendr-generated file(s)`);
    if (exDirs.length > 0) bits.push(`dirs: ${exDirs.join(', ')}`);
    lines.push(row('○', 'Excluded', bits.join('; ')));
  }
  lines.push(
    c.readerTieBack.proven
      ? row('✓', 'Reader tie-back', 'proven for at least one config selector — code reads the env var (see the finding)')
      : row('○', 'Reader tie-back', 'not proven — a config location is a candidate; mendr has not shown that runtime reads it'),
  );

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
  const { exposure, informational } = partitionFindings(investigations);
  const n = exposure.length;

  // A catalog record is NOT a dependency. Only real exposure is counted here;
  // informational references get their own, clearly-labelled line.
  if (n === 0) {
    if (investigations.length === 0) return [];
    const analyzed = coverage.source.tsFiles + (coverage.source.jsFiles ?? 0) + coverage.source.pyFiles;
    const other = coverage.source.unanalyzedFiles ?? 0;
    // M8: a repo mendr mostly could not read must not get a clean-sounding headline.
    const headline = analyzedIsMinority(coverage)
      ? [
          `No retiring model ids in the ${analyzed} TypeScript/JavaScript/Python files analyzed.`,
          `${other} source files in languages mendr does not read (${Math.round((other / (analyzed + other)) * 100)}% of this repository's source) were NOT analyzed — this result says nothing about them.`,
        ]
      : ['We found no retiring AI dependencies in use.'];
    return [
      ...headline,
      '',
      `${word(informational.length).replace(/^\w/, (c) => c.toUpperCase())} deprecated model ${informational.length === 1 ? 'id was' : 'ids were'} found only in catalog, documentation, fixture or reference data — not as something this application selects.`,
      '',
      coverage.runtime.connected
        ? `Production usage was measured via ${RUNTIME_SOURCE_LABEL[coverage.runtime.source ?? 'usage_export']}.`
        : 'Production usage was not measured.',
      'No changes were applied.',
    ];
  }

  const lines = [`We found ${word(n)} retiring AI ${n === 1 ? 'dependency' : 'dependencies'}.`, ''];

  // WORDING DISCIPLINE: source analysis proves a DIRECT PROVIDER CALL SITE exists
  // in the code. It does not prove production executes it — only runtime evidence
  // can say that. Never let a located call site read as proven production traffic.
  // "Verified" is keyed on the TIER, never on a role or a name: a Tier-B call
  // site is real but unverified, and 9 of 12 validation repos read "verified"
  // for exactly that. Each kind carries its plural so the sentence stays English.
  const kind = (inv: ModelInvestigation): [string, string] => {
    if (inv.productionUsage.observed) return ['receiving production traffic', 'receiving production traffic'];
    if (inv.locations.selectors.some((s) => s.tier === 'A')) {
      return [
        'a verified direct provider call site (auto-fix available, nothing applied)',
        'verified direct provider call sites (auto-fix available, nothing applied)',
      ];
    }
    if (inv.locations.selectors.some((s) => s.surface === 'code')) {
      return [
        'a code default or call that could not be traced to a provider request — review before changing',
        'code defaults or calls that could not be traced to a provider request — review before changing',
      ];
    }
    if (inv.locations.selectors.some((s) => s.surface === 'config')) {
      return ['a possible configuration selector', 'possible configuration selectors'];
    }
    if (inv.locations.catalog.some((c) => c.role === 'test_fixture')) return ['test data', 'test data'];
    return ['informational only', 'informational only'];
  };
  const buckets = new Map<string, { plural: string; count: number }>();
  for (const inv of exposure) {
    const [one, many] = kind(inv);
    const b = buckets.get(one) ?? { plural: many, count: 0 };
    b.count += 1;
    buckets.set(one, b);
  }
  for (const [one, { plural, count }] of buckets) {
    lines.push(`${word(count).replace(/^\w/, (c) => c.toUpperCase())} ${count === 1 ? `is ${one}` : `are ${plural}`}.`);
  }
  if (informational.length > 0) {
    lines.push('');
    lines.push(
      `${word(informational.length).replace(/^\w/, (c) => c.toUpperCase())} further deprecated model ${informational.length === 1 ? 'id appears' : 'ids appear'} only in catalog, documentation or fixture data (not dependencies).`,
    );
  }

  lines.push('');
  lines.push(
    coverage.runtime.connected
      ? `Production usage was measured via ${RUNTIME_SOURCE_LABEL[coverage.runtime.source ?? 'usage_export']}.`
      : 'Production usage was not measured.',
  );
  lines.push('No changes were applied.');
  return lines;
}

/** Render the combined audit for a terminal. */
/**
 * The five-way account of every file the walker found.
 *
 * The categories are exclusive and ordered, so a file appears exactly once: a file that fails to
 * parse is a parse failure even though it is also TypeScript, because that is the fact that
 * decides what the report can claim about it.
 */
export function coverageDenominator(src: SourceCoverage): string[] {
  const unsupported = src.unanalyzedFiles ?? 0;
  const tests = src.testFilesSkipped ?? 0;
  const parseFailed = src.parseFailures ?? 0;
  const unreadable = src.unreadableFiles ?? 0;
  // The per-language totals count files on disk by extension, so a file that failed to parse or
  // could not be opened is ALREADY in them. Subtract, so each file lands in exactly one row and
  // the column adds up to the discovered total. Without this, a broken file is reported twice and
  // the denominator is larger than the repository.
  const byLanguage = src.tsFiles + (src.jsFiles ?? 0) + src.pyFiles;
  const analyzed = Math.max(0, byLanguage - parseFailed - unreadable);
  const discovered = analyzed + unsupported + tests + parseFailed + unreadable;
  if (discovered === 0) return [];
  const pad2 = (n: number): string => String(n).padStart(6);
  return [
    '',
    '  Files accounted for',
    `  ${pad2(discovered)}  discovered`,
    `  ${pad2(analyzed)}  analyzed (TS/TSX, JavaScript, Python)`,
    ...(tests > 0 ? [`  ${pad2(tests)}  test files — read, but never migration candidates`] : []),
    ...(unsupported > 0 ? [`  ${pad2(unsupported)}  languages mendr does not read`] : []),
    ...(parseFailed > 0 ? [`  ${pad2(parseFailed)}  parse failures — contents NOT reliably read`] : []),
    ...(unreadable > 0 ? [`  ${pad2(unreadable)}  could not be opened`] : []),
  ];
}

export function renderAuditReport(investigations: readonly ModelInvestigation[], meta: AuditMeta): string[] {
  const lines: string[] = ['mendr audit (preview)', ''];
  for (const line of coverageReport(meta)) lines.push(line);
  lines.push('');

  const count = (d: string): number => investigations.filter((i) => i.decision === d).length;
  const { exposure, informational } = partitionFindings(investigations);
  // The conclusion turns on EXPOSURE, never on informational catalog references.
  const conclusion = concludeAudit(meta.coverage, exposure.length);
  lines.push(`Conclusion: ${CONCLUSION_LINE[conclusion]}`);

  if (exposure.length === 0 && informational.length > 0) {
    lines.push('');
    for (const line of plainSummary(investigations, meta.coverage)) lines.push(line);
    lines.push('');
    lines.push(`Informational references (${informational.length}) — deprecated ids found only in catalog/doc/fixture data:`);
    for (const inv of informational.slice(0, 20)) {
      const where = [...inv.locations.selectors, ...inv.locations.catalog][0];
      // Keep the evidence label: a reader must be able to see WHY this was judged
      // a reference rather than a dependency.
      lines.push(`  · ${inv.model} (${inv.provider})${where ? ` — ${locationPhrase(where)}` : ''}`);
    }
    if (informational.length > 20) lines.push(`  … and ${informational.length - 20} more`);
    const gapsInfo = coverageGaps(meta.coverage);
    if (gapsInfo.length > 0) {
      lines.push('');
      lines.push('Limits of this run:');
      for (const gap of gapsInfo) lines.push(`  • ${gap}`);
    }
    lines.push('');
    lines.push(footer());
    return lines;
  }

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
  lines.push(
    `${investigations.length} deprecated model ids: ${count('patch')} patch-eligible (no change applied), ${count('review')} need human review, ${count('monitor')} informational`,
  );

  // Every exposure in full. Informational references are NOT dependencies and
  // there can be hundreds (litellm: 57); by default show a count and the first
  // few, and let --verbose or --json carry the rest (partner audits, 2026-09-04).
  const shownInformational = meta.verbose ? informational : informational.slice(0, INFORMATIONAL_PREVIEW);
  for (const inv of [...exposure, ...shownInformational]) {
    const r = inv.retirementEvidence;
    lines.push('');
    lines.push(isExposureInv(inv) ? 'Deprecated model dependency located' : 'Informational reference (not a dependency)');
    lines.push('');
    lines.push(`Model: ${inv.model}  (${inv.provider})`);

    // Presentation order: selectors before catalog, and code before config within
    // each, so a catalog block can never push the one code reference out of view.
    const byCodeFirst = (a: LocationRef, b: LocationRef): number =>
      (a.surface === 'code' ? 0 : 1) - (b.surface === 'code' ? 0 : 1);
    const locs = [
      ...[...inv.locations.selectors].sort(byCodeFirst),
      ...[...inv.locations.catalog].sort(byCodeFirst),
    ];
    if (locs.length > 0) {
      lines.push(`Location: ${locationPhrase(locs[0])}`);
      for (const extra of locs.slice(1, 5)) lines.push(`          ${locationPhrase(extra)}`);
      if (locs.length > 5) lines.push(`          … and ${locs.length - 5} more (every location is listed in --json)`);
    } else {
      lines.push('Location: not located in code or config (may be a datastore, a flag, or an unscanned runtime)');
    }

    lines.push(`Retirement: ${deadline(r.status, r.daysUntil, r.shutdownDate, r.sourceUrl !== null)}${r.sourceUrl ? `  [source: ${r.sourceUrl}]` : ''}`);
    if (r.replacement) {
      const verdict = r.replacementVerdict ?? 'unstamped';
      const note =
        verdict === 'verified'
          ? 'evidence only — not applied here'
          : `${verdict} — not a recommended swap`;
      lines.push(`Migration evidence: ${r.replacement} [registry: ${verdict}] (${note})`);
    }
    lines.push(productionUsageLine(inv));
    // Only meaningful when a CONFIG location is involved; printed once per such model.
    if (inv.locations.selectors.some((l) => l.surface === 'config')) {
      const readLoc = inv.locations.selectors.find((l) => l.readerTieBack?.proven)?.readerTieBack?.readers[0];
      lines.push(
        inv.verification.readerTieBackProven && readLoc
          ? `Reader tie-back: proven — read in code at ${readLoc.file}:${readLoc.line} (${readLoc.via})`
          : 'Reader tie-back: not proven',
      );
    }
    // The audit is READ-ONLY. "patch" must never read as though mendr changed
    // something — it means a migration is ELIGIBLE, pending human review.
    for (const line of decisionLines(inv)) lines.push(line);
    lines.push(`Reason: ${inv.reason}`);
  }
  if (informational.length > shownInformational.length) {
    lines.push('');
    lines.push(
      `… and ${informational.length - shownInformational.length} more informational references (not dependencies). Use --verbose to list them all, or --json.`,
    );
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
    'are live. For an env-var config selector it can prove that code reads it (reader tie-back); other config\n' +
    'selection is not traced, so every config change stays under human review. No changes were applied. This command is a preview.'
  );
}
