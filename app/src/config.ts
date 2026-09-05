import { randomBytes } from 'node:crypto';

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
  /** Directory holding the static investigation workspace (site/app). */
  uiDir: string | null;
  /** The Mendr CLI ref the scaffolded audit workflow pins to (a tag or commit SHA). */
  mendrSpec: string;
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function opt(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = int(env.PORT, 8080);
  const secret = opt(env.SESSION_SECRET);
  return {
    appUrl: (opt(env.APP_URL) ?? `http://localhost:${port}`).replace(/\/+$/, ''),
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
    uiDir: opt(env.UI_DIR),
    mendrSpec: opt(env.MENDR_CLI_SPEC) ?? 'v0.2.4-alpha',
  };
}

/** True once the App credentials from /setup/callback are in the environment. */
export function isConfigured(c: AppConfig): boolean {
  return !!(c.githubAppId && c.githubPrivateKey && c.githubWebhookSecret && c.githubClientId && c.githubClientSecret);
}
