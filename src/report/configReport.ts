// Human render for the config LOCATE scan.

import type { ConfigExposure } from '../config/scanConfig.js';
import { daysUntil } from '../watch/exposure.js';

function deadline(shutdownDate: string | null, now: Date): string {
  const d = daysUntil(shutdownDate, now);
  if (d === null) return shutdownDate ? `shuts ${shutdownDate}` : 'no dated deadline';
  if (d < 0) return `${-d}d OVERDUE`;
  if (d === 0) return 'due TODAY';
  return `${d}d left`;
}

/** Render the config exposure for a terminal: selectors (what to change) then catalog. */
export function renderConfigReport(
  exposures: readonly ConfigExposure[],
  filesScanned: number,
  now: Date,
): string[] {
  const lines: string[] = [];
  const totalSelectors = exposures.reduce((s, e) => s + e.selectors.length, 0);
  const totalCatalog = exposures.reduce((s, e) => s + e.catalog.length, 0);

  lines.push(`Config LOCATE scan — ${filesScanned} config file(s)`);
  if (exposures.length === 0) {
    lines.push('No deprecated model ids found in config.');
    return lines;
  }
  lines.push(
    `${exposures.length} deprecated id(s): ${totalSelectors} live selector(s) to change, ${totalCatalog} catalog reference(s)`,
  );

  for (const e of exposures) {
    lines.push('');
    lines.push(`${e.model}  (${e.provider}, ${deadline(e.shutdownDate, now)}) -> ${e.replacement} [registry: ${e.replacementVerdict}]`);
    if (e.selectors.length > 0) {
      lines.push('  change these (Tier B — review, config never auto-applies):');
      for (const m of e.selectors) lines.push(`    - ${m.file}:${m.line}  ${m.key}: ${m.value}`);
    }
    if (e.catalog.length > 0) {
      lines.push(`  catalog/reference (Tier C — informational): ${e.catalog.length} location(s)`);
      for (const m of e.catalog.slice(0, 5)) lines.push(`    - ${m.file}:${m.line}${m.key ? `  (${m.key})` : ''}`);
      if (e.catalog.length > 5) lines.push(`    ... and ${e.catalog.length - 5} more`);
    }
  }
  lines.push('');
  lines.push('This LOCATES the config to change; pair it with `mendr usage-audit` to prioritize by live spend.');
  return lines;
}
