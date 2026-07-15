import { describe, it, expect } from 'vitest';
import { carForEvent, sampleStats, welchT, terciles, monotone, type StudyBar } from '../vector-study';
import { runVectorSim, type SimEvent } from '../vector-sim';

const DAY = 86_400_000;
const T0 = Date.parse('2020-01-01T00:00:00Z');

/** Flat-then-configurable daily series; open = prior close (no gaps). */
function series(n: number, dailyRet = 0, startPx = 100): StudyBar[] {
  const out: StudyBar[] = [];
  let px = startPx;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = px * (1 + dailyRet);
    out.push({ t: T0 + i * DAY, o, c: px });
  }
  return out;
}

const dayOf = (i: number) => new Date(T0 + i * DAY).toISOString().slice(0, 10);

describe('carForEvent', () => {
  it('enters at t+1 OPEN, exits at horizon close, subtracts bench and tiered cost', () => {
    const bars = series(100, 0.01); // +1%/day
    const bench = series(100, 0.002); // +0.2%/day
    const r = carForEvent(bars, bench, dayOf(10), 20, 'SMALL');
    expect(r).not.toBeNull();
    expect(r!.entryDate).toBe(dayOf(11)); // t+1
    expect(r!.holdTd).toBe(20);
    expect(r!.delisted).toBe(false);
    // raw ≈ (1.01^21 - 1) from entry open through 20 closes; bench ≈ 0.002-daily
    const raw = bars[31].c / bars[11].o - 1;
    const benchRet = bench[31].c / bench[11].o - 1;
    expect(r!.car).toBeCloseTo(raw - benchRet - 0.008, 4); // SMALL = 80bps
  });

  it('delisting closes at the last available print and flags it', () => {
    const bars = series(20, 0.01); // dies at bar 19
    const bench = series(100, 0.002);
    const r = carForEvent(bars, bench, dayOf(10), 60, 'MID');
    expect(r).not.toBeNull();
    expect(r!.delisted).toBe(true);
    expect(r!.exitDate).toBe(dayOf(19));
    expect(r!.holdTd).toBe(8);
  });

  it('returns null when the event has no tradable next bar', () => {
    const bars = series(10);
    expect(carForEvent(bars, series(10), dayOf(9), 60, 'LARGE')).toBeNull();
  });

  it('cost tiers differ by bucket (LARGE 20 vs SMALL 80 bps)', () => {
    const bars = series(100, 0.005);
    const bench = series(100, 0.005); // identical → raw - bench = 0
    const large = carForEvent(bars, bench, dayOf(5), 10, 'LARGE')!;
    const small = carForEvent(bars, bench, dayOf(5), 10, 'SMALL')!;
    expect(large.car).toBeCloseTo(-0.002, 6);
    expect(small.car).toBeCloseTo(-0.008, 6);
  });
});

describe('stats helpers', () => {
  it('sampleStats: mean/t/positiveShare on a known sample', () => {
    const s = sampleStats([0.01, 0.02, 0.03, -0.01, 0.05])!;
    expect(s.n).toBe(5);
    expect(s.mean).toBeCloseTo(0.02, 6);
    expect(s.positiveShare).toBeCloseTo(0.8, 6);
    expect(s.t).toBeGreaterThan(1);
    expect(sampleStats([0.1])).toBeNull(); // n < 2
  });

  it('welchT: positive diff when a > b', () => {
    const r = welchT([3, 4, 5, 4, 4], [1, 2, 1, 2, 2])!;
    expect(r.diff).toBeCloseTo(2.4, 3);
    expect(r.t).toBeGreaterThan(3);
  });

  it('terciles + monotone', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((v) => ({ v }));
    const [lo, , hi] = terciles(rows, (r) => r.v);
    expect(lo.map((r) => r.v)).toEqual([1, 2, 3]);
    expect(hi.map((r) => r.v)).toEqual([7, 8, 9]);
    expect(monotone([1, 2, 3])).toBe('increasing');
    expect(monotone([3, 2, 1])).toBe('decreasing');
    expect(monotone([1, 3, 2])).toBe('none');
  });
});

describe('runVectorSim', () => {
  const bench = series(300, 0.001);

  it('enters at t+1 open, exits at horizon, reports time-in-market', () => {
    const bars = new Map([['AAA', series(300, 0.005)]]);
    const events: SimEvent[] = [{ ticker: 'AAA', date: dayOf(10), type: 'E2', sizeBucket: 'MID', sector: 'Tech' }];
    const r = runVectorSim(events, bars, bench);
    expect(r.trades).toBe(1);
    expect(r.stopOuts).toBe(0);
    expect(r.totalReturn).toBeGreaterThan(0);
    expect(r.timeInMarket).toBeGreaterThan(0.25); // 90td of 300
    expect(r.timeInMarket).toBeLessThan(0.45);
  });

  it('15% close-to-close disaster stop fires and realizes the loss', () => {
    // Crashes 3%/day from entry: passes -15% around day 5-6.
    const bars = new Map([['BAD', series(300, -0.03)]]);
    const events: SimEvent[] = [{ ticker: 'BAD', date: dayOf(10), type: 'E3', sizeBucket: 'SMALL', sector: null }];
    const r = runVectorSim(events, bars, bench);
    expect(r.stopOuts).toBe(1);
    // Loss bounded: one slot = 1/15 of equity, stopped near -15-20%.
    expect(r.totalReturn).toBeGreaterThan(-0.03);
    expect(r.totalReturn).toBeLessThan(0);
  });

  it('enforces one-per-ticker, 15-slot book, and the 30% sector cap', () => {
    const bars = new Map<string, StudyBar[]>();
    const events: SimEvent[] = [];
    for (let k = 0; k < 20; k++) {
      const t = `T${String(k).padStart(2, '0')}`;
      bars.set(t, series(300, 0.001));
      events.push({ ticker: t, date: dayOf(10), type: 'E2', sizeBucket: 'MID', sector: 'Tech' });
    }
    // duplicate ticker event
    events.push({ ticker: 'T00', date: dayOf(10), type: 'E2', sizeBucket: 'MID', sector: 'Tech' });
    const r = runVectorSim(events, bars, bench);
    // Sector cap: floor(15 * 0.3) = 4 concurrent Tech slots max.
    expect(r.trades).toBe(4);
    expect(r.skippedSectorCap).toBeGreaterThan(0);
    expect(r.skippedDupTicker + r.skippedSectorCap + r.skippedFullBook).toBe(events.length - 4);
  });

  it('delisted mid-hold closes at last print (delistExits)', () => {
    const short = series(30, 0.002); // dies at bar 29
    const bars = new Map([['DED', short]]);
    const events: SimEvent[] = [{ ticker: 'DED', date: dayOf(10), type: 'E3', sizeBucket: 'SMALL', sector: null }];
    const r = runVectorSim(events, bars, bench);
    expect(r.delistExits).toBe(1);
  });

  it('E1 maxHoldTd (next-earnings-2d) shortens the scheduled exit', () => {
    const bars = new Map([['CAP', series(300, 0.002)]]);
    const long = runVectorSim(
      [{ ticker: 'CAP', date: dayOf(10), type: 'E1', sizeBucket: 'LARGE', sector: null }], bars, bench);
    const capped = runVectorSim(
      [{ ticker: 'CAP', date: dayOf(10), type: 'E1', sizeBucket: 'LARGE', sector: null, maxHoldTd: 5 }], bars, bench);
    expect(capped.timeInMarket).toBeLessThan(long.timeInMarket);
  });
});
