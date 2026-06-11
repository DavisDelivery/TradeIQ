// Wave 4B (code-review-2026-06 infra minor 13) — a transient failure
// fetching SEC's company_tickers.json must NOT be cached as an empty map
// for the life of the warm instance (which silently disabled all role
// enrichment until the next cold start). Failures leave the cache unset
// so a later call retries, gated by a 60s backoff so a hard SEC outage
// isn't hammered.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _getTickerToCikMapForTests as getTickerToCikMap,
  _resetEdgarCachesForTests,
} from '../edgar-roles';

const ORIGINAL_FETCH = globalThis.fetch;

const TICKER_JSON = {
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA Corp' },
};

function res(status: number, body: any): any {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let nowMs: number;

beforeEach(() => {
  _resetEdgarCachesForTests();
  nowMs = 1_750_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  _resetEdgarCachesForTests();
});

describe('EDGAR ticker→CIK map — failure is retried, not cached (Wave 4B)', () => {
  it('retries after a failed fetch once the backoff window passes, then caches the success', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return res(503, { error: 'SEC maintenance' });
      return res(200, TICKER_JSON);
    }) as any;

    // 1st call fails — empty map returned, NOT cached as success.
    const m1 = await getTickerToCikMap();
    expect(m1.size).toBe(0);
    expect(calls).toBe(1);

    // Advance past the 60s backoff — the next call must RETRY (pre-fix
    // code cached the empty map forever and never fetched again).
    nowMs += 61_000;
    const m2 = await getTickerToCikMap();
    expect(calls).toBe(2);
    expect(m2.size).toBe(2);
    expect(m2.get('AAPL')).toBe('0000320193');

    // Success is cached — third call does not refetch.
    const m3 = await getTickerToCikMap();
    expect(calls).toBe(2);
    expect(m3).toBe(m2);
  });

  it('does not hammer SEC within the 60s backoff window', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return res(503, { error: 'down' });
    }) as any;

    await getTickerToCikMap();
    expect(calls).toBe(1);

    // 10s later — still inside backoff; no second fetch.
    nowMs += 10_000;
    const m = await getTickerToCikMap();
    expect(calls).toBe(1);
    expect(m.size).toBe(0);

    // 61s after the failure — backoff expired, retry happens.
    nowMs += 51_000;
    await getTickerToCikMap();
    expect(calls).toBe(2);
  });

  it('treats a thrown fetch (network error) the same as a non-OK status', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return res(200, TICKER_JSON);
    }) as any;

    const m1 = await getTickerToCikMap();
    expect(m1.size).toBe(0);

    nowMs += 61_000;
    const m2 = await getTickerToCikMap();
    expect(m2.size).toBe(2);
    expect(calls).toBe(2);
  });

  it('does not cache a 200 that parses to zero tickers (truncated/garbage body)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return res(200, {});
      return res(200, TICKER_JSON);
    }) as any;

    const m1 = await getTickerToCikMap();
    expect(m1.size).toBe(0);

    nowMs += 61_000;
    const m2 = await getTickerToCikMap();
    expect(m2.size).toBe(2);
  });
});
