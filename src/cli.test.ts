import { describe, it, expect } from 'vitest';
import type { ApiChange, Tier } from './types.js';

describe('mendr scaffold smoke test', () => {
  it('exposes the core types', () => {
    const change: ApiChange = { kind: 'field_rename', path: 'customer.name', from: 'name', to: 'full_name' };
    const tier: Tier = 'A';
    expect(change).toBeDefined();
    expect(change.kind).toBe('field_rename');
    expect(tier).toBe('A');
  });
});
