// GOOGLE TRENDS — present because it was asked for, unweighted because it
// was measured. These tests pin BOTH halves of that.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TRENDS_CAVEAT, fetchTrends, parseSerpApi, recentVsBase, trendsEnabled } from '../google-trends';

const saved = { serp: process.env.SERPAPI_KEY, direct: process.env.GOOGLE_TRENDS_ALLOW_DIRECT };
beforeEach(() => { delete process.env.SERPAPI_KEY; delete process.env.GOOGLE_TRENDS_ALLOW_DIRECT; });
afterEach(() => {
  if (saved.serp) process.env.SERPAPI_KEY = saved.serp; else delete process.env.SERPAPI_KEY;
  if (saved.direct) process.env.GOOGLE_TRENDS_ALLOW_DIRECT = saved.direct; else delete process.env.GOOGLE_TRENDS_ALLOW_DIRECT;
});

const body = (rows: Array<{ date: string; v: number; partial?: boolean }>) => ({
  interest_over_time: {
    timeline_data: rows.map((r) => ({
      date: r.date, partial_data: r.partial ?? false, values: [{ extracted_value: r.v }],
    })),
  },
});

const mock = (payload: any, status = 200) =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })) as unknown as typeof fetch;

describe('parseSerpApi', () => {
  it('parses complete buckets', () => {
    const s = parseSerpApi(body([{ date: 'w1', v: 40 }, { date: 'w2', v: 60 }]), 'crocs', 'today 12-m', 'US');
    expect(s.available).toBe(true);
    expect(s.points).toEqual([{ date: 'w1', value: 40 }, { date: 'w2', value: 60 }]);
  });

  it('DROPS the in-progress bucket', () => {
    // Including it makes the newest point look like a collapse in interest
    // when it is only a partial week.
    const s = parseSerpApi(body([{ date: 'w1', v: 80 }, { date: 'w2', v: 9, partial: true }]), 'x', 't', 'US');
    expect(s.points).toHaveLength(1);
    expect(s.points[0].value).toBe(80);
  });

  it('reports unavailable rather than inventing a series', () => {
    const s = parseSerpApi({}, 'x', 't', 'US');
    expect(s.available).toBe(false);
    expect(s.points).toEqual([]);
    expect(s.reason).toBeTruthy();
  });
});

describe('recentVsBase', () => {
  it('is null below 16 points instead of extrapolating', () => {
    expect(recentVsBase(Array.from({ length: 10 }, (_, i) => ({ date: `${i}`, value: 50 })))).toBeNull();
  });

  it('measures the last 4 against the prior 12', () => {
    const pts = [
      ...Array.from({ length: 12 }, (_, i) => ({ date: `b${i}`, value: 40 })),
      ...Array.from({ length: 4 }, (_, i) => ({ date: `r${i}`, value: 60 })),
    ];
    expect(recentVsBase(pts)).toBe(20);
  });
});

describe('transport policy', () => {
  it('is disabled with no key, and says so usefully', async () => {
    expect(trendsEnabled()).toBe(false);
    const s = await fetchTrends('crocs');
    expect(s.available).toBe(false);
    expect(s.transport).toBe('none');
    expect(s.reason).toMatch(/SERPAPI_KEY/);
    expect(s.reason).toMatch(/carries no weight|context only/i);
  });

  it('uses SerpApi when the key is set', async () => {
    process.env.SERPAPI_KEY = 'k';
    const s = await fetchTrends('crocs', { fetchImpl: mock(body([{ date: 'w1', v: 50 }])) });
    expect(s.transport).toBe('serpapi');
    expect(s.available).toBe(true);
  });

  it('REFUSES the direct transport even when opted in — robots.txt disallows it', async () => {
    process.env.GOOGLE_TRENDS_ALLOW_DIRECT = '1';
    expect(trendsEnabled()).toBe(true);
    const s = await fetchTrends('crocs');
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/robots\.txt/);
  });

  it('surfaces a SerpApi error instead of an empty-looking success', async () => {
    process.env.SERPAPI_KEY = 'k';
    const s = await fetchTrends('crocs', { fetchImpl: mock({ error: 'ran out of searches' }) });
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/ran out of searches/);
  });
});

describe('the caveat travels with the data', () => {
  it('is on every payload, available or not', async () => {
    expect((await fetchTrends('x')).caveat).toBe(TRENDS_CAVEAT);
    process.env.SERPAPI_KEY = 'k';
    const ok = await fetchTrends('x', { fetchImpl: mock(body([{ date: 'w', v: 1 }])) });
    expect(ok.caveat).toMatch(/NO weight/);
  });
});
