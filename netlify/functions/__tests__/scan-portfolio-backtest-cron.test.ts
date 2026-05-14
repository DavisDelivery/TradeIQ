// Phase 4e-1 follow-up — cron window-cycle test.
//
// Verifies the deterministic window picker covers all 13 windows and
// rotates through them as day-of-year advances.

import { describe, expect, it } from 'vitest';
import { _internals } from '../scan-portfolio-backtest-cron';

const { WINDOW_CYCLE, pickWindow } = _internals;

describe('pickWindow', () => {
  it('cycles through all 13 windows over consecutive days', () => {
    const start = new Date(Date.UTC(2026, 5, 1)); // June 1, 2026
    const seen = new Set<string>();
    for (let i = 0; i < WINDOW_CYCLE.length; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      seen.add(pickWindow(d));
    }
    expect(seen.size).toBe(WINDOW_CYCLE.length);
    for (const w of WINDOW_CYCLE) expect(seen.has(w)).toBe(true);
  });

  it('repeats deterministically after a full cycle', () => {
    const start = new Date(Date.UTC(2026, 5, 1));
    const a = pickWindow(start);
    const b = pickWindow(new Date(start.getTime() + WINDOW_CYCLE.length * 86_400_000));
    expect(a).toBe(b);
  });

  it('places the shortest windows first so they finish quickest', () => {
    expect(WINDOW_CYCLE[0]).toBe('covid');
    expect(WINDOW_CYCLE[1]).toBe('rate-hikes');
    // Full window is at the end (most likely to hit the 15-min cap).
    expect(WINDOW_CYCLE[WINDOW_CYCLE.length - 1]).toBe('full');
  });
});
