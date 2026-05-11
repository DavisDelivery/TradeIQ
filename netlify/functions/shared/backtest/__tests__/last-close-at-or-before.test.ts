// Unit tests for lastCloseAtOrBefore — exported from engine.ts.
//
// Added in Phase 4a hotfix-2 after the smoke test (PR #8) flagged
// null entryPrice on every ML row. The bug turned out to be in the
// caller's bar window (not the helper itself), but tightening the
// helper with explicit guards and unit coverage prevents future
// regressions in case the Bar shape evolves.

import { describe, it, expect } from 'vitest';
import { lastCloseAtOrBefore } from '../engine';
import type { Bar } from '../../data-provider';

function bar(date: string, close: number): Bar {
  return {
    // 14:30 UTC = 9:30 AM ET market open
    t: new Date(`${date}T14:30:00Z`).getTime(),
    o: close,
    h: close,
    l: close,
    c: close,
    v: 1_000_000,
  } as Bar;
}

describe('lastCloseAtOrBefore', () => {
  const bars: Bar[] = [
    bar('2024-01-02', 100), // Tue
    bar('2024-01-03', 102), // Wed
    bar('2024-01-04', 105), // Thu
    bar('2024-01-05', 103), // Fri
    bar('2024-01-08', 107), // Mon (after weekend)
  ];

  it('returns null for empty bars', () => {
    expect(lastCloseAtOrBefore([], '2024-01-05')).toBeNull();
  });

  it('returns null for date before all bars', () => {
    expect(lastCloseAtOrBefore(bars, '2023-12-31')).toBeNull();
  });

  it('returns latest close for date after all bars', () => {
    expect(lastCloseAtOrBefore(bars, '2024-01-15')).toBe(107);
  });

  it('returns exact-day close when date matches a trading day', () => {
    expect(lastCloseAtOrBefore(bars, '2024-01-03')).toBe(102);
  });

  it('returns most recent prior close when date falls on a weekend', () => {
    expect(lastCloseAtOrBefore(bars, '2024-01-06')).toBe(103); // Sat
    expect(lastCloseAtOrBefore(bars, '2024-01-07')).toBe(103); // Sun
  });

  it('skips bars with non-finite t', () => {
    const dirty: Bar[] = [
      ...bars,
      { t: NaN as unknown as number, o: 0, h: 0, l: 0, c: 999, v: 0 } as Bar,
    ];
    // Last valid bar still wins; NaN-t bar is silently skipped
    expect(lastCloseAtOrBefore(dirty, '2024-01-15')).toBe(107);
  });

  it('skips bars with non-finite c', () => {
    // Insert a bar with a NaN close just after Jan 8 — should still
    // resolve to 107 (the Jan 8 bar) for a Jan 15 query.
    const dirty: Bar[] = [
      ...bars,
      {
        t: new Date('2024-01-09T14:30:00Z').getTime(),
        o: 0,
        h: 0,
        l: 0,
        c: NaN as unknown as number,
        v: 0,
      } as Bar,
    ];
    expect(lastCloseAtOrBefore(dirty, '2024-01-15')).toBe(107);
  });

  it('handles single-bar input', () => {
    const single = [bar('2024-03-15', 200)];
    expect(lastCloseAtOrBefore(single, '2024-03-14')).toBeNull();
    expect(lastCloseAtOrBefore(single, '2024-03-15')).toBe(200);
    expect(lastCloseAtOrBefore(single, '2024-03-16')).toBe(200);
  });

  it('regression: the asOfDate the ML-row writer actually queries', () => {
    // The Phase 4a hotfix-2 regression scenario: ML-row code calls
    // lastCloseAtOrBefore(bars, asOfDate) where asOfDate is the
    // rebalance date and bars span [asOfDate - 30d, asOfDate + 400d].
    // The helper must find the entry bar (asOfDate or the prior
    // trading day if asOfDate is a weekend/holiday).
    const rebalanceDate = '2024-01-31'; // Wed, real trading day
    const window: Bar[] = [
      bar('2024-01-02', 95),
      bar('2024-01-15', 98),
      bar('2024-01-29', 99),
      bar('2024-01-30', 100),
      bar('2024-01-31', 101), // the entry bar
      bar('2024-02-01', 102),
      bar('2024-02-15', 105),
      bar('2024-02-29', 110), // forward bar
    ];
    expect(lastCloseAtOrBefore(window, rebalanceDate)).toBe(101);
  });
});
