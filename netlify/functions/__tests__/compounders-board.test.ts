// COMP-1 — /api/compounders-board.
//
// This board ranks the most famous large caps on earth and has NO measurement
// behind it. That combination is the whole risk: a table of mega-caps with a
// score column reads as a recommendation unless something on the response
// says otherwise, so the banner is not a nicety here — it is the only thing
// separating the payload from an unsupported claim. These tests therefore pin
// it on every path the handler can take, including the ones where there is
// nothing to show, and pin that it never says a number where none was
// measured.
//
// The second thing pinned is the QS-1 post-mortem's distinction: "no scan has
// ever run" and "a scan ran and was refused publication" render the same
// empty table, and telling a reader the first when the second is true is how
// a diagnosis already written into the snapshot went unread for a week.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  latest: { value: null as any },
  list: vi.fn(async (..._args: any[]) => [] as any[]),
  byId: vi.fn(async (..._args: any[]) => null as any),
  latestThrows: { value: null as string | null },
}));

vi.mock('../shared/snapshot-store', () => ({
  latestSnapshot: vi.fn(async () => {
    if (h.latestThrows.value) throw new Error(h.latestThrows.value);
    return h.latest.value;
  }),
  isSnapshotFresh: vi.fn(
    (snap: any, now: number = Date.now()) =>
      now - new Date(snap.generatedAt).getTime() < snap.freshnessBudgetMs,
  ),
  snapshotAgeMs: vi.fn(
    (snap: any, now: number = Date.now()) => now - new Date(snap.generatedAt).getTime(),
  ),
  listSnapshots: h.list,
  getSnapshotById: h.byId,
}));

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

import { handler } from '../compounders-board';

const call = async (qs?: Record<string, string>) => {
  const res: any = await handler(
    { httpMethod: 'GET', queryStringParameters: qs ?? null, headers: {}, body: null } as any,
    {} as any,
    () => {},
  );
  return { statusCode: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
};

const row = (i: number) => ({
  rank: i + 1,
  ticker: `T${i}`,
  sector: 'Technology',
  composite: 0.9 - i / 1000,
  qualityPct: 0.95,
  momentumPct: 0.8,
  grossProfitability: 0.42,
  momentum12_1Pct: 18.4,
  qualityBasis: 'gross-profits-to-assets',
});

/** A published snapshot in the shape the background worker writes. */
function snapshot(over: Record<string, unknown> = {}) {
  const rows = Array.from({ length: 60 }, (_, i) => row(i));
  return {
    board: 'compounders',
    universe: 'largecap',
    modelVersion: 'test-model',
    generatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    scanDurationMs: 1000,
    status: 'complete',
    universeChecked: 480,
    universeSize: 503,
    scored: 412,
    excludedCounts: { microcap: 0, illiquid: 3, 'price-floor': 0, 'no-data': 20 },
    unscorableCounts: { 'no-quality': 12, 'no-momentum': 4, 'below-quality-floor': 55 },
    exactBasisCount: 380,
    freshnessBudgetMs: 26 * 60 * 60_000,
    warnings: [],
    rows,
    results: rows,
    ...over,
  };
}

beforeEach(() => {
  h.latest.value = null;
  h.latestThrows.value = null;
  h.list.mockReset();
  h.list.mockResolvedValue([]);
  h.byId.mockReset();
  h.byId.mockResolvedValue(null);
});

/** The one assertion every path shares. */
function expectHonestBanner(banner: any) {
  expect(banner).toBeTruthy();
  expect(banner.grade).toBe('unmeasured');
  expect(banner.discovery).toMatch(/NOT MEASURED/);
  expect(banner.netEdgePp).toBeNull();
  expect(banner.netEdgeLabel).toBe('not measured');
  expect(banner.policyVersion).toBeTruthy();
  // The load-bearing negative: no path may render a pp figure, haircut or
  // otherwise, because there is no measurement to haircut. A number here
  // would be a forecast the data does not support.
  expect(banner.headline).not.toMatch(/\d+(\.\d+)?\s*pp/);
}

describe('the banner rides every path — there is no response without it', () => {
  it('healthy: fresh snapshot serves rows AND the banner', async () => {
    h.latest.value = snapshot();
    const { statusCode, body } = await call();
    expect(statusCode).toBe(200);
    expect(body.source).toBe('snapshot');
    expect(body.stale).toBe(false);
    expect(body.rows).toHaveLength(40);
    expectHonestBanner(body.banner);
  });

  it('stale: serves the last completed scan rather than blanking, still bannered', async () => {
    h.latest.value = snapshot({
      generatedAt: new Date(Date.now() - 72 * 60 * 60_000).toISOString(),
    });
    const { statusCode, body } = await call();
    expect(statusCode).toBe(200);
    expect(body.source).toBe('snapshot-stale');
    expect(body.stale).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    expectHonestBanner(body.banner);
  });

  it('snapshot-missing: empty board, banner still attached', async () => {
    const { statusCode, body } = await call();
    expect(statusCode).toBe(200);
    expect(body.source).toBe('snapshot-missing');
    expect(body.rows).toEqual([]);
    expectHonestBanner(body.banner);
  });

  it('snapshot-unpublished: empty board, banner still attached', async () => {
    h.list.mockResolvedValue([{ snapshotId: 'largecap-2026-08-21-2240' }]);
    h.byId.mockResolvedValue({
      generatedAt: '2026-08-21T22:40:00.000Z',
      status: 'partial',
      scored: 0,
      universeChecked: 480,
      warnings: ['publish guard: 0 results on a 480-name universe'],
    });
    const { statusCode, body } = await call();
    expect(statusCode).toBe(200);
    expect(body.source).toBe('snapshot-unpublished');
    expectHonestBanner(body.banner);
  });

  it('error: the 500 carries the banner too', async () => {
    h.latestThrows.value = 'firestore unavailable';
    const { statusCode, body } = await call();
    expect(statusCode).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/firestore unavailable/);
    expect(body.rows).toEqual([]);
    expectHonestBanner(body.banner);
    expect(body.disclosure).toBeTruthy();
  });

  it('does not cache the failure, but does cache the healthy answer', async () => {
    h.latestThrows.value = 'boom';
    const err = await call();
    expect(err.headers['Cache-Control']).toBe('no-store');

    h.latestThrows.value = null;
    h.latest.value = snapshot();
    const ok = await call();
    expect(ok.headers['Cache-Control']).toMatch(/max-age=120/);
  });

  it('prefers the banner the rows were published under over a freshly built one', async () => {
    // A snapshot carries the banner in force when it was written. Rebuilding
    // it on read would silently re-label old rows with today's policy.
    h.latest.value = snapshot({
      banner: { grade: 'unmeasured', headline: 'as published', discovery: 'x', policyVersion: '2026-08-07' },
    });
    const { body } = await call();
    expect(body.banner.headline).toBe('as published');
  });

  it('rebuilds the banner for a snapshot written before the field existed', async () => {
    const snap: any = snapshot();
    delete snap.banner;
    h.latest.value = snap;
    const { body } = await call();
    expectHonestBanner(body.banner);
  });
});

describe('the verdict is UNMEASURED and the payload says so plainly', () => {
  it('never grades itself on the evidence for its inputs', async () => {
    h.latest.value = snapshot();
    const { body } = await call();
    expect(body.banner.grade).not.toBe('replicated-external');
    expect(body.banner.headline).toMatch(/never been backtested or forward-tested/i);
    // "Unmeasured" must not be read as "roughly zero" or "probably fine".
    expect(body.banner.headline).toMatch(/unknown/i);
  });

  it('discloses the missing value axis rather than letting it pass as a design detail', async () => {
    h.latest.value = snapshot();
    const { body } = await call();
    expect(body.disclosure).toMatch(/NO value axis/);
    expect(body.disclosure).toMatch(/departure/i);
  });
});

describe('limit is honoured and clamped', () => {
  beforeEach(() => {
    h.latest.value = snapshot();
  });

  it('defaults to 40', async () => {
    const { body } = await call();
    expect(body.rows).toHaveLength(40);
  });

  it('honours a smaller explicit limit', async () => {
    const { body } = await call({ limit: '5' });
    expect(body.rows).toHaveLength(5);
    expect(body.rows[0].ticker).toBe('T0');
  });

  it('caps an absurd limit rather than serving whatever was asked for', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => row(i));
    h.latest.value = snapshot({ rows, results: rows });
    const { body } = await call({ limit: '99999' });
    expect(body.rows).toHaveLength(200);
  });

  it('floors at 1 — a negative limit is not an empty board', async () => {
    const { body } = await call({ limit: '-5' });
    expect(body.rows).toHaveLength(1);
  });

  it('falls back to the default on garbage and on zero', async () => {
    expect((await call({ limit: 'abc' })).body.rows).toHaveLength(40);
    expect((await call({ limit: '0' })).body.rows).toHaveLength(40);
  });

  it('serves everything there is when the board is shorter than the limit', async () => {
    const rows = [row(0), row(1)];
    h.latest.value = snapshot({ rows, results: rows });
    const { body } = await call({ limit: '40' });
    expect(body.rows).toHaveLength(2);
  });
});

describe('missing vs unpublished — the QS-1 post-mortem, kept fixed', () => {
  it('says "has not completed yet" ONLY when nothing has ever run', async () => {
    h.list.mockResolvedValue([]);
    const { body } = await call();
    expect(body.source).toBe('snapshot-missing');
    expect(body.note).toMatch(/has not completed yet/);
    expect(body.lastAttempt).toBeNull();
    expect(body.warnings).toEqual([]);
    expect(h.byId).not.toHaveBeenCalled();
  });

  it('reports a run that was refused publication, with its reasons', async () => {
    h.list.mockResolvedValue([{ snapshotId: 'largecap-2026-08-21-2240' }]);
    h.byId.mockResolvedValue({
      generatedAt: '2026-08-21T22:40:00.000Z',
      status: 'partial',
      scored: 0,
      universeChecked: 480,
      exactBasisCount: 0,
      unscorableCounts: { 'no-quality': 480, 'no-momentum': 0, 'below-quality-floor': 0 },
      warnings: ['publish guard: 0 results on a 480-name universe'],
    });
    const { body } = await call();
    expect(body.source).toBe('snapshot-unpublished');
    expect(body.note).not.toMatch(/has not completed yet/);
    expect(body.note).toMatch(/scored 0 of 480/);
    expect(body.lastAttempt.status).toBe('partial');
    expect(body.lastAttempt.scored).toBe(0);
    expect(body.lastAttempt.snapshotId).toBe('largecap-2026-08-21-2240');
    // Surfaced at the top level as well: a reader should not have to know the
    // published/unpublished distinction to find out why the board is empty.
    expect(body.warnings).toEqual(['publish guard: 0 results on a 480-name universe']);
    expect(body.unscorableCounts).toEqual({
      'no-quality': 480,
      'no-momentum': 0,
      'below-quality-floor': 0,
    });
  });

  it('treats a listed run whose document has vanished as never-run, not as a phantom attempt', async () => {
    h.list.mockResolvedValue([{ snapshotId: 'largecap-2026-08-21-2240' }]);
    h.byId.mockResolvedValue(null);
    const { body } = await call();
    expect(body.source).toBe('snapshot-missing');
    expect(body.lastAttempt).toBeNull();
  });
});

describe('exactBasisCount travels with scored', () => {
  it('surfaces both, so a reader can tell exact quality from the ROE proxy', async () => {
    h.latest.value = snapshot({ scored: 412, exactBasisCount: 380 });
    const { body } = await call();
    expect(body.scored).toBe(412);
    expect(body.exactBasisCount).toBe(380);
    expect(body.universeChecked).toBe(480);
    expect(body.universeSize).toBe(503);
    expect(body.excludedCounts).toBeTruthy();
    expect(body.modelVersion).toBe('test-model');
  });

  it('is null rather than 0 when the snapshot predates the field — 0 would be a claim', async () => {
    const snap: any = snapshot();
    delete snap.exactBasisCount;
    h.latest.value = snap;
    const { body } = await call();
    expect(body.exactBasisCount).toBeNull();
  });
});

describe('this endpoint never scans', () => {
  it('serves a stale snapshot instead of computing a fresh one', async () => {
    h.latest.value = snapshot({
      generatedAt: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
    });
    const { body } = await call();
    expect(body.source).toBe('snapshot-stale');
    expect(body.rows.length).toBeGreaterThan(0);
    // The scoring core is the scan's dependency, not this endpoint's. If it
    // ever appears in this module's import graph, an inline fallback has been
    // added and the 15-minute worker budget has moved into a 26-second HTTP
    // request.
    const src = readFileSync(
      fileURLToPath(new URL('../compounders-board.ts', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/from '\.\/shared\/compounders'/);
    expect(src).not.toMatch(/scan-compounders/);
  });
});
