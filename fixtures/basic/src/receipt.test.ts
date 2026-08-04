import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DemoCharge } from './types.js';
import { buildReceipt } from './receipt.js';
import { isSuspicious } from './fraud.js';

// Minimal DemoCharge stub. We only populate the fields the helpers read;
// the rest of Stripe.Charge is irrelevant to this test, so we cast.
const sampleCharge = {
  id: 'ch_test_123',
  amount: 4200,
  description: 'Dinner for two',
  status: 'succeeded',
  card: { name: 'Ada Lovelace', last4: '4242' },
} as unknown as DemoCharge;

test('buildReceipt reads card.name, amount and description', () => {
  const receipt = buildReceipt(sampleCharge);
  assert.match(receipt, /Ada Lovelace/);
  assert.match(receipt, /\$42\.00/);
  assert.match(receipt, /Dinner for two/);
});

test('isSuspicious clears a normal succeeded charge', () => {
  assert.equal(isSuspicious(sampleCharge), false);
});
