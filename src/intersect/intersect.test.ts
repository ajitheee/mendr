import { describe, it, expect } from 'vitest';
import { intersect } from './intersect.js';
import type { ChangeSet, SourceLocation, UsageMap } from '../types.js';

const loc = (file: string, line: number, column = 1): SourceLocation => ({ file, line, column });

describe('intersect', () => {
  it('includes a change whose path IS in the usage map, with the right locations', () => {
    const changes: ChangeSet = [{ kind: 'field_removed', path: 'DemoCharge.description' }];
    const usage: UsageMap = { 'DemoCharge.description': [loc('receipt.ts', 12)] };

    const sites = intersect(changes, usage);

    expect(sites).toHaveLength(1);
    expect(sites[0].change).toBe(changes[0]);
    expect(sites[0].locations).toEqual([loc('receipt.ts', 12)]);
  });

  it('EXCLUDES a change whose path is NOT in the usage map (noise-killer guard)', () => {
    const changes: ChangeSet = [{ kind: 'field_removed', path: 'DemoCharge.receipt_url' }];
    const usage: UsageMap = { 'DemoCharge.description': [loc('receipt.ts', 12)] };

    // A change to a field the repo never reads must produce nothing.
    expect(intersect(changes, usage)).toEqual([]);
  });

  it('matches a field_rename on the OLD path (change.path), not the new name', () => {
    const changes: ChangeSet = [
      { kind: 'field_rename', path: 'DemoCharge.card.name', from: 'name', to: 'cardholder_name' },
    ];
    const usage: UsageMap = {
      'DemoCharge.card.name': [loc('receipt.ts', 8), loc('fraud.ts', 9)],
      // The NEW name is not yet in the repo, so it must never be matched.
      'DemoCharge.card.cardholder_name': [loc('other.ts', 3)],
    };

    const sites = intersect(changes, usage);

    expect(sites).toHaveLength(1);
    expect(sites[0].locations).toEqual([loc('receipt.ts', 8), loc('fraud.ts', 9)]);
  });

  it('normalizes a leading Stripe. root prefix on the change side', () => {
    const changes: ChangeSet = [{ kind: 'field_removed', path: 'Stripe.Charge.card.name' }];
    const usage: UsageMap = { 'Charge.card.name': [loc('a.ts', 1)] };

    expect(intersect(changes, usage)).toHaveLength(1);
  });

  it('normalizes a leading Stripe. root prefix on the usage side (vice-versa)', () => {
    const changes: ChangeSet = [{ kind: 'field_removed', path: 'Charge.card.name' }];
    const usage: UsageMap = { 'Stripe.Charge.card.name': [loc('a.ts', 1)] };

    expect(intersect(changes, usage)).toHaveLength(1);
  });

  it('de-duplicates locations merged from Stripe-prefixed and bare keys', () => {
    const changes: ChangeSet = [{ kind: 'field_removed', path: 'Charge.x' }];
    const usage: UsageMap = {
      'Charge.x': [loc('a.ts', 1)],
      'Stripe.Charge.x': [loc('a.ts', 1), loc('b.ts', 2)],
    };

    const sites = intersect(changes, usage);

    expect(sites).toHaveLength(1);
    expect(sites[0].locations).toEqual([loc('a.ts', 1), loc('b.ts', 2)]);
  });
});
