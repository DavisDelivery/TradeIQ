// Shared types for the Phase 4a backtest engine.
//
// Kept central so that workstreams W2..W12 reference one source of truth.

import type { UniverseIndex } from '../universe-history';

export type BacktestUniverse = UniverseIndex; // 'sp500' | 'ndx' | 'dow' | 'russell2k'

export type BacktestBoard =
  | 'prophet'
  | 'target'
  | 'catalyst'
  | 'insider'
  | 'williams'
  | 'lynch'
  | 'earnings' | 'fable'; // FIX-2 W1 — event-anchored earnings board (PEAD/vol/drift)

export type RebalanceFrequency = 'weekly' | 'monthly' | 'quarterly';

export interface PortfolioConfig {
  topN: number; // top-ranked picks per rebalance
  weighting: 'equal' | 'composite'; // composite = weight ∝ composite score
  maxPositionPct: number; // 0..1, e.g. 0.05 = 5%
  maxSectorPct: number; // 0..1
  cashSleeve: number; // 0..1
  minComposite: number; // drop candidates with composite < this
}

export interface CostConfig {
  // Slippage in basis points per leg (applied to entry AND exit).
  slippageBps: Partial<Record<BacktestUniverse, number>>;
  commission: number; // flat dollars per trade
}

export interface BacktestConfig {
  universe: BacktestUniverse;
  startDate: string; // YYYY-MM-DD (inclusive)
  endDate: string; // YYYY-MM-DD (inclusive)
  rebalanceFrequency: RebalanceFrequency;
  board: BacktestBoard;
  portfolio: PortfolioConfig;
  costs: CostConfig;
  initialCapital: number; // dollars
  // Concurrency cap on per-ticker scoring within a rebalance. Free-tier
  // Polygon hates >5. Cache warms after run 1.
  scoringConcurrency?: number;
  // Optional override for "now" — used only by integrity tests. Engine
  // never reads system clock for asOfDate decisions.
  clockOverride?: string;
  /**
   * For boards with a discrete signal (Phase 4n: williams, lynch), when
   * true the PIT scoring path returns null for candidates whose verdict
   * is not BUY. Makes the engine validate the discrete signal itself —
   * "BUY portfolio vs SPY" — rather than a score-ranked basket.
   *
   * Has no effect on the prophet board (no discrete verdict).
   */
  discreteSignalOnly?: boolean;
}

// --- per-rebalance / per-trade records ------------------------------------

export interface ScoredCandidate {
  ticker: string;
  composite: number;
  layers: Record<string, number>;
  metadata: Record<string, unknown>;
  sector: string | null;
}

export interface PortfolioPosition {
  ticker: string;
  weight: number; // target weight in [0, 1]
  composite: number;
  layers: Record<string, number>;
  sector: string | null;
}

export interface TradeRecord {
  rebalanceDate: string;
  ticker: string;
  side: 'buy' | 'sell';
  prevWeight: number;
  newWeight: number;
  deltaWeight: number; // newWeight - prevWeight
  notional: number; // absolute dollar notional traded
  slippageBps: number;
  slippageDollars: number;
  commissionDollars: number;
  // Reference price (close on rebalanceDate) used for accounting.
  refPrice: number | null;
}

export interface DailyEquityPoint {
  date: string; // YYYY-MM-DD
  value: number; // dollars
}

// --- attribution + ML-hook --------------------------------------------------

/**
 * Per-ticker scoring failure captured by the engine's rebalance loop.
 * Phase 4a hotfix added this to replace the previous silent catch{}.
 * One row per (rebalanceDate, ticker, error) tuple — kept as a sample
 * (capped at 20 across the run) so the result document stays under
 * Firestore's 1MiB limit.
 */
export interface TickerFailure {
  rebalanceDate: string;
  ticker: string;
  message: string;
  stage: string; // 'scoreTickerAtDate' for now; expand if other stages catch
}

export interface AttributionRecord {
  rebalanceDate: string;
  ticker: string;
  weight: number;
  segmentReturn: number; // return over (rebalanceDate, nextRebalanceDate]
  contribution: number; // weight * segmentReturn
  // Per-analyst layer breakdown captured at decision time. Enables Phase 5
  // ML training to learn per-layer alpha attribution.
  layers: Record<string, number>;
  composite: number;
  regime: string | null;
}

export interface MLTrainingRow {
  runId: string;
  ticker: string;
  asOfDate: string;
  composite: number;
  layers: Record<string, number>;
  regime: string | null;
  sector: string | null;
  marketCapBucket: 'small' | 'mid' | 'large' | null;
  // Phase 5a-prep: a row is now emitted for EVERY scored candidate at a
  // rebalance, not just the held positions. `inPortfolio` marks whether
  // this candidate actually made it into the target portfolio. The 5a ML
  // pipeline trains cross-sectionally over all scored candidates; this
  // flag lets it filter to held-only when needed without losing the
  // unbiased full-universe sample. Required (not optional) — every row
  // genuinely knows whether it was held.
  inPortfolio: boolean;
  entryPrice: number | null;
  exitPrice: number | null;
  holdDays: number | null;
  forward5dReturn: number | null;
  forward20dReturn: number | null;
  forward60dReturn: number | null;
  forward252dReturn: number | null;
  realizedPnl: number | null;
}

// --- metrics ----------------------------------------------------------------

export interface PerformanceMetrics {
  totalReturnPct: number;
  cagrPct: number;
  sharpe: number; // 252-day, risk-free from FRED DGS3MO at endDate
  sortino: number;
  maxDrawdownPct: number;
  recoveryDays: number | null; // null if did not recover by endDate
  winRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  informationCoefficient: number; // mean Spearman(composite, fwd20dRet)
  informationRatio: number; // (port - bench) / tracking error
  tradeCount: number;
  rebalanceCount: number;
  perRegime: Record<
    string,
    {
      // Average per-position ~20-trading-day segment return (percent,
      // un-annualized). Replaces the old per-regime `sharpe`, which
      // annualized cross-sectional segment returns with √(252/20) —
      // statistically meaningless (code-review-2026-06 track-3 minor 2).
      // Runs persisted before Wave 4D carry `sharpe` instead.
      avgSegmentReturnPct: number;
      totalReturnPct: number;
      rebalanceCount: number;
    }
  >;
}

// --- top-level result -------------------------------------------------------

export interface BacktestResult {
  runId: string;
  config: BacktestConfig;
  metrics: PerformanceMetrics;
  dailyEquity: DailyEquityPoint[];
  trades: TradeRecord[];
  perAnalystAttribution: AttributionRecord[];
  /**
   * Was this backtest run over a survivorship-corrected universe window?
   * Per-universe map allows Phase 4b UI to surface honest disclosure.
   *
   * `corrected=true` ⇔ every rebalance date fell within snapshot coverage
   * for the universe. `false` ⇔ at least one rebalance fell outside coverage
   * and used a current-seed approximation. Phase 4b shows a banner.
   */
  universeSurvivorshipCorrected: {
    universe: BacktestUniverse;
    corrected: boolean;
    coverageThrough: string | null; // earliest snapshot date used
  };
  warnings: string[];
  /**
   * Per-ticker failures from the scoring loop, with a summary aggregate.
   * Added in Phase 4a hotfix to replace the previous silent catch{} that
   * masked the Firestore-undefined-field bug. Sample is bounded to keep
   * the result doc under Firestore's 1MiB ceiling.
   */
  tickerFailures: {
    total: number;
    totalAttempts: number;
    failureRatePct: number;
    sample: TickerFailure[]; // first 20 across the run
  };
  /**
   * CR-2 (2026-06 review): count of candidate scores produced for tickers
   * in the PIT pool but OUTSIDE the current universe seed (historical
   * index members — typically delisted/acquired names). These used to be
   * silently dropped, re-introducing survivorship bias; now they score
   * with degraded name/sector metadata and are counted here. Optional:
   * results persisted before the fix predate the field.
   */
  scoredOutsideCurrentUniverse?: number;
  completedAt: string;
  benchmark: {
    ticker: string;
    totalReturnPct: number;
  } | null;
}
