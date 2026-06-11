// Wave 3B (track-3 M4) — markDates must be TRADING days.
//
// Pre-fix the production worker's makeWindow stepped markDates by
// calendar day (so ~30% of "daily returns" feeding the √252 Sharpe were
// structural weekend/holiday zeros — Sharpe understated ≈17%) and
// rebalances by 7 calendar days (drifting on/off weekends/holidays,
// which combined with the strict rebalance/mark equality of track-2 M6
// silently disabled later rebalances).
//
// makeTradingDayWindow is the shared replacement: marks from the NYSE
// trading calendar (shared/backtest/trading-calendar.ts — NOT the
// divergent shared/us-market-holidays.ts), rebalances every 5th trading
// day drawn from the SAME series.

import { describe, expect, it } from 'vitest';
import {
  makeTradingDayWindow,
  REBALANCE_EVERY_TRADING_DAYS,
} from '../backtest-harness';
import { isMarketOpen } from '../../backtest/trading-calendar';

describe('makeTradingDayWindow', () => {
  it('emits only trading days as markDates (no weekends, no holidays)', () => {
    const win = makeTradingDayWindow('rolling-2024', '2024-01-01', '2025-01-01');
    expect(win.markDates.length).toBeGreaterThan(240); // ~252 trading days
    expect(win.markDates.length).toBeLessThan(260);
    for (const d of win.markDates) {
      expect(isMarketOpen(d), `${d} should be a trading day`).toBe(true);
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      expect(dow).toBeGreaterThan(0);
      expect(dow).toBeLessThan(6);
    }
    // Named closures excluded; adjacent trading days included.
    expect(win.markDates).not.toContain('2024-01-01'); // New Year's Day
    expect(win.markDates).not.toContain('2024-01-15'); // MLK Day
    expect(win.markDates).not.toContain('2024-03-29'); // Good Friday
    expect(win.markDates).toContain('2024-01-02');
    expect(win.markDates).toContain('2024-01-16');
  });

  it('uses the backtest trading calendar (2025-01-09 Carter closure excluded)', () => {
    // The divergence the review flagged: us-market-holidays.ts is
    // MISSING 2025-01-09; trading-calendar.ts has it. Backtest windows
    // must exclude it.
    const win = makeTradingDayWindow('rolling-2025', '2025-01-01', '2026-01-01');
    expect(win.markDates).not.toContain('2025-01-09');
    expect(win.markDates).toContain('2025-01-08');
    expect(win.markDates).toContain('2025-01-10');
  });

  it('draws rebalanceDates from the SAME trading-day series, every 5th trading day', () => {
    const win = makeTradingDayWindow('half-2022', '2022-01-01', '2026-01-01');
    const markSet = new Set(win.markDates);
    for (const r of win.rebalanceDates) {
      expect(markSet.has(r), `rebalance date ${r} must be a mark date`).toBe(true);
    }
    for (let i = 0; i < win.rebalanceDates.length; i++) {
      expect(win.rebalanceDates[i]).toBe(
        win.markDates[i * REBALANCE_EVERY_TRADING_DAYS],
      );
    }
    // ≈ weekly cadence: ceil(marks / 5) rebalances.
    expect(win.rebalanceDates.length).toBe(
      Math.ceil(win.markDates.length / REBALANCE_EVERY_TRADING_DAYS),
    );
  });

  it('first mark/rebalance is the first trading day on or after the window start', () => {
    // 2022-01-01 is a Saturday; first trading day is Mon 2022-01-03
    // (no MLK-style observance for Jan 1 2022 per NYSE).
    const win = makeTradingDayWindow('w', '2022-01-01', '2022-02-01');
    expect(win.markDates[0]).toBe('2022-01-03');
    expect(win.rebalanceDates[0]).toBe('2022-01-03');
  });
});
