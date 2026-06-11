// M5 (2026-06 review) — defensive dedupe in universePoolForDate.
//
// UNIVERSE_HISTORY is generated data and shipped with literal duplicate
// tickers (e.g. "ADRO","ADRO" in russell2k snapshots). A duplicate flows
// pool → scored twice → two full-weight positions, silently doubling the
// name's portfolio weight. The data itself has been fixed (pinned in
// universe-history.test.ts); this suite mocks a corrupted snapshot to
// prove the pool dedupes defensively even if the generator regresses.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../universe-history', () => {
  const UNIVERSE_HISTORY = [
    {
      date: '2025-09-30',
      index: 'russell2k',
      // Corrupted-generator shape: ADRO appears twice (adjacent, as the
      // real defect did — arrays are sorted so dups are adjacent).
      tickers: ['AAA', 'ADRO', 'ADRO', 'ZZZ'],
    },
    {
      date: '2025-10-31',
      index: 'russell2k',
      tickers: ['AAA', 'ADRO', 'ZZZ'],
    },
  ];
  return {
    UNIVERSE_HISTORY,
    tickersInIndexOnDate: (index: string, date: string) => {
      const candidate = UNIVERSE_HISTORY.filter(
        (s) => s.index === index && s.date <= date,
      ).sort((a, b) => b.date.localeCompare(a.date))[0];
      return candidate ? candidate.tickers : null;
    },
    universeHistoryCoverage: () => ({
      sp500: { firstDate: null, lastDate: null, snapshotCount: 0 },
      ndx: { firstDate: null, lastDate: null, snapshotCount: 0 },
      dow: { firstDate: null, lastDate: null, snapshotCount: 0 },
      russell2k: {
        firstDate: '2025-09-30',
        lastDate: '2025-10-31',
        snapshotCount: 2,
      },
    }),
  };
});

import { universePoolForDate } from '../universe-pool';

describe('universePoolForDate — defensive dedupe (M5)', () => {
  it('drops duplicate tickers from a corrupted snapshot, keeping one slot', () => {
    const r = universePoolForDate('russell2k', '2025-10-15');
    expect(r.snapshotDate).toBe('2025-09-30');
    expect(r.tickers).toEqual(['AAA', 'ADRO', 'ZZZ']);
    // Explicitly: no ticker appears more than once.
    expect(new Set(r.tickers).size).toBe(r.tickers.length);
  });

  it('leaves clean snapshots untouched (order preserved)', () => {
    const r = universePoolForDate('russell2k', '2025-11-15');
    expect(r.snapshotDate).toBe('2025-10-31');
    expect(r.tickers).toEqual(['AAA', 'ADRO', 'ZZZ']);
  });
});
