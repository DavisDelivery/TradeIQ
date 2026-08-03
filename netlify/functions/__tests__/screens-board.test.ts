// FVZ-3 — /api/screens-board.
//
// The status contract is the thing worth pinning: a screen returning zero
// rows is a LEGITIMATE 200 (a mean-reversion screen should be empty in a
// melt-up), while an upstream failure must be a 502 and a missing token a
// 503. Collapsing those into "empty list" is how a dead feed silently
// becomes "nothing qualifies today" — the exact failure mode that hid the
// earnings-board outage earlier this year.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getUniverse: vi.fn(),
  fetchScreener: vi.fn(),
  enabled: vi.fn(() => true),
}));

vi.mock('../shared/finviz', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return {
    ...orig,
    finvizEnabled: h.enabled,
    getFinvizUniverseSnapshot: h.getUniverse,
    fetchFinvizScreener: h.fetchScreener,
  };
});

import { handler } from '../screens-board';

const call = async (qs?: Record<string, string>) => {
  const res: any = await handler({ queryStringParameters: qs ?? null } as any, {} as any, () => {});
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
};

const row = (over: Record<string, unknown> = {}) => ({
  ticker: 'AAA',
  sector: 'Technology',
  marketCapM: 50_000,
  pe: 20,
  price: 100,
  avgVolume: 5000,
  high52wDistPct: -3,
  low52wDistPct: 50,
  perfYearPct: 30,
  beta: 0.8,
  roePct: 25,
  debtToEquity: 0.2,
  rsi14: 55,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled.mockReturnValue(true);
  h.getUniverse.mockResolvedValue({
    universe: 'sp500',
    rows: [row(), row({ ticker: 'BBB', high52wDistPct: -1 })],
    fetchedAt: new Date().toISOString(),
    source: 'cache',
    missingHeaders: [],
  });
});

describe('catalog', () => {
  it('no screen param returns the catalog with evidence grades', async () => {
    const { statusCode, body } = await call();
    expect(statusCode).toBe(200);
    expect(body.screens.length).toBeGreaterThan(5);
    const squeeze = body.screens.find((s: any) => s.id === 'short-squeeze');
    expect(squeeze.evidence).toBe('contrary');
    // Catalog must be JSON-serializable — predicates/rank are functions.
    expect(JSON.stringify(body)).not.toContain('function');
  });
});

describe('running a screen', () => {
  it('serves matches ranked, with provenance', async () => {
    const { statusCode, body } = await call({ screen: 'high52w', universe: 'sp500' });
    expect(statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.rows.map((r: any) => r.ticker)).toEqual(['BBB', 'AAA']); // nearest high first
    expect(body.universeChecked).toBe(2);
    expect(body.dataSource).toBe('cache');
    expect(body.screen.evidence).toBe('academic');
  });

  it('a screen with its own filters issues a dedicated scoped fetch', async () => {
    h.fetchScreener.mockResolvedValue({ rows: [row({ ticker: 'CCC', sma50DistPct: 5 })], missingHeaders: [] });
    const { statusCode, body } = await call({ screen: 'minervini', universe: 'ndx' });
    expect(statusCode).toBe(200);
    expect(h.getUniverse).not.toHaveBeenCalled();
    // The universe filter must be prepended, else the screen scans everything.
    expect(h.fetchScreener.mock.calls[0][0][0]).toBe('idx_ndx');
    expect(body.dataSource).toBe('live');
  });

  it('ZERO matches is a 200, not an error', async () => {
    h.getUniverse.mockResolvedValue({
      universe: 'sp500',
      rows: [row({ high52wDistPct: -80 })], // nothing near its high
      fetchedAt: new Date().toISOString(),
      source: 'cache',
      missingHeaders: [],
    });
    const { statusCode, body } = await call({ screen: 'high52w' });
    expect(statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.rows).toEqual([]);
    expect(body.universeChecked).toBe(1); // proves we actually looked
  });
});

describe('failure contract', () => {
  it('upstream failure is 502 — never an empty result set', async () => {
    h.getUniverse.mockResolvedValue(null);
    const { statusCode, body } = await call({ screen: 'high52w' });
    expect(statusCode).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.rows).toBeUndefined();
  });

  it('a failed dedicated screener fetch is 502', async () => {
    h.fetchScreener.mockResolvedValue(null);
    const { statusCode } = await call({ screen: 'minervini' });
    expect(statusCode).toBe(502);
  });

  it('missing token is 503 and does not touch the network', async () => {
    h.enabled.mockReturnValue(false);
    const { statusCode, body } = await call({ screen: 'high52w' });
    expect(statusCode).toBe(503);
    expect(body.enabled).toBe(false);
    expect(h.getUniverse).not.toHaveBeenCalled();
  });

  it('unknown screen is 404 and lists the valid ids', async () => {
    const { statusCode, body } = await call({ screen: 'nope' });
    expect(statusCode).toBe(404);
    expect(body.screens).toContain('high52w');
  });

  it('unknown universe is 400', async () => {
    const { statusCode } = await call({ screen: 'high52w', universe: 'nasdaq' });
    expect(statusCode).toBe(400);
  });

  it('a thrown error is 500, not a silent empty board', async () => {
    h.getUniverse.mockRejectedValue(new Error('boom'));
    const { statusCode, body } = await call({ screen: 'high52w' });
    expect(statusCode).toBe(500);
    expect(body.error).toContain('boom');
  });
});
