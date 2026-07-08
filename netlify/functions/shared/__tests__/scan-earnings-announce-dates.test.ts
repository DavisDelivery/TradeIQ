// Wave 2C (CR-3) — earnings-board reaction windows must anchor on the
// ANNOUNCEMENT date, not the fiscal period end.
//
// Pre-fix, scoreEarningsForTicker windowed the T-1→T+1 "earnings reaction"
// around `h.date` = Finnhub's `period` (quarter end), which lags the print
// by 2-8 weeks — priorMoves/avgPriorMove/moveRatio and the post-print
// PEAD/reversal classification all measured random 2-day moves ~a month
// from the actual print.
//
// Fixture geometry: price is flat at 100 everywhere EXCEPT a +10% step
// inside the bar window the scan matches around the announcement date.
// Around the period end the series is flat, so a period-anchored window
// reads ~0% — the assertions below only hold when the announcement date
// is the anchor.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../data-provider', () => ({
  getEarningsCalendarRange: vi.fn(),
  // FIX-1 W1 — the scan resolves its universe through the status-aware
  // variant; keep this mock delegating to the legacy mock's value so
  // the existing mockResolvedValue([...]) setups keep working.
  getEarningsCalendarRangeWithStatus: vi.fn(),
  getDailyBars: vi.fn(),
  getEarningsHistory: vi.fn(),
  getUpcomingEarnings: vi.fn(),
}));

import { runEarningsScan } from '../scan-earnings';
import {
  getEarningsCalendarRange, getEarningsCalendarRangeWithStatus,
  getDailyBars, getEarningsHistory, getUpcomingEarnings,
} from '../data-provider';

const DAY = 86400000;

/** Daily calendar bars from `from` to `to` inclusive (00:00Z stamps). */
function makeBars(
  from: string,
  to: string,
  closeAt: (iso: string) => number,
  volumeAt: (iso: string) => number = () => 1_000_000,
) {
  const bars: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const c = closeAt(iso);
    bars.push({ t, o: c, h: c, l: c, c, v: volumeAt(iso) });
  }
  return bars;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-11T00:00:00Z'));
  (getUpcomingEarnings as any).mockResolvedValue(null);
  // FIX-1 W1 — the scan resolves its universe through the status-aware
  // calendar variant; delegate it to the legacy mock so the per-test
  // mockResolvedValue([...]) setups keep driving the universe.
  (getEarningsCalendarRangeWithStatus as any).mockImplementation(async (...args: unknown[]) => {
    const entries = await (getEarningsCalendarRange as any)(...args);
    return { entries: entries ?? [], ok: true, httpStatus: 200, rateLimitExhausted: false };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scoreEarningsForTicker — reaction windows anchor on announceDate', () => {
  it('measures avgPriorMove around the announcement, skipping rows with unknown announceDate', async () => {
    // Upcoming print 9 days out → pre-print path.
    (getEarningsCalendarRange as any).mockResolvedValue([
      { ticker: 'AAPL', date: '2026-06-20', hour: 'amc' },
    ]);
    // Q1 period ended 2026-03-31; the print hit ~4 weeks later. The +10%
    // step sits inside the bar window matched around 2026-04-29 — around
    // the period end the series is flat.
    (getEarningsHistory as any).mockResolvedValue([
      { period: '2026-03-31', announceDate: '2026-04-29', epsActual: 1.1, epsEstimate: 1.0, surprisePct: 10 },
      // Older rows with UNRESOLVED announcements: must be skipped, not
      // windowed on period-end (their period neighborhoods are flat, so
      // including them would drag avgPriorMove below 10).
      { period: '2025-12-31', announceDate: null, epsActual: 1.0, epsEstimate: 0.95, surprisePct: 5 },
      { period: '2025-09-30', announceDate: null, epsActual: 0.9, epsEstimate: 0.92, surprisePct: -2 },
    ]);
    (getDailyBars as any).mockResolvedValue(makeBars('2026-02-15', '2026-06-10', (iso) => {
      if (iso <= '2026-04-26') return 100;
      if (iso === '2026-04-27') return 105;
      return 110;
    }));

    const out = await runEarningsScan({ windowDays: 30, postPrintLookbackDays: 0, scanBudgetMs: 10_000 });
    expect(out.setups).toHaveLength(1);
    const setup = out.setups[0];
    // The fix threads withAnnounceDates so the provider performs the join.
    expect((getEarningsHistory as any).mock.calls[0][2]).toMatchObject({ withAnnounceDates: true });
    // Exactly the announcement-window move; a period-anchored window reads
    // 0%, and the two null-announceDate rows would dilute the average.
    expect(setup.avgPriorMove).toBeCloseTo(10, 1);
  });

  it('classifies post-print PEAD off the announcement-window reaction', async () => {
    // Printed 3 days ago (calendar date 2026-06-08), beat by 8%, +8% bar
    // window around the announcement on doubled volume → pead_long.
    (getEarningsCalendarRange as any).mockResolvedValue([
      { ticker: 'AAPL', date: '2026-06-08', hour: 'amc' },
    ]);
    (getEarningsHistory as any).mockResolvedValue([
      { period: '2026-03-31', announceDate: '2026-06-08', epsActual: 1.08, epsEstimate: 1.0, surprisePct: 8 },
    ]);
    (getDailyBars as any).mockResolvedValue(makeBars(
      '2026-02-15', '2026-06-10',
      (iso) => (iso <= '2026-06-05' ? 100 : iso === '2026-06-06' ? 104 : 108),
      (iso) => (iso >= '2026-06-06' ? 3_000_000 : 1_000_000),
    ));

    const out = await runEarningsScan({ windowDays: 30, postPrintLookbackDays: 5, scanBudgetMs: 10_000 });
    expect(out.setups).toHaveLength(1);
    expect(out.setups[0].postPrint).toBe(true);
    expect(out.setups[0].playType).toBe('pead_long');
  });

  it('skips post-print classification entirely when the latest announcement date is unknown', async () => {
    // Identical beat + volume + price tape as the PEAD case, but the
    // announcement date failed to resolve: the scan must NOT fall back to
    // windowing on period-end — no lastMove, no PEAD/reversal call.
    (getEarningsCalendarRange as any).mockResolvedValue([
      { ticker: 'AAPL', date: '2026-06-08', hour: 'amc' },
    ]);
    (getEarningsHistory as any).mockResolvedValue([
      { period: '2026-03-31', announceDate: null, epsActual: 1.08, epsEstimate: 1.0, surprisePct: 8 },
    ]);
    (getDailyBars as any).mockResolvedValue(makeBars(
      '2026-02-15', '2026-06-10',
      (iso) => (iso <= '2026-06-05' ? 100 : iso === '2026-06-06' ? 104 : 108),
      (iso) => (iso >= '2026-06-06' ? 3_000_000 : 1_000_000),
    ));

    const out = await runEarningsScan({ windowDays: 30, postPrintLookbackDays: 5, scanBudgetMs: 10_000 });
    expect(out.setups).toHaveLength(1);
    expect(out.setups[0].playType).toBe('skip');
    expect(out.setups[0].avgPriorMove).toBeNull();
  });
});
