import type { DemoCharge } from './types.js';

/**
 * Very small heuristic fraud check.
 * Reads charge.card.name (the key demo field), charge.status and
 * charge.card.last4.
 */
export function isSuspicious(charge: DemoCharge): boolean {
  const cardholder = charge.card.name;

  // A missing cardholder name on a non-succeeded charge is a red flag.
  if (!cardholder && charge.status !== 'succeeded') {
    return true;
  }

  // Obvious test card used against a live-looking charge.
  if (charge.card.last4 === '0000') {
    return true;
  }

  return false;
}
