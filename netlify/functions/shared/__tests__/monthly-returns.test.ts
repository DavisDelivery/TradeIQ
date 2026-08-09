// QS-1 — universe-wide monthly returns from grouped-daily snapshots.

import { describe, it, expect } from 'vitest';
import {
  monthEndDates,
  ymOfDate,
  buildMonthlyCloses,
  toMonthlyReturns,
  medianDollarVolume,
  indexDollarVolume,
  annualisedVol,
} from '../monthly-returns';
import type { GroupedRow } from '../vector-data';

const row = (T: string, c: number, v = 1_000_000): GroupedRow =>
  ({ T, c, h: c, l: c, o: c, v, t: 0 }) as GroupedRow;

describe('monthEndDates', () => {
  it('takes the last TRADING date in each month, not the calendar last day', () => {
    // 2026-02-28 is a Saturday here; the real month end is the 27th. Asking
    // Polygon for a non-trading date returns an empty grouped response that
    // is indistinguishable from an outage.
    const dates = ['2026-01-02', '2026-01-30', '2026-02-02', '2026-02-27', '2026-03-31'];
    expect(monthEndDates(dates)).toEqual(['2026-01-30', '2026-02-27', '2026-03-31']);
  });

  it('is order-insensitive and returns sorted output', () => {
    expect(monthEndDates(['2026-03-31', '2026-01-30', '2026-02-27']))
      .toEqual(['2026-01-30', '2026-02-27', '2026-03-31']);
  });

  it('handles an empty input', () => {
    expect(monthEndDates([])).toEqual([]);
  });
});

describe('ymOfDate', () => {
  it('extracts YYYYMM', () => {
    expect(ymOfDate('2026-08-09')).toBe(202608);
    expect(ymOfDate('1999-12-31')).toBe(199912);
  });
});

describe('buildMonthlyCloses', () => {
  it('folds snapshots into per-ticker series ordered by month', () => {
    const snaps = new Map<string, GroupedRow[]>([
      ['2026-03-31', [row('AAA', 30), row('BBB', 8)]],
      ['2026-01-30', [row('AAA', 10)]],
      ['2026-02-27', [row('AAA', 20), row('BBB', 5)]],
    ]);
    const out = buildMonthlyCloses(snaps);
    expect(out.get('AAA')!.ym).toEqual([202601, 202602, 202603]);
    expect(out.get('AAA')!.close).toEqual([10, 20, 30]);
    expect(out.get('BBB')!.ym).toEqual([202602, 202603]);
  });

  it('skips rows with a non-positive or missing close', () => {
    const snaps = new Map<string, GroupedRow[]>([
      ['2026-01-30', [row('AAA', 0), row('BBB', 10), { T: 'CCC', c: NaN } as GroupedRow]],
    ]);
    const out = buildMonthlyCloses(snaps);
    expect(out.has('AAA')).toBe(false);
    expect(out.has('CCC')).toBe(false);
    expect(out.get('BBB')!.close).toEqual([10]);
  });
});

describe('toMonthlyReturns', () => {
  it('computes percent returns between consecutive months', () => {
    const s = toMonthlyReturns({ ticker: 'A', ym: [202601, 202602, 202603], close: [100, 110, 99] });
    expect(s.returnsPct[0]).toBeCloseTo(10, 10);
    expect(s.returnsPct[1]).toBeCloseTo(-10, 10);
    expect(s.ym).toEqual([202602, 202603]);
  });

  it('truncates at a month gap rather than splicing across it', () => {
    // A ticker halted for Feb-Mar. Differencing Jan straight into Apr would
    // report a 3-month move as a 1-month return — a fictional momentum spike.
    const s = toMonthlyReturns({
      ticker: 'HALT',
      ym: [202601, 202604, 202605, 202606],
      close: [100, 300, 310, 320],
    });
    // Only the contiguous Apr-Jun run survives.
    expect(s.ym).toEqual([202605, 202606]);
    expect(s.returnsPct.length).toBe(2);
    expect(s.returnsPct[0]).toBeCloseTo((310 - 300) / 300 * 100, 10);
  });

  it('crosses a year boundary as a single month step', () => {
    const s = toMonthlyReturns({ ticker: 'A', ym: [202511, 202512, 202601], close: [100, 110, 121] });
    expect(s.returnsPct.length).toBe(2);
    expect(s.returnsPct[1]).toBeCloseTo(10, 10);
  });

  it('returns an empty series for a single close', () => {
    expect(toMonthlyReturns({ ticker: 'A', ym: [202601], close: [10] }).returnsPct).toEqual([]);
  });
});

describe('dollar volume', () => {
  it('medians across sampled sessions', () => {
    const snaps = [[row('A', 10, 100)], [row('A', 10, 300)], [row('A', 10, 200)]];
    expect(medianDollarVolume('A', snaps)).toBe(2000); // median of 1000/2000/3000
  });

  it('averages the middle two on an even count', () => {
    const snaps = [[row('A', 1, 100)], [row('A', 1, 200)]];
    expect(medianDollarVolume('A', snaps)).toBe(150);
  });

  it('returns null for a ticker that never appears', () => {
    expect(medianDollarVolume('NOPE', [[row('A', 1, 1)]])).toBeNull();
  });

  it('indexDollarVolume agrees with the per-ticker median', () => {
    const snaps = [
      [row('A', 10, 100), row('B', 5, 400)],
      [row('A', 10, 300), row('B', 5, 200)],
      [row('A', 10, 200)],
    ];
    const idx = indexDollarVolume(snaps);
    expect(idx.get('A')).toBe(medianDollarVolume('A', snaps));
    expect(idx.get('B')).toBe(medianDollarVolume('B', snaps));
  });
});

describe('annualisedVol', () => {
  it('annualises a daily stdev by sqrt(252)', () => {
    const daily = [1, -1, 1, -1, 1, -1, 1, -1];
    const v = annualisedVol(daily)!;
    // Sample stdev of ±1 alternating (mean 0, n-1 denominator) is 1.069...
    const expected = Math.sqrt(8 / 7) * Math.sqrt(252);
    expect(v).toBeCloseTo(expected, 8);
  });

  it('returns null with fewer than two observations', () => {
    expect(annualisedVol([1])).toBeNull();
    expect(annualisedVol([])).toBeNull();
  });

  it('ignores non-finite observations', () => {
    expect(annualisedVol([1, NaN, -1, Infinity, 1, -1])).toBeCloseTo(
      annualisedVol([1, -1, 1, -1])!, 10,
    );
  });

  it('is zero for a flat series, not null', () => {
    // A genuinely flat series has measurably zero vol; that is a measurement,
    // not a failure to measure, and exposureFor treats the two differently.
    expect(annualisedVol([0, 0, 0, 0])).toBe(0);
  });
});
