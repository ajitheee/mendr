#!/usr/bin/env node
// Build and SIGN the registry snapshot pinned scanners refresh from.
//
// Output (default ./registry-dist):
//   llm-deprecations.json   byte-identical copy of registries/llm-deprecations.json
//   manifest.json           canonical JSON: schemaVersion, registryVersion (content
//                           hash), sha256, publishedAt, sourceCommit, entryCount
//   manifest.sig            Ed25519 signature over manifest.json's exact bytes (base64)
//
// The key: MENDR_REGISTRY_SIGNING_KEY holds the Ed25519 PRIVATE key PEM (a
// repository secret; `\n`-escaped one-line form accepted). The script REFUSES to
// publish unless that key's PUBLIC half is listed in src/registry/trustedKeys.ts
// — a snapshot no scanner trusts is worse than none, because it looks published.
//
// It also refuses a registry that fails the offline integrity check, so a
// self-contradicting registry can never be signed (validate first is the
// workflow's job; this is the belt to that brace).
//
//   node scripts/publish-registry.mjs [--out DIR] [--dev-key]
//
// --dev-key: generate a throwaway keypair instead of reading the secret, skip
// the trusted-keys check, and ALSO write trusted-keys.pem beside the output so a
// local scanner can be pointed at the result with
// MENDR_REGISTRY_FILE=<out>/llm-deprecations.json
// MENDR_REGISTRY_TRUSTED_KEYS_FILE=<out>/trusted-keys.pem. Never use it in CI.
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : 'registry-dist');
const devKey = args.includes('--dev-key');

function fail(msg) {
  console.error(`publish-registry: ${msg}`);
  process.exit(1);
}

// The signing/canonicalization code is the SCANNER's own (built to dist/), so
// the publisher and the verifier can never drift apart.
const manifestMod = join(root, 'dist', 'registry', 'manifest.js');
const keysMod = join(root, 'dist', 'registry', 'trustedKeys.js');
let m, keys;
try {
  m = await import(pathToFileURL(manifestMod).href);
  keys = await import(pathToFileURL(keysMod).href);
} catch (e) {
  fail(`could not load ${manifestMod} — run \`npm run build\` first (${e.message})`);
}

// 1. The key.
let privatePem;
if (devKey) {
  const { privateKey } = generateKeyPairSync('ed25519');
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  console.error('publish-registry: --dev-key — THROWAWAY key; this snapshot is NOT trusted by any shipped scanner');
} else {
  const raw = process.env.MENDR_REGISTRY_SIGNING_KEY;
  if (!raw || !raw.trim()) fail('MENDR_REGISTRY_SIGNING_KEY is not set (the Ed25519 private key PEM)');
  privatePem = raw.replace(/\\n/g, '\n').trim() + '\n';
}
const publicPem = m.publicKeyPemOf(privatePem);
if (!devKey) {
  const trusted = keys.TRUSTED_REGISTRY_KEYS.map(m.normalizePem);
  if (!trusted.includes(m.normalizePem(publicPem))) {
    fail(
      "the signing key's PUBLIC key is not in src/registry/trustedKeys.ts, so no shipped scanner would trust this snapshot. " +
        'Paste the public key there (openssl pkey -in <key> -pubout), release, then publish.',
    );
  }
}

// 2. The registry — integrity-checked before anything is signed.
const registryPath = join(root, 'registries', 'llm-deprecations.json');
const bytes = readFileSync(registryPath);
let entries;
try {
  entries = JSON.parse(bytes.toString('utf8'));
} catch (e) {
  fail(`${registryPath} is not JSON: ${e.message}`);
}
if (!Array.isArray(entries)) fail(`${registryPath} must be a JSON array`);
try {
  execFileSync(process.execPath, [join(root, 'scripts', 'validate-registry.mjs')], { cwd: root, stdio: 'inherit' });
} catch {
  fail('registry integrity validation failed — refusing to sign a self-contradicting registry');
}

// 3. Provenance.
let sourceCommit;
try {
  sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
} catch {
  sourceCommit = process.env.GITHUB_SHA ?? '';
}
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) fail('could not determine the source commit (git rev-parse HEAD / GITHUB_SHA)');
const publishedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// 4. Manifest + signature, then a self-check with the derived public key.
const manifest = m.buildManifest(bytes, { publishedAt, sourceCommit, entryCount: entries.length });
const manifestBytes = Buffer.from(m.canonicalJson(manifest), 'utf8');
const sig = m.signManifest(manifestBytes, privatePem);
if (!m.verifyManifestSignature(manifestBytes, sig, [publicPem])) fail('self-check failed: the signature does not verify with the derived public key');
m.parseManifest(manifestBytes.toString('utf8')); // the exact bytes must parse as a manifest this scanner accepts

// 5. Write.
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'llm-deprecations.json'), bytes);
writeFileSync(join(outDir, 'manifest.json'), manifestBytes);
writeFileSync(join(outDir, 'manifest.sig'), sig + '\n');
if (devKey) writeFileSync(join(outDir, 'trusted-keys.pem'), publicPem);
console.log(`published ${manifest.registryVersion} (${entries.length} entries) at ${publishedAt} from ${sourceCommit.slice(0, 12)} → ${outDir}`);
