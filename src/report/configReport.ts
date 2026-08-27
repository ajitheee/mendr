// Human render for the config LOCATE scan.
//
// Honest categories (Dify-review P0/P1): a "change these" recommendation is
// printed ONLY for a runtime selector on a DIRECT provider surface with a
// VERIFIED replacement. Catalog definitions, provider-ambiguous surfaces, and
// unverified replacements are exposure-only — never a change recommendation.

import type { ConfigExposure, ConfigMatch } from '../config/scanConfig.js';
import { daysUntil } from '../watch/exposure.js';

function deadline(shutdownDate: string | null, now: Date): string {
  const d = daysUntil(shutdownDate, now);
  if (d === null) return shutdownDate ? `shuts ${shutdownDate}` : 'no dated deadline';
  if (d < 0) return `${-d}d OVERDUE`;
  if (d === 0) return 'due TODAY';
  return `${d}d left`;
}

const directSelectors = (e: ConfigExposure): ConfigMatch[] => e.selectors.filter((s) => s.providerSurface === null);
const ambiguousSelectors = (e: ConfigExposure): ConfigMatch[] => e.selectors.filter((s) => s.providerSurface !== null);

export function renderConfigReport(
  exposures: readonly ConfigExposure[],
  filesScanned: number,
  now: Date,
): string[] {
  const lines: string[] = [];
  lines.push(`Config LOCATE scan — ${filesScanned} config file(s)`);
  if (exposures.length === 0) {
    lines.push('No deprecated model ids found in config.');
    return lines;
  }

  // Category tallies.
  let toChange = 0, unverifiedSel = 0, ambiguous = 0, catalogDefs = 0, catalogRefs = 0;
  for (const e of exposures) {
    const verified = e.replacementVerdict === 'verified';
    for (const s of e.selectors) {
      if (s.providerSurface !== null) ambiguous++;
      else if (verified) toChange++;
      else unverifiedSel++;
    }
    for (const c of e.catalog) (c.purpose === 'catalog_definition' ? catalogDefs++ : catalogRefs++);
  }
  lines.push(
    `${exposures.length} deprecated id(s): ${toChange} runtime selector(s) to change [verified], ` +
      `${unverifiedSel} selector(s) w/o a verified replacement, ${ambiguous} provider-ambiguous, ` +
      `${catalogDefs} catalog definition(s), ${catalogRefs} catalog reference(s)`,
  );

  for (const e of exposures) {
    const verified = e.replacementVerdict === 'verified';
    const direct = directSelectors(e);
    const amb = ambiguousSelectors(e);
    lines.push('');
    lines.push(`${e.model}  (${e.provider}, ${deadline(e.shutdownDate, now)})`);

    if (direct.length > 0 && verified) {
      lines.push(`  Runtime selector located -> change to ${e.replacement} [registry: verified]:`);
      for (const s of direct) lines.push(`    - ${s.file}:${s.line}  ${s.key}: ${s.value}`);
      lines.push('    (reader tie-back not proven — confirm this value drives runtime selection)');
    } else if (direct.length > 0) {
      lines.push(`  Runtime selector located, but the replacement is ${e.replacementVerdict} — exposure only, no recommended change:`);
      for (const s of direct) lines.push(`    - ${s.file}:${s.line}  ${s.key}: ${s.value}`);
    }
    if (amb.length > 0) {
      lines.push('  Provider surface ambiguous — a direct-provider replacement is not valid here (exposure only):');
      for (const s of amb) lines.push(`    - ${s.file}:${s.line}  (surface: ${s.providerSurface})`);
    }
    if (e.catalog.length > 0) {
      const defs = e.catalog.filter((c) => c.purpose === 'catalog_definition').length;
      const refs = e.catalog.length - defs;
      if (defs > 0) lines.push(`  Catalog definition — defines the model, not a selection (Tier C): ${defs} location(s)`);
      if (refs > 0) lines.push(`  Catalog reference (Tier C): ${refs} location(s)`);
      for (const c of e.catalog.slice(0, 3)) lines.push(`    - ${c.file}:${c.line}${c.key ? `  (${c.key})` : ''}`);
      if (e.catalog.length > 3) lines.push(`    ... and ${e.catalog.length - 3} more`);
    }
  }

  lines.push('');
  lines.push('Legend: "to change" = a runtime selector with a verified replacement on a direct provider.');
  lines.push('Catalog definitions, provider-ambiguous surfaces, and unverified replacements are exposure-only.');
  return lines;
}
