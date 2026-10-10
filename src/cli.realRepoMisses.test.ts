import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// MISSES FOUND BY RUNNING v0.5.8-alpha ON REAL PUBLIC REPOSITORIES (2026-10-09), END TO END.
//
// Each fixture here is a minimal shape written for this suite, not code copied from the
// repository where the miss was seen. The unit suites pin the classification; this one pins
// that `fix-llm` and `audit` REPORT the same thing about the same line, because the failure
// that mattered was a team being told by one of them that there was nothing to do.
//
// Hermetic: temp-dir fixtures, `fix-llm --skip-gates` (no type-check, no tests, no network) and
// `audit --offline`, both run from source through tsx.

const MENDR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-real-misses-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'real-misses' }, null, 2));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

async function run(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa('tsx', ['src/cli.ts', command, ...args], {
    cwd: MENDR_ROOT,
    preferLocal: true,
    reject: false,
    env: { ...process.env, MENDR_REGISTRY_MAX_AGE_DAYS: '100000' },
  });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

interface TierBRow {
  file: string;
  line: number;
  modelId: string;
  reason: string;
}

interface AuditLocation {
  file: string;
  line: number;
  tier: string;
  reason: string | null;
  role: string;
}

async function fixLlmTierB(dir: string): Promise<{ tierA: unknown[]; tierB: TierBRow[]; tierC: number }> {
  const { stdout } = await run('fix-llm', [dir, '--skip-gates', '--json']);
  const report = JSON.parse(stdout) as { tierA: unknown[]; tierB: TierBRow[]; summary: { tierC: number } };
  return { tierA: report.tierA, tierB: report.tierB, tierC: report.summary.tierC };
}

async function auditLocations(dir: string): Promise<AuditLocation[]> {
  const { stdout } = await run('audit', [dir, '--offline', '--json']);
  const report = JSON.parse(stdout) as {
    investigations: { locations: { selectors: AuditLocation[]; catalog: AuditLocation[] } }[];
  };
  return report.investigations.flatMap((i) => [...i.locations.selectors, ...i.locations.catalog]);
}

/** A Node server that builds the request in a variable and passes it by name. */
const SERVER_JS = [
  "let llm;",
  "if (process.env.LLM_KEY) {",
  "  const { OpenAI } = require('openai');",
  "  llm = new OpenAI({ apiKey: process.env.LLM_KEY });",
  "}",
  "function register(socket) {",
  "  socket.on('ask', async ({ text }, cb) => {",
  "    const req = {",
  "      messages: [{ role: 'user', content: text }],",
  "      model: 'gpt-3.5-turbo',",
  "    };",
  "    const out = await llm.chat.completions.create(req);",
  "    cb(out.choices[0].message.content);",
  "  });",
  "}",
  "module.exports = { register };",
  '',
].join('\n');

/** The same shape on a proxy client, carrying a parameter the registry has a rule for. */
const PROXY_TS = [
  'import OpenAI from "openai";',
  'const proxy = new OpenAI({ baseURL: "https://llm-proxy.internal/v1" });',
  'export async function reason() {',
  "  const req = { model: 'o3-mini', max_tokens: 50, messages: [] };",
  '  return proxy.chat.completions.create(req);',
  '}',
  '',
].join('\n');

/** A Python agent: a client attribute set to None, built in another method, held by a host in the file. */
const AGENT_PY = [
  'from openai import AsyncOpenAI',
  'from langchain_openai import ChatOpenAI',
  '',
  'class Agent:',
  '    def __init__(self):',
  '        self.llm_client = None',
  '        self.memory_url = "http://127.0.0.1:8010"',
  '',
  '    def _initialize_llm(self, key):',
  '        self.llm_client = AsyncOpenAI(api_key=key)',
  '        self.chat = ChatOpenAI(model_name="o4-mini", temperature=1)',
  '',
  '    async def analyze(self, prompt):',
  '        return await self.llm_client.chat.completions.create(',
  '            model="o4-mini",',
  '            messages=[{"role": "user", "content": prompt}],',
  '        )',
  '',
].join('\n');

/** A TypeScript runtime whose default model lives in a default-configuration object. */
const RUNTIME_TS = [
  'const RUNTIME_CONFIG_DEFAULTS = {',
  '  model: "o4-mini",',
  '  timeout: 120,',
  '};',
  'export class RuntimeConfig {',
  '  readonly model!: string;',
  '  constructor(opts: { model?: string } = {}) {',
  '    Object.assign(this, { ...RUNTIME_CONFIG_DEFAULTS, ...opts });',
  '  }',
  '}',
  '',
].join('\n');

describe('a held Python call (miss 2: printed as "no supported SDK call was found")', () => {
  it('is listed under surface_capped with the guard\'s reason, the code audit gives it', async () => {
    const dir = repo({ 'agents/agent.py': AGENT_PY });
    const fix = await fixLlmTierB(dir);
    const rows = fix.tierB.map((f) => [f.file, f.line, f.reason]);
    expect(rows).toContainEqual(['agents/agent.py', 15, 'surface_capped']);
    expect(rows).toContainEqual(['agents/agent.py', 11, 'surface_capped']);
    expect(fix.tierB.filter((f) => f.reason === 'usage_unverified')).toEqual([]);

    const human = await run('fix-llm', [dir, '--skip-gates']);
    expect(human.stdout).not.toContain('no supported SDK call or parameter sink was found');
    // The reader sees which host capped a client built with no base URL.
    expect(human.stdout).toContain('127.0.0.1');

    const audit = await auditLocations(dir);
    for (const line of [11, 15]) {
      expect(audit.find((l) => l.file === 'agents/agent.py' && l.line === line)).toMatchObject({
        tier: 'B',
        reason: 'surface_capped',
      });
    }
  }, 180_000);
});

describe('an untraced TypeScript default (miss 3: audit said review, fix-llm said nothing)', () => {
  it('is listed in fix-llm Tier B under the reason audit gives it, with the scanner\'s sentence', async () => {
    const dir = repo({ 'ts/src/runtime.ts': RUNTIME_TS });
    const fix = await fixLlmTierB(dir);
    expect(fix.tierB.map((f) => [f.file, f.line, f.modelId, f.reason])).toEqual([
      ['ts/src/runtime.ts', 2, 'o4-mini', 'usage_unverified'],
    ]);
    const human = await run('fix-llm', [dir, '--skip-gates', '--verbose']);
    expect(human.stdout).toContain('ts/src/runtime.ts:2');
    expect(human.stdout).toContain('default-configuration object');

    const audit = await auditLocations(dir);
    expect(audit.find((l) => l.file === 'ts/src/runtime.ts' && l.line === 2)).toMatchObject({
      tier: 'B',
      reason: 'usage_unverified',
    });
  }, 180_000);
});

describe('the audit JSON snippet (miss 5: a token limit printed as a redacted secret)', () => {
  it('keeps a max_tokens parameter as written, and still redacts a key on the next line', async () => {
    const dir = repo({
      'src/chat.js': [
        "const { OpenAI } = require('openai');",
        'const client = new OpenAI();',
        'async function chat(config, messages) {',
        '  return client.chat.completions.create({',
        "    model: config?.llm?.model || 'gpt-3.5-turbo',",
        '    messages,',
        '    max_tokens: config?.llm?.max_tokens || 1024,',
        "    user: 'sk-abcdefghijklmnopqrstuvwxyz0123',",
        '  });',
        '}',
        'module.exports = { chat };',
        '',
      ].join('\n'),
    });
    const { stdout } = await run('audit', [dir, '--offline', '--json']);
    expect(stdout).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    const report = JSON.parse(stdout) as {
      investigations: { locations: { selectors: { file: string; snippet: { lines: string[] } | null }[] } }[];
    };
    const loc = report.investigations.flatMap((i) => i.locations.selectors).find((l) => l.file === 'src/chat.js');
    const snippet = loc?.snippet?.lines.join('\n') ?? '';
    expect(snippet).toContain('max_tokens: config?.llm?.max_tokens || 1024,');
    expect(snippet).not.toContain('max_tokens=***REDACTED***');
    expect(snippet).toContain('REDACTED');
  }, 180_000);
});

describe('a request object built in a variable (miss 1: a live call reported as catalog data)', () => {
  it('is listed in fix-llm Tier B, and audit puts the same line in the same tier', async () => {
    const dir = repo({ 'src/server.js': SERVER_JS, 'src/proxy.ts': PROXY_TS });
    const fix = await fixLlmTierB(dir);
    const rows = fix.tierB.map((f) => [f.file, f.line, f.modelId, f.reason]);
    expect(rows).toContainEqual(['src/server.js', 10, 'gpt-3.5-turbo', 'surface_capped']);
    expect(rows).toContainEqual(['src/proxy.ts', 4, 'o3-mini', 'surface_capped']);
    // Nothing is patched: the held proxy call's own max_tokens is not renamed either.
    expect(fix.tierA).toEqual([]);
    expect(fix.tierC).toBe(0);

    const audit = await auditLocations(dir);
    const at = (file: string, line: number) => audit.find((l) => l.file === file && l.line === line);
    expect(at('src/server.js', 10)).toMatchObject({ tier: 'B', reason: 'surface_capped', role: 'code_candidate' });
    expect(at('src/proxy.ts', 4)).toMatchObject({ tier: 'B', reason: 'surface_capped' });
  }, 180_000);
});
