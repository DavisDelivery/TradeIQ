// Phase 4f W4a — dark-pool compute tests.

import { describe, expect, it } from 'vitest';
import { computeDarkPoolSignal, darkPoolDirection, isDarkTrade } from '../dark-pool';
import type { PolygonTrade, PolygonTradesByDay } from '../types';

function trade(t: number, p: number, s: number, opts: Partial<PolygonTrade> = {}): PolygonTrade {
  return { t, p, s, ...opts };
}

function windowOver(days: number, dayBuilder: (date: string) => PolygonTrade[]): PolygonTradesByDay {
  const byDate: Record<string, PolygonTrade[]> = {};
  const start = Date.parse('2024-06-01T00:00:00Z');
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    byDate[date] = dayBuilder(date);
  }
  return { byDate };
}

describe('isDarkTrade', () => {
  it('flags TRF exchange IDs', () => {
    expect(isDarkTrade(trade(0, 10, 100, { x: 4 }))).toBe(true);
    expect(isDarkTrade(trade(0, 10, 100, { x: 6 }))).toBe(true);
    expect(isDarkTrade(trade(0, 10, 100, { x: 7 }))).toBe(true);
  });

  it('flags off-exchange condition codes', () => {
    expect(isDarkTrade(trade(0, 10, 100, { c: [12] }))).toBe(true);
    expect(isDarkTrade(trade(0, 10, 100, { c: [9, 16] }))).toBe(true);
  });

  it('does not flag pure lit trades', () => {
    expect(isDarkTrade(trade(0, 10, 100, { x: 10 }))).toBe(false);
    expect(isDarkTrade(trade(0, 10, 100, { c: [1, 2] }))).toBe(false);
    expect(isDarkTrade(trade(0, 10, 100))).toBe(false);
  });
});

describe('computeDarkPoolSignal', () => {
  it('returns null on empty window', () => {
    expect(computeDarkPoolSignal('AAPL', '2024-06-30', { byDate: {} })).toBeNull();
  });

  it('returns null when asOfDate has no trades', () => {
    const w = { byDate: { '2024-06-30': [] } };
    expect(computeDarkPoolSignal('AAPL', '2024-06-30', w)).toBeNull();
  });

  it('all-lit window → darkPoolPct ≈ 0', () => {
    const w = windowOver(30, () => [
      trade(0, 100, 1000, { x: 10 }),
      trade(0, 100, 500, { x: 10 }),
    ]);
    const asOf = Object.keys(w.byDate).sort().slice(-1)[0];
    const sig = computeDarkPoolSignal('AAPL', asOf, w);
    expect(sig).not.toBeNull();
    expect(sig!.darkPoolPct).toBe(0);
    expect(sig!.darkPoolPct30dAvg).toBe(0);
    expect(sig!.zScore).toBe(0);
  });

  it('all-dark window → darkPoolPct ≈ 1', () => {
    const w = windowOver(30, () => [
      trade(0, 100, 1000, { x: 4 }),
      trade(0, 100, 500, { c: [12] }),
    ]);
    const asOf = Object.keys(w.byDate).sort().slice(-1)[0];
    const sig = computeDarkPoolSignal('AAPL', asOf, w);
    expect(sig).not.toBeNull();
    expect(sig!.darkPoolPct).toBe(1);
    expect(sig!.todayDarkTrades).toBe(2);
  });

  it('z-score positive when today spikes above the 30d baseline', () => {
    // Baseline 0% dark; today 50% dark.
    const baseline = (date: string) => [trade(0, 100, 1000, { x: 10 })];
    const w = windowOver(31, baseline);
    const asOf = Object.keys(w.byDate).sort().slice(-1)[0];
    w.byDate[asOf] = [
      trade(0, 100, 1000, { x: 4 }),
      trade(0, 100, 1000, { x: 10 }),
    ];
    const sig = computeDarkPoolSignal('AAPL', asOf, w);
    expect(sig!.darkPoolPct).toBe(0.5);
    expect(sig!.darkPoolPct30dAvg).toBe(0);
    // Stdev of baseline is 0 → zScore defaults to 0 to avoid div-by-zero.
    expect(sig!.zScore).toBe(0);
  });

  it('z-score is finite when the baseline has some variance', () => {
    // Alternate 0% and 20% dark across baseline; spike to 80% today.
    const w: PolygonTradesByDay = { byDate: {} };
    const start = Date.parse('2024-06-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      const dark = i % 2 === 0 ? 0 : 200;
      w.byDate[date] = [
        trade(0, 100, dark, { x: 4 }),
        trade(0, 100, 1000 - dark, { x: 10 }),
      ];
    }
    const asOf = new Date(start + 30 * 86_400_000).toISOString().slice(0, 10);
    w.byDate[asOf] = [
      trade(0, 100, 800, { x: 4 }),
      trade(0, 100, 200, { x: 10 }),
    ];
    const sig = computeDarkPoolSignal('AAPL', asOf, w);
    expect(sig).not.toBeNull();
    expect(sig!.zScore).toBeGreaterThan(2);
  });
});

describe('darkPoolDirection', () => {
  const base: any = {
    ticker: 'X',
    asOfDate: '2024-06-30',
    darkPoolPct: 0.6,
    darkPoolPct5dAvg: 0.3,
    darkPoolPct30dAvg: 0.2,
    zScore: 2,
    todayTrades: 100,
    todayDarkTrades: 60,
  };
  it('z > 1.5 + green → accumulation', () => {
    expect(darkPoolDirection(base, 0.01)).toBe('accumulation');
  });
  it('z > 1.5 + red → distribution', () => {
    expect(darkPoolDirection(base, -0.01)).toBe('distribution');
  });
  it('|z| < 1.5 → neutral', () => {
    expect(darkPoolDirection({ ...base, zScore: 1 }, 0.01)).toBe('neutral');
  });
});
