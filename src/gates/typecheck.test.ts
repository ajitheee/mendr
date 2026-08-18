import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { checkTypes } from './typecheck.js';

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
