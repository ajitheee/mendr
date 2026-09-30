import { isMap, isSeq, parseAllDocuments, type Node, type Pair } from 'yaml';

// ENTRY BOUNDARIES IN A ROUTER CONFIG, from the parser rather than from indentation.
//
// A gateway config is a LIST of independent routes:
//
//   model_list:
//     - model_name: fast
//       litellm_params:
//         model: gpt-4-0613            <- a real, live selection
//     - model_name: stub
//       litellm_params:
//         model: openai/fake
//         api_base: os.environ/FAKE_OPENAI_API_BASE   <- a stub, and ONLY a stub
//
// A marker inside one item says something about THAT ROUTE. It says nothing about its siblings,
// and letting it speak for the file produces a false clean on the most ordinary shape there is:
// LiteLLM's own docker sample ships a stub entry, and real deployments keep one beside the live
// routes. Measured 2026-09-29: one entry carrying `FAKE_OPENAI_API_BASE` demoted a sibling
// `model: gpt-4-0613` from review to informational.
//
// WHY A PARSER AND NOT INDENTATION. The previous scoping walked outward from the matched line
// until the indent dropped below its own, bounded at 80 lines. That is correct on a tidy
// two-space file — verified — but it has no real notion of an entry, so it cannot be trusted
// across the shapes this has to survive: four-space indents, flow mappings, several documents in
// one file, a key order that does not start with `model_name`, or a file that does not parse at
// all. The parser knows where an item starts and ends; a line scanner infers it.
//
// FAIL CLOSED, ALWAYS IN THE SAFE DIRECTION. Every uncertainty here resolves to "demote nothing":
// a parse error, a `model_list` that is not a sequence, an item with no usable range, a document
// that is not a mapping. The cost of demoting wrongly is a MISSED RETIREMENT reported as
// informational — a false clean, the one answer this product must never give. The cost of not
// demoting is a review-queue entry on a stub. Those are not comparable, so ambiguity never
// demotes.

/** A 1-based, inclusive line span. */
export interface LineSpan {
  startLine: number;
  endLine: number;
}

export interface ModelListScope {
  /**
   * Spans of `model_list` items that carry a stub marker. A location inside one of these may be
   * treated as a fixture; a location anywhere else must be judged on its own.
   */
  stubs: LineSpan[];
  /**
   * Did the parser actually resolve item boundaries in this file? `false` means "no opinion" —
   * never "no stubs" — and callers must not demote anything on the strength of it.
   */
  resolved: boolean;
}

const NO_OPINION: ModelListScope = { stubs: [], resolved: false };

/** Keys whose value is a list of routes. `model_list` is LiteLLM's; the others are the same idiom. */
const ROUTE_LIST_KEY = /^(model_list|models|deployments|model_group|llm_list)$/i;

/**
 * Markers that mark ONE ROUTE as a stub.
 *
 * `FAKE_*_API_BASE` sits here, and that placement is the fix. It was in the file-level set, but an
 * `api_base` belongs to a single `litellm_params` block by construction — it is the address ONE
 * route dials. A file-level reading of it is a category error, and a measurable false clean.
 */
export const ENTRY_STUB_MARKERS =
  /\b(fake-key|my-fake-model|openai\/fake|test-api-key|FAKE_[A-Z_]*API_BASE|fake_api_base)\b/i;

/** Offset → 1-based line. Built once per file; a scan per lookup made this quadratic on big files. */
function lineIndex(text: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset: number): number => {
    // Binary search for the last line start at or before `offset`.
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Every route-list sequence in one document, at any depth (a Helm chart nests them). */
function routeListSeqs(root: unknown, out: Node[], depth = 0): void {
  if (depth > 8 || root === null || root === undefined) return;
  if (isMap(root)) {
    for (const item of root.items as Pair[]) {
      const key = item.key as { value?: unknown } | null;
      const name = key && typeof key.value === 'string' ? key.value : null;
      if (name !== null && ROUTE_LIST_KEY.test(name) && isSeq(item.value)) {
        out.push(item.value as unknown as Node);
        continue; // the sequence's own items are routes, not further route lists
      }
      routeListSeqs(item.value, out, depth + 1);
    }
    return;
  }
  if (isSeq(root)) {
    for (const item of root.items) routeListSeqs(item, out, depth + 1);
  }
}

/**
 * Locate the stub routes in a YAML config, by parser range.
 *
 * Handles several documents in one file (`---` separated): each is walked, and a parse error in
 * ANY of them collapses the whole answer to {@link NO_OPINION}, because a file we cannot read
 * fully is a file whose entry boundaries we do not know.
 */
export function stubModelListEntries(text: string): ModelListScope {
  if (!ROUTE_LIST_KEY.test('model_list')) return NO_OPINION; // guards against an edited regex
  let docs;
  try {
    docs = parseAllDocuments(text);
  } catch {
    return NO_OPINION;
  }
  if (docs.length === 0) return NO_OPINION;
  const seqs: Node[] = [];
  for (const doc of docs) {
    // A malformed document means unknown boundaries. Say nothing rather than guess.
    if (doc.errors.length > 0) return NO_OPINION;
    routeListSeqs(doc.contents, seqs);
  }
  if (seqs.length === 0) return NO_OPINION;

  const lineAt = lineIndex(text);
  const stubs: LineSpan[] = [];
  for (const seq of seqs) {
    for (const item of (seq as unknown as { items: unknown[] }).items) {
      const range = (item as { range?: [number, number, number] } | null)?.range;
      // An item with no range cannot be bounded, so it cannot be demoted. It also cannot make
      // its SIBLINGS ambiguous — each item is judged from its own range.
      if (!range) continue;
      const [start, , end] = range;
      if (typeof start !== 'number' || typeof end !== 'number' || end <= start) continue;
      const body = text.slice(start, end);
      if (!ENTRY_STUB_MARKERS.test(body)) continue;
      stubs.push({ startLine: lineAt(start), endLine: lineAt(Math.max(start, end - 1)) });
    }
  }
  return { stubs, resolved: true };
}

/** Is this 1-based line inside a RESOLVED stub route? Unresolved scopes always answer `false`. */
export function lineIsInStubEntry(scope: ModelListScope, line: number): boolean {
  if (!scope.resolved) return false;
  return scope.stubs.some((s) => line >= s.startLine && line <= s.endLine);
}
