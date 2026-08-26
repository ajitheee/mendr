#!/usr/bin/env node
// CI gate on the active-model catalog DATA (mirrors scripts/validate-registry.mjs).
// Loads the shipped catalog + deprecation registry from dist/ and runs the same
// pure validateActiveModels the CLI and unit tests use. Exits non-zero on any
// violation OR on a load failure (a catalog that will not load is the most
// severe violation).

import {
  loadActiveModels,
  validateActiveModels,
  formatActiveModelValidation,
} from '../dist/recommend/catalog.js';
import { loadLlmRegistry, modelIdEntries } from '../dist/usage/llmRegistry.js';

function main() {
  let catalog;
  try {
    catalog = loadActiveModels();
  } catch (err) {
    console.error(`active-model catalog failed to load: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const deprecatedIds = new Set(modelIdEntries(loadLlmRegistry()).map((e) => e.deprecated));
  const result = validateActiveModels(catalog, deprecatedIds);
  for (const line of formatActiveModelValidation(result)) console.log(line);
  process.exit(result.violations.length === 0 ? 0 : 1);
}

main();
