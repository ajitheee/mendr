// Hermetic Phase 2 fixture.
//
// This uses a LOCAL `DemoCharge` interface rather than the real `stripe`
// package so the type-based resolver can be exercised without depending on the
// installed Stripe types (whose `Charge` may not expose `charge.card` directly).
// The resolver keys accesses by the *type* name, so the reads below become
// `DemoCharge.card.name`, `DemoCharge.card.last4`, `DemoCharge.amount`,
// `DemoCharge.status` — proving resolution comes from the TYPE, not the variable
// name `charge`.

interface DemoCharge {
  card: { name: string | null; last4: string };
  amount: number;
  status: string;
}

export function describeCharge(charge: DemoCharge): string {
  const holder = charge.card.name ?? 'unknown'; // -> DemoCharge.card.name
  const tail = charge.card.last4; // -> DemoCharge.card.last4
  const cents = charge.amount; // -> DemoCharge.amount
  return `${holder} (${tail}) ${cents} ${charge.status}`; // -> DemoCharge.status
}

export function isPaid(charge: DemoCharge): boolean {
  return charge.status === 'succeeded'; // -> DemoCharge.status
}

// False-positive guard: `raw` is typed `any`, so NONE of these accesses may be
// recorded. Accuracy over recall — the resolver must skip `any` bases.
export function sloppy(raw: any): unknown {
  return raw.card.name + raw.amount; // must NOT appear in the usage map
}
