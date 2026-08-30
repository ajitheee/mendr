// Adversarial probe harness: classify a Python snippet and print each match's
// tier, position and reason. Used by the Tier-A decision-path review.
//
//   node scripts/tier-probe.mjs <file.py> [--path models/azure_openai/x.py]
//
// `--path` sets the PATH the scanner sees (surface attribution reads it), while
// the content comes from the real file on disk.

import { readFileSync } from 'node:fs';
import { findPyModelIdLiterals } from '../dist/python/scanPy.js';
import { classifyOccurrenceTier } from '../dist/report/classifyOccurrence.js';
import { loadLlmRegistry } from '../dist/usage/llmRegistry.js';

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error('usage: node scripts/tier-probe.mjs <file.py> [--path <virtual/path.py>]');
  process.exit(2);
}
const pathIdx = args.indexOf('--path');
const virtualPath = pathIdx !== -1 ? args[pathIdx + 1] : file;

const text = readFileSync(file, 'utf8');
const registry = loadLlmRegistry();
const matches = await findPyModelIdLiterals([{ path: virtualPath, text }], registry);

if (matches.length === 0) {
  console.log('(no registry model ids matched)');
  process.exit(0);
}
for (const m of matches) {
  const t = classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason });
  console.log(
    `${t.tier}  line ${String(m.location.line).padStart(3)}  ${m.value.padEnd(26)} ` +
      `position=${m.position}${t.reason ? ` tierReason=${t.reason}` : ''}` +
      `${m.purpose ? ` purpose=${m.purpose}` : ''}${m.reason ? `\n      why: ${m.reason}` : ''}`,
  );
}
