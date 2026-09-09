#!/usr/bin/env node
// Build the mendr-migration-report/v1 that mendr-action sends to the customer's
// Mendr App: the outcome, the PR url, and from the migration artifact the
// verdict, gates, swaps and file paths — plus, unless MENDR_SEND_DIFF=false, the
// unified diff of the swap itself so the finding can show what changes (the
// change, never whole files; the App redacts and caps it again). Built by
// whitelisting fields, so nothing else rides along.
//
//   node build-report.mjs <artifact.json or ''> <outcome> <pr_url or ''>
import { readFileSync } from 'node:fs';

const MAX_DIFF_CHARS = 200_000;
const sendDiff = process.env.MENDR_SEND_DIFF !== 'false';

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
  registry:
    a && a.registry && typeof a.registry === 'object'
      ? {
          source: str(a.registry.source),
          version: str(a.registry.version),
          publishedAt: str(a.registry.publishedAt),
          ageDays: Number.isFinite(a.registry.ageDays) ? a.registry.ageDays : -1,
          maxAgeDays: Number.isFinite(a.registry.maxAgeDays) ? a.registry.maxAgeDays : 0,
          freshness: str(a.registry.freshness),
        }
      : null,
  diff: sendDiff && a && str(a.diff) ? a.diff.slice(0, MAX_DIFF_CHARS) : null,
};
process.stdout.write(JSON.stringify(report));
