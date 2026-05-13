// Phase 4e-1 — Decision log row builder + forward-return computation.
//
// The decisionLog table is the data substrate Phase 5c (monitoring +
// retraining) consumes. Every rebalance writes one row per decision
// (ADD / EXIT / HOLD_IN / HOLD_OUT) capturing what the signal saw at
// that moment. Forward-return labels (30d/60d/90d) are populated by a
// lagged-update scan (scan-prophet-portfolio-fwd-returns.ts) using
// adjusted-close prices from Polygon.
//
// All logic in this module is pure — I/O is wired up by callers.

import type {
  DecisionAction,
  DecisionLogRow,
  PortfolioState,
  RankingResult,
  RebalanceDecision,
} from './types';

interface BuildDecisionRowsInput {
  asOfDate: string;
  state: PortfolioState;
  candidates: RankingResult[];
  decision: RebalanceDecision;
  signalId: string;
  regime?: string;
  sieveStage?: number;
}

/**
 * Generate one DecisionLogRow per ticker the rebalance touched (ADDs,
 * EXITs, and HOLDs — both 'HOLD_IN' for currently-held names that
 * stayed, and 'HOLD_OUT' for in-universe names we considered but
 * didn't add). Phase 5c will use these to backtest alternative
 * signals against the same as-of feature snapshot.
 */
export function buildDecisionLogRows(
  input: BuildDecisionRowsInput,
): DecisionLogRow[] {
  const { asOfDate, state, candidates, decision, signalId } = input;
  const regime = input.regime ?? 'neutral';
  const sieveStage = input.sieveStage;
  const rows: DecisionLogRow[] = [];

  const candidateByTicker = new Map<string, RankingResult>();
  for (const c of candidates) candidateByTicker.set(c.ticker, c);

  const seen = new Set<string>();

  function pushRow(
    ticker: string,
    action: DecisionAction,
    candidate: RankingResult | undefined,
  ) {
    if (seen.has(ticker)) return;
    seen.add(ticker);
    rows.push({
      decisionDate: asOfDate,
      ticker,
      action,
      composite: candidate?.composite ?? 0,
      layers: candidate?.layers ?? {},
      regime,
      sieveStage,
      signalId,
    });
  }

  for (const a of decision.in) {
    pushRow(a.ticker, 'ADD', candidateByTicker.get(a.ticker));
  }
  for (const e of decision.out) {
    pushRow(e.ticker, 'EXIT', candidateByTicker.get(e.ticker));
  }
  for (const h of decision.holds) {
    const isHeld = state.positions.some((p) => p.ticker === h.ticker);
    pushRow(
      h.ticker,
      isHeld ? 'HOLD_IN' : 'HOLD_OUT',
      candidateByTicker.get(h.ticker),
    );
  }
  // Also log top candidates the rule passed over (didn't pick, didn't
  // already hold) — these are the "shadow" rows that let 5c learn what
  // the rule missed.
  for (const c of candidates) {
    if (seen.has(c.ticker)) continue;
    const isHeld = state.positions.some((p) => p.ticker === c.ticker);
    pushRow(c.ticker, isHeld ? 'HOLD_IN' : 'HOLD_OUT', c);
  }
  return rows;
}

// --- Forward-return computation ---------------------------------------------
//
// Given a decisionLog row dated D and a price series spanning [D, D+90+5d],
// compute the per-window returns:
//   - 30d  trading-day window (≈ 30 calendar days; we approximate by
//     finding the close at the 30th calendar day or the next trading day)
//   - 60d
//   - 90d
//
// Pure helper exposed for unit testing.

export interface PriceBar {
  date: string; // YYYY-MM-DD
  close: number;
}

export function computeForwardReturns(
  decisionDate: string,
  bars: PriceBar[],
  windowsDays: number[] = [30, 60, 90],
): Record<string, number | null> {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  // Entry bar: first bar with date >= decisionDate. (decisionDate close
  // is the reference: this represents the entry at the decision-day
  // close, matching the rebalance simulation.)
  let entryIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].date >= decisionDate) {
      entryIdx = i;
      break;
    }
  }
  const out: Record<string, number | null> = {};
  const ENTRY_TOLERANCE_DAYS = 5;
  // Reject if no bar found, OR if the closest bar is much later than
  // decisionDate (decisionDate precedes the price series).
  if (entryIdx < 0) {
    for (const w of windowsDays) out[`forwardReturn${w}d`] = null;
    return out;
  }
  const decisionMs0 = Date.parse(`${decisionDate}T00:00:00Z`);
  const entryMs = Date.parse(`${sorted[entryIdx].date}T00:00:00Z`);
  if ((entryMs - decisionMs0) / 86_400_000 > ENTRY_TOLERANCE_DAYS) {
    for (const w of windowsDays) out[`forwardReturn${w}d`] = null;
    return out;
  }
  const entryClose = sorted[entryIdx].close;
  if (!Number.isFinite(entryClose) || entryClose <= 0) {
    for (const w of windowsDays) out[`forwardReturn${w}d`] = null;
    return out;
  }
  const decisionMs = Date.parse(`${decisionDate}T00:00:00Z`);
  for (const w of windowsDays) {
    const targetMs = decisionMs + w * 86_400_000;
    const targetDate = new Date(targetMs).toISOString().slice(0, 10);
    // First bar on or after target date.
    let exitIdx = -1;
    for (let i = entryIdx + 1; i < sorted.length; i++) {
      if (sorted[i].date >= targetDate) {
        exitIdx = i;
        break;
      }
    }
    if (exitIdx < 0) {
      out[`forwardReturn${w}d`] = null;
    } else {
      const exitClose = sorted[exitIdx].close;
      out[`forwardReturn${w}d`] = +((exitClose - entryClose) / entryClose).toFixed(6);
    }
  }
  return out;
}
