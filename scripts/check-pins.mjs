#!/usr/bin/env node
// Every pin a customer copy-pastes must be THE verified pin.
//
// RC-2026-09-16.md carries a "Verified pin" row and, further down, an install snippet the
// customer pastes. Those drifted: the identity row was rolled four times while the snippet kept a
// SHA from several releases earlier -- a build carrying every bug those releases fixed. Nothing
// caught it, because a stale 40-character hex string is indistinguishable from a fresh one to
// everything except this check.
import { readFileSync } from 'node:fs';

const RC = 'RC-2026-09-16.md';
const DOCS = [RC, 'onboarding/FIRST-REPO-NOTE.md', 'onboarding/OBSERVATION-RECORD.md'];

const rc = readFileSync(RC, 'utf8');
const pin = /\*\*Verified pin[^`]*`([0-9a-f]{40})`/.exec(rc)?.[1];
if (!pin) {
  console.error(`check-pins: no "Verified pin" row found in ${RC}.`);
  process.exit(1);
}

let bad = 0;
for (const file of DOCS) {
  const text = readFileSync(file, 'utf8');
  // Only positions a customer actually pastes: a workflow `uses:` ref, and MENDR_SPEC.
  for (const m of text.matchAll(/(?:mendr\/\.github\/workflows\/[a-z-]+\.yml@|MENDR_SPEC[^\n]*?)([0-9a-f]{40})/g)) {
    if (m[1] !== pin) {
      console.error(`check-pins: ${file} pins ${m[1]} but the verified pin is ${pin}`);
      bad++;
    }
  }
}

if (bad > 0) {
  console.error(`check-pins: ${bad} stale pin(s). A customer would install the wrong build.`);
  process.exit(1);
}
console.log(`check-pins: OK — every customer-facing pin is ${pin}`);
