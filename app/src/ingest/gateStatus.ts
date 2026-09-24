// The App's copy of the CLI's verification vocabulary, plus the translation for
// reports sent by CLIs that predate it.
//
// WHY A COPY AT ALL. The App is a separate deployable with its own build; it
// cannot import from the CLI's src/ at runtime (app/tsconfig.json sets
// rootDir: src, so an import above it fails the build with TS6059). So the word
// list is mirrored here, and `gateStatus.test.ts` fails if it drifts from
// src/gates/status.ts — the guarantee is mechanical, not a comment asking the
// next person to remember. Same pattern, and the same reason, as app/src/redact.ts.
//
// WHY A TRANSLATION, and why it is not temporary. The App is a server; the CLI
// version is pinned PER CUSTOMER, in a workflow file committed to their repo
// (app/src/ui/workflowTemplate.ts writes the pin, mendr-action/action.yml
// defaults it). A customer who pinned an older tag keeps sending the old words
// until they choose to bump, which may be never. Both vocabularies therefore
// arrive indefinitely, and dropping either one blanks a real dashboard.
//
// WHAT WENT WRONG WITHOUT THIS. The CLI's five words landed in src/ only; this
// boundary still declared the old four and coerced everything else to
// `not-configured`. A build or test gate that RAN AND FAILED was stored, and
// rendered to the customer, as "—" — "there was nothing to run". That is the
// exact class of lie src/gates/status.ts exists to stop, reintroduced one
// package over, on the one surface an external reviewer logs into.

/** MIRRORED FROM src/gates/status.ts — keep the words identical; gateStatus.test.ts enforces it. */
export const GATE_STATUSES = ['passed', 'failed', 'skipped', 'not_run', 'inconclusive'] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

/**
 * The four words every CLI before the vocabulary merge sent, and what each one
 * becomes.
 *
 * `not-configured` is the only one that needs an argument. The old union had no
 * "we chose not to run it" state at all — it used `not-configured` for both
 * "there was nothing to run" and `--skip-verify` — so it maps to `not_run`,
 * not `skipped`, for three reasons:
 *
 *   * Today's CLI emits `not_run` on that same --skip-verify path, so the
 *     mapping makes an old and a new CLI agree about the same repository. Two
 *     CLIs disagreeing about one repo is the defect the merge existed to end.
 *   * `not_run` is the definition the old word carried: "there was nothing to
 *     run", never "we decided against it".
 *   * `skipped` asserts a deliberate choice. The old wire format never carried
 *     that fact, so claiming it would be inventing evidence.
 *
 * Under-claiming is the safe direction here; over-claiming is not.
 */
const LEGACY_GATE_STATUSES: Readonly<Record<string, GateStatus>> = {
  pass: 'passed',
  fail: 'failed',
  inconclusive: 'inconclusive',
  'not-configured': 'not_run',
};

/**
 * Normalize whatever arrived on the wire into one of the five words.
 *
 * Anything unrecognized — a missing field, a future CLI's sixth word, a
 * malformed value — becomes `inconclusive`, never `not_run`. The distinction
 * matters: `not_run` is a CLAIM about the customer's repository ("there was
 * nothing to run") that the App is in no position to make on its own, while
 * `inconclusive` says only "we cannot tell", which is exactly true when the
 * report did not say. The old default did the opposite, and that is how a
 * failure came to be displayed as an absence.
 */
export function toGateStatus(value: unknown): GateStatus {
  if (typeof value !== 'string') return 'inconclusive';
  if ((GATE_STATUSES as readonly string[]).includes(value)) return value as GateStatus;
  return LEGACY_GATE_STATUSES[value] ?? 'inconclusive';
}
