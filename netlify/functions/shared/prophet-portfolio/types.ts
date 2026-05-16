// Phase 4e-1 — Prophet Portfolio shared types.
//
// Kept dependency-light: no I/O imports. Each module under
// ./prophet-portfolio/ pulls from here so the state shape, signal
// interface, and rebalance contract have one source of truth.

export type PortfolioUniverse = 'largecap' | 'russell2k';

export interface PortfolioPosition {
  ticker: string;
  shares: number;
  entryDate: string; // YYYY-MM-DD
  entryPrice: number;
  currentPrice: number;
  marketValue: number; // shares * currentPrice
  weight: number; // marketValue / totalEquity, 0..1
  sector: string;
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
  date: string;
  equity: number;
  cash: number;
  holdingsValue: number;
  dailyReturn: number;
  spyClose: number | null;
  qqqClose: number | null;
  iwfClose: number | null;
}

export type DecisionAction = 'ADD' | 'EXIT' | 'HOLD_IN' | 'HOLD_OUT';

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
