import type { DemoCharge } from './types.js';

/**
 * Build a human-readable receipt string from a charge.
 * Reads charge.card.name (the key demo field), charge.amount and
 * charge.description.
 */
export function buildReceipt(charge: DemoCharge): string {
  const cardholder = charge.card.name ?? 'Unknown cardholder';
  const dollars = (charge.amount / 100).toFixed(2);
  const description = charge.description ?? 'No description';

  return [
    `Receipt for ${cardholder}`,
    `Amount: $${dollars}`,
    `Description: ${description}`,
  ].join('\n');
}
