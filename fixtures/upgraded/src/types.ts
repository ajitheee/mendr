import type Stripe from 'stripe';

/**
 * DemoCharge mirrors a Stripe Charge for this fixture — at state t1 (post-SDK
 * upgrade).
 *
 * The upgraded SDK renamed the cardholder field: `card.name` is GONE and the
 * value now lives under `card.cardholder_name`. This interface reflects the NEW
 * shape. The rest of the source tree, however, has NOT been migrated yet — it
 * still reads `charge.card.name`, which no longer exists here. That mismatch is
 * a real, pre-existing type error (the whole reason Mendr runs), and it is
 * exactly what the rename codemod fixes.
 */
export interface DemoCharge extends Stripe.Charge {
  card: {
    cardholder_name: string | null;
    last4: string;
  };
}
