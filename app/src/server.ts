import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createLocalJWKSet } from 'jose';
import { createApp } from './app.js';
import { isConfigured, loadConfig } from './config.js';
import { createGitHubApi } from './github/api.js';
import { createActionsVerifier, remoteActionsJwks } from './github/oidc.js';
import { MemoryStore } from './store/memory.js';
import { createPgStore } from './store/pg.js';

const config = loadConfig();

const store = config.databaseUrl ? await createPgStore(config.databaseUrl) : new MemoryStore();
if (!config.databaseUrl) console.warn('DATABASE_URL is not set: using the in-memory store. Runs vanish on restart. Development only.');
if (config.sessionGenerated) console.warn('SESSION_SECRET is not set: a random one was generated; every restart signs everyone out.');

const keys = config.oidcJwksFile ? createLocalJWKSet(JSON.parse(readFileSync(config.oidcJwksFile, 'utf8'))) : remoteActionsJwks(config.oidcIssuer);
if (config.oidcJwksFile) console.warn(`OIDC_JWKS_FILE is set: accepting tokens signed by ${config.oidcJwksFile}, not GitHub. Development only.`);

const app = createApp({
  config,
  store,
  github: createGitHubApi(config),
  verifyActionsToken: createActionsVerifier(keys, { issuer: config.oidcIssuer, audience: config.oidcAudience }),
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`mendr-app listening on http://localhost:${info.port}  public=${config.appUrl}  configured=${isConfigured(config)}  store=${store.kind}`);
  if (!isConfigured(config)) console.log(`Create the GitHub App at ${config.appUrl}/setup`);
});
