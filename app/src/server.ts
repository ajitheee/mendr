import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createLocalJWKSet } from 'jose';
import { createApp } from './app.js';
import { isConfigured, loadConfig } from './config.js';
import { createGitHubApi } from './github/api.js';
import { createActionsVerifier, remoteActionsJwks } from './github/oidc.js';
import { MemoryStore } from './store/memory.js';
import { createPgStore } from './store/pg.js';
import { loadKeyring } from './store/encryption.js';
import type { Store } from './store/types.js';
import { createSignupAlert } from './waitlistAlert.js';

const config = loadConfig();

const keyring = loadKeyring(config.dataKey);
// No database, no service: say why in one line and exit non-zero within DB_TIMEOUT_MS. Render
// then does not promote the deploy, keeps the previous one serving, and shows this line as the
// reason; it restarts a crashed instance itself, so the App recovers once DATABASE_URL is fixed.
let store: Store;
try {
  store = config.databaseUrl ? await createPgStore(config.databaseUrl, keyring) : new MemoryStore();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
if (!config.databaseUrl) console.warn('DATABASE_URL is not set: using the in-memory store. Runs vanish on restart. Development only.');
if (config.databaseUrl && !keyring) console.warn('MENDR_DATA_KEY is not set: stored reports are NOT field-encrypted at rest. Set it in production.');
// A key set after data already existed: seal what is still plaintext, so
// "encrypted at rest" holds for every row, not only the ones stored from now on.
if (keyring) {
  const sealed = await store.sealPlaintextReports();
  if (sealed.runs || sealed.migrations) console.log(`sealed ${sealed.runs} run report(s) and ${sealed.migrations} migration report(s) that were stored in plaintext`);
}
if (config.sessionGenerated) console.warn('SESSION_SECRET is not set: a random one was generated; every restart signs everyone out.');

const keys = config.oidcJwksFile ? createLocalJWKSet(JSON.parse(readFileSync(config.oidcJwksFile, 'utf8'))) : remoteActionsJwks(config.oidcIssuer);
if (config.oidcJwksFile) console.warn(`OIDC_JWKS_FILE is set: accepting tokens signed by ${config.oidcJwksFile}, not GitHub. Development only.`);

// Sign-up alerts: on with both settings, off with neither, and a half-set pair says which is missing.
// The address itself is never printed: no email in a log line.
const waitlistAlert = createSignupAlert({ apiKey: config.resendApiKey, to: config.waitlistAlertTo });
if (waitlistAlert) console.log('waitlist sign-up alerts: on');
else if (config.resendApiKey || config.waitlistAlertTo) {
  console.warn(`waitlist sign-up alerts: off, because ${config.resendApiKey ? 'WAITLIST_ALERT_TO' : 'RESEND_API_KEY'} is not set. Set both to be emailed about each sign-up.`);
}

const app = createApp({
  config,
  store,
  github: createGitHubApi(config),
  verifyActionsToken: createActionsVerifier(keys, { issuer: config.oidcIssuer, audience: config.oidcAudience }),
  waitlistAlert,
});

// Bind all interfaces so containerized hosts (Render, Fly, Railway, Docker)
// can reach it; they inject the port via PORT, which config.port reads.
serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`mendr-app listening on http://localhost:${info.port}  public=${config.appUrl}  configured=${isConfigured(config)}  store=${store.kind}`);
  if (!isConfigured(config)) console.log(`Create the GitHub App at ${config.appUrl}/setup`);
});
