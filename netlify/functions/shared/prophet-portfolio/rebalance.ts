// Phase 4e-1 — Rebalance decision logic (pure).
//
// Encodes the v1 rebalance rule from briefs/phase-4e-1-brief.md. No I/O,
// no clock — every output is a deterministic function of the inputs.
// Tests cover the cases enumerated in the brief.
//
// Inputs the caller must arrange:
//   - state: current PortfolioState (positions w/ entryDate + sector)
//   - candidates: top-K RankingResults (K = config.candidatePool, e.g. 15)
//     The candidates list should include every CURRENT HOLDING that is
//     visible in the latest snapshot — otherwise its fundamentalPass
//     cannot be observed and it will be treated as "fell out of top-N"
//     instead of "fundamental_fail". The scheduled-function caller (W5)
//     is responsible for ensuring holdings appear here when present in
//     the snapshot universe.
//
// Output: an ordered RebalanceDecision the caller materializes into
//   trades + new state.

import type {
  PortfolioConfig,
  PortfolioState,
  RankingResult,
  RebalanceDecision,
} from './types';

function daysBetween(entryDate: string, asOfDate: string): number {
  const a = Date.parse(`${entryDate}T00:00:00Z`);
  const b = Date.parse(`${asOfDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

interface CandidateRanked extends RankingResult {
  rank: number; // 1-based, top of candidates list
}

export function decideRebalance(
  state: PortfolioState,
  candidates: RankingResult[],
  config: PortfolioConfig,
  asOfDate: string,
): RebalanceDecision {
  const notes: string[] = [];
  const out: RebalanceDecision['out'] = [];
  const holdsOut: RebalanceDecision['holds'] = [];

  // Rank candidates 1..N for stable downstream attribution.
  const ranked: CandidateRanked[] = candidates.map((c, i) => ({
    ...c,
    rank: i + 1,
  }));
  const byTicker = new Map<string, CandidateRanked>();
  for (const r of ranked) byTicker.set(r.ticker, r);

  const positions = state.positions ?? [];
  const targetWeight = 1 / Math.max(1, config.positionCount);

  // ---- 1. Forced exits: holdings appearing in candidates with
  //         fundamentalPass=false. Earnings-gate breach is a quality
  //         signal change, not noise — bypasses the 30-day min-hold.
  const forcedExits: Array<{
    ticker: string;
    shares: number;
    sortKey: number;
  }> = [];
  for (const p of positions) {
    const c = byTicker.get(p.ticker);
    if (c && !c.fundamentalPass) {
      forcedExits.push({
        ticker: p.ticker,
        shares: p.shares,
        sortKey: c.composite, // low composite exits first if budget binds
      });
    }
  }
  forcedExits.sort((a, b) => a.sortKey - b.sortKey);

  // ---- 2. Drop-outs: holdings NOT in candidates (i.e., fell out of
  //         top-15 entirely) AND held >= minHoldDays.
  const dropOuts: Array<{
    ticker: string;
    shares: number;
    holdDays: number;
  }> = [];
  for (const p of positions) {
    if (byTicker.has(p.ticker)) continue; // still in candidates
    const held = daysBetween(p.entryDate, asOfDate);
    if (held >= config.minHoldDays) {
      dropOuts.push({ ticker: p.ticker, shares: p.shares, holdDays: held });
    } else {
      // Min-hold active — defer exit.
      holdsOut.push({ ticker: p.ticker, reason: 'min_hold_active' });
    }
  }
  // Worst-fallen first — but we don't know the universe rank past 15,
  // so order them by hold-days descending (oldest underperformer first).
  dropOuts.sort((a, b) => b.holdDays - a.holdDays);

  // ---- 3. Apply swap budget. Forced exits get budget priority.
  const budget = Math.max(0, config.maxSwapsPerRebalance);
  const selectedForced = forcedExits.slice(0, budget);
  const deferredForced = forcedExits.slice(budget);
  const budgetAfterForced = Math.max(0, budget - selectedForced.length);
  const selectedDrop = dropOuts.slice(0, budgetAfterForced);
  const deferredDrop = dropOuts.slice(budgetAfterForced);

  for (const e of selectedForced) {
    out.push({ ticker: e.ticker, shares: e.shares, reason: 'fundamental_fail' });
  }
  for (const e of selectedDrop) {
    out.push({ ticker: e.ticker, shares: e.shares, reason: 'fell_out_of_top_N' });
  }

  if (deferredForced.length > 0) {
    notes.push(
      `${deferredForced.length} forced exit(s) deferred (swap budget ${budget}): ${deferredForced.map((d) => d.ticker).join(', ')}`,
    );
    for (const d of deferredForced) {
      holdsOut.push({ ticker: d.ticker, reason: 'still_in_universe' });
    }
  }
  if (deferredDrop.length > 0) {
    notes.push(
      `${deferredDrop.length} drop-out exit(s) deferred (swap budget): ${deferredDrop.map((d) => d.ticker).join(', ')}`,
    );
    for (const d of deferredDrop) {
      holdsOut.push({ ticker: d.ticker, reason: 'still_in_universe' });
    }
  }

  // Positions surviving this rebalance (for sector-cap accounting).
  const exitedTickers = new Set(out.map((e) => e.ticker));
  const survivors = positions.filter((p) => !exitedTickers.has(p.ticker));

  // Holdings that are simply still in top-15 → 'still_top_N'.
  const inSurvivorHoldsAlready = new Set(holdsOut.map((h) => h.ticker));
  for (const s of survivors) {
    if (inSurvivorHoldsAlready.has(s.ticker)) continue;
    holdsOut.push({ ticker: s.ticker, reason: 'still_top_N' });
  }

  // ---- 4. Additions: top-ranked candidates not currently held,
  //         honoring fundamental-pass + sector cap + open slots.
  const sectorCounts = new Map<string, number>();
  for (const s of survivors) {
    sectorCounts.set(s.sector, (sectorCounts.get(s.sector) ?? 0) + 1);
  }
  const heldTickers = new Set(survivors.map((p) => p.ticker));
  const slotsAvailable = Math.max(0, config.positionCount - survivors.length);

  const additions: RebalanceDecision['in'] = [];
  if (slotsAvailable > 0) {
    for (const c of ranked) {
      if (additions.length >= slotsAvailable) break;
      if (heldTickers.has(c.ticker)) continue;
      if (!c.fundamentalPass) continue;
      const sectorTotal = sectorCounts.get(c.sector) ?? 0;
      if (sectorTotal >= config.sectorCap) {
        notes.push(`Skipped ${c.ticker} (sector cap reached for ${c.sector})`);
        continue;
      }
      additions.push({
        ticker: c.ticker,
        targetWeight,
        rank: c.rank,
        composite: c.composite,
        sector: c.sector,
      });
      sectorCounts.set(c.sector, sectorTotal + 1);
    }
  }

  // ---- 5. Cash-sleeve note when we can't fill the portfolio.
  const filledCount = survivors.length + additions.length;
  if (filledCount < config.positionCount) {
    notes.push(
      `Cash sleeve: ${filledCount}/${config.positionCount} positions filled — ` +
        `${config.positionCount - filledCount} slot(s) vacant.`,
    );
  }

  return {
    out,
    in: additions,
    holds: holdsOut,
    notes,
  };
}
