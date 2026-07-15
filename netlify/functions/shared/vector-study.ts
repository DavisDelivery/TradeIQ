// VECTOR — event-study statistics (pure, no I/O).
//
// CARs are market-adjusted (SPY for LARGE, IWM for MID/SMALL — the
// benchmark series is the caller's choice per event), net of tiered
// round-trip costs, with delistings closed at the last available print.
// Entry is the next regular-session OPEN after the event day (t+1 open,
// per the playbook); exit is the horizon-th trading day's close after
// entry, or the final print if the series ends first (delisting).

import { COST_BPS, type SizeBucket } from './vector-constants';

export interface StudyBar {
  t: number; // epoch ms
  o: number;
  c: number;
}

export interface CarResult {
  car: number; // net market-adjusted return over the window
  entryDate: string;
  exitDate: string;
  delisted: boolean; // exited early at last available print
  holdTd: number;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Net CAR for one event. `bars`/`bench` are full ascending daily series
 * (bench must cover the ticker's dates). Returns null when the event has
 * no tradable t+1 entry (e.g. event on the final print).
 */
export function carForEvent(
  bars: StudyBar[],
  bench: StudyBar[],
  eventDate: string,
  horizonTd: number,
  sizeBucket: SizeBucket,
): CarResult | null {
  const idx = bars.findIndex((b) => isoDay(b.t) > eventDate);
  if (idx < 0) return null; // no bar after the event: nothing tradable
  const entry = bars[idx];
  if (!(entry.o > 0)) return null;

  const exitIdx = Math.min(idx + horizonTd, bars.length - 1);
  const exit = bars[exitIdx];
  const delisted = exitIdx < idx + horizonTd;

  const bIdxEntry = bench.findIndex((b) => b.t >= entry.t);
  if (bIdxEntry < 0) return null;
  // Benchmark exit aligned by DATE (delisted names exit when they exit).
  let bIdxExit = bench.findIndex((b) => b.t >= exit.t);
  if (bIdxExit < 0) bIdxExit = bench.length - 1;

  const raw = exit.c / entry.o - 1;
  const benchRet = bench[bIdxExit].c / bench[bIdxEntry].o - 1;
  const cost = COST_BPS[sizeBucket] / 10_000;
  return {
    car: +(raw - benchRet - cost).toFixed(6),
    entryDate: isoDay(entry.t),
    exitDate: isoDay(exit.t),
    delisted,
    holdTd: exitIdx - idx,
  };
}

// ---------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------

export interface SampleStats {
  n: number;
  mean: number;
  median: number;
  sd: number;
  t: number;
  positiveShare: number;
  p10: number;
  p90: number;
  worstDecileMean: number;
}

export function sampleStats(xs: number[]): SampleStats | null {
  const n = xs.length;
  if (n < 2) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const q = (p: number) => s[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  const decile = s.slice(0, Math.max(1, Math.floor(n / 10)));
  return {
    n,
    mean: +mean.toFixed(6),
    median: +(n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2).toFixed(6),
    sd: +sd.toFixed(6),
    t: sd > 0 ? +((mean / (sd / Math.sqrt(n)))).toFixed(3) : 0,
    positiveShare: +(xs.filter((x) => x > 0).length / n).toFixed(4),
    p10: +q(0.1).toFixed(6),
    p90: +q(0.9).toFixed(6),
    worstDecileMean: +(decile.reduce((a, b) => a + b, 0) / decile.length).toFixed(6),
  };
}

/** Welch two-sample t (difference a - b). */
export function welchT(a: number[], b: number[]): { diff: number; t: number } | null {
  if (a.length < 2 || b.length < 2) return null;
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  const va = a.reduce((x, y) => x + (y - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((x, y) => x + (y - mb) ** 2, 0) / (b.length - 1);
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (!(se > 0)) return null;
  return { diff: +(ma - mb).toFixed(6), t: +(((ma - mb) / se)).toFixed(3) };
}

/** Split values into terciles by a key; returns [low, mid, high] samples. */
export function terciles<T>(rows: T[], key: (r: T) => number | null): [T[], T[], T[]] {
  const valid = rows.filter((r) => key(r) != null);
  const sorted = [...valid].sort((a, b) => (key(a)! - key(b)!));
  const third = Math.floor(sorted.length / 3);
  return [sorted.slice(0, third), sorted.slice(third, 2 * third), sorted.slice(2 * third)];
}

/** Monotone check: means strictly ordered across [low, mid, high]. */
export function monotone(means: [number, number, number]): 'increasing' | 'decreasing' | 'none' {
  const [lo, mid, hi] = means;
  if (lo < mid && mid < hi) return 'increasing';
  if (lo > mid && mid > hi) return 'decreasing';
  return 'none';
}
