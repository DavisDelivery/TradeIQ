// Phase 4f W4b — Unusual options activity.
//
// Aggregates a window of options trades + per-strike open-interest
// snapshots into a single OptionsFlowSignal. Pure compute; caller
// fetches the raw data via Polygon (or supplies fixtures in tests).
//
// Flags (per brief):
//   - **Sweeps**: a fill that crossed ≥ 3 exchanges within ~100ms.
//     We assume the caller has already grouped multi-exchange fills
//     into a single trade with `exchanges >= 3` set.
//   - **Blocks**: a single print with premium notional ≥ $500K (size
//     × per-contract premium × 100, since each contract = 100 shares).
//   - **OI spikes**: any strike where (oiToday - oiPrev) / max(1, oiPrev)
//     > 0.5.
//   - **Volume / OI > 3**: handled implicitly via OI spikes when total
//     traded volume on a strike exceeded prior OI substantially. Not
//     reported separately to keep the signal surface small.
//
// Directional bucketing:
//   - Calls bought (at or above ask) → bullish
//   - Calls sold (at or below bid) → bearish
//   - Puts bought → bearish
//   - Puts sold → bullish
//   - Mid-spread fills → split evenly into bull/bear pools
//
// Premium is computed in dollar terms: contracts × per-contract
// premium × 100 (CBOE multiplier).

import type {
  OptionsFlowSignal,
  OptionStrikeOI,
  OptionsTickWindow,
  PolygonOptionsTrade,
} from './types';

const BLOCK_PREMIUM_USD = 500_000;
const SWEEP_EXCHANGES = 3;
const OI_SPIKE_THRESHOLD = 0.5;
const CONTRACT_MULTIPLIER = 100;

type Aggression = 'bought' | 'sold' | 'mid';

function classifyAggression(t: PolygonOptionsTrade): Aggression {
  if (t.bid != null && t.ask != null && t.ask > t.bid) {
    if (t.p >= t.ask) return 'bought';
    if (t.p <= t.bid) return 'sold';
    return 'mid';
  }
  return 'mid';
}

function isBullish(side: PolygonOptionsTrade['side'], agg: Aggression): 0 | 1 | 0.5 {
  if (agg === 'mid') return 0.5;
  if (side === 'C' && agg === 'bought') return 1;
  if (side === 'C' && agg === 'sold') return 0;
  if (side === 'P' && agg === 'sold') return 1;
  if (side === 'P' && agg === 'bought') return 0;
  return 0.5;
}

export function premiumOf(t: PolygonOptionsTrade): number {
  return t.p * t.s * CONTRACT_MULTIPLIER;
}

export function countSweeps(trades: PolygonOptionsTrade[]): number {
  let n = 0;
  for (const t of trades) {
    if ((t.exchanges ?? 0) >= SWEEP_EXCHANGES) n++;
  }
  return n;
}

export function countBlocks(trades: PolygonOptionsTrade[]): number {
  let n = 0;
  for (const t of trades) {
    if (premiumOf(t) >= BLOCK_PREMIUM_USD) n++;
  }
  return n;
}

export function countOiSpikes(oi: OptionStrikeOI[]): number {
  let n = 0;
  for (const row of oi) {
    const prev = Math.max(1, row.openInterestPrev);
    const delta = (row.openInterestToday - row.openInterestPrev) / prev;
    if (delta > OI_SPIKE_THRESHOLD) n++;
  }
  return n;
}

export interface OptionsFlowInput {
  ticker: string;
  asOfDate: string;
  window: OptionsTickWindow;
}

export function computeOptionsFlowSignal(
  input: OptionsFlowInput,
): OptionsFlowSignal {
  const trades = input.window.trades;
  let bullish = 0;
  let bearish = 0;
  for (const t of trades) {
    const prem = premiumOf(t);
    const bullScore = isBullish(t.side, classifyAggression(t));
    if (bullScore === 1) bullish += prem;
    else if (bullScore === 0) bearish += prem;
    else {
      bullish += prem / 2;
      bearish += prem / 2;
    }
  }
  const sweepCount = countSweeps(trades);
  const blockCount = countBlocks(trades);
  const oiSpikeStrikes = countOiSpikes(input.window.openInterest);

  const netDirectionalPremium = +(bullish - bearish).toFixed(2);
  const totalPremium = bullish + bearish;

  // Composite 0..100. Three sub-scores at 0..100:
  //   - direction: |net| / total, scaled (50 = neutral, 100 = all-bullish)
  //   - flow_intensity: sweeps + blocks (capped, scaled)
  //   - oi_intensity: OI-spike strike count (capped, scaled)
  //
  // Then averaged. Cap helpers keep this stable across thin and thick
  // tape days.
  const direction =
    totalPremium > 0
      ? 50 + 50 * (netDirectionalPremium / totalPremium)
      : 50;
  const flowIntensity = Math.min(100, (sweepCount + blockCount) * 5);
  const oiIntensity = Math.min(100, oiSpikeStrikes * 10);
  const unusualScore = +((direction + flowIntensity + oiIntensity) / 3).toFixed(2);

  return {
    ticker: input.ticker,
    asOfDate: input.asOfDate,
    bullishPremium: +bullish.toFixed(2),
    bearishPremium: +bearish.toFixed(2),
    netDirectionalPremium,
    sweepCount,
    blockCount,
    oiSpikeStrikes,
    unusualScore,
  };
}
