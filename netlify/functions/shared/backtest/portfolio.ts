// Portfolio construction: turn a ranked list of scored candidates into a
// target-weight portfolio that respects position-size, sector, and cash
// caps. Pure math — no I/O, no clock.

import type {
  PortfolioConfig,
  PortfolioPosition,
  ScoredCandidate,
} from './types';

/**
 * Pick top-N candidates by composite, filter by minComposite, then size
 * positions to honor position-size + sector caps + cash sleeve.
 *
 * Sizing algorithm:
 *   1. Drop candidates with composite < minComposite.
 *   2. Take top N by composite (ties broken by ticker for determinism).
 *   3. Compute raw weights:
 *        - equal: 1/N per pick
 *        - composite: pick.composite / sum(composites)
 *   4. Cap each position at maxPositionPct; redistribute the overflow
 *      pro-rata across remaining (un-capped) positions, iterating until
 *      stable or empty.
 *   5. Apply sector cap by clipping per-sector total to maxSectorPct;
 *      overflow drops the lowest-composite positions in that sector
 *      first.
 *   6. Scale all weights so they sum to (1 - cashSleeve).
 */
export function buildPortfolio(
  candidates: ScoredCandidate[],
  config: PortfolioConfig,
): PortfolioPosition[] {
  // Step 1: threshold + deterministic sort
  const filtered = candidates
    .filter((c) => c.composite >= config.minComposite)
    .sort((a, b) => {
      if (b.composite !== a.composite) return b.composite - a.composite;
      return a.ticker.localeCompare(b.ticker);
    });

  // Step 2: top-N
  const top = filtered.slice(0, config.topN);
  if (top.length === 0) return [];

  // Step 3: raw weights pre-cap
  let weights = new Map<string, number>();
  if (config.weighting === 'equal') {
    const w = 1 / top.length;
    for (const c of top) weights.set(c.ticker, w);
  } else {
    const totalComposite = top.reduce((s, c) => s + Math.max(0, c.composite), 0);
    if (totalComposite <= 0) {
      const w = 1 / top.length;
      for (const c of top) weights.set(c.ticker, w);
    } else {
      for (const c of top)
        weights.set(c.ticker, Math.max(0, c.composite) / totalComposite);
    }
  }

  // Step 4: cap individual positions at maxPositionPct, redistribute
  weights = applyPositionCap(weights, config.maxPositionPct);

  // Step 5: sector cap — drop lowest-composite picks in over-cap sectors
  const sectorOf = new Map(top.map((c) => [c.ticker, c.sector ?? 'Unknown']));
  weights = applySectorCap(
    weights,
    sectorOf,
    new Map(top.map((c) => [c.ticker, c.composite])),
    config.maxSectorPct,
    config.maxPositionPct,
  );

  // Step 6: scale to 1 - cashSleeve, but never above maxPositionPct per
  // position. If the math can't fit (e.g. topN=3 with maxPositionPct=0.25
  // can only sum to 0.75), the residual is additional implicit cash.
  const sum = [...weights.values()].reduce((s, w) => s + w, 0);
  const target = 1 - config.cashSleeve;
  if (sum > 0 && target > 0) {
    const maxAchievable = top.length * config.maxPositionPct;
    const effectiveTarget = Math.min(target, maxAchievable);
    const scale = effectiveTarget / sum;
    for (const [k, v] of weights) {
      weights.set(k, Math.min(config.maxPositionPct, v * scale));
    }
  }

  // Materialize positions in composite-descending order for stability
  const out: PortfolioPosition[] = [];
  for (const c of top) {
    const w = weights.get(c.ticker);
    if (w === undefined || w <= 0) continue;
    out.push({
      ticker: c.ticker,
      weight: w,
      composite: c.composite,
      layers: c.layers,
      sector: c.sector,
    });
  }
  return out;
}

/**
 * Iteratively cap positions at maxPositionPct, redistributing overflow
 * pro-rata to non-capped positions. Terminates when no caps are exceeded
 * or all positions are capped.
 */
function applyPositionCap(
  weights: Map<string, number>,
  cap: number,
): Map<string, number> {
  if (cap >= 1) return weights;
  const result = new Map(weights);
  for (let iter = 0; iter < 100; iter++) {
    let overflow = 0;
    const uncapped: string[] = [];
    for (const [k, v] of result) {
      if (v > cap) {
        overflow += v - cap;
        result.set(k, cap);
      } else {
        uncapped.push(k);
      }
    }
    if (overflow === 0 || uncapped.length === 0) break;
    const uncappedSum = uncapped.reduce((s, k) => s + result.get(k)!, 0);
    if (uncappedSum === 0) {
      // Equal split overflow across uncapped
      const share = overflow / uncapped.length;
      for (const k of uncapped) {
        result.set(k, Math.min(cap, result.get(k)! + share));
      }
    } else {
      for (const k of uncapped) {
        const share = (result.get(k)! / uncappedSum) * overflow;
        result.set(k, Math.min(cap, result.get(k)! + share));
      }
    }
  }
  return result;
}

/**
 * Drop lowest-composite positions in any sector whose aggregate weight
 * exceeds maxSectorPct. After dropping, re-apply position cap.
 */
function applySectorCap(
  weights: Map<string, number>,
  sectorOf: Map<string, string>,
  compositeOf: Map<string, number>,
  sectorCap: number,
  positionCap: number,
): Map<string, number> {
  if (sectorCap >= 1) return weights;
  const result = new Map(weights);
  for (let iter = 0; iter < 100; iter++) {
    const sectorTotals = new Map<string, number>();
    for (const [k, w] of result) {
      const s = sectorOf.get(k) ?? 'Unknown';
      sectorTotals.set(s, (sectorTotals.get(s) ?? 0) + w);
    }
    let droppedAny = false;
    for (const [sector, total] of sectorTotals) {
      if (total <= sectorCap) continue;
      // Drop the lowest-composite ticker in this sector
      const inSector = [...result.entries()]
        .filter(([k]) => (sectorOf.get(k) ?? 'Unknown') === sector)
        .sort((a, b) => (compositeOf.get(a[0]) ?? 0) - (compositeOf.get(b[0]) ?? 0));
      if (inSector.length === 0) break;
      result.delete(inSector[0][0]);
      droppedAny = true;
      break; // re-scan after each drop
    }
    if (!droppedAny) break;
    // Renormalize and re-apply position cap on the survivors
    const sum = [...result.values()].reduce((s, w) => s + w, 0);
    if (sum > 0) {
      for (const [k, w] of result) result.set(k, w / sum);
    }
    const recapped = applyPositionCap(result, positionCap);
    result.clear();
    for (const [k, v] of recapped) result.set(k, v);
  }
  return result;
}

/**
 * Compute trades from prevPositions → newPositions. Returns one trade
 * record per ticker that has a nonzero delta. Notional = |Δweight| ×
 * portfolio NAV.
 *
 * Trade side: buy when newWeight > prevWeight, sell otherwise.
 */
export function diffPortfolios(
  prev: PortfolioPosition[],
  next: PortfolioPosition[],
  portfolioNAV: number,
  rebalanceDate: string,
  prevPriceOf: Map<string, number>,
): Array<{
  rebalanceDate: string;
  ticker: string;
  side: 'buy' | 'sell';
  prevWeight: number;
  newWeight: number;
  deltaWeight: number;
  notional: number;
  refPrice: number | null;
  sector: string | null;
}> {
  const prevMap = new Map(prev.map((p) => [p.ticker, p]));
  const nextMap = new Map(next.map((p) => [p.ticker, p]));
  const tickers = new Set<string>([...prevMap.keys(), ...nextMap.keys()]);
  const out: Array<{
    rebalanceDate: string;
    ticker: string;
    side: 'buy' | 'sell';
    prevWeight: number;
    newWeight: number;
    deltaWeight: number;
    notional: number;
    refPrice: number | null;
    sector: string | null;
  }> = [];
  for (const t of tickers) {
    const prevW = prevMap.get(t)?.weight ?? 0;
    const newW = nextMap.get(t)?.weight ?? 0;
    const delta = newW - prevW;
    if (delta === 0) continue;
    out.push({
      rebalanceDate,
      ticker: t,
      side: delta > 0 ? 'buy' : 'sell',
      prevWeight: prevW,
      newWeight: newW,
      deltaWeight: delta,
      notional: Math.abs(delta) * portfolioNAV,
      refPrice: prevPriceOf.get(t) ?? null,
      sector: nextMap.get(t)?.sector ?? prevMap.get(t)?.sector ?? null,
    });
  }
  // Deterministic order
  out.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return out;
}
