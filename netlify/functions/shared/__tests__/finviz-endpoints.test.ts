// FVZ-2 — the non-screener Finviz export endpoints + the throttle circuit
// breaker.
//
// Everything here is pinned to behaviour MEASURED against the live account on
// 2026-08-03, not to documentation (Finviz publishes none for these):
//
//   - Throttling answers with HTTP 200 and a plain-text body, NOT 429. A
//     ~25-call burst tripped it; it cleared inside 60s. So throttle must be
//     detected by BODY TEXT, and a trip must arm a cooldown — retrying into
//     it is the TREND-1 amplification bug in a new costume.
//   - Daily bars are SPLIT-ADJUSTED (AAPL pre-4:1 reads ~$126, not ~$505) and
//     match Polygon closes to 0.00000% across all 252 trading days of 2024.
//   - Delisted/acquired tickers (TWTR, SIVB, FRC, ATVI, CREE, XLNX) return
//     ZERO rows. That must surface as an empty array, never as a failure and
//     never as silence — a backtest universe built from this source is
//     survivorship-biased by construction.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../provider-live-cache', () => ({
  liveCacheGet: vi.fn().mockResolvedValue(null),
  liveCacheSet: vi.fn().mockResolvedValue(undefined),
}));
// Inert the real 45rpm pacing bucket — otherwise this suite sleeps per call.
vi.mock('../rate-limiter', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getFinvizBucket: () => ({ acquire: async () => {} }),
}));

import {
  finvizRequest,
  isFinvizThrottleBody,
  finvizThrottleRemainingMs,
  __setFinvizThrottleForTesting,
  parseFinvizBarDate,
  parseFinvizBars,
  fetchFinvizBars,
  parseFinvizInsiders,
  fetchFinvizInsiders,
  parseFinvizOptions,
  parseFinvizFilings,
  parseFinvizManagers,
} from '../finviz';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const ok = (body: string) => Promise.resolve({ ok: true, status: 200, text: async () => body });

const THROTTLE_BODY =
  'This user has performed an unusual high number of requests and has been blocked. Please try again later.';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FINVIZ_AUTH_TOKEN = 'test-token';
  __setFinvizThrottleForTesting(0);
});

describe('throttle circuit breaker', () => {
  it('recognises the measured throttle body', () => {
    expect(isFinvizThrottleBody(THROTTLE_BODY)).toBe(true);
    expect(isFinvizThrottleBody('Date,Open,High,Low,Close,Volume')).toBe(false);
  });

  it('a throttle body at HTTP 200 is a typed failure, not data', async () => {
    fetchMock.mockImplementation(() => ok(THROTTLE_BODY));
    const out = await finvizRequest('stock', { t: 'AAPL' });
    expect(out).toEqual({ ok: false, reason: 'throttled' });
  });

  it('a trip arms a cooldown that short-circuits WITHOUT touching the network', async () => {
    fetchMock.mockImplementation(() => ok(THROTTLE_BODY));
    await finvizRequest('stock', { t: 'AAPL' });
    expect(finvizThrottleRemainingMs()).toBeGreaterThan(0);

    fetchMock.mockClear();
    const out = await finvizRequest('stock', { t: 'MSFT' });
    expect(out).toEqual({ ok: false, reason: 'throttled' });
    expect(fetchMock).not.toHaveBeenCalled(); // no amplification
  });

  it('a real 429 also arms the cooldown', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 429, text: async () => '' }));
    const out = await finvizRequest('stock', { t: 'AAPL' });
    expect(out).toEqual({ ok: false, reason: 'throttled' });
    expect(finvizThrottleRemainingMs()).toBeGreaterThan(0);
  });

  it('distinguishes auth / http / transport / disabled', async () => {
    fetchMock.mockImplementation(() => ok('<!DOCTYPE html><html>login</html>'));
    expect(await finvizRequest('stock', { t: 'A' })).toEqual({ ok: false, reason: 'auth' });

    __setFinvizThrottleForTesting(0);
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 500, text: async () => '' }));
    expect(await finvizRequest('stock', { t: 'A' })).toEqual({ ok: false, reason: 'http' });

    fetchMock.mockImplementation(() => Promise.reject(new Error('ECONNRESET')));
    expect(await finvizRequest('stock', { t: 'A' })).toEqual({ ok: false, reason: 'transport' });

    delete process.env.FINVIZ_AUTH_TOKEN;
    fetchMock.mockClear();
    expect(await finvizRequest('stock', { t: 'A' })).toEqual({ ok: false, reason: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('bars (/export/stock)', () => {
  const DAILY = [
    'Date,Open,High,Low,Close,Volume',
    '08/26/2020,126.179,126.993,125.082,126.522,163022272',
    '08/31/2020,127.58,131,126,129.04,225702688',
  ].join('\n');

  it('parses split-adjusted daily bars', () => {
    const bars = parseFinvizBars(DAILY);
    expect(bars).toHaveLength(2);
    // The split-adjustment guard: unadjusted AAPL was ~$505 here.
    expect(bars[0]).toEqual({
      date: '2020-08-26',
      open: 126.179,
      high: 126.993,
      low: 125.082,
      close: 126.522,
      volume: 163022272,
    });
    expect(bars[0].close).toBeLessThan(200);
  });

  it('parses intraday timestamps', () => {
    const bars = parseFinvizBars(
      ['Date,Open,High,Low,Close,Volume', '07/20/2026 04:00 AM,333.01,333.66,332.98,333.505,6302'].join('\n'),
    );
    expect(bars[0].date).toBe('2026-07-20T04:00');
  });

  it('parseFinvizBarDate handles both shapes and rejects junk', () => {
    expect(parseFinvizBarDate('07/21/2016')).toBe('2016-07-21');
    expect(parseFinvizBarDate('10/14/2025 09:30 AM')).toBe('2025-10-14T09:30');
    expect(parseFinvizBarDate('10/14/2025 01:00 PM')).toBe('2025-10-14T13:00');
    expect(parseFinvizBarDate('not-a-date')).toBeNull();
  });

  it('a DELISTED ticker yields [] (no coverage), while a failure yields null', async () => {
    fetchMock.mockImplementation(() => ok(''));
    // Empty body is a failure shape, not an answer.
    expect(await fetchFinvizBars('TWTR')).toBeNull();

    fetchMock.mockImplementation(() => ok('Date,Open,High,Low,Close,Volume'));
    expect(await fetchFinvizBars('TWTR')).toEqual([]); // header only = covered-but-empty

    fetchMock.mockImplementation(() => ok(THROTTLE_BODY));
    expect(await fetchFinvizBars('AAPL')).toBeNull();
  });

  it('daily omits the p param; other timeframes send it', async () => {
    fetchMock.mockImplementation(() => ok(DAILY));
    await fetchFinvizBars('AAPL', 'd');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('p=');
    fetchMock.mockClear();
    await fetchFinvizBars('AAPL', 'i5');
    expect(String(fetchMock.mock.calls[0][0])).toContain('p=i5');
  });
});

describe('insiders (/export/insiders)', () => {
  const CSV = [
    'Ticker,Owner,Owner CIK,Relationship,Date,Transaction,Cost,#Shares,Value ($),#Shares Total,SEC Form 4,SEC Form 4 Link',
    '"WLFC","Flaherty Scott B.",1676532,"EVP, CFO",07/31/2026,Buy,29.07,148,4302,244324,08/03/2026 14:06,http://www.sec.gov/x',
  ].join('\n');

  it('parses a Form-4 row including the filing timestamp', () => {
    const [tx] = parseFinvizInsiders(CSV);
    expect(tx.ticker).toBe('WLFC');
    expect(tx.owner).toBe('Flaherty Scott B.');
    expect(tx.relationship).toBe('EVP, CFO'); // comma inside quotes
    expect(tx.date).toBe('2026-07-31');
    expect(tx.transaction).toBe('Buy');
    expect(tx.price).toBeCloseTo(29.07);
    expect(tx.valueUsd).toBe(4302);
    expect(tx.filedAt).toBe('2026-08-03T14:06');
  });

  it('market-wide feed omits the ticker param', async () => {
    fetchMock.mockImplementation(() => ok(CSV));
    await fetchFinvizInsiders();
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('t=');
    fetchMock.mockClear();
    await fetchFinvizInsiders('aapl');
    expect(String(fetchMock.mock.calls[0][0])).toContain('t=AAPL');
  });
});

describe('options (/export/options)', () => {
  const CSV = [
    'Contract Name,Last Trade,Expiry,Strike,Last Close,Bid,Ask,Change $,Change %,Volume,Open Int.,Type,IV,Delta,Gamma,Theta,Vega,Rho',
    'AAPL260821C00300000,08/03/2026,08/21/2026,300,12.35,12.30,12.40,0.55,4.66%,1204,8877,Call,0.2841,0.5732,0.0121,-0.1893,0.2447,0.1132',
  ].join('\n');

  it('parses a contract with full greeks', () => {
    const [c] = parseFinvizOptions(CSV);
    expect(c.contract).toBe('AAPL260821C00300000');
    expect(c.expiry).toBe('2026-08-21');
    expect(c.strike).toBe(300);
    expect(c.type).toBe('call');
    expect(c.openInterest).toBe(8877);
    expect(c.iv).toBeCloseTo(0.2841);
    expect(c.delta).toBeCloseTo(0.5732);
    expect(c.theta).toBeCloseTo(-0.1893);
    expect(c.rho).toBeCloseTo(0.1132);
    expect(c.changePct).toBeCloseTo(4.66);
  });
});

describe('filings + managers', () => {
  it('parses filings with EDGAR links', () => {
    const [f] = parseFinvizFilings(
      [
        'Filing Date,Report Date,Form,Description,Filing,Document',
        '7/31/2026,6/27/2026,10-Q,"Quarterly report","https://sec.gov/a","https://sec.gov/b"',
      ].join('\n'),
    );
    expect(f.form).toBe('10-Q');
    expect(f.filingDate).toBe('2026-07-31');
    expect(f.reportDate).toBe('2026-06-27');
    expect(f.documentUrl).toBe('https://sec.gov/b');
  });

  it('parses a 13F manager summary', () => {
    const [m] = parseFinvizManagers(
      [
        'Name,Portfolio Manager,Investor ID,Report Date,Portfolio Value,# Investments,New Purchased,Sold Out,Added,Reduced,Top 10 Concentration (%),Turnover (%),Time Held Top 10,Time Held All',
        '"SUSQUEHANNA INTERNATIONAL GROUP, LLP","",1446194,2026-03-31,893325416442,13000,900,800,3000,2500,18.4,22.1,,',
      ].join('\n'),
    );
    expect(m.name).toBe('SUSQUEHANNA INTERNATIONAL GROUP, LLP');
    expect(m.investorId).toBe('1446194');
    expect(m.portfolioValueUsd).toBe(893325416442);
    expect(m.top10ConcentrationPct).toBeCloseTo(18.4);
    expect(m.portfolioManager).toBeNull(); // empty string → null
  });
});
