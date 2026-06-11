// Phase 4e-1 — Prophet Portfolio shared types.
//
// Kept dependency-light: no I/O imports. Each module under
// ./prophet-portfolio/ pulls from here so the state shape, signal
// interface, and rebalance contract have one source of truth.

export type PortfolioUniverse = 'largecap' | 'russell2k';

export interface PortfolioPosition {
  ticker: string;
  /** COSMETIC, entry-time record (Wave 3A / CR-5). Captured at entry for
   *  display + swap-event bookkeeping only. NEVER used for valuation:
   *  Polygon closes are split-adjusted, so a fixed share count × today's
   *  adjusted close misreads every split as a price move. Valuation is
   *  `marketValue`, chained from daily adjusted-close returns. */
  shares: number;
  entryDate: string; // YYYY-MM-DD
  /** Cosmetic entry-time record — in the adjusted basis at entry time;
   *  NOT comparable to currentPrice across later splits. */
  entryPrice: number;
  /** Latest adjusted close observed for display. Cosmetic — splits make
   *  it discontinuous with entryPrice; do not derive value from it. */
  currentPrice: number;
  /** Position value, chained from entry: compounded daily by
   *  todayAdjClose/prevAdjClose − 1 with both closes from the SAME bar
   *  fetch (split-consistent basis), so splits have ~0 equity impact.
   *  Price-only: Polygon adjusted=true is splits-only, dividends are NOT
   *  credited (the SPY benchmark column is price-only too — consistent). */
  marketValue: number;
  weight: number; // marketValue / totalEquity, 0..1
  sector: string;
  /** Bar date (YYYY-MM-DD) `marketValue` is marked to. Absent on rows
   *  persisted before Wave 3A — recomputeMarks migrates those by seeding
   *  the chain from the legacy shares×price marketValue at state.asOfDate. */
  lastMarkDate?: string;
}

export interface PortfolioState {
  universe: PortfolioUniverse;
  asOfDate: string;
  cash: number;
  equity: number; // cash + sum(positions.marketValue)
  positions: PortfolioPosition[];
  lastRebalanceAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

export interface PortfolioConfig {
  universe: PortfolioUniverse;
  startDate: string;
  startCapital: number;
  positionCount: number; // 20 (v2; was 10 in v1)
  minHoldDays: number; // 7 (v2; was 30 in v1)
  maxSwapsPerRebalance: number; // 8 (v2; was 3 in v1)
  sectorCap: number; // 4
  slippageBps: number; // 10
  minComposite: number; // 50
  candidatePool: number; // 50 (v2; was 15 in v1)
  version: string; // 'v2'
}

export type ExitReason =
  | 'fell_out_of_top_N'
  | 'fundamental_fail'
  | 'sector_cap_breach'
  | 'forced_exit';

export type HoldReason =
  | 'still_top_N'
  | 'min_hold_active'
  | 'still_in_universe';

export interface SwapEvent {
  swapId: string;
  timestamp: string;
  asOfDate: string;
  out: Array<{
    ticker: string;
    shares: number;
    exitPrice: number;
    holdDays: number;
    totalReturnPct: number;
    reasonCode: ExitReason;
  }>;
  in: Array<{
    ticker: string;
    shares: number;
    entryPrice: number;
    candidateRank: number;
    composite: number;
    fundamentalScore: number;
  }>;
  candidatesConsidered: number;
  swapsApplied: number;
  snapshotId: string;
  notes: string;
  signalId: string; // 'composite-v1' initially
}

export interface EquityCurvePoint {
  /** The BAR date the marks belong to (latest settled session), NOT the
   *  wall-clock date the cron ran (Wave 3A / M9) — so holidays/weekends
   *  never produce duplicate or misdated points. */
  date: string;
  equity: number;
  cash: number;
  holdingsValue: number;
  /** Return since the previous written point. Normally one session; if
   *  the cron missed sessions it spans them (multi-session, still keyed
   *  to bar dates). Price-only — splits-only adjusted closes on both the
   *  portfolio and the benchmark columns; dividends excluded on both. */
  dailyReturn: number;
  spyClose: number | null;
  qqqClose: number | null;
  iwfClose: number | null;
}

export type DecisionAction = 'ADD' | 'EXIT' | 'HOLD_IN' | 'HOLD_OUT';

/** Lifecycle of a row's forward-return labels (Wave 3A / M5):
 *  - 'pending'   — windows still maturing or unfilled; populator picks it up.
 *  - 'complete'  — all three windows populated.
 *  - 'exhausted' — populator failed MAX_FWD_RETURN_ATTEMPTS times on
 *    matured windows (delisted ticker, no bars, …); unfilled windows are
 *    written as explicit nulls and the row is excluded from future
 *    batches so it can't starve younger rows out of the oldest-first query. */
export type FwdReturnsStatus = 'pending' | 'complete' | 'exhausted';

export interface DecisionLogRow {
  decisionDate: string;
  ticker: string;
  action: DecisionAction;
  composite: number;
  layers: Record<string, { score: number; pass: boolean }>;
  regime: string;
  sieveStage?: number;
  signalId: string;
  // Lagged-populated by scan-prophet-portfolio-fwd-returns.ts (W8).
  forwardReturn30d?: number | null;
  forwardReturn60d?: number | null;
  forwardReturn90d?: number | null;
  /** Wave 3A / M5 — see FwdReturnsStatus. Stamped 'pending' at write. */
  fwdReturnsStatus?: FwdReturnsStatus;
  /** Runs where a matured window stayed unfilled after an attempt. */
  fwdReturnAttempts?: number;
}

// --- Ranking signal interface (W2) ------------------------------------------
//
// The seam where Phase 5b will plug in an ML-driven ranker. 4e-1 ships
// `compositeRankingSignal`; 5b would add `mlRankingSignal` implementing
// the same interface. The rebalance function never imports a concrete
// signal — it consumes the interface.

export interface RankingResult {
  ticker: string;
  name: string;
  sector: string;
  composite: number;
  layers: Record<string, { score: number; pass: boolean }>;
  fundamentalPass: boolean;
  regime: 'risk_on' | 'risk_off' | 'neutral';
  signalId: string;
}

export interface RankingSignal {
  readonly id: string;
  rankAtDate(opts: {
    universe: PortfolioUniverse;
    asOfDate: string;
    topN: number;
    minComposite?: number;
  }): Promise<RankingResult[]>;
}

// --- Rebalance decision (W3) ------------------------------------------------

export interface RebalanceDecision {
  out: Array<{
    ticker: string;
    shares: number;
    reason: ExitReason;
  }>;
  in: Array<{
    ticker: string;
    targetWeight: number;
    rank: number;
    composite: number;
    sector: string;
  }>;
  holds: Array<{
    ticker: string;
    reason: HoldReason;
  }>;
  notes: string[];
}
