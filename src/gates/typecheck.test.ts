import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { checkTypes, unresolvedScopeNote } from './typecheck.js';

// Hermetic tests for the BASELINE-RELATIVE type-check gate. Everything is built
// in-memory from source strings; no on-disk fixture or installed types needed.
//
// The key property under test is that the gate compares AFTER vs BEFORE and
// only reacts to diagnostics the patch INTRODUCES — a repo that was already
// broken elsewhere must not sink an otherwise-clean patch.

/** A tiny two-project pair sharing compiler options, built from source pairs. */
function projectFrom(fileName: string, source: string): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, target: 99 /* ESNext */ },
  });
  project.createSourceFile(fileName, source);
  return project;
}

// Each test runs full program diagnostics on TWO in-memory projects, which can
// take several seconds on a loaded machine — give them a realistic budget.
describe('checkTypes (baseline-relative type-check gate)', { timeout: 60_000 }, () => {
  it('passes when the patched code is valid (the migrated field exists)', () => {
    // baseline: reads the OLD name and the type has cardholder_name -> broken.
    const baseline = projectFrom(
      'src/a.ts',
      `interface Card { cardholder_name: string; }
       export const f = (c: Card) => c.name;`,
    );
    // patched: reads the NEW field -> valid.
    const patched = projectFrom(
      'src/a.ts',
      `interface Card { cardholder_name: string; }
       export const f = (c: Card) => c.cardholder_name;`,
    );

    const result = checkTypes(baseline, patched);
    expect(result.passed).toBe(true);
    expect(result.newDiagnostics).toHaveLength(0);
  });

  it('fails when the patch introduces a NEW type error', () => {
    // baseline: valid (field `name` exists).
    const baseline = projectFrom(
      'src/a.ts',
      `interface Card { name: string; }
       export const f = (c: Card) => c.name;`,
    );
    // patched: reads cardholder_name, which is NOT on this (t0) type -> new error.
    const patched = projectFrom(
      'src/a.ts',
      `interface Card { name: string; }
       export const f = (c: Card) => c.cardholder_name;`,
    );

    const result = checkTypes(baseline, patched);
    expect(result.passed).toBe(false);
    expect(result.newDiagnostics.length).toBeGreaterThan(0);
    expect(result.newDiagnostics[0].code).toBe(2339); // "Property does not exist"
    expect(result.newDiagnostics[0].message).toContain('cardholder_name');
  });

  it('is baseline-relative: a PRE-EXISTING error the patch does not touch still passes', () => {
    // Both baseline and patched carry the SAME unrelated pre-existing error
    // (a string assigned to a number). The patch legitimately fixes a DIFFERENT
    // line, introducing nothing new -> the gate must pass.
    const preExisting = `const broken: number = 'not a number';\n`;
    const baseline = projectFrom(
      'src/a.ts',
      `${preExisting}interface Card { cardholder_name: string; }
       export const f = (c: Card) => c.name;`,
    );
    const patched = projectFrom(
      'src/a.ts',
      `${preExisting}interface Card { cardholder_name: string; }
       export const f = (c: Card) => c.cardholder_name;`,
    );

    // Sanity: the baseline really does have the pre-existing error.
    expect(baseline.getPreEmitDiagnostics().length).toBeGreaterThan(0);

    const result = checkTypes(baseline, patched);
    expect(result.passed).toBe(true);
    expect(result.newDiagnostics).toHaveLength(0);
  });
});

// WHAT THE GATE COULD NOT SEE. `fix-llm <url>` shallow-clones and installs
// nothing, so the SDK whose types would reject a bad model id is unresolved
// and the argument it guards is `any`. The gate then passes because nothing
// could fail it — and printed a bare "passed", which a reader takes to mean
// "the SDK accepts this id". The packages are now named beside the pass.
describe('unresolved packages are reported as scope, not as failure', { timeout: 60_000 }, () => {
  const withImports = (body: string) =>
    projectFrom(
      'src/a.ts',
      `import OpenAI from 'openai';\nimport { encoding_for_model } from 'tiktoken';\n${body}`,
    );

  it('collects the packages the baseline could not resolve', () => {
    const result = checkTypes(withImports('export const A = 1;'), withImports('export const A = 2;'));

    expect(result.passed).toBe(true);
    expect(result.unresolvedModules).toEqual(['openai', 'tiktoken']);
    expect(unresolvedScopeNote(result)).toContain('2 packages not installed in this checkout');
    expect(unresolvedScopeNote(result)).toContain('their types were not checked');
  });

  it('reports a deep import as its package, once', () => {
    const deep = (n: number) =>
      projectFrom(
        'src/a.ts',
        `import type { X } from 'openai/resources/chat';\nimport OpenAI from 'openai';\nexport const A = ${n};`,
      );
    expect(checkTypes(deep(1), deep(2)).unresolvedModules).toEqual(['openai']);

    const scoped = (n: number) =>
      projectFrom(
        'src/a.ts',
        `import { Anthropic } from '@anthropic-ai/sdk/client';\nexport const A = ${n};`,
      );
    expect(checkTypes(scoped(1), scoped(2)).unresolvedModules).toEqual(['@anthropic-ai/sdk']);
  });

  it('does not call a repo\u2019s own broken relative import a missing package', () => {
    const relative = (n: number) =>
      projectFrom('src/a.ts', `import { gone } from './gone.js';\nexport const A = ${n} + gone;`);
    const result = checkTypes(relative(1), relative(2));

    expect(result.unresolvedModules).toEqual([]);
    expect(unresolvedScopeNote(result)).toBeUndefined();
  });

  it('says nothing when every package resolved', () => {
    const clean = (n: number) => projectFrom('src/a.ts', `export const A = ${n};`);
    const result = checkTypes(clean(1), clean(2));

    expect(result.unresolvedModules).toEqual([]);
    expect(unresolvedScopeNote(result)).toBeUndefined();
  });
});
