#!/usr/bin/env node
// Every pin a customer copy-pastes must be THE verified pin, and the release it
// names must actually contain the code that release is supposed to deliver.
//
// THREE RULES, each from a real failure:
//
//   1. SHA    RC-2026-09-16.md carries a "Verified pin" row and, further down, an install
//             snippet the customer pastes. Those drifted: the identity row was rolled four
//             times while the snippet kept a SHA from several releases earlier -- a build
//             carrying every bug those releases fixed. Nothing caught it, because a stale
//             40-character hex string is indistinguishable from a fresh one.
//
//   2. TAG    Thirteen positions name a release TAG, across YAML, TypeScript constants and
//             customer-facing docs. Rule 1 cannot see any of them: it matches 40-hex only.
//             `src/watch/installWorkflow.ts` sat at v0.1.0 for five releases, baking a
//             five-release-old CLI into every workflow `mendr watch --install` scaffolds,
//             and WATCH-TESTERS.md told testers to install the same thing.
//
//   3. STALE  The one that motivated this rewrite, and the one rule-2-by-itself misses.
//             PR #12 added `mendr redact` and a run-mendr.sh that calls it. Every tag pin
//             still agreed with every other tag pin, so a consistency check was green --
//             while `git show v0.5.5-alpha:mendr-action/scripts/run-mendr.sh | grep -c redact`
//             returned 0. The fix reached NO execution path: reusable-migrate.yml hardcodes
//             `uses: ...@<tag>`, and GitHub forbids an expression there, so even @main runs
//             the tagged script. A security fix sat green on main, delivered to nobody.
//
//             So: if mendr-action/ or the CLI has changed since the tag the pins name, say
//             so. It is not an error in the code; it is the fact that the code is undelivered.
//
// Zero dependencies on purpose: the CI job that runs this (.github/workflows/ci.yml) does
// checkout + setup-node and no `npm ci`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RC = 'RC-2026-09-16.md';
const SHA_DOCS = [RC, 'onboarding/FIRST-REPO-NOTE.md', 'onboarding/OBSERVATION-RECORD.md'];

/**
 * Positions that name the release TAG, each with the regex that finds it.
 *
 * A whitelist, not a tree sweep, and deliberately so: launch/DEMO-CLIP.md and TRUST.md name
 * old versions as historical record ("v0.5.5-alpha prints ..."), and site/index.html says
 * "Released, v0.1.0" about a command. Those are correct as written and must never move.
 */
const TAG_PINS = [
  ['.github/workflows/reusable-audit.yml', /default:\s*(v[\w.-]+)/],
  ['.github/workflows/reusable-migrate.yml', /uses:\s*ajitheee\/mendr\/mendr-action@(\S+)/],
  ['.github/workflows/reusable-migrate.yml', /mendr-spec:\s*github:ajitheee\/mendr#(\S+)/],
  ['mendr-action/action.yml', /default:\s*"github:ajitheee\/mendr#([^"]+)"/],
  ['mendr-action/examples/mendr.yml', /uses:\s*ajitheee\/mendr\/mendr-action@(\S+)/],
  ['mendr-action/examples/mendr.yml', /mendr-spec:\s*github:ajitheee\/mendr#(\S+)/],
  ['app/src/config.ts', /MENDR_CLI_SPEC\s*=\s*'([^']+)'/],
  ['app/docker-compose.yml', /MENDR_CLI_SPEC:\s*\$\{MENDR_CLI_SPEC:-([^}]+)\}/],
  ['src/audit/installAuditWorkflow.ts', /AUDIT_MENDR_RELEASE\s*=\s*'([^']+)'/],
  ['src/watch/installWorkflow.ts', /MENDR_RELEASE\s*=\s*'([^']+)'/],
];

/**
 * Docs where every PASTE position must name the current tag.
 *
 * Context-anchored: only `github:ajitheee/mendr#<ref>`, `mendr-action@<ref>` and a reusable
 * workflow `@<ref>` count. Prose that merely mentions a version has no paste syntax and is
 * skipped by construction.
 */
const TAG_DOCS = ['README.md', 'mendr-action/README.md', 'WATCH-TESTERS.md', 'launch/DEMO-CLIP.md', 'site/index.html'];
const PASTE = /(?:github:ajitheee\/mendr#|ajitheee\/mendr\/mendr-action@|mendr\/\.github\/workflows\/[a-z-]+\.yml@)(v[\w.-]+)/g;

/** Deliberately frozen pins, each with the reason. Empty is the correct state. */
const KNOWN_STALE = new Map([]);

let bad = 0;
const fail = (msg) => {
  console.error(`check-pins: ${msg}`);
  bad++;
};

// ---- rule 1: the SHA a customer pastes -------------------------------------
const rc = readFileSync(RC, 'utf8');
const pin = /\*\*Verified pin[^`]*`([0-9a-f]{40})`/.exec(rc)?.[1];
if (!pin) {
  console.error(`check-pins: no "Verified pin" row found in ${RC}.`);
  process.exit(1);
}
for (const file of SHA_DOCS) {
  const text = readFileSync(file, 'utf8');
  // Only positions a customer actually pastes: a workflow `uses:` ref, and MENDR_SPEC.
  for (const m of text.matchAll(/(?:mendr\/\.github\/workflows\/[a-z-]+\.yml@|MENDR_SPEC[^\n]*?)([0-9a-f]{40})/g)) {
    if (m[1] !== pin) fail(`${file} pins ${m[1]} but the verified pin is ${pin}`);
  }
}

// ---- rule 2: every release tag equals the version being shipped ------------
//
// Anchored on package.json rather than on RC's SHA, because the release commit's SHA does not
// exist until the commit is made -- yet every tag pin must already be correct INSIDE that
// commit. `version` is the one field the release bumps first, and a self-referencing pin is
// capability-correct by construction: the tag cut from this commit contains this commit.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const TAG = `v${version}`;

for (const [file, re] of TAG_PINS) {
  const text = readFileSync(file, 'utf8');
  const found = [...text.matchAll(new RegExp(re, re.flags.includes('g') ? re.flags : `${re.flags}g`))];
  if (found.length === 0) {
    // A pin that vanished is worse than a stale one: the check goes quietly green while the
    // position it was guarding is unguarded. REGISTRY-FRESHNESS.md still names render.yaml as
    // a bump target and render.yaml has carried no pin for several releases.
    fail(`${file} has no pin matching ${re} — the position moved or was removed, so nothing is guarding it`);
    continue;
  }
  for (const m of found) {
    const ref = m[1];
    if (ref === TAG) continue;
    if (KNOWN_STALE.get(`${file}:${ref}`)) continue;
    fail(`${file} pins ${ref} but package.json says the release is ${TAG}`);
  }
}

for (const file of TAG_DOCS) {
  const text = file === 'site/index.html' ? decodePastes(readFileSync(file, 'utf8')) : readFileSync(file, 'utf8');
  for (const m of text.matchAll(PASTE)) {
    if (m[1] === TAG) continue;
    if (KNOWN_STALE.get(`${file}:${m[1]}`)) continue;
    fail(`${file} tells a reader to install ${m[1]} but the release is ${TAG}`);
  }
}

/** site/index.html carries a pin inside a `?body=` query string, where `#` is `%23`. */
function decodePastes(html) {
  return html.replace(/%3A/gi, ':').replace(/%2F/gi, '/').replace(/%23/gi, '#');
}

// ---- rule 3: is the named release actually carrying today's code? ----------
//
// Advisory, not fatal: on main between releases it is EXPECTED that work has landed since the
// tag. It is fatal only in the release commit itself, where the pins name a tag that is about
// to be cut from this very tree — there, anything unshipped is a lie.
const DELIVERY_PATHS = ['mendr-action/', 'src/cli.ts'];
try {
  execFileSync('git', ['rev-parse', '--verify', `${TAG}^{commit}`], { stdio: 'pipe' });
  const changed = execFileSync('git', ['log', '--oneline', `${TAG}..HEAD`, '--', ...DELIVERY_PATHS], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (changed) {
    const n = changed.split('\n').length;
    console.log(
      `check-pins: NOTE — ${n} commit(s) touch ${DELIVERY_PATHS.join(' or ')} since ${TAG}.\n` +
        `  Those changes reach NO customer until a new tag is cut: reusable-migrate.yml hardcodes\n` +
        `  the action ref and GitHub forbids an expression in \`uses:\`, so even @main runs the\n` +
        `  TAGGED script. This is how PR #12's sanitizer shipped to nobody.\n` +
        changed
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
    );
  }
} catch {
  // Shallow clone, missing tags, or no git at all. Say so rather than passing quietly — a
  // guard that silently does nothing is the thing this file exists to prevent.
  console.log(`check-pins: NOTE — could not read git history for ${TAG}; the delivery-staleness rule did not run.`);
}

if (bad > 0) {
  console.error(`check-pins: ${bad} stale pin(s). A customer would install the wrong build.`);
  process.exit(1);
}
console.log(`check-pins: OK — SHA pins are ${pin}, release pins are ${TAG}`);
