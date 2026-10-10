#!/usr/bin/env node
// registry-refresh's "What actually moved" step.
//
// Every decision is summarizeRefresh() in src/registry/refreshSummary.ts, which is
// unit-tested; until 2026-10-09 this logic lived inline in the workflow, untested, and
// keyed SDK versions by package name alone (PyPI `openai` overwrote npm `openai`). All
// this file adds is the I/O a workflow step needs: the two registry files at HEAD and in
// the working tree in, the step outputs and refresh-body.md out.
//
// Requires `npm run build` first: it imports from dist/, so the job reports with the code
// that ships, the same contract as scripts/validate-registry.mjs.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { summarizeRefresh } from '../dist/registry/refreshSummary.js';

const CATALOG = 'registries/model-catalog.json';
const SDK = 'registries/sdk-releases.json';

const inTree = (path) => JSON.parse(readFileSync(path, 'utf8'));
const atHead = (path) => JSON.parse(execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' }));

const now = { catalog: inTree(CATALOG), sdk: inTree(SDK) };
const was = { catalog: atHead(CATALOG), sdk: atHead(SDK) };
const s = summarizeRefresh(was, now);

const outputs = [
  `summary=${s.summary}`,
  `substantive=${s.substantive ? 'yes' : 'no'}`,
  `catalog_count=${now.catalog.count}`,
  `sdk_count=${now.sdk.count}`,
];
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs.map((l) => `${l}\n`).join(''));
writeFileSync('refresh-body.md', s.body);

for (const line of outputs) console.log(line);
console.log('');
console.log(s.body);
