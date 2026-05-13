// Tests for 4c-2 sieve Stage 1 — universe-wide cheap filter.
//
// We use synthetic ticker data with mocked getDailyBars so the test runs
// hermetically. The contract under test:
//   - All tickers in the input universe get scored (or skipped if bars
//     are too short — minimum 200 bars for SMA200).
//   - Stage 1 composite is the equal-weighted average of 5 percentile-
//     ranked signals (trend, momentum, volume, inverted volatility,
//     above-52w-low).
//   - Survival: top N by composite, clamped between [min, max].

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../data-provider', () => ({
  getDailyBars: vi.fn(),
}));

import { runStage1, computeRawSignals } from '../prophet-sieve/stage1';
import { getDailyBars } from '../data-provider';
import type { Bar } from '../data-provider';

// Generate synthetic bars: linear-uptrend with given daily return.
function makeBars(n: number, startPrice: number, dailyReturn: number, dailyVol = 50_000): Bar[] {
  const bars: Bar[] = [];
  let p = startPrice;
  for (let i = 0; i < n; i++) {
    p = p * (1 + dailyReturn);
    bars.push({
      t: Date.now() - (n - i) * 86_400_000,
      o: p,
      h: p,
      l: p,
      c: p,
      v: dailyVol,
    } as any);
  }
  return bars;
}

// Bars with a recent volume surge in the last 5 days
function makeBarsWithVolSurge(n: number, startPrice: number, dailyReturn: number): Bar[] {
  const bars = makeBars(n, startPrice, dailyReturn, 50_000);
  for (let i = bars.length - 5; i < bars.length; i++) {
    bars[i].v = 200_000;
  }
  return bars;
}

describe('computeRawSignals — bars-only signal math', () => {
  it('flags trendQualifier when close > all three SMAs', () => {
    const bars = makeBars(250, 50, 0.001); // gentle uptrend
    const r = computeRawSignals('TEST', bars);
    expect(r).not.toBeNull();
    expect(r!.trendQualifier).toBe(true);
  });

  it('does NOT flag trendQualifier when bars are flat/declining', () => {
    const bars = makeBars(250, 50, -0.001); // gentle downtrend
    const r = computeRawSignals('TEST', bars);
    expect(r!.trendQualifier).toBe(false);
  });

  it('returns null when fewer than 200 bars (SMA200 unavailable)', () => {
    const bars = makeBars(150, 50, 0.001);
    expect(computeRawSignals('TEST', bars)).toBeNull();
  });

  it('detects volume surge', () => {
    const bars = makeBarsWithVolSurge(250, 50, 0.001);
    const r = computeRawSignals('TEST', bars);
    // 5d avg vol = 200000, 20d ~= (15*50000 + 5*200000)/20 = 87500, ratio ~2.3
    expect(r!.volumeSurge).toBeGreaterThan(1.8);
  });

  it('computes momentum20d as 20-day return', () => {
    // Constant daily return r → 20-day return = (1+r)^20 - 1
    const r = computeRawSignals('TEST', makeBars(250, 50, 0.005));
    const expected = Math.pow(1.005, 20) - 1;
    expect(r!.momentum20d).toBeCloseTo(expected, 3);
  });

  it('computes above-52w-low margin', () => {
    const bars = makeBars(252, 50, 0.002);
    const r = computeRawSignals('TEST', bars);
    expect(r!.above52wLowPct).toBeGreaterThan(0); // uptrending, so above the 52w low
  });
});

describe('runStage1 — orchestration + percentile ranking + survival', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('scores every ticker that has sufficient bars + filters survivors', async () => {
    // Build a cohort where ~half are strong uptrending and ~half are flat.
    const strongTickers = ['STRONG1', 'STRONG2', 'STRONG3', 'STRONG4', 'STRONG5'];
    const weakTickers = ['WEAK1', 'WEAK2', 'WEAK3', 'WEAK4', 'WEAK5'];

    (getDailyBars as any).mockImplementation((ticker: string) => {
      if (strongTickers.includes(ticker)) {
        return Promise.resolve(makeBarsWithVolSurge(252, 50, 0.003));
      }
      if (weakTickers.includes(ticker)) {
        return Promise.resolve(makeBars(252, 50, -0.0005));
      }
      return Promise.resolve([]);
    });

    const entries = [...strongTickers, ...weakTickers].map((t) => ({
      ticker: t,
      name: t,
      sector: 'Technology',
      indices: ['russell2k' as const],
    }));

    const result = await runStage1(
      {
        entries,
        from: '2025-01-01',
        to: '2026-01-01',
        spyBars: [],
      },
      { budgetMs: 60_000 },
    );

    expect(result.meta.scored).toBe(10);
    // Strong tickers should be in survivors; weak should not (with min=300/max=600
    // and topPct=20%, but only 10 tickers, the clamp kicks in to min=300 which is
    // higher than the cohort. The minComposite=50 cap still applies. The strong
    // group composites should clearly beat 50; the weak should not.)
    const survivorTickers = new Set(result.survivors.map((s) => s.ticker));
    // At least 3 strong tickers should survive
    const strongSurvived = strongTickers.filter((t) => survivorTickers.has(t)).length;
    expect(strongSurvived).toBeGreaterThanOrEqual(3);
    // Weak tickers should mostly be excluded (composite below minComposite=50)
    const weakSurvived = weakTickers.filter((t) => survivorTickers.has(t)).length;
    expect(weakSurvived).toBeLessThan(strongSurvived);
  });

  it('skips tickers with insufficient bars', async () => {
    (getDailyBars as any).mockImplementation((ticker: string) =>
      ticker === 'GOOD' ? Promise.resolve(makeBars(252, 50, 0.002)) : Promise.resolve(makeBars(50, 50, 0.001)),
    );

    const entries = [
      { ticker: 'GOOD', name: 'GOOD', sector: 'Tech', indices: ['russell2k' as const] },
      { ticker: 'SHORT', name: 'SHORT', sector: 'Tech', indices: ['russell2k' as const] },
    ];

    const result = await runStage1(
      { entries, from: '2025-01-01', to: '2026-01-01', spyBars: [] },
      { budgetMs: 60_000 },
    );
    expect(result.meta.scored).toBe(1);
    expect(result.results[0].ticker).toBe('GOOD');
  });

  it('stamps partial:true when the budget is exhausted mid-scan', async () => {
    (getDailyBars as any).mockImplementation(
      () =>
        new Promise((r) => setTimeout(() => r(makeBars(252, 50, 0.001)), 50)),
    );

    const entries = Array.from({ length: 20 }, (_, i) => ({
      ticker: `T${i}`,
      name: `T${i}`,
      sector: 'Tech',
      indices: ['russell2k' as const],
    }));

    // Tight budget — most fetches won't complete
    const result = await runStage1(
      { entries, from: '2025-01-01', to: '2026-01-01', spyBars: [] },
      { budgetMs: 10, concurrency: 4 },
    );
    expect(result.meta.partial).toBe(true);
  });
});
