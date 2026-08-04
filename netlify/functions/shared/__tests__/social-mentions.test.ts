import { describe, expect, it, vi } from 'vitest';
import {
  MENTIONS_CAVEAT,
  fetchMentionSnapshot,
  normaliseMentionRows,
  readTicker,
  type MentionSnapshot,
} from '../social-mentions';

// Shape verified live 2026-08-04.
const page = (rows: any[], pages = 1) => ({ count: rows.length, pages, results: rows });
const row = (rank: number, ticker: string, mentions: number, extra: any = {}) => ({
  rank, ticker, name: `${ticker} Inc`, mentions, upvotes: mentions * 3,
  rank_24h_ago: rank + 1, mentions_24h_ago: mentions - 1, ...extra,
});

const okFetch = (bodies: any[]) => {
  let i = 0;
  return vi.fn(async () => {
    const b = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(b) } as any;
  });
};

describe('normaliseMentionRows', () => {
  it('parses the live ApeWisdom row shape', () => {
    const rows = normaliseMentionRows([page([
      { rank: 1, ticker: 'MU', name: 'Micron Technology', mentions: 619, upvotes: 3096, rank_24h_ago: 1, mentions_24h_ago: 107 },
    ])]);
    expect(rows[0]).toMatchObject({ ticker: 'MU', rank: 1, mentions: 619, upvotes: 3096, mentions24hAgo: 107 });
  });

  it('keeps mentions24hAgo NULL when the source has no prior observation', () => {
    // A brand-new entrant and a name that collapsed to zero are different
    // events; 0 would erase that distinction.
    const rows = normaliseMentionRows([page([row(1, 'CROX', 1, { mentions_24h_ago: null })])]);
    expect(rows[0].mentions24hAgo).toBeNull();
    expect(rows[0].mentions).toBe(1);
  });

  it('dedupes across pages — the live list reorders under you mid-walk', () => {
    const rows = normaliseMentionRows([
      page([row(1, 'MU', 600), row(2, 'SPY', 500)]),
      page([row(2, 'SPY', 500), row(3, 'PLTR', 280)]),
    ]);
    expect(rows.map((r) => r.ticker)).toEqual(['MU', 'SPY', 'PLTR']);
  });

  it('drops rows missing a ticker or a count rather than defaulting them', () => {
    const rows = normaliseMentionRows([page([
      { rank: 1, mentions: 10 },
      { rank: 2, ticker: 'OK', mentions: 5 },
      { rank: 3, ticker: 'NOCOUNT' },
    ])]);
    expect(rows.map((r) => r.ticker)).toEqual(['OK']);
  });

  it('survives a non-array body', () => {
    expect(normaliseMentionRows([{ detail: 'nope' }, null])).toEqual([]);
  });
});

describe('fetchMentionSnapshot', () => {
  it('walks pages up to the declared count and computes the tracking floor', async () => {
    const f = okFetch([
      page([row(1, 'MU', 600), row(2, 'SPY', 500)], 2),
      page([row(3, 'CROX', 1)], 2),
    ]);
    const snap = await fetchMentionSnapshot('all-stocks', { fetchImpl: f as any });
    expect(snap.available).toBe(true);
    expect(snap.rows).toHaveLength(3);
    expect(snap.floor).toBe(1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('stops at maxPages so a source-side change cannot cause an unbounded crawl', async () => {
    const f = okFetch([page([row(1, 'MU', 600)], 9999)]);
    await fetchMentionSnapshot('all-stocks', { fetchImpl: f as any, maxPages: 3 });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('reports unavailable with a reason on a first-page failure', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503, text: async () => '' }) as any);
    const snap = await fetchMentionSnapshot('all-stocks', { fetchImpl: f as any });
    expect(snap.available).toBe(false);
    expect(snap.rows).toEqual([]);
    expect(snap.reason).toMatch(/HTTP 503/);
  });

  it('keeps a partial walk when a LATER page fails', async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n === 1) return { ok: true, status: 200, text: async () => JSON.stringify(page([row(1, 'MU', 600)], 5)) } as any;
      return { ok: false, status: 500, text: async () => '' } as any;
    });
    const snap = await fetchMentionSnapshot('all-stocks', { fetchImpl: f as any });
    expect(snap.available).toBe(true);
    expect(snap.rows).toHaveLength(1);
  });

  it('parses a text/javascript body — the endpoint has served both', async () => {
    const f = vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: () => 'text/javascript' },
      text: async () => JSON.stringify(page([row(1, 'MU', 600)])),
    }) as any);
    const snap = await fetchMentionSnapshot('all-stocks', { fetchImpl: f as any });
    expect(snap.available).toBe(true);
  });

  it('is unavailable — never an empty success — when parsing yields nothing', async () => {
    const f = okFetch([{ results: [] }]);
    const snap = await fetchMentionSnapshot('all-stocks', { fetchImpl: f as any });
    expect(snap.available).toBe(false);
    expect(snap.reason).toMatch(/no usable rows/);
  });
});

// The three-state model is the whole point of this module. Collapsing
// BELOW_FLOOR into UNAVAILABLE loses a real observation; collapsing it into
// "0 mentions" invents a measurement nobody made.
describe('readTicker — absence is not zero and not missing', () => {
  const snap: MentionSnapshot = {
    date: '2026-08-04', filter: 'all-stocks', available: true, floor: 1,
    reason: null, fetchedAt: '2026-08-04T21:10:00.000Z',
    rows: normaliseMentionRows([page([row(1, 'MU', 600), row(73, 'CELH', 7), row(399, 'CROX', 1)])]),
  };

  it('TRACKED carries the count and the rank', () => {
    const r = readTicker('CELH', snap);
    expect(r.state).toBe('TRACKED');
    expect(r.mentions).toBe(7);
    expect(r.rank).toBe(73);
    expect(r.universeSize).toBe(3);
  });

  it('BELOW_FLOOR gives mentions NULL, never 0', () => {
    const r = readTicker('BROS', snap);
    expect(r.state).toBe('BELOW_FLOOR');
    expect(r.mentions).toBeNull();
    expect(r.floor).toBe(1);
    expect(r.reason).toMatch(/fewer than 1 mentions/);
  });

  it('UNAVAILABLE is distinct from BELOW_FLOOR', () => {
    const r = readTicker('BROS', null);
    expect(r.state).toBe('UNAVAILABLE');
    expect(r.mentions).toBeNull();
    expect(r.floor).toBeNull();
  });

  it('an unavailable snapshot never masquerades as a quiet ticker', () => {
    const bad: MentionSnapshot = { ...snap, available: false, rows: [], reason: 'HTTP 503' };
    const r = readTicker('CELH', bad);
    expect(r.state).toBe('UNAVAILABLE');
    expect(r.reason).toBe('HTTP 503');
  });

  it('is case-insensitive on the ticker', () => {
    expect(readTicker('celh', snap).state).toBe('TRACKED');
  });

  it('always carries the caveat, in every state', () => {
    for (const t of ['CELH', 'BROS']) expect(readTicker(t, snap).caveat).toBe(MENTIONS_CAVEAT);
    expect(readTicker('CELH', null).caveat).toBe(MENTIONS_CAVEAT);
  });

  it('the caveat states the saturation direction', () => {
    expect(MENTIONS_CAVEAT).toMatch(/argues AGAINST an undiscovered setup/);
    expect(MENTIONS_CAVEAT).toMatch(/not zero/i);
  });
});
