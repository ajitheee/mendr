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

const config = loadConfig();

const keyring = loadKeyring(config.dataKey);
const store = config.databaseUrl ? await createPgStore(config.databaseUrl, keyring) : new MemoryStore();
if (!config.databaseUrl) console.warn('DATABASE_URL is not set: using the in-memory store. Runs vanish on restart. Development only.');
if (config.databaseUrl && !keyring) console.warn('MENDR_DATA_KEY is not set: stored reports are NOT field-encrypted at rest. Set it in production.');
if (config.sessionGenerated) console.warn('SESSION_SECRET is not set: a random one was generated; every restart signs everyone out.');

const keys = config.oidcJwksFile ? createLocalJWKSet(JSON.parse(readFileSync(config.oidcJwksFile, 'utf8'))) : remoteActionsJwks(config.oidcIssuer);
if (config.oidcJwksFile) console.warn(`OIDC_JWKS_FILE is set: accepting tokens signed by ${config.oidcJwksFile}, not GitHub. Development only.`);

const app = createApp({
  config,
  store,
  github: createGitHubApi(config),
  verifyActionsToken: createActionsVerifier(keys, { issuer: config.oidcIssuer, audience: config.oidcAudience }),
});

// Bind all interfaces so containerized hosts (Render, Fly, Railway, Docker)
// can reach it; they inject the port via PORT, which config.port reads.
serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`mendr-app listening on http://localhost:${info.port}  public=${config.appUrl}  configured=${isConfigured(config)}  store=${store.kind}`);
  if (!isConfigured(config)) console.log(`Create the GitHub App at ${config.appUrl}/setup`);
});
