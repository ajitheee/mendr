// The Ed25519 public keys this build trusts to sign registry snapshots.
//
// A snapshot verifies if ANY key here verifies its manifest signature. This is
// the trust anchor for refreshed registry DATA, baked into the pinned scanner
// build so a compromised download host or mirror cannot substitute its own
// registry. Rotation: add the new public key, dual-sign publishes for a
// transition window, then drop the old key in a later release.
//
// To (re)generate a keypair — the PRIVATE key goes ONLY into the repository
// secret MENDR_REGISTRY_SIGNING_KEY that .github/workflows/registry-publish.yml
// reads; it is never committed and never pasted anywhere else:
//
//   openssl genpkey -algorithm ed25519 -out mendr-registry.key
//   openssl pkey -in mendr-registry.key -pubout          # ← paste THIS below
//
// While this list is EMPTY the scanner makes no refresh request at all (there
// is nothing it could trust), and every audit grades the bundled registry by
// its own stamped age — see src/registry/freshRegistry.ts.
//
// MENDR_REGISTRY_TRUSTED_KEYS_FILE (a PEM file, one or more PUBLIC KEY blocks)
// REPLACES this list at runtime. That sits at the same trust level as
// MENDR_SPEC itself — the customer's own repository configuration — and exists
// for tests, self-hosted mirrors that sign their own snapshots, and air-gapped
// runs.

export const TRUSTED_REGISTRY_KEYS: readonly string[] = [
  // Paste the PUBLIC key PEM (SPKI, `-----BEGIN PUBLIC KEY-----`) here.
];
