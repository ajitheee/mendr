import type { DemoCharge } from './types.js';

/**
 * Build a human-readable receipt string from a charge.
 *
 * NOTE (state t1): this reads `charge.card.name`, the OLD field name. After the
 * SDK upgrade that field is `cardholder_name`, so this line does NOT type-check
 * until Mendr migrates it.
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
