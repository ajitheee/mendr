#!/usr/bin/env node
// CI entrypoint for the registry integrity check.
//
// It runs the SAME validateRegistry() the `mendr validate-registry` command and
// the unit test call — a CI job with its own copy of the rules is a CI job that
// drifts from the tool. All this file adds is the process contract CI needs:
// stdout for a human reading the log, and a non-zero exit on any violation.
//
// Requires `npm run build` first (it imports from dist/, so the check runs
// against the code that would actually ship, not against sources tsc has not
// agreed to yet).

import { loadLlmRegistry } from '../dist/usage/llmRegistry.js';
import { formatValidation, validateRegistry } from '../dist/registry/validateRegistry.js';

let registry;
try {
  registry = loadLlmRegistry();
} catch (err) {
  // A registry that will not load is the most severe violation there is: the
  // loader's shape rules are part of the same contract.
  console.error(`registry INVALID: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const result = validateRegistry(registry);
for (const line of formatValidation(result)) console.log(line);
if (result.violations.length > 0) process.exit(1);
