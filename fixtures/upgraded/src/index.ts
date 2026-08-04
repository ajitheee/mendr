import Stripe from 'stripe';
import type { DemoCharge } from './types.js';
import { buildReceipt } from './receipt.js';
import { isSuspicious } from './fraud.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder');

/**
 * Retrieve a charge and run it through the receipt + fraud helpers.
 * The API call only needs to typecheck for this fixture; it is not meant to
 * run against the real Stripe API.
 */
export async function processCharge(chargeId: string): Promise<string> {
  const charge = (await stripe.charges.retrieve(chargeId)) as unknown as DemoCharge;

  if (isSuspicious(charge)) {
    return `Charge ${charge.id} flagged as suspicious (status: ${charge.status})`;
  }

  return buildReceipt(charge);
}
