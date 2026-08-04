import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DemoCharge } from './types.js';
import { buildReceipt } from './receipt.js';
import { isSuspicious } from './fraud.js';

// Minimal DemoCharge stub for state t1. The card object uses the NEW field name
// `cardholder_name` (this is the upgraded shape). This literal is NOT a property
// access, so Mendr never rewrites it — it must already carry the new field so
// that the PATCHED helpers (which read `charge.card.cardholder_name`) find the
// value and the assertions below hold.
const sampleCharge = {
  id: 'ch_test_123',
  amount: 4200,
  description: 'Dinner for two',
  status: 'succeeded',
  card: { cardholder_name: 'Ada Lovelace', last4: '4242' },
} as unknown as DemoCharge;

test('buildReceipt reads the cardholder name, amount and description', () => {
  const receipt = buildReceipt(sampleCharge);
  assert.match(receipt, /Ada Lovelace/);
  assert.match(receipt, /\$42\.00/);
  assert.match(receipt, /Dinner for two/);
});

test('isSuspicious clears a normal succeeded charge', () => {
  assert.equal(isSuspicious(sampleCharge), false);
});
