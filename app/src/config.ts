import { randomBytes } from 'node:crypto';

/**
 * The Mendr CLI release the App's generated workflows pin to. Bumped with each
 * release (see REGISTRY-FRESHNESS.md → Release checklist). Deliberately NOT an
 * environment variable: a stale deployment setting once kept the App handing
 * out an older pin than the release it was built from. A customer who wants a
 * different pin sets the MENDR_SPEC repository variable, which every generated
 * workflow reads first.
 */
export const MENDR_CLI_SPEC = 'v0.4.6-alpha';

export interface AppConfig {
  /** Public base URL, no trailing slash. Webhooks and OAuth redirects come here. */
  appUrl: string;
  port: number;
  githubAppName: string;
  githubAppId: string | null;
  githubAppSlug: string | null;
  githubPrivateKey: string | null;
  githubWebhookSecret: string | null;
  githubClientId: string | null;
  githubClientSecret: string | null;
  githubApiUrl: string;
  githubWebUrl: string;
  /** Issuer of the GitHub Actions OIDC tokens the ingest endpoint accepts. */
  oidcIssuer: string;
  /** Audience the customer's workflow requests; anything else is rejected. */
  oidcAudience: string;
  /** Development only: a local JWKS file instead of GitHub's. */
  oidcJwksFile: string | null;
  sessionSecret: string;
  sessionGenerated: boolean;
  databaseUrl: string | null;
  maxBodyBytes: number;
  maxRunsPerRepo: number;
  /** The Mendr CLI release the generated workflows pin to (MENDR_CLI_SPEC, release-coupled). */
  mendrSpec: string;
  /** Field-level encryption keyring for stored reports (MENDR_DATA_KEY); null = plaintext (dev). */
  dataKey: string | null;
  /** Delete runs older than this many days (MENDR_RETENTION_DAYS); 0 = keep (bounded by MAX_RUNS_PER_REPO). */
  retentionDays: number;
  /**
   * Offer "open a pull request and merge it when checks pass" on Approve
   * (MENDR_AUTO_MERGE). OFF in the public beta: Mendr promises never to merge,
   * and the option comes back as an advanced opt-in only after partner validation.
   */
  autoMerge: boolean;
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function opt(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/**
 * Normalize APP_URL to a bare ORIGIN (scheme://host[:port]) — no path, query or
 * trailing slash. APP_URL is the base every callback/webhook URL is built from,
 * so a pasted `https://host/healthz` (a common mistake) must not corrupt them
 * into `/healthz/setup/callback`. Falls back to the given default on a bad value.
 */
function originOf(v: string | undefined, fallback: string): string {
  const t = opt(v);
  if (!t) return fallback;
  try {
    return new URL(t.includes('://') ? t : `https://${t}`).origin;
  } catch {
    return t.replace(/\/+$/, '');
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = int(env.PORT, 8080);
  const secret = opt(env.SESSION_SECRET);
  return {
    appUrl: originOf(env.APP_URL, `http://localhost:${port}`),
    port,
    githubAppName: opt(env.GITHUB_APP_NAME) ?? 'Mendr audit',
    githubAppId: opt(env.GITHUB_APP_ID),
    githubAppSlug: opt(env.GITHUB_APP_SLUG),
    // Hosts often store the PEM on one line with literal "\n" sequences.
    githubPrivateKey: opt(env.GITHUB_PRIVATE_KEY)?.replace(/\\n/g, '\n') ?? null,
    githubWebhookSecret: opt(env.GITHUB_WEBHOOK_SECRET),
    githubClientId: opt(env.GITHUB_CLIENT_ID),
    githubClientSecret: opt(env.GITHUB_CLIENT_SECRET),
    githubApiUrl: (opt(env.GITHUB_API_URL) ?? 'https://api.github.com').replace(/\/+$/, ''),
    githubWebUrl: (opt(env.GITHUB_WEB_URL) ?? 'https://github.com').replace(/\/+$/, ''),
    oidcIssuer: opt(env.OIDC_ISSUER) ?? 'https://token.actions.githubusercontent.com',
    oidcAudience: opt(env.OIDC_AUDIENCE) ?? 'mendr',
    oidcJwksFile: opt(env.OIDC_JWKS_FILE),
    sessionSecret: secret ?? randomBytes(32).toString('hex'),
    sessionGenerated: !secret,
    databaseUrl: opt(env.DATABASE_URL),
    maxBodyBytes: int(env.MAX_BODY_BYTES, 2 * 1024 * 1024),
    maxRunsPerRepo: int(env.MAX_RUNS_PER_REPO, 100),
    mendrSpec: MENDR_CLI_SPEC,
    dataKey: opt(env.MENDR_DATA_KEY),
    retentionDays: Math.max(0, Math.floor(Number(env.MENDR_RETENTION_DAYS) || 0)),
    autoMerge: /^(on|1|true|yes)$/i.test((env.MENDR_AUTO_MERGE ?? '').trim()),
  };
}

/** True once the App credentials from /setup/callback are in the environment. */
export function isConfigured(c: AppConfig): boolean {
  return !!(c.githubAppId && c.githubPrivateKey && c.githubWebhookSecret && c.githubClientId && c.githubClientSecret);
}
