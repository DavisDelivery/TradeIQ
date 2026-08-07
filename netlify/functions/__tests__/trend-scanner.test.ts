import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const finvizEnabledMock = vi.fn();
const consumerWatchlistMock = vi.fn();
const scanForTrendsMock = vi.fn();
const createMock = vi.fn();

vi.mock('../shared/finviz', async (importOriginal) => {
  const real = await importOriginal<typeof import('../shared/finviz')>();
  return { ...real, finvizEnabled: () => finvizEnabledMock() };
});

vi.mock('../shared/consumer-universe', async (importOriginal) => {
  const real = await importOriginal<typeof import('../shared/consumer-universe')>();
  return { ...real, consumerWatchlist: (...a: unknown[]) => consumerWatchlistMock(...a) };
});

vi.mock('../shared/trend-detect', async (importOriginal) => {
  const real = await importOriginal<typeof import('../shared/trend-detect')>();
  return { ...real, scanForTrends: (...a: unknown[]) => scanForTrendsMock(...a) };
});

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({ create: createMock }) }) }),
}));

import { handler } from '../trend-scanner';

const evt = (params: Record<string, string> = {}) =>
  ({ queryStringParameters: params, httpMethod: 'GET' }) as any;

const call = (params: Record<string, string> = {}) =>
  handler(evt(params), {} as any, () => {}) as Promise<any>;

const row = (ticker: string) => ({ ticker, marketCapM: 1000, price: 10, perfWeekPct: 1, perfMonthPct: 2, avgVolume: 1e6, shortFloatPct: 3, instOwnPct: 40, earningsDate: null });

const candidate = (ticker: string, convergence: number) => ({
  ticker, companyName: null, convergence, sourcesAvailable: 3,
  observations: [], saturation: { mentionRank: null, mentionState: 'UNAVAILABLE', offExchangeZ: null, crowded: false, reasons: [], note: '' },
  context: {},
});

function scanResult(candidates: any[] = [candidate('AAA', 1), candidate('ZZZ', 2)]) {
  return {
    asOf: '2026-08-06',
    universeChecked: candidates.length,
    candidates,
    order: 'alphabetical by ticker — this is NOT a ranking; sort client-side on any column',
    paperTrail: { date: '2026-08-06', seed: 's', candidates: candidates.map((c) => c.ticker), control: ['QQQ'], universeScanned: ['AAA', 'QQQ', 'ZZZ'] },
    mentionHistory: { daysRecorded: 2, daysRequired: 35, usable: false },
    degraded: [],
    caveat: 'A CANDIDATE GENERATOR, not a signal, and deliberately NOT RANKED.',
  };
}

const ORIGINAL_CONTEXT = process.env.CONTEXT;

beforeEach(() => {
  process.env.CONTEXT = 'production';
  finvizEnabledMock.mockReset().mockReturnValue(true);
  consumerWatchlistMock.mockReset().mockResolvedValue([row('AAA'), row('ZZZ')]);
  scanForTrendsMock.mockReset().mockResolvedValue(scanResult());
  createMock.mockReset().mockResolvedValue(undefined);
});

describe('trend-scanner endpoint', () => {
  it('serves the alphabetical candidate list', async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.candidates.map((c: any) => c.ticker)).toEqual(['AAA', 'ZZZ']);
    expect(body.order).toMatch(/NOT a ranking/);
  });

  it('carries the no-edge disclaimer in the contract, not just in the UI', async () => {
    const body = JSON.parse((await call()).body);
    expect(body.disclaimer).toMatch(/NOT RANKED/);
    expect(body.disclaimer).toMatch(/NO_EDGE/);
    expect(body.caveat).toMatch(/CANDIDATE GENERATOR/);
  });

  it('reports how much mention history exists, so a thin leg is explainable', async () => {
    const body = JSON.parse((await call()).body);
    expect(body.mentionHistory).toEqual({ daysRecorded: 2, daysRequired: 35, usable: false });
  });

  describe('cache headers — an outage must not be pinned into the CDN', () => {
    it('caches a successful scan', async () => {
      const res = await call();
      expect(res.headers['cache-control']).toBe('public, max-age=300');
    });

    it('does NOT cache a 502', async () => {
      consumerWatchlistMock.mockResolvedValue(null);
      const res = await call();
      expect(res.statusCode).toBe(502);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('does NOT cache a 503', async () => {
      finvizEnabledMock.mockReturnValue(false);
      const res = await call();
      expect(res.statusCode).toBe(503);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('does NOT cache a 500', async () => {
      scanForTrendsMock.mockRejectedValue(new Error('quiver exploded'));
      const res = await call();
      expect(res.statusCode).toBe(500);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });
  });

  it('returns 502 on a dead universe feed rather than an empty board', async () => {
    // An empty "nothing is trending" is a claim about the world. We did not
    // measure it, so we must not print it.
    consumerWatchlistMock.mockResolvedValue(null);
    const res = await call();
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).candidates).toBeUndefined();
  });

  describe('query validation', () => {
    it('clamps a negative limit instead of slicing from the end', async () => {
      // `.slice(0, -5)` would silently drop the LAST five names.
      await call({ limit: '-5' });
      expect(consumerWatchlistMock.mock.calls[0][0]).toBeGreaterThanOrEqual(5);
    });

    it('clamps a zero limit', async () => {
      await call({ limit: '0' });
      expect(consumerWatchlistMock.mock.calls[0][0]).toBeGreaterThanOrEqual(5);
    });

    it('caps an oversized limit', async () => {
      await call({ limit: '5000' });
      expect(consumerWatchlistMock.mock.calls[0][0]).toBeLessThanOrEqual(60);
    });

    it('falls back to the default on junk', async () => {
      await call({ limit: 'banana' });
      expect(consumerWatchlistMock.mock.calls[0][0]).toBe(40);
    });

    it('rejects an unknown universe rather than guessing', async () => {
      const res = await call({ universe: 'crypto' });
      expect(res.statusCode).toBe(400);
    });

    it('filters on minSources', async () => {
      const body = JSON.parse((await call({ minSources: '2' })).body);
      expect(body.candidates.map((c: any) => c.ticker)).toEqual(['ZZZ']);
    });

    it('clamps minSources to the number of convergence legs that exist', async () => {
      // Off-exchange moved to saturation, so there are TWO legs. Asking for 3
      // would otherwise return a permanently empty board.
      const body = JSON.parse((await call({ minSources: '3' })).body);
      expect(body.minSources).toBeLessThanOrEqual(2);
    });
  });

  describe('paper trail — the forward record the study\'s gate requires', () => {
    it('records the flagged set and its control cohort', async () => {
      const body = JSON.parse((await call()).body);
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(createMock.mock.calls[0][0]).toMatchObject({ candidates: ['AAA', 'ZZZ'], control: ['QQQ'], seed: 's' });
      expect(body.paperTrail.recorded).toBe('written');
    });

    it('does not overwrite an existing day — a cohort re-rolled after the fact is worthless', async () => {
      createMock.mockRejectedValue(Object.assign(new Error('already exists'), { code: 6 }));
      const body = JSON.parse((await call()).body);
      expect(body.paperTrail.recorded).toBe('exists');
    });

    it('REFUSES to write from a non-production context', async () => {
      // Deploy previews share the production Firebase project, and create()
      // means the first write owns that day forever. A smoke test against a
      // half-built branch must not be able to pin a cohort into the study.
      process.env.CONTEXT = 'deploy-preview';
      const body = JSON.parse((await call()).body);
      expect(createMock).not.toHaveBeenCalled();
      expect(body.paperTrail.recorded).toBe('skipped-non-production');
    });

    it('still records when CONTEXT is unset, as in local and test runs', async () => {
      delete process.env.CONTEXT;
      const body = JSON.parse((await call()).body);
      expect(body.paperTrail.recorded).toBe('written');
    });

    it('still serves the board when the record cannot be written', async () => {
      createMock.mockRejectedValue(new Error('firestore down'));
      const res = await call();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).paperTrail.recorded).toBe('failed');
    });
  });

  it('passes trader context columns through to the scan', async () => {
    await call();
    const input = scanForTrendsMock.mock.calls[0][0];
    expect(input[0].context).toMatchObject({ marketCapM: 1000, price: 10, avgVolume: 1e6, shortFloatPct: 3 });
  });
});

afterAll(() => {
  if (ORIGINAL_CONTEXT === undefined) delete process.env.CONTEXT;
  else process.env.CONTEXT = ORIGINAL_CONTEXT;
});
