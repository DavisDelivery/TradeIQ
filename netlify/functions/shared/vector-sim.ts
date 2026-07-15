// VECTOR — portfolio simulation over event positions (pure, no I/O).
//
// Playbook (frozen): entry t+1 open after the event; exits per event type
// (E1 60td capped at next-earnings-2d upstream, E2 90td, E3 120td);
// disaster stop 15% close-to-close; max 15 concurrent equal-weight slots;
// sector cap 30%; one position per ticker; round-trip costs tiered by
// sizeBucket. Cash earns 0. Time-in-market reported. Book verdict input:
// daily active returns vs the benchmark (IWM per the validation rule).

import { PLAYBOOK, COST_BPS, type SizeBucket } from './vector-constants';
import type { StudyBar } from './vector-study';

export interface SimEvent {
  ticker: string;
  date: string; // event day d (entry at next open after d)
  type: 'E1' | 'E2' | 'E3';
  sizeBucket: SizeBucket;
  sector: string | null;
  /** optional cap on hold (E1: next earnings - 2d), in trading days */
  maxHoldTd?: number;
}

export interface SimResult {
  totalReturn: number;
  benchReturn: number;
  activeReturnPp: number; // percentage points
  tActiveDaily: number; // t-stat of mean daily active return
  trades: number;
  stopOuts: number;
  delistExits: number;
  skippedFullBook: number;
  skippedSectorCap: number;
  skippedDupTicker: number;
  timeInMarket: number; // fraction of days with >= 1 open position
  equityCurve: { date: string; equity: number; positions: number }[];
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function runVectorSim(
  events: SimEvent[],
  barsByTicker: Map<string, StudyBar[]>,
  bench: StudyBar[],
): SimResult {
  const horizon: Record<SimEvent['type'], number> = {
    E1: PLAYBOOK.exits.E1.maxTradingDays,
    E2: PLAYBOOK.exits.E2.maxTradingDays,
    E3: PLAYBOOK.exits.E3.maxTradingDays,
  };
  const maxSectorSlots = Math.floor(PLAYBOOK.maxConcurrent * PLAYBOOK.sectorCapPct);

  // Trading calendar = benchmark days.
  const days = bench.map((b) => isoDay(b.t));
  const dayIdx = new Map(days.map((d, i) => [d, i]));

  // Index each ticker's bars by day for O(1) marks.
  const idxByTicker = new Map<string, Map<string, number>>();
  for (const [t, bars] of barsByTicker) {
    idxByTicker.set(t, new Map(bars.map((b, i) => [isoDay(b.t), i])));
  }

  // Queue events by their entry day (first bench day AFTER event date).
  const entriesByDay = new Map<string, SimEvent[]>();
  for (const e of events) {
    const i = days.findIndex((d) => d > e.date);
    if (i < 0) continue;
    const d = days[i];
    if (!entriesByDay.has(d)) entriesByDay.set(d, []);
    entriesByDay.get(d)!.push(e);
  }

  interface Pos {
    ticker: string;
    sector: string | null;
    entryPx: number;
    lastClose: number;
    weightAtEntry: number; // capital fraction committed
    value: number; // current value as fraction of initial capital
    exitOnIdx: number; // bench day index of scheduled exit
    enteredOnIdx: number;
    barMap: Map<string, number>;
    bars: StudyBar[];
    costPaid: number;
  }

  let equity = 1;
  let cash = 1;
  const open: Pos[] = [];
  const equityCurve: SimResult['equityCurve'] = [];
  const dailyActive: number[] = [];
  let trades = 0, stopOuts = 0, delistExits = 0;
  let skippedFullBook = 0, skippedSectorCap = 0, skippedDupTicker = 0;
  let daysInMarket = 0;
  let prevEquity = 1;
  let prevBench: number | null = null;

  for (let di = 0; di < days.length; di++) {
    const d = days[di];

    // 1) Entries at today's open.
    for (const e of entriesByDay.get(d) ?? []) {
      if (open.length >= PLAYBOOK.maxConcurrent) { skippedFullBook++; continue; }
      if (open.some((p) => p.ticker === e.ticker)) { skippedDupTicker++; continue; }
      if (e.sector && open.filter((p) => p.sector === e.sector).length >= maxSectorSlots) {
        skippedSectorCap++; continue;
      }
      const bars = barsByTicker.get(e.ticker);
      const bmap = idxByTicker.get(e.ticker);
      const bi = bmap?.get(d);
      if (!bars || bi == null || !(bars[bi].o > 0)) continue;

      const weight = equity / PLAYBOOK.maxConcurrent; // equal-weight slots
      if (cash < weight * 0.999) { skippedFullBook++; continue; } // cash-constrained
      const cost = (COST_BPS[e.sizeBucket] / 10_000) * weight; // full round-trip charged at entry
      cash -= weight;
      const hold = Math.min(horizon[e.type], e.maxHoldTd ?? Infinity);
      open.push({
        ticker: e.ticker,
        sector: e.sector,
        entryPx: bars[bi].o,
        lastClose: bars[bi].o,
        weightAtEntry: weight,
        value: weight - cost,
        exitOnIdx: di + hold,
        enteredOnIdx: di,
        barMap: bmap!,
        bars,
        costPaid: cost,
      });
      trades++;
    }

    // 2) Mark-to-market at close; process stops/exits/delistings.
    for (let pi = open.length - 1; pi >= 0; pi--) {
      const p = open[pi];
      const bi = p.barMap.get(d);
      let close = p.lastClose;
      let hasBar = false;
      if (bi != null) { close = p.bars[bi].c; hasBar = true; }

      if (hasBar) {
        // Base for today's mark: entry OPEN on the entry day (we bought at
        // the open, not yesterday's close); the last marked close after.
        const base = di === p.enteredOnIdx ? p.entryPx : p.lastClose;
        const ret = base > 0 ? close / base - 1 : 0;
        p.value *= 1 + ret;
        // Disaster stop: 15% below entry, evaluated close-to-close.
        if (close <= p.entryPx * (1 - PLAYBOOK.disasterStopPct)) {
          cash += p.value;
          open.splice(pi, 1);
          stopOuts++;
          continue;
        }
        p.lastClose = close;
      } else {
        // No bar today: either a ticker-specific halt or a delisting. If no
        // future bar exists, the position closes at the last print.
        const anyFuture = p.bars.length && isoDay(p.bars[p.bars.length - 1].t) > d;
        if (!anyFuture) {
          cash += p.value;
          open.splice(pi, 1);
          delistExits++;
          continue;
        }
      }

      // Scheduled exit at horizon close.
      if (di >= p.exitOnIdx) {
        cash += p.value;
        open.splice(pi, 1);
      }
    }

    equity = cash + open.reduce((a, p) => a + p.value, 0);
    if (open.length > 0) daysInMarket++;

    const benchClose = bench[di].c;
    if (prevBench != null) {
      const stratRet = equity / prevEquity - 1;
      const benchRet = benchClose / prevBench - 1;
      dailyActive.push(stratRet - benchRet);
    }
    prevEquity = equity;
    prevBench = benchClose;

    // Monthly-ish sampling keeps the curve doc-sized.
    if (di % 5 === 0 || di === days.length - 1) {
      equityCurve.push({ date: d, equity: +equity.toFixed(6), positions: open.length });
    }
  }

  const benchTotal = bench[bench.length - 1].c / bench[0].c - 1;
  const mean = dailyActive.length ? dailyActive.reduce((a, b) => a + b, 0) / dailyActive.length : 0;
  const sd = dailyActive.length > 1
    ? Math.sqrt(dailyActive.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyActive.length - 1))
    : 0;
  const tActive = sd > 0 ? (mean / (sd / Math.sqrt(dailyActive.length))) : 0;

  return {
    totalReturn: +(equity - 1).toFixed(6),
    benchReturn: +benchTotal.toFixed(6),
    activeReturnPp: +(((equity - 1) - benchTotal) * 100).toFixed(2),
    tActiveDaily: +tActive.toFixed(3),
    trades,
    stopOuts,
    delistExits,
    skippedFullBook,
    skippedSectorCap,
    skippedDupTicker,
    timeInMarket: +(daysInMarket / days.length).toFixed(4),
    equityCurve,
  };
}
