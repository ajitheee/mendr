import { describe, expect, it } from 'vitest';
import { recoveryPlan } from './recovery.js';

// Synthetic schedule only: never claims an observed provider outage or parity.
const swap = { from: 'o4-mini', to: 'gpt-5.6-terra', shutdownDate: '2026-10-23' };
describe('recovery schedule evidence', () => {
  it('does not make an unknown deadline a safe revert, including mixed swaps', () => {
    for (const swaps of [[], [{ ...swap, shutdownDate: null }], [swap, { ...swap, from: 'unknown', shutdownDate: null }]]) {
      const r = recoveryPlan(swaps, new Date('2026-10-22T00:00:00Z'));
      expect(r.options[0].available).toBe(false);
      expect(r.options[0].detail).toMatch(/not established|not proven|unknown/i);
    }
  });
  it('closes the scheduled window on the UTC date without inventing observed failure', () => {
    for (const now of ['2026-10-23T00:00:00Z', '2026-10-24T00:00:00Z', '2026-10-22T23:30:00-12:00']) {
      const r = recoveryPlan([swap], new Date(now));
      expect(r.options[0].available).toBe(false);
      expect(r.options[0].detail).toContain('announced');
      expect(r.options[0].detail).not.toMatch(/shut down on|no longer answers|no longer exists/);
    }
  });
  it('describes a pre-deadline option as schedule-only and records unobserved access', () => {
    for (const now of ['2026-10-22T23:59:59Z', '2026-10-23T00:30:00+14:00']) {
      const r = recoveryPlan([swap], new Date(now));
      expect(r.options[0].available).toBe(true);
      expect(r.options[0].detail).toContain('announced');
      expect(r.caveats.join(' ')).toMatch(/accessibility.*not observed/i);
      expect(r.caveats.join(' ')).toMatch(/quality.*not/i);
    }
  });
});
