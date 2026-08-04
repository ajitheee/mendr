import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadSpec } from './fetchSpec.js';
import { diffSpecs } from './diffSpec.js';
import type { ApiChange } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const specPath = (name: string) => resolve(here, '../../specs', name);

async function loadFixtures() {
  const [a, b] = await Promise.all([
    loadSpec(specPath('stripe-vA.json')),
    loadSpec(specPath('stripe-vB.json')),
  ]);
  return { a, b };
}

function find(changes: ApiChange[], kind: ApiChange['kind']): ApiChange[] {
  return changes.filter((c) => c.kind === kind);
}

describe('diffSpecs', () => {
  it('detects a field rename inside a nested object (card.name -> cardholder_name)', async () => {
    const { a, b } = await loadFixtures();
    const changes = diffSpecs(a, b);
    const renames = find(changes, 'field_rename');
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({
      kind: 'field_rename',
      path: 'Charge.card.name',
      from: 'name',
      to: 'cardholder_name',
    });
    // The rename must NOT also surface as a field_removed.
    expect(find(changes, 'field_removed').some((c) => c.path === 'Charge.card.name')).toBe(false);
  });

  it('detects a type change (string -> number)', async () => {
    const { a, b } = await loadFixtures();
    const changes = diffSpecs(a, b);
    const typeChanges = find(changes, 'type_change');
    expect(typeChanges).toContainEqual({
      kind: 'type_change',
      path: 'Charge.amount_display',
      from: 'string',
      to: 'number',
    });
  });

  it('detects a removed field with nothing added in its place', async () => {
    const { a, b } = await loadFixtures();
    const changes = diffSpecs(a, b);
    const removed = find(changes, 'field_removed');
    expect(removed).toContainEqual({
      kind: 'field_removed',
      path: 'Charge.description',
    });
  });

  it('detects an enum value change', async () => {
    const { a, b } = await loadFixtures();
    const changes = diffSpecs(a, b);
    const enumChanges = find(changes, 'enum_value_change');
    expect(enumChanges).toHaveLength(1);
    expect(enumChanges[0]).toMatchObject({
      kind: 'enum_value_change',
      path: 'Charge.status',
    });
    expect(enumChanges[0].from).toContain('failed');
    expect(enumChanges[0].to).toContain('canceled');
  });

  it('yields an empty ChangeSet when diffing a spec against itself (no false positives)', async () => {
    const { a } = await loadFixtures();
    expect(diffSpecs(a, a)).toEqual([]);
  });
});
