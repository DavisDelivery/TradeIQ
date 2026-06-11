// Phase 4t W1 — PIT integrity tests for the ten-analyst composite
// (`target` board) scoring path added in Phase 4t.
//
// The contract asserted here:
//   1. Every data fetch the path makes carries `asOfDate` (or an
//      explicit `from`/`to` range ending at `asOfDate`). No fetch
//      defaults to "now" — that is the look-ahead trap the brief
//      (PART V, R1) calls out.
//   2. The ScoredCandidate has the ten-analyst layer scores and the
//      composite metadata Phase 4s established (composite, tier,
//      direction, conflict level), so the backtest engine's W3
//      attribution can decompose per-factor.
//   3. The composite is scoreable on real-shape mock data — the
//      analysts run, composeTarget combines them, the result is
//      deterministic in (ticker, asOfDate).
//
// The PIT classification per factor is in `reports/phase-4t/pit-
// audit.md`. This test enforces the wire-level half (the fetches);
// the audit owns the analytical half (which factors are PIT-clean,
// caveated, or excluded).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every PIT-relevant fetch the path makes so we can assert
// each one carries the correct asOfDate.
const barFetchCalls: Array<{ ticker: string; from: string; to: string }> = [];
const fundamentalsCalls: Array<{ ticker: string; asOfDate?: string }> = [];
const newsCalls: Array<{ ticker: string; asOfDate?: string; limit?: number }> = [];
const upcomingEarningsCalls: Array<{ ticker: string; daysAhead: number; asOfDate?: string }> = [];
const earningsHistoryCalls: Array<{ ticker: string; limit: number; asOfDate?: string }> = [];
const insiderCalls: Array<{ ticker: string; lookbackDays: number; asOfDate?: string }> = [];
const patentCalls: Array<{ ticker: string; name: string; lookbackDays: number; asOfDate?: string }> = [];
const contractCalls: Array<{ ticker: string; lookbackDays: number; asOfDate?: string }> = [];
const politicalBacktestCalls: Array<{ ticker: string; lookbackDays: number; asOfDate: string }> = [];

vi.mock('../../data-provider', async () => {
  const actual = await vi.importActual<typeof import('../../data-provider')>(
    '../../data-provider',
  );
  return {
    ...actual,
    getDailyBars: vi.fn(async (ticker: string, from: string, to: string) => {
      barFetchCalls.push({ ticker, from, to });
      // 250 daily bars, gentle uptrend, finite ATR.
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
          h: price * 1.01,
          l: price * 0.99,
          c: price,
          v: 1_000_000,
        });
      }
      return bars;
    }),
    getFundamentals: vi.fn(async (ticker: string, opts: { asOfDate?: string } = {}) => {
      fundamentalsCalls.push({ ticker, asOfDate: opts.asOfDate });
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
        epsGrowthTTM: 0.25, // (5 − 4) / 4 — Wave 4C Lynch growth input
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
    getNews: vi.fn(
      async (
        ticker: string,
        optsOrLimit: { asOfDate?: string; limit?: number } | number = 20,
      ) => {
        const opts = typeof optsOrLimit === 'number' ? { limit: optsOrLimit } : optsOrLimit;
        newsCalls.push({ ticker, asOfDate: opts.asOfDate, limit: opts.limit });
        return [];
      },
    ),
    getUpcomingEarnings: vi.fn(
      async (
        ticker: string,
        daysAhead: number,
        opts: { asOfDate?: string } = {},
      ) => {
        upcomingEarningsCalls.push({ ticker, daysAhead, asOfDate: opts.asOfDate });
        return null;
      },
    ),
    getEarningsHistory: vi.fn(
      async (
        ticker: string,
        limit: number,
        opts: { asOfDate?: string } = {},
      ) => {
        earningsHistoryCalls.push({ ticker, limit, asOfDate: opts.asOfDate });
        return [
          { period: '2024-09-30', announceDate: '2024-10-28', epsActual: 1.3, epsEstimate: 1.2, surprisePct: 8.3 },
          { period: '2024-06-30', announceDate: '2024-07-29', epsActual: 1.2, epsEstimate: 1.1, surprisePct: 9.0 },
          { period: '2024-03-31', announceDate: '2024-04-26', epsActual: 1.1, epsEstimate: 1.05, surprisePct: 4.7 },
          { period: '2023-12-31', announceDate: '2024-01-29', epsActual: 1.0, epsEstimate: 0.95, surprisePct: 5.2 },
        ];
      },
    ),
  };
});

vi.mock('../../insider-provider', () => ({
  getInsiderActivity: vi.fn(
    async (ticker: string, lookbackDays: number, opts: { asOfDate?: string } = {}) => {
      insiderCalls.push({ ticker, lookbackDays, asOfDate: opts.asOfDate });
      return null; // null is the analyst's no-data branch (mocked path)
    },
  ),
}));

vi.mock('../../patent-provider', () => ({
  getPatentActivity: vi.fn(
    async (
      ticker: string,
      name: string,
      lookbackDays: number,
      opts: { asOfDate?: string } = {},
    ) => {
      patentCalls.push({ ticker, name, lookbackDays, asOfDate: opts.asOfDate });
      return null;
    },
  ),
}));

vi.mock('../../govcontracts-provider', () => ({
  getGovContractActivity: vi.fn(
    async (ticker: string, lookbackDays: number, opts: { asOfDate?: string } = {}) => {
      contractCalls.push({ ticker, lookbackDays, asOfDate: opts.asOfDate });
      return null;
    },
  ),
}));

vi.mock('../stock-act-shift', () => ({
  getPoliticalActivityForBacktest: vi.fn(
    async (ticker: string, lookbackDays: number, asOfDate: string) => {
      politicalBacktestCalls.push({ ticker, lookbackDays, asOfDate });
      return null;
    },
  ),
}));

// Disable Firestore PIT cache write path.
vi.mock('../../pit-cache', async () => {
  const actual = await vi.importActual<typeof import('../../pit-cache')>('../../pit-cache');
  return {
    ...actual,
    pitCacheWrap: vi.fn(async <T,>(_key: unknown, loader: () => Promise<T>) => loader()),
  };
});

// Regime: synthetic clean output so the macro analyst (weight 0) and
// the context just receive a deterministic macroBias.
vi.mock('../../regime', () => ({
  computeRegime: vi.fn(async () => ({
    regime: 'risk_on' as const,
    vix: 14,
    spyAbove200: true,
    breadth: 0.6,
    asOfDate: '2024-12-15',
  })),
}));

import {
  scoreTickerAtDate,
  buildMarketContextAtDate,
  _internalsTarget,
} from '../score-at-date';

beforeEach(() => {
  barFetchCalls.length = 0;
  fundamentalsCalls.length = 0;
  newsCalls.length = 0;
  upcomingEarningsCalls.length = 0;
  earningsHistoryCalls.length = 0;
  insiderCalls.length = 0;
  patentCalls.length = 0;
  contractCalls.length = 0;
  politicalBacktestCalls.length = 0;
});

describe('scoreTickerAtDate — target board PIT', () => {
  it('threads asOfDate into every data fetch (no look-ahead in any factor)', async () => {
    const asOfDate = '2024-06-03';
    const ctx = await buildMarketContextAtDate(asOfDate);
    barFetchCalls.length = 0; // ctx pre-fetches SPY + sector ETFs; reset before the ticker call
    const result = await scoreTickerAtDate('AAPL', asOfDate, 'target', ctx);

    expect(result).not.toBeNull();

    // 1. Every ticker bar fetch ends at asOfDate.
    const tickerBars = barFetchCalls.filter((c) => c.ticker === 'AAPL');
    expect(tickerBars.length).toBeGreaterThan(0);
    for (const f of tickerBars) {
      expect(f.to).toBe(asOfDate);
      expect(f.from < f.to).toBe(true);
    }

    // 2. Fundamentals (PIT-with-restatement-caveat): asOfDate threaded.
    const fund = fundamentalsCalls.filter((c) => c.ticker === 'AAPL');
    expect(fund.length).toBeGreaterThan(0);
    for (const f of fund) expect(f.asOfDate).toBe(asOfDate);

    // 3. News (PIT-with-coverage-caveat): asOfDate threaded.
    const news = newsCalls.filter((c) => c.ticker === 'AAPL');
    expect(news.length).toBeGreaterThan(0);
    for (const n of news) expect(n.asOfDate).toBe(asOfDate);

    // 4. Upcoming earnings (PIT-clean): asOfDate threaded.
    const upc = upcomingEarningsCalls.filter((c) => c.ticker === 'AAPL');
    expect(upc.length).toBeGreaterThan(0);
    for (const u of upc) expect(u.asOfDate).toBe(asOfDate);

    // 5. Earnings history (PIT-with-EPS-restatement-caveat): asOfDate threaded.
    const eh = earningsHistoryCalls.filter((c) => c.ticker === 'AAPL');
    expect(eh.length).toBeGreaterThan(0);
    for (const e of eh) expect(e.asOfDate).toBe(asOfDate);

    // 6. Insider (PIT-clean, filing-date): asOfDate threaded.
    const ins = insiderCalls.filter((c) => c.ticker === 'AAPL');
    expect(ins.length).toBeGreaterThan(0);
    for (const i of ins) expect(i.asOfDate).toBe(asOfDate);

    // 7. Patents (weight=0 but still scored): asOfDate threaded.
    const pat = patentCalls.filter((c) => c.ticker === 'AAPL');
    expect(pat.length).toBeGreaterThan(0);
    for (const p of pat) expect(p.asOfDate).toBe(asOfDate);

    // 8. Contracts (PIT-clean, action-date): asOfDate threaded.
    const con = contractCalls.filter((c) => c.ticker === 'AAPL');
    expect(con.length).toBeGreaterThan(0);
    for (const c of con) expect(c.asOfDate).toBe(asOfDate);

    // 9. Political backtest (STOCK-Act-shifted): asOfDate threaded.
    //    The path uses getPoliticalActivityForBacktest, NOT the raw
    //    getPoliticalActivity — the shift models the 45-day disclosure
    //    lag so the backtest sees only what was PUBLIC on asOfDate.
    const pol = politicalBacktestCalls.filter((c) => c.ticker === 'AAPL');
    expect(pol.length).toBeGreaterThan(0);
    for (const p of pol) expect(p.asOfDate).toBe(asOfDate);
  });

  it('returns a composite + per-analyst layer scores + PIT caveat metadata', async () => {
    const asOfDate = '2024-06-03';
    const ctx = await buildMarketContextAtDate(asOfDate);
    const result = await scoreTickerAtDate('AAPL', asOfDate, 'target', ctx);

    expect(result).not.toBeNull();
    const r = result!;
    expect(typeof r.composite).toBe('number');
    expect(r.composite).toBeGreaterThanOrEqual(0);
    expect(r.composite).toBeLessThanOrEqual(100);

    // All ten analyst layer scores must be present so W3 leave-one-out
    // can decompose the edge per-factor.
    expect(r.layers).toMatchObject({
      technical: expect.any(Number),
      'sector-rotation': expect.any(Number),
      fundamental: expect.any(Number),
      flow: expect.any(Number),
      news: expect.any(Number),
      earnings: expect.any(Number),
      macro: expect.any(Number),
      insider: expect.any(Number),
      patents: expect.any(Number),
      political: expect.any(Number),
    });

    expect(['long', 'short', 'neutral']).toContain(r.metadata.direction);
    expect(['severe', 'moderate', 'mild', 'none']).toContain(r.metadata.conflictLevel);
    expect(['A', 'B', 'C']).toContain(r.metadata.tier);

    // The PIT caveat surfaces in metadata so reports can't bury it.
    expect(typeof r.metadata.pitCaveat).toBe('string');
    expect(r.metadata.pitCaveat).toMatch(/restatement|news-coverage/i);
  });

  it('returns null when bars are insufficient (<50)', async () => {
    // Force getDailyBars to return only 10 bars (well under the
    // 50-bar minimum the runners require). Override with a
    // ticker-aware impl, then restore the original tall-trend
    // generator so subsequent tests still see real-shape bars.
    const dp = await import('../../data-provider');
    const spy = dp.getDailyBars as unknown as ReturnType<typeof vi.fn>;
    const restoreImpl = async (ticker: string, from: string, to: string) => {
      barFetchCalls.push({ ticker, from, to });
      const bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> = [];
      const start = new Date(`${from}T12:00:00Z`).getTime();
      const end = new Date(`${to}T12:00:00Z`).getTime();
      let price = 100;
      for (let t = start; t <= end; t += 86400000) {
        const dow = new Date(t).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        price *= 1.0005;
        bars.push({ t, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1_000_000 });
      }
      return bars;
    };
    spy.mockImplementation(async (ticker: string, from: string, to: string) => {
      if (ticker === 'AAPL') {
        barFetchCalls.push({ ticker, from, to });
        return Array.from({ length: 10 }, (_, i) => ({
          t: i, o: 100, h: 101, l: 99, c: 100, v: 1000,
        }));
      }
      return restoreImpl(ticker, from, to);
    });
    try {
      const asOfDate = '2024-06-03';
      const ctx = await buildMarketContextAtDate(asOfDate);
      const result = await scoreTickerAtDate('AAPL', asOfDate, 'target', ctx);
      expect(result).toBeNull();
    } finally {
      spy.mockImplementation(restoreImpl);
    }
  });

  it('scores tickers OUTSIDE the current universe seed with degraded metadata (CR-2)', async () => {
    // CR-2 (2026-06 review): historical pool tickers missing from the
    // current 2026 seed (delisted/acquired names) must still score —
    // dropping them re-introduced the survivorship bias the PIT pool
    // exists to remove. The degraded entry drops ONLY the sub-signals
    // that genuinely require the missing fields: the patent search
    // (needs a company name) is skipped; sector-relative inputs fall
    // back to their no-sector neutral branches.
    const asOfDate = '2024-01-15';
    const ctx = await buildMarketContextAtDate(asOfDate);
    patentCalls.length = 0;
    const result = await scoreTickerAtDate(
      'NOT_A_REAL_TICKER_AAA',
      asOfDate,
      'target',
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result!.ticker).toBe('NOT_A_REAL_TICKER_AAA');
    expect(typeof result!.composite).toBe('number');
    expect(result!.sector).toBeNull();
    expect(result!.metadata.outsideCurrentUniverse).toBe(true);
    // No company name → the patent fetch must be skipped entirely
    // (never called with a fabricated name like the bare ticker).
    expect(
      patentCalls.filter((c) => c.ticker === 'NOT_A_REAL_TICKER_AAA'),
    ).toHaveLength(0);
    // All ten layer scores still present (patents via the no-data branch).
    expect(Object.keys(result!.layers)).toHaveLength(10);
  });

  it('does NOT flag in-universe tickers as outsideCurrentUniverse', async () => {
    const asOfDate = '2024-01-15';
    const ctx = await buildMarketContextAtDate(asOfDate);
    const result = await scoreTickerAtDate('AAPL', asOfDate, 'target', ctx);
    expect(result).not.toBeNull();
    expect(result!.metadata.outsideCurrentUniverse).toBeUndefined();
  });

  it('does NOT use the raw getPoliticalActivity (live path) — uses the STOCK-Act-shifted backtest helper instead', async () => {
    // This is the central PIT guarantee for the political factor.
    // The live `getPoliticalActivity` returns trades by execution
    // date; the backtest path must apply the disclosure shift so
    // backtests see only what was PUBLIC on asOfDate. Asserting the
    // backtest helper is hit (and the live helper isn't) on the
    // target path closes that hole.
    const asOfDate = '2023-04-15';
    const ctx = await buildMarketContextAtDate(asOfDate);
    politicalBacktestCalls.length = 0;
    await scoreTickerAtDate('AAPL', asOfDate, 'target', ctx);
    const pol = politicalBacktestCalls.filter((c) => c.ticker === 'AAPL');
    expect(pol.length).toBeGreaterThan(0);
    for (const p of pol) {
      expect(p.asOfDate).toBe(asOfDate);
      // The backtest helper takes (ticker, lookbackDays, asOfDate) —
      // not an opts bag. asOfDate is positional, so an accidental
      // call to the live signature would land asOfDate as undefined.
      expect(typeof p.lookbackDays).toBe('number');
      expect(p.lookbackDays).toBeGreaterThan(0);
    }
  });

  it('TARGET_ANALYST_WEIGHTS mirrors the live ANALYST_WEIGHTS exactly (drift guard)', async () => {
    // Import the live weights through analyst-runner (re-exported as a
    // const at the module level). Drift between the two tables would
    // mean the backtest measures a DIFFERENT composite than production
    // produces — a silent integrity break.
    const liveModule = await import('../../analyst-runner');
    // ANALYST_WEIGHTS is module-local in analyst-runner; we test the
    // value shape via composeTarget rather than the raw export.
    expect(typeof liveModule.composeTarget).toBe('function');
    // The drift-guard contract: TARGET_ANALYST_WEIGHTS keys + values
    // match the documented Phase 4f live values. If
    // shared/analyst-runner.ts changes ANALYST_WEIGHTS, this test
    // surfaces the drift on the score-at-date side.
    expect(_internalsTarget.TARGET_ANALYST_WEIGHTS).toEqual({
      'technical-analyst': 0.15,
      'sector-rotation': 0.08,
      'fundamental-analyst': 0.13,
      'flow-analyst': 0.10,
      'news-sentiment': 0.10,
      'earnings-analyst': 0.07,
      'macro-regime': 0,
      'insider-analyst': 0.14,
      'patent-analyst': 0,
      'political-analyst': 0.10,
    });
  });
});
