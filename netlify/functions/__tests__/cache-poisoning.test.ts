// Cache-poisoning regression suite.
//
// History this guards against:
//   v0.7.18 — target-board cached an empty result during a cold-start timeout,
//             then served 0 targets for the next 10 minutes.
//   v0.7.19 — prophet-picks repeated the same bug pattern.
//   v0.7.21 — earnings-board AND insider-board both shipped with the same hole.
//
// The fix in every case was the same one-liner: gate the `resultCache.set(...)`
// call on `results.length > 0`. This file pins that invariant for all four
// endpoints. If the gate is removed (intentionally or accidentally), the
// matching test fails before the PR can merge.
//
// Strategy: mock all upstream data-fetching modules to return empty arrays,
// invoke the handler, then assert the module-scoped resultCache stays empty.
// Each handler exposes its cache via `__testInternals` (a test-only hook
// added in this commit; it has no production code path).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks: all four endpoints share these upstream modules. Mock them up front
// so every spec gets empty inputs, then invoke handlers via dynamic import
// so vi.mock() takes effect before module evaluation.
// ---------------------------------------------------------------------------

vi.mock('../shared/analyst-runner', () => ({
  fetchBarCache: vi.fn(async () => ({})),
  runAnalystsForTicker: vi.fn(async () => ({ target: null })),
}));

vi.mock('../shared/regime', () => ({
  computeRegime: vi.fn(async () => ({
    regime: 'neutral',
    conviction: 'low',
    vol: { level: 15, regime: 'normal', trend: 'stable', percentile: 50 },
    rates: { tenYear: 4, twoTenSpread: 0, curveRegime: 'normal', trend: 'stable' },
    riskAppetite: { ratioTrend: 'neutral', creditSignal: 'neutral' },
    rationale: 'mock',
    computedAt: new Date().toISOString(),
  })),
  regimeToMacroBias: vi.fn(() => 0),
}));

vi.mock('../shared/universe', async () => {
  const actual = await vi.importActual<typeof import('../shared/universe')>(
    '../shared/universe',
  );
  return {
    ...actual,
    // keep the real universe data — the bug isn't about which tickers are
    // scanned, it's about how an empty *result* is handled.
  };
});

vi.mock('../shared/data-provider', () => ({
  getDailyBars: vi.fn(async () => []),
  getFundamentals: vi.fn(async () => null),
  getUpcomingEarnings: vi.fn(async () => null),
  getEarningsCalendarRange: vi.fn(async () => []),
  getEarningsHistory: vi.fn(async () => []),
  getFinnhubInsiderTransactions: vi.fn(async () => []),
  getNews: vi.fn(async () => []),
  getPreviousClose: vi.fn(async () => null),
  getMacroData: vi.fn(async () => ({})),
}));

vi.mock('../shared/earnings-intel', () => ({
  getEarningsIntel: vi.fn(async () => null),
}));
vi.mock('../shared/insider-provider', () => ({
  getInsiderActivity: vi.fn(async () => null),
}));
vi.mock('../shared/political-provider', () => ({
  getPoliticalActivity: vi.fn(async () => null),
}));
vi.mock('../shared/govcontracts-provider', () => ({
  getGovContractActivity: vi.fn(async () => null),
}));
vi.mock('../shared/patent-provider', () => ({
  getPatentActivity: vi.fn(async () => null),
}));
vi.mock('../shared/edgar-roles', () => ({
  lookupInsiderRole: vi.fn(async () => null),
}));

// Stub Netlify event helper
const mkEvent = (qs: Record<string, string> = {}) =>
  ({ queryStringParameters: qs, httpMethod: 'GET', headers: {}, path: '/' }) as any;

// ---------------------------------------------------------------------------
// target-board
// ---------------------------------------------------------------------------

describe('cache-poisoning regression: target-board', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT cache when result set is empty', async () => {
    const mod = await import('../target-board');
    mod.__testInternals.reset();

    const res = await mod.handler(mkEvent({ universe: 'core' }), {} as any, () => {}) as any;
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.targets)).toBe(true);
    expect(body.targets.length).toBe(0);

    // The whole point of the regression: empty results must NOT poison cache.
    expect(mod.__testInternals.resultCache.size).toBe(0);
  });

  it('re-runs the scan on a second call when first call was empty', async () => {
    const mod = await import('../target-board');
    const ar = await import('../shared/analyst-runner');
    mod.__testInternals.reset();
    vi.clearAllMocks();

    await mod.handler(mkEvent({ universe: 'core' }), {} as any, () => {}) as any;
    const callCountAfter1 = (ar.fetchBarCache as any).mock.calls.length;
    expect(callCountAfter1).toBeGreaterThan(0);

    await mod.handler(mkEvent({ universe: 'core' }), {} as any, () => {}) as any;
    const callCountAfter2 = (ar.fetchBarCache as any).mock.calls.length;

    // Second invocation must do real work, not return a cached empty.
    expect(callCountAfter2).toBeGreaterThan(callCountAfter1);
  });
});

// ---------------------------------------------------------------------------
// prophet-picks
// ---------------------------------------------------------------------------

describe('cache-poisoning regression: prophet-picks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT cache when picks list is empty', async () => {
    const mod = await import('../prophet-picks');
    mod.__testInternals.reset();

    const res = await mod.handler(
      mkEvent({ universe: 'largecap', minConviction: 'low', narrate: '0' }),
      {} as any,
      () => {},
    ) as any;
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.picks)).toBe(true);
    expect(body.picks.length).toBe(0);

    expect(mod.__testInternals.resultCache.size).toBe(0);
  });

  it('re-runs the scan on a second call when first call was empty', async () => {
    const mod = await import('../prophet-picks');
    const dp = await import('../shared/data-provider');
    mod.__testInternals.reset();
    vi.clearAllMocks();

    await mod.handler(
      mkEvent({ universe: 'largecap', minConviction: 'low', narrate: '0' }),
      {} as any, () => {},
    ) as any;
    const c1 = (dp.getDailyBars as any).mock.calls.length;
    expect(c1).toBeGreaterThan(0);

    await mod.handler(
      mkEvent({ universe: 'largecap', minConviction: 'low', narrate: '0' }),
      {} as any, () => {},
    ) as any;
    const c2 = (dp.getDailyBars as any).mock.calls.length;
    expect(c2).toBeGreaterThan(c1);
  });
});

// ---------------------------------------------------------------------------
// earnings-board
// ---------------------------------------------------------------------------

describe('cache-poisoning regression: earnings-board', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT cache when setups list is empty', async () => {
    const mod = await import('../earnings-board');
    mod.__testInternals.reset();

    const res = await mod.handler(mkEvent({ days: '7' }), {} as any, () => {}) as any;
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.setups)).toBe(true);
    expect(body.setups.length).toBe(0);

    expect(mod.__testInternals.resultCache.size).toBe(0);
  });

  it('re-runs the calendar fetch on a second call when first call was empty', async () => {
    const mod = await import('../earnings-board');
    const dp = await import('../shared/data-provider');
    mod.__testInternals.reset();
    vi.clearAllMocks();

    await mod.handler(mkEvent({ days: '7' }), {} as any, () => {}) as any;
    const c1 = (dp.getEarningsCalendarRange as any).mock.calls.length;
    expect(c1).toBeGreaterThan(0);

    await mod.handler(mkEvent({ days: '7' }), {} as any, () => {}) as any;
    const c2 = (dp.getEarningsCalendarRange as any).mock.calls.length;
    expect(c2).toBeGreaterThan(c1);
  });
});

// ---------------------------------------------------------------------------
// insider-board
// ---------------------------------------------------------------------------

describe('cache-poisoning regression: insider-board', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT cache when rows list is empty', async () => {
    const mod = await import('../insider-board');
    mod.__testInternals.reset();

    const res = await mod.handler(
      mkEvent({ days: '90', limit: '100', index: 'sp500' }),
      {} as any, () => {},
    ) as any;
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBe(0);

    expect(mod.__testInternals.resultCache.size).toBe(0);
  });

  it('re-runs the insider fetch on a second call when first call was empty', async () => {
    const mod = await import('../insider-board');
    const dp = await import('../shared/data-provider');
    mod.__testInternals.reset();
    vi.clearAllMocks();

    await mod.handler(
      mkEvent({ days: '90', limit: '100', index: 'sp500' }),
      {} as any, () => {},
    ) as any;
    const c1 = (dp.getFinnhubInsiderTransactions as any).mock.calls.length;
    expect(c1).toBeGreaterThan(0);

    await mod.handler(
      mkEvent({ days: '90', limit: '100', index: 'sp500' }),
      {} as any, () => {},
    ) as any;
    const c2 = (dp.getFinnhubInsiderTransactions as any).mock.calls.length;
    expect(c2).toBeGreaterThan(c1);
  });
});
