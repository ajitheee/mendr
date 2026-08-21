# Evidence snapshots

Committed copies of the documents Mendr's registry claims were read from. Each
file is named `<first 12 hex of the sha256>.txt` and is referenced by an
`EvidenceRef.contentHash` on a registry or candidate entry.

These files **are** the audit trail, so they are committed rather than ignored:
an audit trail that only exists on the machine that ran the discovery job is not
an audit trail. `mendr evidence <modelId>` prints the refs; this directory is
what lets a reviewer read what the page actually said after the provider has
rewritten it.

Three rules keep the directory affordable and honest:

- **Content-addressed names, over the _normalized_ document.** The hash is taken
  after stripping the page's per-response noise — CSP `nonce="…"` attributes,
  `<script>` bodies, `integrity="…"` SRI hashes, and runs of whitespace. Without
  that, the Anthropic and Google deprecation pages hash differently on *every*
  fetch (they mint a fresh nonce per response), so an unchanged page would look
  like drift forever and each scheduled run would commit another snapshot.
  A capture whose file is already here is **left untouched**, so a run that finds
  nothing new produces a genuinely empty diff. Only a real edit to the page
  changes the hash, and that shows up as a new snapshot under a new name.
- **1MB cap, excerpt-aware.** A whole provider docs page now fits (Anthropic's is
  ~973KB). When a document still doesn't, the stored file keeps the head **plus a
  window around every quoted row**, with a marker at each gap naming how many
  characters were dropped there. This matters: Anthropic's cited row sits at
  char ~168k, which the old 200KB head-only cut came within 32KB of discarding —
  the evidence would have been missing from the file that exists to hold it.
- **The hash describes the document, not the file.** For a truncated snapshot,
  re-hashing the stored bytes proves nothing — the marker says so. For an
  untruncated one the check does work, but normalize first: the hash is
  `sha256(normalizeForHash(document))`, not `sha256(file)`.
