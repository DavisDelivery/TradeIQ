// FVZ-1 — Finviz Elite export client.
//
// The traps these tests pin, in order of how much they'd hurt:
//   1. Finviz serves its LOGIN PAGE as HTML with HTTP 200 on auth failure —
//      body shape, not status, is the success signal. An HTML body must be
//      a null (failure), and per M8/4t-W1c a failure must NEVER be cached:
//      a lapsed subscription must not become a durable "empty S&P 500".
//   2. Parsing is keyed by HEADER NAME, not column position — a Finviz-side
//      column reshuffle must degrade to missing fields, never to silently
//      transposed values (P/E stored as price).
//   3. Quote-aware CSV: text cells legally contain commas.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock('../provider-live-cache', () => ({
  liveCacheGet: h.cacheGet,
  liveCacheSet: h.cacheSet,
}));
// Inert the pacing bucket: it is real (45rpm) and would make this suite sleep
// its way through every call. Pacing behaviour is asserted in
// rate-limiter tests, not here.
vi.mock('../rate-limiter', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getFinvizBucket: () => ({ acquire: async () => {} }),
}));

import {
  parseCsvLine,
  parseFinvizNumber,
  parseFinvizEarnings,
  fetchFinvizScreener,
  getFinvizUniverseSnapshot,
  __setFinvizThrottleForTesting,
} from '../finviz';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Byte-exact headers the live export emitted 2026-08-03 for our column set.
const HEADERS = [
  'Ticker', 'Sector', 'Market Cap', 'P/E', 'Forward P/E', 'PEG', 'Dividend Yield',
  'EPS Growth This Year', 'EPS Growth Next Year', 'EPS Growth Next 5 Years',
  'EPS Growth Quarter Over Quarter', 'Sales Growth Quarter Over Quarter',
  'Insider Ownership', 'Institutional Ownership', 'Short Float', 'Return on Equity',
  'Total Debt/Equity', 'Gross Margin', 'Profit Margin', 'Performance (Week)',
  'Performance (Month)', 'Performance (Year)', '20-Day Simple Moving Average',
  '50-Day Simple Moving Average', '200-Day Simple Moving Average', '52-Week High',
  '52-Week Low', 'Relative Strength Index (14)', 'Analyst Recom', 'Average Volume',
  'Relative Volume', 'Price', 'Change', 'Volume', 'Earnings Date', 'Target Price',
  // FVZ-3 screen-enabling columns.
  'P/S', 'P/B', 'Payout Ratio', 'EPS Growth Past 5 Years', 'Shares Float',
  'Insider Transactions', 'Short Ratio', 'Return on Assets',
  'Return on Invested Capital', 'Current Ratio', 'Performance (Quarter)',
  'Beta', 'Average True Range',
];

const q = (v: string) => `"${v.replace(/"/g, '""')}"`;

function csvOf(headers: string[], rows: Record<string, string>[]): string {
  const lines = [headers.map(q).join(',')];
  for (const r of rows) lines.push(headers.map((hd) => q(r[hd] ?? '-')).join(','));
  return lines.join('\n');
}

const AAPL: Record<string, string> = {
  Ticker: 'AAPL',
  Sector: 'Technology',
  'Market Cap': '4494326.59',
  'P/E': '35.08',
  'Dividend Yield': '0.35%',
  'Return on Equity': '148.75%',
  'Gross Margin': '48.65%',
  'Relative Volume': '1.06',
  Price: '306.00',
  Change: '-0.94%',
  Volume: '41634968',
  'Earnings Date': '7/30/2026 4:30:00 PM',
  'Target Price': '328.01',
};

const ok = (body: string) => Promise.resolve({ ok: true, status: 200, text: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FINVIZ_AUTH_TOKEN = 'test-token';
  h.cacheGet.mockResolvedValue(null);
  h.cacheSet.mockResolvedValue(undefined);
  // The throttle cooldown is module-level state by design (it must outlive a
  // single call to stop a scan from hammering a throttling upstream). That
  // makes it leak between tests exactly like the provider-live-cache L1 did:
  // the 429 case below would arm it and every later test would short-circuit
  // before reaching its fetch mock. Reset it per test.
  __setFinvizThrottleForTesting(0);
});

describe('CSV primitives', () => {
  it('parseCsvLine handles quoted commas and escaped quotes', () => {
    expect(parseCsvLine('"AAPL","DJIA, NDX, S&P 500","a ""b"" c"')).toEqual([
      'AAPL',
      'DJIA, NDX, S&P 500',
      'a "b" c',
    ]);
  });

  it('parseFinvizNumber: %, thousands separators, dashes, garbage', () => {
    expect(parseFinvizNumber('48.65%')).toBe(48.65);
    expect(parseFinvizNumber('-0.94%')).toBe(-0.94);
    expect(parseFinvizNumber('1,234.5')).toBe(1234.5);
    expect(parseFinvizNumber('-')).toBeNull();
    expect(parseFinvizNumber('')).toBeNull();
    expect(parseFinvizNumber('N/A')).toBeNull();
    expect(parseFinvizNumber(undefined)).toBeNull();
  });

  it('parseFinvizEarnings: amc / bmo / date-only / empty', () => {
    expect(parseFinvizEarnings('7/30/2026 4:30:00 PM')).toEqual({ date: '2026-07-30', session: 'amc' });
    expect(parseFinvizEarnings('8/5/2026 8:00:00 AM')).toEqual({ date: '2026-08-05', session: 'bmo' });
    expect(parseFinvizEarnings('7/30/2026')).toEqual({ date: '2026-07-30', session: null });
    expect(parseFinvizEarnings('-')).toEqual({ date: null, session: null });
  });
});

describe('fetchFinvizScreener', () => {
  it('parses a realistic export keyed by header name', async () => {
    fetchMock.mockImplementation(() => ok(csvOf(HEADERS, [AAPL])));
    const res = await fetchFinvizScreener(['idx_sp500']);
    expect(res).not.toBeNull();
    expect(res!.rows).toHaveLength(1);
    const r = res!.rows[0];
    expect(r.ticker).toBe('AAPL');
    expect(r.sector).toBe('Technology');
    expect(r.marketCapM).toBeCloseTo(4494326.59);
    expect(r.dividendYieldPct).toBeCloseTo(0.35);
    expect(r.roePct).toBeCloseTo(148.75);
    expect(r.changePct).toBeCloseTo(-0.94);
    expect(r.earningsDate).toBe('2026-07-30');
    expect(r.earningsSession).toBe('amc');
    expect(r.peg).toBeNull(); // '-' in fixture
    expect(res!.missingHeaders).toEqual([]);
  });

  it('a column reshuffle still parses correctly (header-name keying)', async () => {
    const shuffled = [...HEADERS].reverse();
    fetchMock.mockImplementation(() => ok(csvOf(shuffled, [AAPL])));
    const res = await fetchFinvizScreener(['idx_sp500']);
    expect(res!.rows[0].ticker).toBe('AAPL');
    expect(res!.rows[0].price).toBeCloseTo(306.0);
    expect(res!.rows[0].marketCapM).toBeCloseTo(4494326.59);
  });

  it('a dropped column reports missingHeaders and nulls the field — never transposes', async () => {
    const noPe = HEADERS.filter((hd) => hd !== 'P/E');
    fetchMock.mockImplementation(() => ok(csvOf(noPe, [AAPL])));
    const res = await fetchFinvizScreener(['idx_sp500']);
    expect(res!.missingHeaders).toEqual(['P/E']);
    expect(res!.rows[0].pe).toBeNull();
    expect(res!.rows[0].price).toBeCloseTo(306.0);
  });

  it('the login page (HTML at HTTP 200) is a FAILURE, not an empty result', async () => {
    fetchMock.mockImplementation(() => ok('<!DOCTYPE html>\n<html lang="en"><head><title>Finviz</title>'));
    expect(await fetchFinvizScreener(['idx_sp500'])).toBeNull();
  });

  it('HTTP !ok is a failure', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 429, text: async () => '' }));
    expect(await fetchFinvizScreener(['idx_sp500'])).toBeNull();
  });

  it('missing FINVIZ_AUTH_TOKEN: disabled, no network call', async () => {
    delete process.env.FINVIZ_AUTH_TOKEN;
    expect(await fetchFinvizScreener(['idx_sp500'])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Sharded cache (FVZ-3). The russell2k columnar doc reached 989KB — 94% of
// Firestore's 1MB ceiling — once COLUMNS widened to 51, so the universe is
// stored as a manifest + N row-shards. `writes` indexes cacheSet calls by
// their endpoint so the tests read against intent rather than call order.
const writesTo = (endpoint: string) =>
  h.cacheSet.mock.calls.filter((c: any[]) => c[0]?.endpoint === endpoint);

/** Replay whatever the last live fetch stored, as liveCacheGet would serve it. */
const serveFromStore = () => {
  const store = new Map<string, unknown>();
  for (const [key, value] of h.cacheSet.mock.calls) {
    store.set(`${key.endpoint}|${key.ticker}`, value);
  }
  return (key: any) => Promise.resolve(store.get(`${key.endpoint}|${key.ticker}`) ?? null);
};

describe('getFinvizUniverseSnapshot cache discipline', () => {
  it('live success writes shards + a manifest and reports source=live', async () => {
    fetchMock.mockImplementation(() => ok(csvOf(HEADERS, [AAPL])));
    const snap = await getFinvizUniverseSnapshot('sp500');
    expect(snap!.source).toBe('live');
    expect(snap!.rows[0].ticker).toBe('AAPL');

    const shards = writesTo('screener-universe-shard');
    const manifests = writesTo('screener-universe');
    expect(shards).toHaveLength(1);
    expect(manifests).toHaveLength(1);
    expect(manifests[0][0]).toEqual({
      provider: 'finviz',
      endpoint: 'screener-universe',
      ticker: '_sp500',
      extra: 'v2', // epoch bumped with the column widening
    });
    expect(manifests[0][1].shards).toBe(1);
    expect(manifests[0][1].f).toContain('ticker');
  });

  it('the manifest is written LAST so a crash cannot promise missing shards', async () => {
    fetchMock.mockImplementation(() => ok(csvOf(HEADERS, [AAPL])));
    await getFinvizUniverseSnapshot('sp500');
    const endpoints = h.cacheSet.mock.calls.map((c: any[]) => c[0].endpoint);
    expect(endpoints[endpoints.length - 1]).toBe('screener-universe');
  });

  it('a cache hit costs zero fetches and round-trips every field', async () => {
    fetchMock.mockImplementation(() => ok(csvOf(HEADERS, [AAPL])));
    const first = await getFinvizUniverseSnapshot('sp500');
    const replay = serveFromStore();
    vi.clearAllMocks();
    h.cacheGet.mockImplementation(replay);

    const snap = await getFinvizUniverseSnapshot('sp500');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(snap!.source).toBe('cache');
    expect(snap!.rows).toEqual(first!.rows);
  });

  it('a MISSING shard is a cache miss, never a truncated universe', async () => {
    fetchMock.mockImplementation(() => ok(csvOf(HEADERS, [AAPL])));
    await getFinvizUniverseSnapshot('sp500');
    vi.clearAllMocks();
    // Manifest survives but its shard was evicted/never written. Serving the
    // manifest alone would silently return an EMPTY S&P 500 as authoritative.
    h.cacheGet.mockImplementation((key: any) =>
      Promise.resolve(
        key.endpoint === 'screener-universe' ? { shards: 1, f: ['ticker'], at: 'x', mh: [] } : null,
      ),
    );
    fetchMock.mockImplementation(() => ok(csvOf(HEADERS, [AAPL])));
    const snap = await getFinvizUniverseSnapshot('sp500');
    expect(fetchMock).toHaveBeenCalled(); // refetched rather than served short
    expect(snap!.source).toBe('live');
    expect(snap!.rows).toHaveLength(1);
  });

  it('a FAILED fetch (login-page HTML) returns null and caches NOTHING', async () => {
    fetchMock.mockImplementation(() => ok('<!DOCTYPE html><html><body>login</body></html>'));
    expect(await getFinvizUniverseSnapshot('sp500')).toBeNull();
    expect(h.cacheSet).not.toHaveBeenCalled();
  });

  it('a verified-empty answer (valid header, zero rows) IS cached', async () => {
    fetchMock.mockImplementation(() => ok(csvOf(HEADERS, [])));
    const snap = await getFinvizUniverseSnapshot('sp500');
    expect(snap!.rows).toEqual([]);
    expect(writesTo('screener-universe')).toHaveLength(1);
  });

  it('disabled (no token): null, no fetch, no cache traffic', async () => {
    delete process.env.FINVIZ_AUTH_TOKEN;
    expect(await getFinvizUniverseSnapshot('sp500')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.cacheGet).not.toHaveBeenCalled();
    expect(h.cacheSet).not.toHaveBeenCalled();
  });
});
