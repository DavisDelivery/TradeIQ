// Phase 4w W2 — Massive Financials client unit tests.
//
// Pins the per-endpoint contract: URL params, WithStatus envelope on success
// vs rate-limit vs hard error, PIT cache discipline (write only on verified
// result; never poison on throw).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  fetchRatiosWithStatus,
  fetchIncomeStatementsWithStatus,
  fetchBalanceSheetsWithStatus,
  fetchCashFlowStatementsWithStatus,
  getIncomeStatementsPit,
  makeLiveCache,
} from '../massive-fundamentals';
import { __setDbForTesting } from '../pit-cache';

const ORIGINAL_FETCH = globalThis.fetch;

// In-memory Firestore fake (mirrors pit-cache.test.ts).
function makeFakeDb() {
  const store = new Map<string, unknown>();
  const docRef = (id: string) => ({
    id,
    async get() { const v = store.get(id); return { exists: v !== undefined, data: () => v }; },
    async set(payload: unknown) { store.set(id, payload); },
  });
  return {
    collection: () => ({ doc: docRef }),
    async getAll(...refs: ReturnType<typeof docRef>[]) {
      return refs.map((r) => {
        const v = store.get(r.id);
        return { exists: v !== undefined, data: () => v };
      });
    },
    __store: store,
  };
}

let fakeDb: ReturnType<typeof makeFakeDb>;

beforeEach(() => {
  process.env.MASSIVE_FUNDAMENTALS_API_KEY = 'test-key';
  delete process.env.PIT_CACHE_BYPASS;
  fakeDb = makeFakeDb();
  __setDbForTesting(fakeDb as never);
});
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

function jsonRes(body: unknown, init: { status?: number } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
}

describe('Massive WithStatus fetch helpers', () => {
  it('fetchRatiosWithStatus returns the verified row', async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      expect(url).toContain('/stocks/financials/v1/ratios');
      expect(url).toContain('ticker=NVDA');
      expect(url).toContain('apiKey=test-key');
      return jsonRes({ status: 'OK', results: [{ ticker: 'NVDA', price_to_earnings: 29.4 }] });
    }) as any;
    const r = await fetchRatiosWithStatus('NVDA');
    expect(r.rateLimited).toBe(false);
    expect(r.rateLimitExhausted).toBe(false);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].price_to_earnings).toBe(29.4);
  });

  it('income/balance/cashflow URLs include filing_date.lte and the quarterly sort', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      seen.push(url);
      return jsonRes({ status: 'OK', results: [] });
    }) as any;
    await fetchIncomeStatementsWithStatus('AAPL', { asOfDate: '2019-03-31' });
    await fetchBalanceSheetsWithStatus('AAPL', { asOfDate: '2019-03-31' });
    await fetchCashFlowStatementsWithStatus('AAPL', { asOfDate: '2019-03-31' });
    expect(seen[0]).toMatch(/income-statements\?.*filing_date\.lte=2019-03-31/);
    expect(seen[1]).toMatch(/balance-sheets\?.*filing_date\.lte=2019-03-31/);
    expect(seen[2]).toMatch(/cash-flow-statements\?.*filing_date\.lte=2019-03-31/);
    expect(seen.every((u) => u.includes('timeframe=quarterly'))).toBe(true);
    expect(seen.every((u) => u.includes('sort=period_end.desc'))).toBe(true);
    // Regression — the statement endpoints filter by `tickers` (PLURAL).
    // Sending the singular `ticker` is silently ignored and returns the
    // default page (the AVGO→Deere bug). Pin the plural param and assert the
    // singular form never appears.
    expect(seen.every((u) => /[?&]tickers=AAPL/.test(u))).toBe(true);
    expect(seen.some((u) => /[?&]ticker=AAPL/.test(u))).toBe(false);
  });

  it('GUARD: keeps only statement rows whose `tickers` includes the request', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonRes({
        status: 'OK',
        results: [
          { tickers: ['AVGO'], revenue: 19311000000, period_end: '2026-02-01' },
          { tickers: ['DE', 'DEw'], revenue: 13369000000, period_end: '2026-05-03' },
        ],
      }),
    ) as any;
    const r = await fetchIncomeStatementsWithStatus('AVGO');
    expect(r.errorMessage).toBeUndefined();
    expect(r.data).toHaveLength(1);
    expect(r.data[0].revenue).toBe(19311000000);
  });

  it('GUARD: a non-empty response that matches NOTHING is a hard error, not silent data', async () => {
    // The AVGO→Deere signature: rows returned, none belong to the request.
    globalThis.fetch = vi.fn(async () =>
      jsonRes({ status: 'OK', results: [{ tickers: ['DE', 'DEw'], revenue: 13369000000 }] }),
    ) as any;
    const r = await fetchIncomeStatementsWithStatus('AVGO');
    expect(r.data).toEqual([]);
    expect(r.errorMessage).toMatch(/none match AVGO/);
  });

  it('GUARD: a legitimately-empty response stays empty (no error)', async () => {
    globalThis.fetch = vi.fn(async () => jsonRes({ status: 'OK', results: [] })) as any;
    const r = await fetchBalanceSheetsWithStatus('AVGO');
    expect(r.data).toEqual([]);
    expect(r.errorMessage).toBeUndefined();
  });

  it('GUARD: ratios filters by the singular `ticker` field, dropping a mismatch', async () => {
    // ?tickers= is ignored by ratios and returns the wrong company (→ "A");
    // the row-identity filter drops it rather than mis-attributing ratios.
    globalThis.fetch = vi.fn(async () =>
      jsonRes({ status: 'OK', results: [{ ticker: 'A', price_to_earnings: 27.14 }] }),
    ) as any;
    const r = await fetchRatiosWithStatus('AVGO');
    expect(r.data).toEqual([]);
  });

  it('surfaces a 429 as rateLimitExhausted (no data, no errorMessage)', async () => {
    globalThis.fetch = vi.fn(async () => jsonRes({ error: 'too many' }, { status: 429 })) as any;
    const r = await fetchRatiosWithStatus('NVDA');
    expect(r.rateLimitExhausted).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('surfaces a 500 as errorMessage (no rate-limit flags)', async () => {
    globalThis.fetch = vi.fn(async () => jsonRes({ error: 'oops' }, { status: 500 })) as any;
    const r = await fetchIncomeStatementsWithStatus('NVDA');
    expect(r.rateLimitExhausted).toBe(false);
    expect(r.errorMessage).toMatch(/500/);
    expect(r.data).toEqual([]);
  });
});

describe('getIncomeStatementsPit — pit-cache discipline', () => {
  it('throws on rate-limit-exhausted AND leaves the cache untouched', async () => {
    globalThis.fetch = vi.fn(async () => jsonRes({}, { status: 429 })) as any;
    await expect(getIncomeStatementsPit('NVDA', '2024-09-30', 4)).rejects.toThrow(/rate-limit/);
    expect(fakeDb.__store.size).toBe(0);
  });

  it('throws on hard error AND leaves the cache untouched', async () => {
    globalThis.fetch = vi.fn(async () => jsonRes({}, { status: 503 })) as any;
    await expect(getIncomeStatementsPit('NVDA', '2024-09-30', 4)).rejects.toThrow(/503/);
    expect(fakeDb.__store.size).toBe(0);
  });

  it('caches verified data on success (including legitimately-empty)', async () => {
    globalThis.fetch = vi.fn(async () => jsonRes({ status: 'OK', results: [] })) as any;
    const out = await getIncomeStatementsPit('NVDA', '2024-09-30', 4);
    expect(out).toEqual([]);
    expect(fakeDb.__store.size).toBe(1);

    // Second call must hit the cache, not fetch.
    let fetchHits = 0;
    globalThis.fetch = vi.fn(async () => { fetchHits++; return jsonRes({ status: 'OK', results: [] }); }) as any;
    const cached = await getIncomeStatementsPit('NVDA', '2024-09-30', 4);
    expect(cached).toEqual([]);
    expect(fetchHits).toBe(0);
  });
});

describe('makeLiveCache (24h TTL)', () => {
  it('returns the cached value within TTL and expires after', () => {
    const c = makeLiveCache<number>();
    c.set('AAPL', 1);
    expect(c.get('AAPL')).toBe(1);
    // Simulate clock advance by stubbing Date.now.
    const real = Date.now;
    Date.now = () => real() + 25 * 60 * 60 * 1000;
    try {
      expect(c.get('AAPL')).toBeUndefined();
    } finally {
      Date.now = real;
    }
  });
});
