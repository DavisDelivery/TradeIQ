import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const finvizEnabledMock = vi.fn();
const universeSnapshotMock = vi.fn();
const scanForTrendsMock = vi.fn();
const createMock = vi.fn();

vi.mock('../shared/finviz', async (importOriginal) => {
  const real = await importOriginal<typeof import('../shared/finviz')>();
  return {
    ...real,
    finvizEnabled: () => finvizEnabledMock(),
    getFinvizUniverseSnapshot: (...a: unknown[]) => universeSnapshotMock(...a),
  };
});

vi.mock('../shared/trend-detect', async (importOriginal) => {
  const real = await importOriginal<typeof import('../shared/trend-detect')>();
  return { ...real, scanForTrends: (...a: unknown[]) => scanForTrendsMock(...a) };
});

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({ create: createMock }) }) }),
}));

import { handler, isProductionHost } from '../trend-scanner';

const evt = (params: Record<string, string> = {}, host = 'tradeiq-alpha.netlify.app') =>
  ({ queryStringParameters: params, httpMethod: 'GET', headers: { host } }) as any;

const call = (params: Record<string, string> = {}, host?: string) =>
  handler(evt(params, host), {} as any, () => {}) as Promise<any>;

// Must clear the ratified universe floors: cap >= $300M, price >= $5, and
// avgVolume (thousands of shares) x price >= $3M/day.
const row = (ticker: string, sector = 'Consumer Cyclical') => ({
  ticker, sector, marketCapM: 1000, price: 10, perfWeekPct: 1, perfMonthPct: 2,
  avgVolume: 500, shortFloatPct: 3, instOwnPct: 40, earningsDate: null,
});

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
    appRatingHistory: { daysRecorded: 2, daysRequired: 36, usable: false },
    degraded: [],
    caveat: 'A CANDIDATE GENERATOR, not a signal, and deliberately NOT RANKED.',
  };
}

const ORIGINAL_CONTEXT = process.env.CONTEXT;

beforeEach(() => {
  process.env.CONTEXT = 'production';
  finvizEnabledMock.mockReset().mockReturnValue(true);
  universeSnapshotMock.mockReset().mockResolvedValue({ universe: 'russell2k', rows: [row('AAA'), row('ZZZ')], fetchedAt: '', source: 'cache', missingHeaders: [] });
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
      universeSnapshotMock.mockResolvedValue(null);
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
    universeSnapshotMock.mockResolvedValue(null);
    const res = await call();
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).candidates).toBeUndefined();
  });

  describe('query validation', () => {
    it('clamps a negative limit instead of slicing from the end', async () => {
      // `.slice(0, -5)` would silently drop the LAST five names.
      await call({ limit: '-5' });
      expect(scanForTrendsMock.mock.calls[0][0].length).toBe(2); // both rows, not a negative slice
    });

    it('clamps a zero limit', async () => {
      await call({ limit: '0' });
      expect(scanForTrendsMock.mock.calls[0][0].length).toBe(2);
    });

    it('caps an oversized limit', async () => {
      const many = Array.from({ length: 200 }, (_, i) => row(`T${String(i).padStart(3, '0')}`));
      universeSnapshotMock.mockResolvedValue({ rows: many } as any);
      await call({ limit: '5000' });
      expect(scanForTrendsMock.mock.calls[0][0].length).toBeLessThanOrEqual(60);
    });

    it('falls back to the default on junk', async () => {
      const many = Array.from({ length: 100 }, (_, i) => row(`T${String(i).padStart(3, '0')}`));
      universeSnapshotMock.mockResolvedValue({ rows: many } as any);
      await call({ limit: 'banana' });
      expect(scanForTrendsMock.mock.calls[0][0].length).toBe(40);
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
      // THREE legs: wikipedia, recorded mentions, app ratings. Off-exchange is
      // not one — it is saturation. Asking for 4 would otherwise return a
      // permanently empty board.
      const body = JSON.parse((await call({ minSources: '9' })).body);
      expect(body.minSources).toBeLessThanOrEqual(3);
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

    it('REFUSES to write when served from a deploy preview', async () => {
      // Previews share the production Firebase project, and create() means the
      // first write owns that day forever. A smoke test against a half-built
      // branch must not be able to pin a cohort into the study.
      const body = JSON.parse((await call({}, 'deploy-preview-196--tradeiq-alpha.netlify.app')).body);
      expect(createMock).not.toHaveBeenCalled();
      expect(body.paperTrail.recorded).toBe('skipped-non-production');
    });

    it('refuses to write from a branch deploy or from localhost', async () => {
      expect(JSON.parse((await call({}, 'my-branch--tradeiq-alpha.netlify.app')).body).paperTrail.recorded)
        .toBe('skipped-non-production');
      expect(JSON.parse((await call({}, 'localhost:8888')).body).paperTrail.recorded)
        .toBe('skipped-non-production');
      expect(createMock).not.toHaveBeenCalled();
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
    expect(input[0].context).toMatchObject({ marketCapM: 1000, price: 10, avgVolume: 500, shortFloatPct: 3 });
  });

  it('reports what the ratified universe policy removed, so the cut is not silent', async () => {
    universeSnapshotMock.mockResolvedValue({
      rows: [row('GOOD'), { ...row('TINY'), marketCapM: 50 }, { ...row('PENNY'), price: 1 }],
    } as any);
    const body = JSON.parse((await call()).body);
    expect(body.universePolicy.excludedCounts.microcap).toBe(1);
    expect(body.universePolicy.excludedCounts['price-floor']).toBe(1);
    expect(body.universePolicy.version).toBeTruthy();
    expect(scanForTrendsMock.mock.calls[0][0].map((i: any) => i.ticker)).toEqual(['GOOD']);
  });

  it('does not scan non-consumer sectors', async () => {
    universeSnapshotMock.mockResolvedValue({ rows: [row('EAT'), row('AAPL', 'Technology')] } as any);
    await call();
    expect(scanForTrendsMock.mock.calls[0][0].map((i: any) => i.ticker)).toEqual(['EAT']);
  });
});

afterAll(() => {
  if (ORIGINAL_CONTEXT === undefined) delete process.env.CONTEXT;
  else process.env.CONTEXT = ORIGINAL_CONTEXT;
});

describe('isProductionHost — derived from the request, because CONTEXT is a BUILD variable', () => {
  it('accepts the production host', () => {
    expect(isProductionHost('tradeiq-alpha.netlify.app')).toBe(true);
  });

  it('accepts a custom domain, so a rename does not silently stop the record', () => {
    // The failure that matters here is a forward record that goes quiet
    // without anyone noticing, so an unrecognised host records rather than
    // being treated as suspect.
    expect(isProductionHost('tradeiq.davisdelivery.com')).toBe(true);
  });

  it('rejects every Netlify non-production hostname shape', () => {
    expect(isProductionHost('deploy-preview-196--tradeiq-alpha.netlify.app')).toBe(false);
    expect(isProductionHost('some-branch--tradeiq-alpha.netlify.app')).toBe(false);
    expect(isProductionHost('6a751d6d44b2f70007eb6492--tradeiq-alpha.netlify.app')).toBe(false);
  });

  it('rejects local development', () => {
    expect(isProductionHost('localhost:8888')).toBe(false);
    expect(isProductionHost('tradeiq.local')).toBe(false);
  });

  it('fails closed on a missing host rather than guessing', () => {
    expect(isProductionHost(undefined)).toBe(false);
    expect(isProductionHost('')).toBe(false);
  });

  it('ignores port and case', () => {
    expect(isProductionHost('TradeIQ-Alpha.Netlify.App:443')).toBe(true);
  });
});
