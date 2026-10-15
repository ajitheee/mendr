import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ts } from 'ts-morph';

// INVARIANT 2 (ARCHITECTURE-NEXT.md), held by a test instead of a sentence:
//   detector→classifier→fix→gate is deterministic; an LLM runs only outside it.
//
// Proven statically, the way the code is shipped: start at every detector, fix and gate
// entry point, follow every relative import transitively, and fail — naming the import
// chain — if the walk reaches the LLM client module or a module importing an LLM SDK. The
// walk counts static, re-exported, dynamic, require() and type-only imports alike: a
// type-only import of `ChatClient` is exactly how a client would be handed to a gate.
// An import the walk cannot follow (a non-literal specifier, a path that resolves to no
// file) fails too: a hole in the walk is a hole in the fence.
//
// The fence is rooted at the entry points, NOT at cli.ts: cli.ts imports the reader for
// `mendr read-page`, and the last describe block proves the walk sees that edge.

const MENDR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(MENDR_ROOT, 'src');

/** The modules that talk to a model. A new one is fenced only once it is listed here. */
const LLM_CLIENT_MODULES = [join(SRC, 'registry', 'aiReader.ts')];

/** LLM SDKs by package name; a scope (`@x/`) covers every package under it. */
const LLM_SDK_PACKAGES = [
  'openai',
  '@openai/',
  '@anthropic-ai/',
  '@azure/openai',
  '@google/generative-ai',
  '@google/genai',
  '@google-cloud/vertexai',
  '@aws-sdk/client-bedrock-runtime',
  '@aws-sdk/client-bedrock-agent-runtime',
  '@mistralai/',
  'cohere-ai',
  'groq-sdk',
  'ollama',
  'together-ai',
  'replicate',
  '@huggingface/inference',
  'ai',
  '@ai-sdk/',
  'langchain',
  '@langchain/',
  'llamaindex',
];

/** Every non-test module directly in `dir`: a new detector, fix or gate is fenced the day it lands. */
function modulesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(dir, f));
}

const ROOT_DIRS = [join(SRC, 'detect'), join(SRC, 'fix'), join(SRC, 'gates')];
const NAMED_ROOTS = [
  join(SRC, 'migrate', 'migrate.ts'),
  join(SRC, 'usage', 'scanLiterals.ts'),
  join(SRC, 'usage', 'scanRepo.ts'),
  join(SRC, 'python', 'fixPy.ts'),
];
// src/detect is the Stripe spec detector; cli.ts is its only importer, so nothing below
// would reach it unless it is a root of its own.
const FIX_GATE_ROOTS = [...ROOT_DIRS.flatMap(modulesIn), ...NAMED_ROOTS];

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isLlmSdk(specifier: string): boolean {
  const name = packageName(specifier);
  return LLM_SDK_PACKAGES.some((p) => (p.endsWith('/') ? name.startsWith(p) : name === p));
}

interface ImportRef {
  /** Undefined when the specifier is not a string literal and so cannot be followed. */
  specifier: string | undefined;
  line: number;
}

const parsed = new Map<string, ImportRef[]>();

/** Every module specifier a file names, read from its syntax tree (never from a regex). */
function importsOf(file: string): ImportRef[] {
  const cached = parsed.get(file);
  if (cached) return cached;
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: ImportRef[] = [];
  const add = (node: ts.Node, arg: ts.Node | undefined): void => {
    found.push({
      specifier: arg && ts.isStringLiteralLike(arg) ? arg.text : undefined,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // `import … from`, `import type … from`, `import '…'`, `export … from`.
      if (node.moduleSpecifier) add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      add(node, node.arguments[0]);
    } else if (ts.isImportTypeNode(node)) {
      // `import('…').T` in a type position.
      add(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  parsed.set(file, found);
  return found;
}

/** NodeNext resolution as this repo writes it: `./x.js` is the source file `./x.ts`. */
function resolveModule(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = /\.[cm]?js$/.test(base)
    ? [base.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts'), base]
    : [`${base}.ts`, join(base, 'index.ts'), base];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

interface Breach {
  /** Repo-relative path from an entry point to the offending module or package. */
  chain: string[];
  why: string;
}

/**
 * Breadth-first over relative imports from `roots`, so each reported chain is the shortest
 * one from some entry point. Test files are never entered.
 */
function findBreaches(
  roots: string[],
  clientModules: string[],
  base: string,
): { breaches: Breach[]; reached: Set<string> } {
  const rel = (f: string): string => relative(base, f).split(sep).join('/');
  const clients = new Set(clientModules.map((m) => resolve(m)));
  const parent = new Map<string, string | undefined>();
  const queue: string[] = [];
  for (const r of roots.map((x) => resolve(x))) {
    if (!parent.has(r)) {
      parent.set(r, undefined);
      queue.push(r);
    }
  }
  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    for (let f: string | undefined = file; f; f = parent.get(f)) chain.unshift(rel(f));
    return chain;
  };

  const breaches: Breach[] = [];
  for (let file = queue.shift(); file; file = queue.shift()) {
    if (clients.has(file)) {
      breaches.push({ chain: chainTo(file), why: 'reaches the LLM client module' });
      continue;
    }
    if (!/\.[cm]?[jt]s$/.test(file)) continue; // data (e.g. JSON) imports nothing
    for (const { specifier, line } of importsOf(file)) {
      const at = `${rel(file)}:${line}`;
      if (specifier === undefined) {
        breaches.push({ chain: chainTo(file), why: `${at} imports a non-literal specifier the fence cannot follow` });
      } else if (specifier.startsWith('.')) {
        const target = resolveModule(file, specifier);
        if (!target) {
          breaches.push({ chain: chainTo(file), why: `${at} imports '${specifier}', which resolves to no file` });
        } else if (!target.endsWith('.test.ts') && !parent.has(target)) {
          parent.set(target, file);
          queue.push(target);
        }
      } else if (isLlmSdk(specifier)) {
        breaches.push({ chain: [...chainTo(file), specifier], why: `${at} imports an LLM SDK` });
      }
    }
  }
  return { breaches, reached: new Set(parent.keys()) };
}

const show = (b: Breach): string => `${b.chain.join(' → ')}  (${b.why})`;

// Parsing most of src takes well under a second alone, but the full suite runs files in
// parallel and a synchronous walk can be starved past vitest's 5 s default.
const WALK_TIMEOUT = 60_000;

describe('invariant 2: nothing the fix/gate path reaches imports an LLM client', () => {
  it('every named entry point exists, so a rename cannot leave the fence guarding nothing', () => {
    expect(NAMED_ROOTS.filter((r) => !existsSync(r)).map((r) => relative(MENDR_ROOT, r))).toEqual([]);
    for (const dir of ROOT_DIRS) expect(modulesIn(dir).length).toBeGreaterThan(0);
  });

  it('the walk from src/detect, src/fix, src/gates, migrate, scanLiterals, scanRepo and fixPy reaches no LLM client', () => {
    const { breaches, reached } = findBreaches(FIX_GATE_ROOTS, LLM_CLIENT_MODULES, MENDR_ROOT);
    // It followed imports past the roots; an empty walk would pass vacuously.
    expect(reached.size).toBeGreaterThan(FIX_GATE_ROOTS.length);
    expect(breaches.map(show)).toEqual([]);
  }, WALK_TIMEOUT);
});

describe('the fence can fail', () => {
  it('finds the reader when rooted at cli.ts, which does import it', () => {
    const { breaches } = findBreaches([join(SRC, 'cli.ts')], LLM_CLIENT_MODULES, MENDR_ROOT);
    const toReader = breaches.filter((b) => b.why === 'reaches the LLM client module');
    expect(toReader.map((b) => b.chain)).toEqual([['src/cli.ts', 'src/registry/aiReader.ts']]);
  }, WALK_TIMEOUT);

  // A throwaway tree with one entry point per way an import can arrive.
  const fixture = mkdtempSync(join(tmpdir(), 'mendr-invariant2-'));
  afterAll(() => rmSync(fixture, { recursive: true, force: true }));
  const files: Record<string, string> = {
    'registry/aiReader.ts': 'export const readPage = 1;\nexport type ChatClient = () => void;\n',
    'lib/pure.ts': "import { readFileSync } from 'node:fs';\nexport const pure = readFileSync;\n",
    'lib/sdk.ts': "import OpenAI from 'openai';\nexport const sdk = OpenAI;\n",
    'lib/sideEffect.ts': "import '../registry/aiReader.js';\n",
    'fix/clean.ts': "import { pure } from '../lib/pure.js';\nexport const clean = pure;\n",
    'fix/viaSdk.ts': "import { sdk } from '../lib/sdk.js';\nexport const viaSdk = sdk;\n",
    'fix/viaReexport.ts': "export { readPage } from '../registry/aiReader.js';\n",
    'fix/viaTypeOnly.ts': "import type { ChatClient } from '../registry/aiReader.js';\nexport type T = ChatClient;\n",
    'fix/viaRequire.ts': "const m = require('../lib/sideEffect');\nexport const viaRequire = m;\n",
    'fix/viaDynamic.ts': "export const viaDynamic = () => import('@anthropic-ai/sdk');\n",
    'fix/viaImportType.ts': "export type R = import('@google/genai').GenerateContentResponse;\n",
    'fix/opaque.ts': 'export const opaque = (p: string) => import(p);\n',
    'fix/dangling.ts': "import { gone } from './gone.js';\nexport const dangling = gone;\n",
    'fix/ignored.test.ts': "import OpenAI from 'openai';\nexport const t = OpenAI;\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), text);
  }
  const fixtureClients = [join(fixture, 'registry', 'aiReader.ts')];
  const breachesFrom = (...roots: string[]): string[] =>
    findBreaches(roots.map((r) => join(fixture, r)), fixtureClients, fixture).breaches.map(show);

  it('passes a clean module', () => {
    expect(breachesFrom('fix/clean.ts')).toEqual([]);
  });

  it('names the chain for every way of reaching a client or an SDK', () => {
    expect(breachesFrom('fix/viaSdk.ts')).toEqual([
      'fix/viaSdk.ts → lib/sdk.ts → openai  (lib/sdk.ts:1 imports an LLM SDK)',
    ]);
    expect(breachesFrom('fix/viaReexport.ts')).toEqual([
      'fix/viaReexport.ts → registry/aiReader.ts  (reaches the LLM client module)',
    ]);
    expect(breachesFrom('fix/viaTypeOnly.ts')).toEqual([
      'fix/viaTypeOnly.ts → registry/aiReader.ts  (reaches the LLM client module)',
    ]);
    expect(breachesFrom('fix/viaRequire.ts')).toEqual([
      'fix/viaRequire.ts → lib/sideEffect.ts → registry/aiReader.ts  (reaches the LLM client module)',
    ]);
    expect(breachesFrom('fix/viaDynamic.ts')).toEqual([
      'fix/viaDynamic.ts → @anthropic-ai/sdk  (fix/viaDynamic.ts:1 imports an LLM SDK)',
    ]);
    expect(breachesFrom('fix/viaImportType.ts')).toEqual([
      'fix/viaImportType.ts → @google/genai  (fix/viaImportType.ts:1 imports an LLM SDK)',
    ]);
  });

  it('fails on an import it cannot follow rather than skipping it', () => {
    expect(breachesFrom('fix/opaque.ts')).toEqual([
      'fix/opaque.ts  (fix/opaque.ts:1 imports a non-literal specifier the fence cannot follow)',
    ]);
    expect(breachesFrom('fix/dangling.ts')).toEqual([
      "fix/dangling.ts  (fix/dangling.ts:1 imports './gone.js', which resolves to no file)",
    ]);
  });

  it('roots a directory at its non-test modules only', () => {
    const roots = modulesIn(join(fixture, 'fix')).map((f) => relative(fixture, f).split(sep).join('/'));
    expect(roots).not.toContain('fix/ignored.test.ts');
    expect(roots).toContain('fix/clean.ts');
  });
});
