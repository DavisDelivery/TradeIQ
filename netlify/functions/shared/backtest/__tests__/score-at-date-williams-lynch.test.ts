// PIT integrity test for the Williams and Lynch scoring paths added in
// Phase 4n (W4). Each test asserts the same shape:
//
//   1. Every data fetch the scoring path makes carries `asOfDate` (or an
//      explicit `from`/`to` range that ends at `asOfDate`). No fetch
//      defaults to "now".
//   2. The resulting ScoredCandidate includes the discrete verdict in
//      metadata so the W5 backtest harness can filter on it.
//   3. Calling at a past date returns the same result whether system
//      time is "today" or anything else — deterministic in (ticker,
//      asOfDate, data).
//
// Williams' inputs are bars-only, so PIT correctness reduces to "fetch
// only bars ≤ asOfDate". Lynch additionally fetches fundamentals +
// earnings history — both must carry asOfDate. Polygon's restatement
// risk on fundamentals is documented as residual in the report; the
// fetch-side test here proves we at least USE the PIT filter.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const barFetchCalls: Array<{ ticker: string; from: string; to: string }> = [];
const fundamentalsCalls: Array<{ ticker: string; asOfDate?: string }> = [];
const earningsCalls: Array<{ ticker: string; asOfDate?: string }> = [];

vi.mock('../../data-provider', async () => {
  const actual = await vi.importActual<typeof import('../../data-provider')>(
    '../../data-provider',
  );
  return {
    ...actual,
    getDailyBars: vi.fn(async (ticker: string, from: string, to: string) => {
      barFetchCalls.push({ ticker, from, to });
      // 250 daily bars, simple uptrend, finite ATR.
      const bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> = [];
      const start = new Date(`${from}T12:00:00Z`).getTime();
      const end = new Date(`${to}T12:00:00Z`).getTime();
      let price = 100;
      for (let t = start; t <= end; t += 86400000) {
        const dow = new Date(t).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        price *= 1.0005;
        bars.push({
          t,
          o: price,
          h: price * 1.02,
          l: price * 0.98,
          c: price,
          v: 1_000_000,
        });
      }
      return bars;
    }),
    getFundamentals: vi.fn(async (ticker: string, opts: { asOfDate?: string } = {}) => {
      fundamentalsCalls.push({ ticker, asOfDate: opts.asOfDate });
      // Lynch BUY profile: PEG 0.8, profitable, decent growth, low debt.
      return {
        ticker,
        revenue: 100_000_000,
        priorRevenue: 80_000_000,
        revenueGrowthYoY: 0.25,
        eps: 5,
        priorEps: 4,
        epsGrowthYoY: 0.25,
        ttmEps: 5,
        priorTtmEps: 4,
        grossMargin: 0.4,
        priorGrossMargin: 0.38,
        priorGrossMarginYoY: 0.37,
        operatingMargin: 0.18,
        priorOperatingMargin: 0.17,
        priorOperatingMarginYoY: 0.16,
        debtToEquity: 0.2,
        asOf: '2024-09-30',
      };
    }),
    getEarningsHistory: vi.fn(
      async (ticker: string, _limit: number, opts: { asOfDate?: string } = {}) => {
        earningsCalls.push({ ticker, asOfDate: opts.asOfDate });
        return [
          { date: '2024-09-30', epsActual: 1.3, epsEstimate: 1.2, surprisePct: 8.3 },
          { date: '2024-06-30', epsActual: 1.2, epsEstimate: 1.1, surprisePct: 9.0 },
          { date: '2024-03-31', epsActual: 1.1, epsEstimate: 1.05, surprisePct: 4.7 },
          { date: '2023-12-31', epsActual: 1.0, epsEstimate: 0.95, surprisePct: 5.2 },
        ];
      },
    ),
  };
});

// Disable the pit-cache Firestore write path so tests don't need a stubbed db.
vi.mock('../../pit-cache', async () => {
  const actual = await vi.importActual<typeof import('../../pit-cache')>('../../pit-cache');
  return {
    ...actual,
    pitCacheWrap: vi.fn(async <T,>(_key: unknown, loader: () => Promise<T>) => loader()),
  };
});

import { scoreTickerAtDate, buildMarketContextAtDate } from '../score-at-date';

beforeEach(() => {
  barFetchCalls.length = 0;
  fundamentalsCalls.length = 0;
  earningsCalls.length = 0;
});

describe('scoreTickerAtDate — Williams PIT', () => {
  it('returns a scored candidate with a discrete verdict in metadata', async () => {
    const asOfDate = '2024-12-15';
    // Williams doesn't actually use the context — pass a placeholder.
    const ctx = await buildMarketContextAtDate(asOfDate);
    const result = await scoreTickerAtDate('AAPL', asOfDate, 'williams', ctx);

    expect(result).not.toBeNull();
    expect(result!.ticker).toBe('AAPL');
    expect(typeof result!.composite).toBe('number');
    expect(['BUY', 'SELL', 'HOLD']).toContain(result!.metadata.verdict);
    // Williams only fetches bars — no fundamentals/earnings.
    expect(fundamentalsCalls).toHaveLength(0);
    expect(earningsCalls).toHaveLength(0);
  });

  it('every bar fetch ends at asOfDate (no look-ahead)', async () => {
    const asOfDate = '2022-06-01';
    const ctx = await buildMarketContextAtDate(asOfDate);
    await scoreTickerAtDate('AAPL', asOfDate, 'williams', ctx);
    const tickerFetches = barFetchCalls.filter((c) => c.ticker === 'AAPL');
    expect(tickerFetches.length).toBeGreaterThan(0);
    for (const f of tickerFetches) {
      expect(f.to).toBe(asOfDate);
      // `from` is strictly before `to`.
      expect(f.from < f.to).toBe(true);
    }
  });

  it('returns null when the universe does not contain the ticker', async () => {
    const ctx = await buildMarketContextAtDate('2024-01-15');
    const result = await scoreTickerAtDate(
      'NOT_A_REAL_TICKER_AAA',
      '2024-01-15',
      'williams',
      ctx,
    );
    expect(result).toBeNull();
  });
});

describe('scoreTickerAtDate — Lynch PIT', () => {
  it('threads asOfDate into fundamentals + earnings + bar fetches', async () => {
    const asOfDate = '2023-10-15';
    const ctx = await buildMarketContextAtDate(asOfDate);
    await scoreTickerAtDate('AAPL', asOfDate, 'lynch', ctx);

    // Every fundamentals + earnings fetch must carry asOfDate.
    expect(fundamentalsCalls.length).toBeGreaterThan(0);
    expect(earningsCalls.length).toBeGreaterThan(0);
    for (const c of fundamentalsCalls) expect(c.asOfDate).toBe(asOfDate);
    for (const c of earningsCalls) expect(c.asOfDate).toBe(asOfDate);

    // Bar fetches must end at asOfDate.
    const tickerFetches = barFetchCalls.filter((c) => c.ticker === 'AAPL');
    expect(tickerFetches.length).toBeGreaterThan(0);
    for (const f of tickerFetches) expect(f.to).toBe(asOfDate);
  });

  it('returns BUY verdict for the synthetic BUY-profile inputs', async () => {
    const asOfDate = '2024-12-15';
    const ctx = await buildMarketContextAtDate(asOfDate);
    const result = await scoreTickerAtDate('AAPL', asOfDate, 'lynch', ctx);
    expect(result).not.toBeNull();
    // The mocked fundamentals describe a Lynch sweet-spot company.
    expect(result!.metadata.verdict).toBe('BUY');
    expect(result!.metadata.fairValueLow).not.toBeNull();
    expect(result!.metadata.fairValueHigh).not.toBeNull();
  });

  it('carries the residual-restatement caveat in metadata for the report', async () => {
    const asOfDate = '2023-10-15';
    const ctx = await buildMarketContextAtDate(asOfDate);
    const result = await scoreTickerAtDate('AAPL', asOfDate, 'lynch', ctx);
    expect(result).not.toBeNull();
    expect(String(result!.metadata.pitCaveat)).toMatch(/restatement/i);
  });
});

describe('scoreTickerAtDate — discreteSignalOnly filter', () => {
  it('Lynch with discreteSignalOnly returns the BUY candidate as-is', async () => {
    const asOfDate = '2024-12-15';
    const ctx = await buildMarketContextAtDate(asOfDate);
    const result = await scoreTickerAtDate('AAPL', asOfDate, 'lynch', ctx, {
      discreteSignalOnly: true,
    });
    expect(result).not.toBeNull();
    expect(result!.metadata.verdict).toBe('BUY');
  });

  it('Williams with discreteSignalOnly drops HOLD candidates (synthetic uptrend has no %R turn)', async () => {
    const asOfDate = '2024-12-15';
    const ctx = await buildMarketContextAtDate(asOfDate);
    // Without the filter we get a HOLD verdict on the synthetic bars
    // (no %R turn → no BUY confluence). With the filter that null-pads.
    const unfiltered = await scoreTickerAtDate('AAPL', asOfDate, 'williams', ctx);
    expect(unfiltered).not.toBeNull();
    expect(unfiltered!.metadata.verdict).toBe('HOLD');

    const filtered = await scoreTickerAtDate('AAPL', asOfDate, 'williams', ctx, {
      discreteSignalOnly: true,
    });
    expect(filtered).toBeNull();
  });
});

describe('scoreTickerAtDate — dispatch', () => {
  it('returns null for boards without a PIT scoring path (catalyst/insider)', async () => {
    // Phase 4t W1 added the target board PIT path; catalyst + insider
    // remain stubs whose PIT story has not been audited.
    const ctx = await buildMarketContextAtDate('2024-12-15');
    const r1 = await scoreTickerAtDate('AAPL', '2024-12-15', 'catalyst', ctx);
    const r2 = await scoreTickerAtDate('AAPL', '2024-12-15', 'insider', ctx);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });

  it('throws when ctx.asOfDate disagrees with asOfDate', async () => {
    const ctx = await buildMarketContextAtDate('2024-12-15');
    await expect(
      scoreTickerAtDate('AAPL', '2024-11-01', 'williams', ctx),
    ).rejects.toThrow(/ctx\.asOfDate/);
  });
});
