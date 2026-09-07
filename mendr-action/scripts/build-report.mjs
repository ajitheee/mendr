#!/usr/bin/env node
// Build the mendr-migration-report/v1 that mendr-action sends to the customer's
// Mendr App: the migration artifact WITHOUT the diff — never code — plus the
// outcome and the PR url. Built by whitelisting fields, so nothing rides along.
//
//   node build-report.mjs <artifact.json or ''> <outcome> <pr_url or ''>
import { readFileSync } from 'node:fs';

const [artifactPath, outcome, prUrl] = process.argv.slice(2);
let a = null;
try {
  if (artifactPath) a = JSON.parse(readFileSync(artifactPath, 'utf8'));
} catch {
  a = null;
}
if (a !== null && (typeof a !== 'object' || Array.isArray(a))) a = null;

const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const gate = (g) => (g && typeof g === 'object' && typeof g.status === 'string' ? g.status : 'not-configured');
const verification = a && a.verification && typeof a.verification === 'object' ? a.verification : null;

const report = {
  schema: 'mendr-migration-report/v1',
  outcome: str(outcome) ?? 'error',
  prUrl: str(prUrl),
  sha: a ? str(a.sha) : null,
  generatedAt: a ? str(a.generatedAt) : null,
  verdict: verification ? str(verification.verdict) : null,
  gates: verification
    ? { typeCheck: gate(verification.typeCheck), build: gate(verification.build), tests: gate(verification.tests), eval: gate(verification.eval) }
    : null,
  behavioralTested: verification ? verification.behavioralTested === true : false,
  migrations:
    a && Array.isArray(a.migrations)
      ? a.migrations
          .filter((m) => m && typeof m === 'object')
          .map((m) => ({ provider: str(m.provider), from: str(m.from), to: str(m.to), language: str(m.language) ?? 'unknown', sites: Number.isInteger(m.sites) ? m.sites : 0, files: list(m.files) }))
      : [],
  changedFiles: a ? list(a.changedFiles) : [],
  notes: a ? list(a.notes) : [],
};
process.stdout.write(JSON.stringify(report));
