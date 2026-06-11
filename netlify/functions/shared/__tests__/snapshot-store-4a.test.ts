// Wave 4A — schedule-aware freshness (M2) + keep-daily-close retention.
//
// M2: a constant age budget cannot model the scan calendar — the daily
// after-close boards scan once per weekday (skipping NYSE holidays), so
// Friday-close → Monday-close is ~74h and a holiday Monday pushes it to
// ~98h. The schedule-aware predicate pins:
//   fresh ⇔ generatedAt >= last EXPECTED scan slot
// All clocks below are fake (explicit `now`); no test depends on wall time.
//
// Calendar facts used (verified against the UTC calendar +
// us-market-holidays.ts): 2026-06-12 Fri / 13 Sat / 14 Sun / 15 Mon /
// 16 Tue; 2026-09-04 Fri, 2026-09-07 Mon = Labor Day (NYSE holiday).
//
// Retention: pruneOldSnapshots' keep-daily-close mode keeps recent
// history verbatim and degrades pre-horizon history to one snapshot per
// UTC calendar day (the day's last non-partial), so snapshotBeforeDate /
// PIT backtest reads keep resolving while intraday extras are dropped.
//
// Hermetic — same minimal Firestore fake as snapshot-store-4h.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeRuns: Array<{ id: string; data: any }> = [];
const batchOps: string[][] = [];

const queryChain = () => {
  let universeFilter: string | undefined;
  let dir: 'asc' | 'desc' = 'asc';

  const build = () => ({
    where: (field: string, op: string, val: any) => {
      if (field === 'universe' && op === '==') universeFilter = val;
      return build();
    },
    orderBy: (_f: string, d: 'asc' | 'desc' = 'asc') => {
      dir = d;
      return build();
    },
    get: async () => {
      let items = [...fakeRuns];
      if (universeFilter) items = items.filter((r) => r.data.universe === universeFilter);
      items.sort((a, b) =>
        dir === 'asc'
          ? a.data.generatedAt.localeCompare(b.data.generatedAt)
          : b.data.generatedAt.localeCompare(a.data.generatedAt),
      );
      return {
        empty: items.length === 0,
        size: items.length,
        docs: items.map((r) => ({
          id: r.id,
          data: () => r.data,
          ref: { id: r.id, _kind: 'runs', _ref: r },
        })),
      };
    },
  });
  return build();
};

vi.mock('../firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: (_cn: string) => ({
      doc: (_dn: string) => ({
        collection: (_sub: string) => queryChain(),
      }),
    }),
    batch: () => {
      const pending: string[] = [];
      return {
        delete: (ref: any) => pending.push(ref.id),
        commit: async () => {
          batchOps.push([...pending]);
          for (const id of pending) {
            const idx = fakeRuns.findIndex((r) => r.id === id);
            if (idx >= 0) fakeRuns.splice(idx, 1);
          }
        },
      };
    },
  })),
}));

import {
  isSnapshotFresh,
  lastExpectedScanSlot,
  dailyScanSlotFor,
  pruneOldSnapshots,
  FRESHNESS_BUDGETS_MS,
  SCAN_SETTLE_GRACE_MS,
  type BoardSnapshot,
  type BoardName,
  type UniverseKey,
} from '../snapshot-store';

beforeEach(() => {
  fakeRuns.length = 0;
  batchOps.length = 0;
});

const ms = (iso: string) => new Date(iso).getTime();

function snap(opts: {
  board?: BoardName;
  universe?: UniverseKey;
  generatedAt: string;
  freshnessBudgetMs?: number;
}): BoardSnapshot {
  return {
    modelVersion: 'v1',
    generatedAt: opts.generatedAt,
    scanDurationMs: 0,
    universeChecked: 100,
    results: [],
    freshnessBudgetMs: opts.freshnessBudgetMs ?? FRESHNESS_BUDGETS_MS[opts.board ?? 'prophet'],
    // board + universe are stamped onto stored docs by writeSnapshot;
    // latestSnapshot returns them as part of the doc data.
    ...(opts.board ? { board: opts.board } : {}),
    ...(opts.universe ? { universe: opts.universe } : {}),
  } as BoardSnapshot;
}

// ====================================================================
// lastExpectedScanSlot
// ====================================================================

describe('lastExpectedScanSlot — walks back to the last weekday non-holiday slot', () => {
  it('mid-week: a Wednesday noon expects Tuesday 22:00', () => {
    const slot = lastExpectedScanSlot(ms('2026-06-10T12:00:00Z'));
    expect(slot?.toISOString()).toBe('2026-06-09T22:00:00.000Z');
  });

  it('settle grace: at Tuesday 23:00 the Tuesday slot is NOT yet expected (scan may be in flight)', () => {
    const slot = lastExpectedScanSlot(ms('2026-06-09T23:00:00Z'));
    expect(slot?.toISOString()).toBe('2026-06-08T22:00:00.000Z');
  });

  it('settle grace boundary: at exactly slot+2h the slot becomes expected', () => {
    const slot = lastExpectedScanSlot(ms('2026-06-10T00:00:00Z'));
    expect(slot?.toISOString()).toBe('2026-06-09T22:00:00.000Z');
  });

  it('weekend: Sunday afternoon expects Friday 22:00 (Sat/Sun have no slot)', () => {
    const slot = lastExpectedScanSlot(ms('2026-06-14T15:00:00Z'));
    expect(slot?.toISOString()).toBe('2026-06-12T22:00:00.000Z');
  });

  it('holiday Monday (Labor Day 2026-09-07): Tuesday morning still expects the prior Friday', () => {
    const slot = lastExpectedScanSlot(ms('2026-09-08T12:00:00Z'));
    expect(slot?.toISOString()).toBe('2026-09-04T22:00:00.000Z');
  });

  it('after the first post-holiday slot settles, that slot becomes expected', () => {
    const slot = lastExpectedScanSlot(ms('2026-09-09T01:00:00Z')); // Tue 22:00 + 2h = Wed 00:00
    expect(slot?.toISOString()).toBe('2026-09-08T22:00:00.000Z');
  });

  it('supports per-board slot times (insider/earnings 21:30)', () => {
    const slot = lastExpectedScanSlot(ms('2026-06-14T15:00:00Z'), { hourUtc: 21, minuteUtc: 30 });
    expect(slot?.toISOString()).toBe('2026-06-12T21:30:00.000Z');
  });

  it('grace is 2h (a scan takes ~15 min; margin for chained workers)', () => {
    expect(SCAN_SETTLE_GRACE_MS).toBe(2 * 60 * 60_000);
  });
});

// ====================================================================
// dailyScanSlotFor — board/universe cadence classification
// ====================================================================

describe('dailyScanSlotFor — cadence classification (read from the cron files)', () => {
  it('prophet/largecap is daily after-close at 22:00 (cron `0 22 * * 1-5`)', () => {
    expect(dailyScanSlotFor('prophet', 'largecap')).toEqual({ hourUtc: 22, minuteUtc: 0 });
  });

  it('prophet/russell2k + prophet/all are intraday (cron `0,30 13-21 * * 1-5`) — budget-based', () => {
    expect(dailyScanSlotFor('prophet', 'russell2k')).toBeNull();
    expect(dailyScanSlotFor('prophet', 'all')).toBeNull();
  });

  it('a prophet snapshot missing its universe is conservatively budget-based', () => {
    expect(dailyScanSlotFor('prophet', undefined)).toBeNull();
  });

  it('insider + earnings are daily at 21:30; lynch daily at 22:00', () => {
    expect(dailyScanSlotFor('insider', 'sp500')).toEqual({ hourUtc: 21, minuteUtc: 30 });
    expect(dailyScanSlotFor('earnings', 'all')).toEqual({ hourUtc: 21, minuteUtc: 30 });
    expect(dailyScanSlotFor('lynch', 'russell2k')).toEqual({ hourUtc: 22, minuteUtc: 0 });
  });

  it('intraday boards (target-board, catalyst, williams) have no daily slot', () => {
    expect(dailyScanSlotFor('target-board', 'russell2k')).toBeNull();
    expect(dailyScanSlotFor('catalyst', 'sp500')).toBeNull();
    expect(dailyScanSlotFor('williams', 'ndx')).toBeNull();
  });
});

// ====================================================================
// isSnapshotFresh — schedule-aware predicate (M2)
// ====================================================================

describe('isSnapshotFresh — daily boards are schedule-aware (M2)', () => {
  // The Friday-22:05 prophet largecap snapshot, written minutes after the
  // Friday 22:00 cron. Under the pre-fix constant 26h budget it went
  // "stale" Saturday night by construction — the exact #67/#70/#71 cycle.
  const fridaySnap = snap({
    board: 'prophet',
    universe: 'largecap',
    generatedAt: '2026-06-12T22:05:00Z',
  });

  it('Friday-22:05 snapshot is FRESH on Saturday night (age > 26h budget)', () => {
    expect(isSnapshotFresh(fridaySnap, ms('2026-06-14T01:00:00Z'))).toBe(true);
  });

  it('Friday-22:05 snapshot is FRESH on Sunday afternoon (~41h old)', () => {
    expect(isSnapshotFresh(fridaySnap, ms('2026-06-14T15:00:00Z'))).toBe(true);
  });

  it('Friday-22:05 snapshot is FRESH on Monday before the Monday slot settles', () => {
    // Monday 23:30 — the Monday 22:00 scan may still be in flight (grace).
    expect(isSnapshotFresh(fridaySnap, ms('2026-06-15T23:30:00Z'))).toBe(true);
  });

  it('Friday-22:05 snapshot is STALE on a normal Tuesday after a missed Monday scan', () => {
    // Monday 2026-06-15 was a normal trading day; its 22:00 slot settled
    // at Tuesday 00:00. A snapshot that predates it is stale.
    expect(isSnapshotFresh(fridaySnap, ms('2026-06-16T12:00:00Z'))).toBe(false);
  });

  it('Monday-22:05 snapshot is FRESH on Tuesday (next slot not yet settled)', () => {
    const monday = snap({
      board: 'prophet',
      universe: 'largecap',
      generatedAt: '2026-06-15T22:05:00Z',
    });
    expect(isSnapshotFresh(monday, ms('2026-06-16T21:00:00Z'))).toBe(true);
  });

  it('holiday Monday (Labor Day 2026-09-07): Friday-22:05 snapshot is FRESH all Monday', () => {
    const laborFriday = snap({
      board: 'prophet',
      universe: 'largecap',
      generatedAt: '2026-09-04T22:05:00Z',
    });
    expect(isSnapshotFresh(laborFriday, ms('2026-09-07T20:00:00Z'))).toBe(true);
    // …and Tuesday daytime too — the Tuesday slot hasn't settled yet and
    // no scan was expected on the holiday Monday (~88h old here).
    expect(isSnapshotFresh(laborFriday, ms('2026-09-08T18:00:00Z'))).toBe(true);
    // After the Tuesday slot settles (Wed 00:00) with no newer snapshot → stale.
    expect(isSnapshotFresh(laborFriday, ms('2026-09-09T01:00:00Z'))).toBe(false);
  });

  it('off-slot (manual) Saturday snapshot on a daily board is fresh through Monday grace', () => {
    const saturday = snap({
      board: 'prophet',
      universe: 'largecap',
      generatedAt: '2026-06-13T10:00:00Z',
    });
    // Sunday: within 26h budget floor anyway; Monday 12:00 → generatedAt
    // (Sat 10:00) >= last expected slot (Fri 22:00) → fresh.
    expect(isSnapshotFresh(saturday, ms('2026-06-15T12:00:00Z'))).toBe(true);
  });

  it('insider (slot 21:30): Friday-21:35 snapshot is FRESH on Sunday, STALE Tuesday after a missed Monday', () => {
    const insider = snap({
      board: 'insider',
      universe: 'russell2k',
      generatedAt: '2026-06-12T21:35:00Z',
    });
    expect(isSnapshotFresh(insider, ms('2026-06-14T15:00:00Z'))).toBe(true);
    expect(isSnapshotFresh(insider, ms('2026-06-16T12:00:00Z'))).toBe(false);
  });

  it('earnings (12h budget, slot 21:30): Friday-evening snapshot survives the weekend', () => {
    const earnings = snap({
      board: 'earnings',
      universe: 'all',
      generatedAt: '2026-06-12T21:40:00Z',
    });
    // Saturday morning: already past the 12h budget — schedule keeps it fresh.
    expect(isSnapshotFresh(earnings, ms('2026-06-13T11:00:00Z'))).toBe(true);
    expect(isSnapshotFresh(earnings, ms('2026-06-14T20:00:00Z'))).toBe(true);
    // Missed both Monday scans → stale Tuesday.
    expect(isSnapshotFresh(earnings, ms('2026-06-16T12:00:00Z'))).toBe(false);
  });
});

describe('isSnapshotFresh — intraday boards keep pure budget freshness', () => {
  it('prophet/russell2k: 48h-old snapshot is stale even on Sunday (26h budget, no slot)', () => {
    const russell = snap({
      board: 'prophet',
      universe: 'russell2k',
      generatedAt: '2026-06-12T21:30:00Z',
    });
    expect(isSnapshotFresh(russell, ms('2026-06-14T22:00:00Z'))).toBe(false);
  });

  it('prophet/russell2k: snapshot within the 26h budget is fresh (floor unchanged)', () => {
    const russell = snap({
      board: 'prophet',
      universe: 'russell2k',
      generatedAt: '2026-06-12T21:30:00Z',
    });
    expect(isSnapshotFresh(russell, ms('2026-06-13T20:00:00Z'))).toBe(true);
  });

  it('williams (intraday): 27h-old snapshot stays stale on a weekday', () => {
    const williams = snap({
      board: 'williams',
      universe: 'sp500',
      generatedAt: '2026-06-09T21:30:00Z',
    });
    expect(isSnapshotFresh(williams, ms('2026-06-11T01:00:00Z'))).toBe(false);
  });
});

describe('isSnapshotFresh — legacy snapshots without board/universe fall back to the stored budget', () => {
  it('no board: stored freshnessBudgetMs decides, schedule never applies', () => {
    const legacy = snap({ generatedAt: '2026-06-12T22:05:00Z', freshnessBudgetMs: 26 * 60 * 60_000 });
    delete (legacy as any).board;
    expect(isSnapshotFresh(legacy, ms('2026-06-13T20:00:00Z'))).toBe(true); // < 26h
    expect(isSnapshotFresh(legacy, ms('2026-06-14T15:00:00Z'))).toBe(false); // > 26h, no schedule
  });
});

// ====================================================================
// pruneOldSnapshots — keep-daily-close mode (Wave 4A retention)
// ====================================================================

function addRun(universe: string, generatedAt: string, status?: 'complete' | 'partial'): void {
  const id = `${universe}-${generatedAt.slice(0, 10)}-${generatedAt.slice(11, 13)}${generatedAt.slice(14, 16)}`;
  fakeRuns.push({ id, data: { universe, generatedAt, ...(status ? { status } : {}) } });
}

describe('pruneOldSnapshots — keep-daily-close mode', () => {
  const NOW = ms('2026-06-11T00:00:00Z');

  it('prunes pre-horizon intraday extras, keeps each old day\'s last snapshot, leaves recent days untouched', async () => {
    // Old day (2026-05-01, well past the 30d horizon): three intraday runs.
    addRun('russell2k', '2026-05-01T14:00:00.000Z');
    addRun('russell2k', '2026-05-01T18:00:00.000Z');
    addRun('russell2k', '2026-05-01T21:30:00.000Z'); // day's last — KEPT
    // Another old day with a single (daily-close) run — KEPT.
    addRun('russell2k', '2026-05-04T21:30:00.000Z');
    // Recent days (inside the horizon): everything kept, even extras.
    addRun('russell2k', '2026-06-09T14:00:00.000Z');
    addRun('russell2k', '2026-06-09T21:30:00.000Z');
    addRun('russell2k', '2026-06-10T21:30:00.000Z');

    const result = await pruneOldSnapshots('prophet', 'russell2k', {
      mode: 'keep-daily-close',
      horizonDays: 30,
      now: NOW,
    });

    expect(result.deleted).toBe(2);
    expect(result.kept).toBe(5);
    const remaining = fakeRuns.map((r) => r.data.generatedAt).sort();
    expect(remaining).toEqual([
      '2026-05-01T21:30:00.000Z',
      '2026-05-04T21:30:00.000Z',
      '2026-06-09T14:00:00.000Z',
      '2026-06-09T21:30:00.000Z',
      '2026-06-10T21:30:00.000Z',
    ]);
  });

  it('prefers the old day\'s last NON-partial snapshot so PIT reads (status filter) keep resolving', async () => {
    // The day's chronologically-last run is partial (never promoted, and
    // snapshotBeforeDate skips it). Deleting the earlier complete one
    // would silently shift backtests to the previous day.
    addRun('russell2k', '2026-05-01T18:00:00.000Z', 'complete');
    addRun('russell2k', '2026-05-01T21:30:00.000Z', 'partial');
    const result = await pruneOldSnapshots('prophet', 'russell2k', {
      mode: 'keep-daily-close',
      horizonDays: 30,
      now: NOW,
    });
    expect(result.deleted).toBe(1);
    expect(fakeRuns.map((r) => r.data.generatedAt)).toEqual(['2026-05-01T18:00:00.000Z']);
  });

  it('keeps the day\'s last partial when the day produced ONLY partials (diagnostics)', async () => {
    addRun('russell2k', '2026-05-01T18:00:00.000Z', 'partial');
    addRun('russell2k', '2026-05-01T21:30:00.000Z', 'partial');
    const result = await pruneOldSnapshots('prophet', 'russell2k', {
      mode: 'keep-daily-close',
      horizonDays: 30,
      now: NOW,
    });
    expect(result.deleted).toBe(1);
    expect(fakeRuns.map((r) => r.data.generatedAt)).toEqual(['2026-05-01T21:30:00.000Z']);
  });

  it('only prunes the targeted universe', async () => {
    addRun('russell2k', '2026-05-01T14:00:00.000Z');
    addRun('russell2k', '2026-05-01T21:30:00.000Z');
    addRun('all', '2026-05-01T14:00:00.000Z');
    addRun('all', '2026-05-01T21:30:00.000Z');
    await pruneOldSnapshots('prophet', 'russell2k', {
      mode: 'keep-daily-close',
      horizonDays: 30,
      now: NOW,
    });
    expect(fakeRuns.filter((r) => r.data.universe === 'all')).toHaveLength(2);
    expect(fakeRuns.filter((r) => r.data.universe === 'russell2k')).toHaveLength(1);
  });

  it('no-ops when every doc is within the horizon', async () => {
    addRun('russell2k', '2026-06-09T14:00:00.000Z');
    addRun('russell2k', '2026-06-09T21:30:00.000Z');
    const result = await pruneOldSnapshots('prophet', 'russell2k', {
      mode: 'keep-daily-close',
      horizonDays: 30,
      now: NOW,
    });
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(2);
    expect(batchOps).toHaveLength(0);
  });

  it('batches deletes in chunks ≤ 100 per commit', async () => {
    // 1 old day with 130 intraday runs → 129 deletions → 2 batches.
    for (let i = 0; i < 130; i++) {
      const hh = String(Math.floor(i / 60) + 13).padStart(2, '0');
      const mm = String(i % 60).padStart(2, '0');
      addRun('russell2k', `2026-05-01T${hh}:${mm}:00.000Z`);
    }
    const result = await pruneOldSnapshots('prophet', 'russell2k', {
      mode: 'keep-daily-close',
      horizonDays: 30,
      now: NOW,
    });
    expect(result.deleted).toBe(129);
    expect(batchOps).toHaveLength(2);
    expect(batchOps[0]).toHaveLength(100);
    expect(batchOps[1]).toHaveLength(29);
    expect(fakeRuns).toHaveLength(1);
    expect(fakeRuns[0].data.generatedAt).toBe('2026-05-01T15:09:00.000Z'); // day's last
  });
});
