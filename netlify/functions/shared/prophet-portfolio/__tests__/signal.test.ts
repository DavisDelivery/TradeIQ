// Phase 4e-1 — RankingSignal tests.
//
// Most of the interesting logic lives in `pickFromSnapshot`, a pure
// transform. The async `compositeRankingSignal.rankAtDate` wrapper
// delegates to it; one test exercises the wrapper against a mocked
// snapshot store to confirm wiring.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const snapshotState: { latest: any | null; before: any | null } = {
  latest: null,
  before: null,
};

vi.mock('../../snapshot-store', () => ({
  latestSnapshot: vi.fn(async () => snapshotState.latest),
  snapshotBeforeDate: vi.fn(async () => snapshotState.before),
}));

import { compositeRankingSignal, pickFromSnapshot } from '../signal';

function makePick(
  ticker: string,
  composite: number,
  fundamentalPass: boolean,
  sector = 'Technology',
): any {
  return {
    ticker,
    name: ticker,
    sector,
    composite,
    layers: {
      structure: { score: 70, pass: true },
      momentum: { score: 70, pass: true },
      volume: { score: 70, pass: true },
      volatility: { score: 70, pass: true },
      relativeStrength: { score: 70, pass: true },
      fundamental: { score: 70, pass: fundamentalPass },
      catalyst: { score: 70, pass: true },
    },
  };
}

function snap(results: any[]): any {
  return {
    modelVersion: 'test',
    generatedAt: '2024-01-08T21:00:00.000Z',
    scanDurationMs: 1,
    universeChecked: results.length,
    results,
    freshnessBudgetMs: 30 * 60_000,
  };
}

describe('pickFromSnapshot', () => {
  it('takes top-N by composite descending', () => {
    const s = snap([
      makePick('A', 90, true),
      makePick('B', 70, true),
      makePick('C', 80, true),
    ]);
    const r = pickFromSnapshot(s, {
      topN: 2,
      minComposite: 50,
      signalId: 'composite-v1',
    });
    expect(r.map((x) => x.ticker)).toEqual(['A', 'C']);
  });

  it('filters out picks where fundamentalPass=false (earnings gate)', () => {
    const s = snap([
      makePick('A', 90, true),
      makePick('FAIL', 88, false),
      makePick('C', 70, true),
    ]);
    const r = pickFromSnapshot(s, {
      topN: 5,
      minComposite: 50,
      signalId: 'composite-v1',
    });
    expect(r.map((x) => x.ticker)).toEqual(['A', 'C']);
  });

  it('honors minComposite cutoff', () => {
    const s = snap([
      makePick('A', 75, true),
      makePick('B', 65, true),
      makePick('C', 55, true),
    ]);
    const r = pickFromSnapshot(s, {
      topN: 10,
      minComposite: 60,
      signalId: 'composite-v1',
    });
    expect(r.map((x) => x.ticker)).toEqual(['A', 'B']);
  });

  it('breaks composite ties deterministically by ticker', () => {
    const s = snap([
      makePick('B', 80, true),
      makePick('A', 80, true),
      makePick('C', 80, true),
    ]);
    const r = pickFromSnapshot(s, {
      topN: 3,
      minComposite: 50,
      signalId: 'composite-v1',
    });
    expect(r.map((x) => x.ticker)).toEqual(['A', 'B', 'C']);
  });

  it('stamps every result with the provided signalId', () => {
    const s = snap([makePick('A', 80, true)]);
    const r = pickFromSnapshot(s, {
      topN: 1,
      minComposite: 50,
      signalId: 'composite-v1',
    });
    expect(r[0].signalId).toBe('composite-v1');
  });

  it('returns [] for empty snapshot', () => {
    const r = pickFromSnapshot(snap([]), {
      topN: 10,
      minComposite: 50,
      signalId: 'composite-v1',
    });
    expect(r).toEqual([]);
  });

  it('marks fundamentalPass=true on returned rows', () => {
    const s = snap([makePick('A', 80, true)]);
    const r = pickFromSnapshot(s, {
      topN: 1,
      minComposite: 50,
      signalId: 'composite-v1',
    });
    expect(r[0].fundamentalPass).toBe(true);
  });

  it('defaults regime to neutral when snapshot lacks regime info', () => {
    const s = snap([makePick('A', 80, true)]);
    const r = pickFromSnapshot(s, {
      topN: 1,
      minComposite: 50,
      signalId: 'composite-v1',
    });
    expect(r[0].regime).toBe('neutral');
  });
});

describe('compositeRankingSignal.rankAtDate (wiring)', () => {
  beforeEach(() => {
    snapshotState.latest = null;
    snapshotState.before = null;
  });

  it('returns [] when no snapshot exists', async () => {
    const r = await compositeRankingSignal.rankAtDate({
      universe: 'largecap',
      asOfDate: '2024-01-08',
      topN: 10,
    });
    expect(r).toEqual([]);
  });

  it('prefers snapshotBeforeDate over latestSnapshot', async () => {
    snapshotState.before = snap([makePick('FROM_BEFORE', 80, true)]);
    snapshotState.latest = snap([makePick('FROM_LATEST', 90, true)]);
    const r = await compositeRankingSignal.rankAtDate({
      universe: 'largecap',
      asOfDate: '2024-01-08',
      topN: 5,
    });
    expect(r[0].ticker).toBe('FROM_BEFORE');
  });

  it('falls back to latestSnapshot when no prior snapshot exists', async () => {
    snapshotState.before = null;
    snapshotState.latest = snap([makePick('LIVE', 75, true)]);
    const r = await compositeRankingSignal.rankAtDate({
      universe: 'largecap',
      asOfDate: '2024-01-08',
      topN: 5,
    });
    expect(r[0].ticker).toBe('LIVE');
  });

  it('exports a stable signal id', () => {
    expect(compositeRankingSignal.id).toBe('composite-v1');
  });
});
