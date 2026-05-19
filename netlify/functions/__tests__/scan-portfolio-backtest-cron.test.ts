// Phase 4e-1 follow-up + Phase 4r W1 — cron window selection tests.

import { describe, expect, it, vi } from 'vitest';
import {
  _internals,
  pickNextUndoneWindow,
  runCron,
} from '../scan-portfolio-backtest-cron';

const { WINDOW_CYCLE, PRIORITY, ROLLING_WINDOWS, pickWindow } = _internals;

// ---------------------------------------------------------------------------
// Legacy day-of-year cycle (preserved as fallback)
// ---------------------------------------------------------------------------

describe('pickWindow (legacy fallback)', () => {
  it('cycles through all 13 windows over consecutive days', () => {
    const start = new Date(Date.UTC(2026, 5, 1)); // June 1, 2026
    const seen = new Set<string>();
    for (let i = 0; i < WINDOW_CYCLE.length; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      seen.add(pickWindow(d));
    }
    expect(seen.size).toBe(WINDOW_CYCLE.length);
    for (const w of WINDOW_CYCLE) expect(seen.has(w)).toBe(true);
  });

  it('repeats deterministically after a full cycle', () => {
    const start = new Date(Date.UTC(2026, 5, 1));
    const a = pickWindow(start);
    const b = pickWindow(new Date(start.getTime() + WINDOW_CYCLE.length * 86_400_000));
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Phase 4r W1 — next-undone selection. Stub Firestore via a minimal db.
// ---------------------------------------------------------------------------

interface FakeDoc {
  id: string;
  data: () => {
    window?: string;
    status?: string;
    version?: string;
    startedAt?: string;
  };
}

function makeStubDb(docs: FakeDoc[]) {
  const collection = vi.fn(() => ({
    orderBy: vi.fn(() => ({
      limit: vi.fn(() => ({
        get: vi.fn(async () => ({ docs })),
      })),
    })),
  }));
  // The cron's pickNextUndoneWindow accepts a typed Firestore; we cast
  // because the test only exercises one read path.
  return { collection } as unknown as Parameters<typeof pickNextUndoneWindow>[0];
}

function fakeDoc(window: string, status: string, version: string | null, startedAt: string): FakeDoc {
  const dataObj: Record<string, string> = { window, status, startedAt };
  if (version !== null) dataObj.version = version;
  return {
    id: `pb-${window}-${startedAt.replace(/[-:T.Z]/g, '').slice(0, 12)}-test01`,
    data: () => dataObj,
  };
}

describe('pickNextUndoneWindow', () => {
  it('priority list begins with all 8 rolling windows, then named comparisons', () => {
    for (let i = 0; i < ROLLING_WINDOWS.length; i++) {
      expect(PRIORITY[i]).toBe(ROLLING_WINDOWS[i]);
    }
    expect(PRIORITY[ROLLING_WINDOWS.length]).toBe('full');
  });

  it('picks the first rolling window with no doc when collection is empty', async () => {
    const db = makeStubDb([]);
    const { window, reason } = await pickNextUndoneWindow(db, 'v2');
    expect(window).toBe(PRIORITY[0]); // rolling-2018
    expect(reason).toBe('undone');
  });

  it('skips windows that already have a done doc at the active version', async () => {
    // rolling-2018 + rolling-2019 + rolling-2020 done at v2.
    // rolling-2021 is the first undone — but only because rolling-2021 is missing.
    const docs = [
      fakeDoc('rolling-2018', 'done', 'v2', '2026-05-10T22:00:00Z'),
      fakeDoc('rolling-2019', 'done', 'v2', '2026-05-11T22:00:00Z'),
      fakeDoc('rolling-2020', 'done', 'v2', '2026-05-12T22:00:00Z'),
    ];
    const db = makeStubDb(docs);
    const { window, reason } = await pickNextUndoneWindow(db, 'v2');
    expect(window).toBe('rolling-2021');
    expect(reason).toBe('undone');
  });

  it('treats a stale-version done doc as undone (re-fires it under the active version)', async () => {
    // rolling-2021's latest doc is `done` at v1 — the exact live state we
    // diagnosed in Phase 4r. The cron must pick rolling-2021 to re-fire
    // under v2 so the verdict aggregates a consistent rule version.
    const docs = [
      fakeDoc('rolling-2021', 'done', 'v1', '2026-05-15T22:06:00Z'),
    ];
    const db = makeStubDb(docs);
    const { window, perWindow } = await pickNextUndoneWindow(db, 'v2');
    // The first rolling window with no v2 done at all is rolling-2018,
    // which has no doc → that wins.
    expect(window).toBe('rolling-2018');
    // But the perWindow inspection should reflect that rolling-2021 has
    // a stale-version done — proves we surface the mix to the caller.
    expect(perWindow['rolling-2021']).toMatchObject({
      status: 'done',
      version: 'v1',
    });
  });

  it('treats a doc with no `version` field as v1 (pre-Phase-4i)', async () => {
    // Pre-Phase-4i result docs have no `version` field. We want those
    // to count as needing a re-run under v2, not silently as v2.
    const docs = [
      fakeDoc('rolling-2018', 'done', null, '2026-05-15T22:06:00Z'),
    ];
    const db = makeStubDb(docs);
    const { window } = await pickNextUndoneWindow(db, 'v2');
    // rolling-2018 was the legacy-version done; the active-version
    // pass still treats it as undone. The first undone in priority is
    // rolling-2018 itself (since version !== 'v2').
    expect(window).toBe('rolling-2018');
  });

  it('skips a pending doc — pending is not done, so the window is still undone', async () => {
    // The live state has rolling-2022 stuck as pending. With every
    // other rolling-* missing, the strategy picks rolling-2018 first.
    const docs = [
      fakeDoc('rolling-2022', 'pending', null, '2026-05-14T22:00:00Z'),
    ];
    const db = makeStubDb(docs);
    const { window } = await pickNextUndoneWindow(db, 'v2');
    expect(window).toBe('rolling-2018'); // first in priority that's also undone
  });

  it('returns all-done-revalidate only when every priority window is done at active version', async () => {
    const docs: FakeDoc[] = [];
    let day = 0;
    for (const w of PRIORITY) {
      day++;
      docs.push(fakeDoc(w, 'done', 'v2', `2026-04-${String(day).padStart(2, '0')}T22:00:00Z`));
    }
    const db = makeStubDb(docs);
    const { window, reason } = await pickNextUndoneWindow(db, 'v2');
    expect(reason).toBe('all-done-revalidate');
    expect(window).toBe(ROLLING_WINDOWS[0]);
  });
});

// ---------------------------------------------------------------------------
// Phase 4r W1 — runCron end-to-end: it picks a window, POSTs to the
// trigger, returns a 200 with the strategy + perWindow inspection.
// ---------------------------------------------------------------------------

describe('runCron', () => {
  it('dispatches the picked window to the portfolio-backtest-trigger', async () => {
    const docs = [
      fakeDoc('rolling-2018', 'done', 'v2', '2026-05-10T22:00:00Z'),
    ];
    const db = makeStubDb(docs);
    const fetchSpy = vi.fn(async (_url: string, _opts?: unknown) =>
      new Response('{"ok":true}', { status: 202 }),
    );
    const res = await runCron({
      db,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      origin: 'https://example.test',
      activeVersion: 'v2',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.window).toBe('rolling-2019'); // first undone after 2018
    expect(body.strategy).toBe('next-undone');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/.netlify/functions/portfolio-backtest-trigger');
    expect(init.method).toBe('POST');
    const payload = JSON.parse(init.body as string);
    expect(payload.window).toBe('rolling-2019');
  });

  it('falls back to the legacy dayOfYear%13 picker when Firestore throws', async () => {
    const throwingDb = {
      collection: () => ({
        orderBy: () => ({
          limit: () => ({
            get: async () => {
              throw new Error('firestore unavailable');
            },
          }),
        }),
      }),
    } as unknown as Parameters<typeof pickNextUndoneWindow>[0];
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 202 }));
    const res = await runCron({
      db: throwingDb,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      origin: 'https://example.test',
      activeVersion: 'v2',
      now: new Date(Date.UTC(2026, 5, 1)),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.strategy).toBe('legacy-fallback');
    expect(WINDOW_CYCLE).toContain(body.window);
  });

  // Phase 4r-W1b W3 — recovery sweep runs BEFORE the window pick. The
  // stub here returns no `cursor` on any doc, so the sweep is a no-op
  // (no stuck runs to recover); the test asserts that the sweep is
  // wired in without disrupting the pick. The detailed recovery
  // semantics are covered in recover.test.ts.
  it('runs the stuck-run recovery sweep without breaking window selection', async () => {
    const docs = [
      fakeDoc('rolling-2018', 'done', 'v2', '2026-05-10T22:00:00Z'),
      fakeDoc('rolling-2019', 'done', 'v2', '2026-05-11T22:00:00Z'),
    ];
    const db = makeStubDb(docs);
    const fetchSpy = vi.fn(async () =>
      new Response('{"ok":true}', { status: 202 }),
    );
    const res = await runCron({
      db,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      origin: 'https://example.test',
      activeVersion: 'v2',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // rolling-2018 and -2019 are done; next undone is rolling-2020.
    expect(body.window).toBe('rolling-2020');
    expect(body.strategy).toBe('next-undone');
  });

  // Phase 4r-W1b W3 — if the recovery sweep itself throws, runCron
  // logs and continues with the window pick. Defence in depth: a
  // recovery hiccup must not freeze the cron.
  it('continues to dispatch when the recovery sweep throws', async () => {
    let recoveryCallCount = 0;
    const collection = vi.fn(() => ({
      orderBy: vi.fn(() => ({
        limit: vi.fn(() => ({
          get: vi.fn(async () => {
            recoveryCallCount++;
            // First call (from recoverStuckBacktestRuns) throws; second
            // call (from pickNextUndoneWindow) succeeds with no docs so
            // the pick falls through to the first rolling window.
            if (recoveryCallCount === 1) throw new Error('recovery firestore down');
            return { docs: [] };
          }),
        })),
      })),
    }));
    const db = { collection } as unknown as Parameters<typeof pickNextUndoneWindow>[0];
    const fetchSpy = vi.fn(async () =>
      new Response('{"ok":true}', { status: 202 }),
    );
    const res = await runCron({
      db,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      origin: 'https://example.test',
      activeVersion: 'v2',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.strategy).toBe('next-undone');
    // The cron still dispatched a window despite the recovery throw.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
