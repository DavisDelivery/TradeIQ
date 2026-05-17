// Phase 4l W1 — `index=all` aggregates the four per-universe insider snapshots
// (sp500 ∪ ndx ∪ dow ∪ russell2k), de-duplicates by ticker, re-aggregates to
// the requested window, sorts, trims. Replaces the prior 80-cap live scan.
//
// Tests verify: union+dedup, graceful partial when one universe is absent or
// stale, generatedAt reflects the oldest contributor, stale flag honest, and
// `source: 'snapshot-aggregate'` (never `fallback-partial` when at least one
// snapshot exists).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UniverseKey } from '../shared/snapshot-store';

const mocks = vi.hoisted(() => ({
  snapshots: new Map<string, any>(),
  runInsiderScan: vi.fn(),
}));

vi.mock('../shared/snapshot-store', async () => {
  const actual = await vi.importActual<any>('../shared/snapshot-store');
  return {
    ...actual,
    latestSnapshot: vi.fn(async (_board: string, universe: UniverseKey) =>
      mocks.snapshots.get(universe) ?? null,
    ),
    isSnapshotFresh: vi.fn((snap: any, now: number = Date.now()) =>
      now - new Date(snap.generatedAt).getTime() < snap.freshnessBudgetMs,
    ),
    snapshotAgeMs: vi.fn((snap: any, now: number = Date.now()) =>
      now - new Date(snap.generatedAt).getTime(),
    ),
  };
});

vi.mock('../shared/scan-insider', async () => {
  const actual = await vi.importActual<any>('../shared/scan-insider');
  return {
    ...actual,
    runInsiderScan: mocks.runInsiderScan,
  };
});

vi.mock('../shared/logger', () => ({
  logger: {
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
}));

vi.mock('../shared/model-version', () => ({ MODEL_VERSION: 'test-model' }));

import { handler } from '../insider-board';

function row(ticker: string, opts: { buyDollars?: number; netDollars?: number; sellDollars?: number; filings?: any[] } = {}) {
  const now = new Date().toISOString();
  return {
    ticker,
    buyDollars: opts.buyDollars ?? 100_000,
    awardDollars: 0,
    sellDollars: opts.sellDollars ?? 0,
    netDollars: opts.netDollars ?? opts.buyDollars ?? 100_000,
    buyerCount: 1,
    totalBuys: 1,
    totalAwards: 0,
    totalSells: 0,
    topBuyer: { name: `Insider-${ticker}`, role: 'CEO', dollars: opts.buyDollars ?? 100_000 },
    latestFilingDate: now,
    daysSinceLatest: 1,
    filings: opts.filings ?? [
      {
        name: `Insider-${ticker}`,
        role: 'CEO',
        shares: 100,
        dollars: opts.buyDollars ?? 100_000,
        filingDate: now,
        transactionDate: now,
        code: 'P',
        daysSince: 1,
      },
    ],
  };
}

function snapshot(opts: {
  ageMs: number;
  results: any[];
  budgetMs?: number;
  universeChecked?: number;
}) {
  return {
    modelVersion: 'test-model',
    generatedAt: new Date(Date.now() - opts.ageMs).toISOString(),
    scanDurationMs: 1000,
    universeChecked: opts.universeChecked ?? opts.results.length,
    results: opts.results,
    freshnessBudgetMs: opts.budgetMs ?? 24 * 60 * 60_000,
    warnings: [],
  };
}

function evt(qs: Record<string, string>) {
  return {
    httpMethod: 'GET',
    queryStringParameters: qs,
    headers: {},
    body: null,
  } as any;
}

beforeEach(() => {
  mocks.snapshots.clear();
  mocks.runInsiderScan.mockReset();
});

describe('insider-board — index=all snapshot aggregation (Phase 4l W1)', () => {
  it('unions four per-universe snapshots and returns snapshot-aggregate', async () => {
    mocks.snapshots.set('sp500', snapshot({ ageMs: 60_000, results: [row('AAPL'), row('MSFT')], universeChecked: 208 }));
    mocks.snapshots.set('ndx', snapshot({ ageMs: 60_000, results: [row('AAPL'), row('NVDA')], universeChecked: 70 }));
    mocks.snapshots.set('dow', snapshot({ ageMs: 60_000, results: [row('AAPL'), row('JPM')], universeChecked: 27 }));
    mocks.snapshots.set('russell2k', snapshot({ ageMs: 60_000, results: [row('SMALL1'), row('SMALL2')], universeChecked: 2037 }));

    const res = (await handler(evt({ index: 'all' }), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('snapshot-aggregate');
    // Dedup: AAPL appears in 3 snapshots → counted once.
    const tickers = body.rows.map((r: any) => r.ticker).sort();
    expect(tickers).toEqual(['AAPL', 'JPM', 'MSFT', 'NVDA', 'SMALL1', 'SMALL2']);
    expect(body.contributingUniverses).toEqual(['sp500', 'ndx', 'dow', 'russell2k']);
    expect(body.missingUniverses).toEqual([]);
    expect(body.partial).toBe(false);
    expect(body.stale).toBe(false);
    expect(body.universeChecked).toBe(208 + 70 + 27 + 2037);
    // runInsiderScan must NOT be called — the 80-cap live scan must NOT run.
    expect(mocks.runInsiderScan).not.toHaveBeenCalled();
  });

  it('de-duplicates by ticker — same ticker present in multiple snapshots appears once', async () => {
    // Russell scan ran later; its AAPL row should win (freshest).
    const sp500At = 5 * 60_000;
    const russell2kAt = 1 * 60_000;
    mocks.snapshots.set(
      'sp500',
      snapshot({ ageMs: sp500At, results: [row('AAPL', { buyDollars: 50_000 })] }),
    );
    mocks.snapshots.set(
      'russell2k',
      snapshot({ ageMs: russell2kAt, results: [row('AAPL', { buyDollars: 999_999 })] }),
    );

    const res = (await handler(evt({ index: 'all' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.rows).toHaveLength(1);
    // Freshest contributor's row wins.
    expect(body.rows[0].buyDollars).toBe(999_999);
  });

  it('graceful partial — one snapshot missing — still returns the rest, flagged', async () => {
    mocks.snapshots.set('sp500', snapshot({ ageMs: 60_000, results: [row('AAPL')] }));
    mocks.snapshots.set('ndx', snapshot({ ageMs: 60_000, results: [row('NVDA')] }));
    mocks.snapshots.set('dow', snapshot({ ageMs: 60_000, results: [row('JPM')] }));
    // russell2k missing.

    const res = (await handler(evt({ index: 'all' }), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('snapshot-aggregate');
    expect(body.partial).toBe(true);
    expect(body.missingUniverses).toEqual(['russell2k']);
    expect(body.contributingUniverses).toEqual(['sp500', 'ndx', 'dow']);
    expect(body.rows).toHaveLength(3);
    expect(mocks.runInsiderScan).not.toHaveBeenCalled();
  });

  it('graceful partial — one snapshot stale — included but flagged stale', async () => {
    const freshBudget = 24 * 60 * 60_000;
    mocks.snapshots.set('sp500', snapshot({ ageMs: 60_000, results: [row('AAPL')], budgetMs: freshBudget }));
    mocks.snapshots.set('ndx', snapshot({ ageMs: 60_000, results: [row('NVDA')], budgetMs: freshBudget }));
    mocks.snapshots.set('dow', snapshot({ ageMs: 60_000, results: [row('JPM')], budgetMs: freshBudget }));
    // russell2k stale: 48h old > 24h budget
    mocks.snapshots.set('russell2k', snapshot({ ageMs: 48 * 60 * 60_000, results: [row('SMALL1')], budgetMs: freshBudget }));

    const res = (await handler(evt({ index: 'all' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.source).toBe('snapshot-aggregate');
    expect(body.partial).toBe(true);
    expect(body.stale).toBe(true);
    expect(body.staleUniverses).toEqual(['russell2k']);
    expect(body.rows.map((r: any) => r.ticker).sort()).toEqual(['AAPL', 'JPM', 'NVDA', 'SMALL1']);
  });

  it('generatedAt reflects the OLDEST contributing snapshot (honest freshness)', async () => {
    const now = Date.now();
    const sp500Iso = new Date(now - 2 * 60 * 60_000).toISOString(); // 2h old
    const russellIso = new Date(now - 10 * 60 * 60_000).toISOString(); // 10h old — oldest
    mocks.snapshots.set('sp500', { ...snapshot({ ageMs: 2 * 60 * 60_000, results: [row('AAPL')] }), generatedAt: sp500Iso });
    mocks.snapshots.set('russell2k', { ...snapshot({ ageMs: 10 * 60 * 60_000, results: [row('SMALL1')] }), generatedAt: russellIso });

    const res = (await handler(evt({ index: 'all' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.generatedAt).toBe(russellIso);
    expect(body.ageMs).toBeGreaterThanOrEqual(10 * 60 * 60_000 - 1000);
  });

  it('falls back to live scan ONLY when no snapshots exist at all', async () => {
    mocks.runInsiderScan.mockResolvedValue({
      rows: [row('LIVE')],
      universeChecked: 80,
      scanned: 80,
      scanDurationMs: 1000,
      warnings: [],
      budgetExceeded: false,
    });
    // No snapshots set.

    const res = (await handler(evt({ index: 'all' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.source).toBe('fallback-partial');
    expect(mocks.runInsiderScan).toHaveBeenCalled();
  });

  it('force=1 keeps the capped live scan as a debug escape hatch', async () => {
    mocks.snapshots.set('sp500', snapshot({ ageMs: 60_000, results: [row('AAPL')] }));
    mocks.snapshots.set('ndx', snapshot({ ageMs: 60_000, results: [row('NVDA')] }));
    mocks.snapshots.set('dow', snapshot({ ageMs: 60_000, results: [row('JPM')] }));
    mocks.snapshots.set('russell2k', snapshot({ ageMs: 60_000, results: [row('SMALL1')] }));
    mocks.runInsiderScan.mockResolvedValue({
      rows: [row('LIVE')],
      universeChecked: 2245,
      scanned: 80,
      scanDurationMs: 1000,
      warnings: [],
      budgetExceeded: false,
    });

    const res = (await handler(evt({ index: 'all', force: '1' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.source).toBe('forced-partial');
    expect(mocks.runInsiderScan).toHaveBeenCalled();
  });

  it('re-windows snapshot rows when windowDays < 180', async () => {
    const now = Date.now();
    const oldFilingDate = new Date(now - 100 * 86400_000).toISOString(); // 100d
    const freshFilingDate = new Date(now - 10 * 86400_000).toISOString(); // 10d
    mocks.snapshots.set('sp500', snapshot({
      ageMs: 60_000,
      results: [row('AAPL', {
        filings: [
          {
            name: 'CEO-A', role: 'CEO', shares: 100, dollars: 50_000,
            filingDate: oldFilingDate, transactionDate: oldFilingDate, code: 'P', daysSince: 100,
          },
        ],
      })],
    }));
    mocks.snapshots.set('russell2k', snapshot({
      ageMs: 60_000,
      results: [row('SMALL1', {
        filings: [
          {
            name: 'CEO-B', role: 'CEO', shares: 100, dollars: 50_000,
            filingDate: freshFilingDate, transactionDate: freshFilingDate, code: 'P', daysSince: 10,
          },
        ],
      })],
    }));

    // 30-day window — AAPL's 100d-old filing falls outside; SMALL1's 10d filing survives.
    const res = (await handler(evt({ index: 'all', days: '30' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.windowDays).toBe(30);
    expect(body.rows.map((r: any) => r.ticker)).toEqual(['SMALL1']);
  });
});
