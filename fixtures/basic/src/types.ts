import type Stripe from 'stripe';

/**
 * DemoCharge mirrors a Stripe Charge for this fixture.
 *
 * The official `Stripe.Charge` type no longer exposes a top-level `card`
 * property (legacy card details now live under `payment_method_details.card`).
 * To keep the product's demo field `charge.card.name` statically typed -- so a
 * scanner can resolve it -- we extend the real `Stripe.Charge` with a small,
 * explicit `card` shape. Every other field we read (amount, description,
 * status, ...) still comes from the genuine `Stripe.Charge` type.
 */
export interface DemoCharge extends Stripe.Charge {
  card: {
    name: string | null;
    last4: string;
  };
}
