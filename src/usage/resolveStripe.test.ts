import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadProject } from './scanRepo.js';
import { buildUsageMap } from './usageMap.js';
import type { UsageMap } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '__fixtures__/sample');
const chargesPath = resolve(fixtureDir, 'charges.ts');

/** 1-based line of the first source line containing `needle`. */
function lineOf(needle: string): number {
  const lines = readFileSync(chargesPath, 'utf8').split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`fixture line not found: ${needle}`);
  return idx + 1;
}

function build(): UsageMap {
  return buildUsageMap(loadProject(fixtureDir));
}

describe('buildUsageMap (type-based Stripe resolution)', () => {
  it('keys nested reads by the TYPE name, not the variable name', () => {
    const map = build();

    // `charge.card.name` where `charge: DemoCharge` -> `DemoCharge.card.name`.
    const nameSites = map['DemoCharge.card.name'];
    expect(nameSites).toBeDefined();
    expect(nameSites).toHaveLength(1);
    expect(nameSites[0].file.replace(/\\/g, '/')).toContain('__fixtures__/sample/charges.ts');
    expect(nameSites[0].line).toBe(lineOf('charge.card.name'));

    // The other leaf fields are present too.
    expect(map['DemoCharge.card.last4']).toBeDefined();
    expect(map['DemoCharge.amount']).toBeDefined();

    // `status` is read from two sites (describeCharge + isPaid).
    expect(map['DemoCharge.status']).toHaveLength(2);

    // Intermediate chain segment is recorded so intersection works at any depth.
    expect(map['DemoCharge.card']).toBeDefined();
  });

  it('does NOT record accesses through an `any`-typed base (false-positive guard)', () => {
    const map = build();
    const anyLine = lineOf('raw.card.name');

    // Every recorded key must be rooted in the resolved type name.
    for (const key of Object.keys(map)) {
      expect(key.startsWith('DemoCharge')).toBe(true);
    }

    // No location anywhere may point at the `any`-typed access line.
    const allLocations = Object.values(map).flat();
    expect(allLocations.some((loc) => loc.line === anyLine)).toBe(false);
  });
});
