// TREND-1 — regression tests for EDGAR filing-mention attribution.
//
// The bucket-key fixtures below are VERBATIM from live EDGAR responses
// captured 2026-08-03, including the double-space separators and the
// multi-class ticker form. EDGAR publishes no schema for this
// aggregation, so the parser is only as good as the shapes it is pinned
// against.
//
// The behaviour these tests exist to protect:
//   1. A phrase that scatters across unrelated filers is reported as
//      AMBIGUOUS, not presented as an attribution (the homonym trap).
//   2. A throttled/malformed EDGAR response THROWS rather than being
//      read as "zero filings mention this phrase" — those two mean
//      opposite things to the user.

import { describe, expect, it } from 'vitest';
import {
  EFTS_EPOCH,
  MIN_SPECIFICITY,
  fetchExposure,
  fetchPageviews,
  mom,
  parseBucketKey,
  specificityOf,
  yoy,
} from '../trend-exposure';

// --- live-captured bucket keys ------------------------------------------
const KEY_SIMPLE = 'Crocs, Inc.  (CROX)  (CIK 0001334036)';
const KEY_MULTI = 'ALBEMARLE CORP  (ALB, ALB-PA)  (CIK 0000915913)';
const KEY_NO_TICKER = 'Blackstone Private Equity Strategies Fund L.P.  (CIK 0001930054)';

function mockFetch(payload: unknown, status = 200) {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }) as unknown as Response;
}

function edgarPayload(total: number, buckets: Array<[string, number]>) {
  return {
    hits: { total: { value: total } },
    aggregations: { entity_filter: { buckets: buckets.map(([key, doc_count]) => ({ key, doc_count })) } },
  };
}

describe('parseBucketKey', () => {
  it('extracts name, ticker and zero-padded CIK from the standard shape', () => {
    expect(parseBucketKey(KEY_SIMPLE)).toEqual({
      name: 'Crocs, Inc.',
      ticker: 'CROX',
      tickers: ['CROX'],
      cik: '0001334036',
    });
  });

  it('keeps every share class but reports the first as the primary ticker', () => {
    const p = parseBucketKey(KEY_MULTI);
    expect(p.name).toBe('ALBEMARLE CORP');
    expect(p.tickers).toEqual(['ALB', 'ALB-PA']);
    expect(p.ticker).toBe('ALB');
  });

  it('treats a missing ticker as "not listed", not as a parse failure', () => {
    const p = parseBucketKey(KEY_NO_TICKER);
    expect(p.name).toBe('Blackstone Private Equity Strategies Fund L.P.');
    expect(p.ticker).toBeNull();
    expect(p.cik).toBe('0001930054');
  });

  it('does not swallow a company name that ends in parentheses', () => {
    const p = parseBucketKey('Some Holdings (Delaware)  (CIK 0000000123)');
    expect(p.name).toBe('Some Holdings (Delaware)');
    expect(p.ticker).toBeNull();
  });

  // 2026-08-03 review: the ticker character class is [A-Z0-9.-], so an
  // ALL-CAPS parenthetical belonging to the company's own name matched it
  // and was reported as a ticker. The mixed-case "(Delaware)" case above
  // never caught this. EDGAR delimits real fields with TWO spaces, which is
  // what distinguishes them.
  it('does not mistake an all-caps name suffix for a ticker', () => {
    const p = parseBucketKey('SANOFI (US)  (CIK 0001121404)');
    expect(p.name).toBe('SANOFI (US)');
    expect(p.ticker).toBeNull();
    expect(p.cik).toBe('0001121404');
  });
});

describe('specificityOf', () => {
  it('is high when one filer dominates', () => {
    expect(specificityOf([{ doc_count: 22 }, { doc_count: 2 }], 31)).toBeCloseTo(0.71, 2);
  });

  it('collapses when mentions scatter — the homonym signature', () => {
    // Live: bare "Celsius" over 2y, 384 filings, top bucket 17.
    expect(specificityOf([{ doc_count: 17 }, { doc_count: 4 }], 384)).toBeLessThan(MIN_SPECIFICITY);
  });

  it('is null with no hits rather than dividing by zero', () => {
    expect(specificityOf([], 0)).toBeNull();
  });
});

describe('fetchExposure', () => {
  it('attributes a clean single-owner phrase', async () => {
    const res = await fetchExposure('HeyDude', {
      fetchImpl: mockFetch(edgarPayload(16, [[KEY_SIMPLE, 7], ['CALERES INC  (CAL)  (CIK 0000014707)', 4]])),
    });
    expect(res.totalFilings).toBe(16);
    expect(res.filers[0].ticker).toBe('CROX');
    expect(res.filers[0].share).toBeCloseTo(7 / 16, 4);
    expect(res.ambiguous).toBe(false);
    expect(res.noListedMention).toBe(false);
  });

  it('flags a scattered phrase as ambiguous instead of attributing it', async () => {
    const res = await fetchExposure('Celsius', {
      fetchImpl: mockFetch(
        edgarPayload(384, [
          ['Celsius Holdings, Inc.  (CELH)  (CIK 0001341766)', 17],
          ['ALBEMARLE CORP  (ALB, ALB-PA)  (CIK 0000915913)', 4],
        ]),
      ),
    });
    expect(res.ambiguous).toBe(true);
    expect(res.specificity).toBeLessThan(MIN_SPECIFICITY);
    // The ranking is still returned — the flag is the guard, not censorship.
    expect(res.filers[0].ticker).toBe('CELH');
  });

  it('reports zero hits as "no listed mention", which is a real answer', async () => {
    const res = await fetchExposure('Stanley Quencher', {
      fetchImpl: mockFetch(edgarPayload(0, [])),
    });
    expect(res.noListedMention).toBe(true);
    expect(res.specificity).toBeNull();
    expect(res.ambiguous).toBe(false);
    expect(res.filers).toEqual([]);
  });

  it('THROWS on a malformed/throttled payload — never reads it as zero hits', async () => {
    // This is the silent-failure guard. EDGAR under load returns a body
    // with no `hits` block; treating that as "nothing mentions this" would
    // tell the user a private-brand story that isn't true.
    await expect(
      fetchExposure('Crocs', { fetchImpl: mockFetch({ error: 'throttled' }) }),
    ).rejects.toThrow(/no hits block/i);
  });

  it('throws on a non-2xx response', async () => {
    await expect(
      fetchExposure('Crocs', { fetchImpl: mockFetch({}, 429) }),
    ).rejects.toThrow(/429/);
  });

  // 2026-08-03 review: EFTS_EPOCH was exported but never applied, while the
  // "Max" window allows 9000 days — a start date EDGAR's full-text index
  // cannot answer, reported back as if it had.
  it('clamps the start date to the EDGAR full-text epoch', async () => {
    const res = await fetchExposure('Crocs', {
      startDate: '1994-01-01',
      fetchImpl: mockFetch(edgarPayload(1, [[KEY_SIMPLE, 1]])),
    });
    expect(res.startDate).toBe(EFTS_EPOCH);
  });
});

describe('pageview deltas', () => {
  const series = (n: number, fn: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({ views: fn(i) }));

  it('returns null rather than a fabricated number when history is short', () => {
    expect(yoy(series(100, () => 10))).toBeNull();
    expect(mom(series(30, () => 10))).toBeNull();
  });

  it('computes a 28d-over-28d change', () => {
    // Last 28 days at 200, prior 28 at 100 => +100%.
    const pts = [...series(28, () => 100), ...series(28, () => 200)];
    expect(mom(pts)).toBeCloseTo(100, 5);
  });

  it('guards against a zero baseline', () => {
    const pts = [...series(28, () => 0), ...series(28, () => 50)];
    expect(mom(pts)).toBeNull();
  });
});

describe('fetchPageviews', () => {
  it('treats a 404 as "no pageview record", not an error', async () => {
    const res = await fetchPageviews('Nonexistent_Article', { fetchImpl: mockFetch({}, 404) });
    expect(res.points).toEqual([]);
    expect(res.yoyPct).toBeNull();
  });

  it('parses the compact timestamp format into ISO dates', async () => {
    const res = await fetchPageviews('Crocs', {
      fetchImpl: mockFetch({
        items: [
          { timestamp: '2026070100', views: 1200 },
          { timestamp: '2026070200', views: 1350 },
        ],
      }),
    });
    expect(res.points).toEqual([
      { date: '2026-07-01', views: 1200 },
      { date: '2026-07-02', views: 1350 },
    ]);
  });
});
