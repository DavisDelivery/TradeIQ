// Walk-forward rebalance date iterator.
//
// Yields a sequence of trading-day rebalance dates spanning the config's
// [startDate, endDate] window at the requested frequency. The iterator is
// the only place the engine decides "what's today" — every downstream
// asOfDate flows from here. No external clock is consulted; no system
// time leaks anywhere.

import {
  addDays,
  isMarketOpen,
  nextTradingDay,
  prevOrCurrentTradingDay,
} from './trading-calendar';
import type { BacktestConfig, RebalanceFrequency } from './types';

/**
 * Step from one rebalance to the next by frequency. Returns the first
 * trading day on or after the nominal step.
 */
function stepFrequency(date: string, frequency: RebalanceFrequency): string {
  let candidate: string;
  if (frequency === 'weekly') {
    candidate = addDays(date, 7);
  } else if (frequency === 'monthly') {
    // Add ~1 month (30 days) — for backtest cadence this is close enough;
    // exact calendar month would drift on 31st-of-month etc.
    candidate = addDays(date, 30);
  } else {
    // quarterly
    candidate = addDays(date, 91);
  }
  return isMarketOpen(candidate) ? candidate : nextTradingDay(candidate);
}

/**
 * Walk-forward dates as a generator. The first yielded date is the first
 * trading day ≥ startDate (using prevOrCurrentTradingDay semantics for
 * the boundary — if startDate is a weekend, snap forward to next trading
 * day). Subsequent dates step by frequency.
 *
 * Last yielded date is the largest date ≤ endDate.
 */
export function* walkForwardDates(config: BacktestConfig): Generator<string> {
  if (config.startDate > config.endDate) return;
  let d = isMarketOpen(config.startDate)
    ? config.startDate
    : nextTradingDay(config.startDate);
  while (d <= config.endDate) {
    yield d;
    const next = stepFrequency(d, config.rebalanceFrequency);
    if (next <= d) {
      // Defensive: shouldn't happen, but prevents infinite loop.
      return;
    }
    d = next;
  }
}

/**
 * Materialize the iterator as an array — convenient for callers that need
 * to know "the next rebalance" while processing each one.
 */
export function walkForwardArray(config: BacktestConfig): string[] {
  return Array.from(walkForwardDates(config));
}

/**
 * For a given config, find the largest trading day ≤ endDate that the
 * engine should mark equity through. Used by the engine to bound the
 * final segment.
 */
export function finalMarkDate(config: BacktestConfig): string {
  return prevOrCurrentTradingDay(config.endDate);
}
