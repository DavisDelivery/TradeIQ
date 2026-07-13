// Phase 4o W1 — 429 backoff-and-retry behavior for the Finnhub insider
// data provider. The russell2k scan's silent-empty Bug A had its root
// cause here: a 429 became `return []` with only a `console.warn`. The
// new code must retry on 429 and, after exhaustion, surface a flag the
// scan can propagate up into the snapshot warnings + the W3 guard.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getFinnhubInsiderTransactions,
  getFinnhubInsiderTransactionsWithStatus,
} from '../data-provider';
import { _resetFinnhubBucketForTests } from '../rate-limiter';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.POLYGON_API_KEY = 'test-poly';
  process.env.FINNHUB_API_KEY = 'test-finn';
  process.env.FINNHUB_RPM = '600'; // generous so the bucket doesn't block tests
  _resetFinnhubBucketForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.FINNHUB_RPM;
});

function makeFakeRes(body: any, opts: { status?: number; retryAfter?: string } = {}): any {
  const headers = new Map<string, string>();
  if (opts.retryAfter) headers.set('retry-after', opts.retryAfter);
  return {
    ok: (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('getFinnhubInsiderTransactionsWithStatus — 429 backoff-and-retry', () => {
  it('retries on 429 and returns rows when a later attempt succeeds', async () => {
    let idx = 0;
    globalThis.fetch = vi.fn(async () => {
      idx += 1;
      if (idx <= 2) return makeFakeRes(null, { status: 429 });
      return makeFakeRes({
        data: [
          {
            name: 'CEO',
            share: 100,
            change: 100,
            filingDate: '2024-05-15',
            transactionDate: '2024-05-13',
            transactionPrice: 50,
            transactionCode: 'P',
            isDerivative: false,
            source: 'F4',
            currency: 'USD',
          },
        ],
      });
    }) as any;

    // The patient retry envelope (2s..20s backoff, ~50s worst case) uses
    // real setTimeout sleeps — pump them with fake timers.
    vi.useFakeTimers();
    try {
      const p = getFinnhubInsiderTransactionsWithStatus('NVDA', 180);
      await vi.runAllTimersAsync();
      const r = await p;
      expect(r.data).toHaveLength(1);
      expect(r.rateLimited).toBe(true);
      expect(r.rateLimitExhausted).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flags rateLimitExhausted=true when every retry returns 429', async () => {
    globalThis.fetch = vi.fn(async () => makeFakeRes(null, { status: 429 })) as any;
    vi.useFakeTimers();
    try {
      const p = getFinnhubInsiderTransactionsWithStatus('NVDA', 180);
      await vi.runAllTimersAsync();
      const r = await p;
      expect(r.data).toEqual([]);
      expect(r.rateLimited).toBe(true);
      expect(r.rateLimitExhausted).toBe(true);
      // maxRetries 5 ⇒ 6 total attempts before exhaustion.
      expect(globalThis.fetch).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('first attempt 200 keeps both flags false', async () => {
    globalThis.fetch = vi.fn(async () => makeFakeRes({ data: [] })) as any;
    const r = await getFinnhubInsiderTransactionsWithStatus('NVDA', 180);
    expect(r.rateLimited).toBe(false);
    expect(r.rateLimitExhausted).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('non-429 error flows through with errorMessage set', async () => {
    globalThis.fetch = vi.fn(async () => makeFakeRes(null, { status: 500 })) as any;
    const r = await getFinnhubInsiderTransactionsWithStatus('NVDA', 180);
    expect(r.data).toEqual([]);
    expect(r.rateLimitExhausted).toBe(false);
    expect(r.errorMessage).toBe('finnhub status 500');
  });

  it('getFinnhubInsiderTransactions (legacy signature) returns the same rows on 429-then-success', async () => {
    let idx = 0;
    globalThis.fetch = vi.fn(async () => {
      idx += 1;
      if (idx === 1) return makeFakeRes(null, { status: 429 });
      return makeFakeRes({
        data: [
          {
            name: 'CFO',
            share: 50,
            change: 50,
            filingDate: '2024-08-15',
            transactionDate: '2024-08-13',
            transactionPrice: 60,
            transactionCode: 'P',
            isDerivative: false,
            source: 'F4',
            currency: 'USD',
          },
        ],
      });
    }) as any;
    const rows = await getFinnhubInsiderTransactions('NVDA', 180);
    expect(rows).toHaveLength(1);
    // Confirms the retry path is actually being taken — 2 fetches, not 1.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
