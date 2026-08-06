// SECTOR-1 — the cross-sector table's honesty rules.
//
// The failure mode this guards is the one that has cost this app the most:
// a number that looks like what it is not. A "12-month return" computed from
// eight months of bars, or a "#1 of 11" when only nine sectors had data,
// reads as fact and is not one.

import { describe, it, expect } from 'vitest';
import {
  windowReturnPct,
  sma,
  buildSectorPerformance,
  LOOKBACKS,
} from '../sector-performance';

const DAY = 86_400_000;

/** Ascending bars whose closes follow `f(i)`. */
function bars(n: number, f: (i: number) => number) {
  return Array.from({ length: n }, (_, i) => ({
    t: Date.parse('2025-01-01T00:00:00Z') + i * DAY,
    o: f(i), h: f(i), l: f(i), c: f(i), v: 1_000_000,
  }));
}
/** Flat series at `v`, length n. */
const flat = (n: number, v: number) => bars(n, () => v);
/** Series ending `pct` above where it was `n` bars ago. */
function endsUp(len: number, n: number, pct: number) {
  return bars(len, (i) => (i <= len - 1 - n ? 100 : 100 * (1 + pct / 100)));
}

describe('windowReturnPct', () => {
  it('measures the last n trading days', () => {
    // 300 bars; last 63 are 10% above the prior level
    expect(windowReturnPct(endsUp(300, 63, 10), 63)).toBeCloseTo(10, 6);
  });

  it('returns null rather than a partial-window number', () => {
    // 100 bars cannot answer a 252-day question — the dangerous behaviour
    // would be returning the 100-day number under a "12 month" label.
    expect(windowReturnPct(flat(100, 50), LOOKBACKS.m12)).toBeNull();
    expect(windowReturnPct(flat(253, 50), LOOKBACKS.m12)).not.toBeNull();
  });

  it('needs n+1 bars, because an n-day return spans n+1 observations', () => {
    expect(windowReturnPct(flat(21, 10), 21)).toBeNull();
    expect(windowReturnPct(flat(22, 10), 21)).toBe(0);
  });

  it('is null on a zero or non-finite base rather than Infinity', () => {
    expect(windowReturnPct(bars(30, (i) => (i === 8 ? 0 : 10)), 21)).toBeNull();
  });
});

describe('sma', () => {
  it('averages the final n closes', () => {
    expect(sma(flat(250, 40), 200)).toBe(40);
  });
  it('is null when the series is shorter than the window', () => {
    expect(sma(flat(199, 40), 200)).toBeNull();
  });
});

describe('buildSectorPerformance', () => {
  const spyBars = endsUp(300, 63, 5); // SPY +5% over 3m

  it('ranks sectors by return, strongest first', () => {
    const res = buildSectorPerformance(
      {
        XLK: endsUp(300, 63, 20),
        XLF: endsUp(300, 63, 10),
        XLE: endsUp(300, 63, -5),
      },
      spyBars,
    );
    const byName = Object.fromEntries(res.sectors.map((s) => [s.sector, s]));
    expect(byName.Technology.windows.m3.rank).toBe(1);
    expect(byName.Financials.windows.m3.rank).toBe(2);
    expect(byName.Energy.windows.m3.rank).toBe(3);
  });

  it('reports excess over SPY in percentage points', () => {
    const res = buildSectorPerformance({ XLK: endsUp(300, 63, 20) }, spyBars);
    const tech = res.sectors.find((s) => s.sector === 'Technology')!;
    expect(tech.windows.m3.returnPct).toBeCloseTo(20, 6);
    expect(tech.windows.m3.vsSpyPp).toBeCloseTo(15, 6); // 20 − 5
  });

  it('rankOf counts only the sectors that had data for THAT window', () => {
    // XLK has a full year; XLF only has 100 bars, so it is rankable at 3m
    // but not at 12m. "#1 of 2" at 3m and "#1 of 1" at 12m are both true.
    const res = buildSectorPerformance(
      { XLK: endsUp(300, 63, 20), XLF: endsUp(100, 63, 10) },
      spyBars,
    );
    const tech = res.sectors.find((s) => s.sector === 'Technology')!;
    const fin = res.sectors.find((s) => s.sector === 'Financials')!;
    expect(tech.windows.m3.rankOf).toBe(2);
    expect(tech.windows.m12.rankOf).toBe(1);
    expect(fin.windows.m12.rank).toBeNull();
    expect(fin.windows.m12.returnPct).toBeNull();
  });

  it('names sectors with no data instead of rendering them as zero', () => {
    const res = buildSectorPerformance({ XLK: endsUp(300, 63, 20) }, spyBars);
    expect(res.unavailable).toContain('Energy');
    expect(res.sectors.map((s) => s.sector)).not.toContain('Energy');
    // and nothing fabricated a 0% return for the missing ones
    expect(res.sectors.every((s) => s.windows.m3.returnPct !== 0 || s.sector === 'Technology')).toBe(true);
  });

  it('flags whether the sector ETF is above its own 200-day average', () => {
    const rising = buildSectorPerformance({ XLK: bars(300, (i) => 100 + i) }, spyBars);
    const falling = buildSectorPerformance({ XLK: bars(300, (i) => 400 - i) }, spyBars);
    expect(rising.sectors[0].aboveSma200).toBe(true);
    expect(falling.sectors[0].aboveSma200).toBe(false);
  });

  it('leaves vsSpyPp null when SPY itself is unavailable — never treats missing SPY as 0%', () => {
    const res = buildSectorPerformance({ XLK: endsUp(300, 63, 20) }, []);
    const tech = res.sectors[0];
    expect(tech.windows.m3.returnPct).toBeCloseTo(20, 6);
    expect(tech.windows.m3.vsSpyPp).toBeNull();
  });

  it('survives a completely empty provider response', () => {
    const res = buildSectorPerformance({}, []);
    expect(res.sectors).toHaveLength(0);
    expect(res.unavailable.length).toBeGreaterThan(10);
    expect(res.asOf).toBeNull();
  });
});
