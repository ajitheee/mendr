import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

// APP_URL is the base for every GitHub callback/webhook URL, so it must be a
// bare origin. A pasted path (e.g. the /healthz page URL) previously corrupted
// the manifest redirect into /healthz/setup/callback → 404 on the callback.

describe('APP_URL is normalized to an origin', () => {
  const app = (APP_URL?: string) => loadConfig({ APP_URL, PORT: '8080' } as NodeJS.ProcessEnv).appUrl;

  it('strips a path, query and trailing slash', () => {
    expect(app('https://mendr-app.onrender.com/healthz')).toBe('https://mendr-app.onrender.com');
    expect(app('https://mendr-app.onrender.com/')).toBe('https://mendr-app.onrender.com');
    expect(app('https://mendr-app.onrender.com/setup?x=1')).toBe('https://mendr-app.onrender.com');
    expect(app('https://mendr-app.onrender.com')).toBe('https://mendr-app.onrender.com');
  });

  it('adds https:// when the scheme is missing', () => {
    expect(app('mendr-app.onrender.com/healthz')).toBe('https://mendr-app.onrender.com');
  });

  it('falls back to localhost when unset', () => {
    expect(app(undefined)).toBe('http://localhost:8080');
  });
});
