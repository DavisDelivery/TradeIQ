// Type contracts matching v1 frontend expectations exactly.

export type Direction = 'long' | 'short' | 'neutral';
export type Tier = 'A' | 'B' | 'C';
export type ConflictLevel = 'none' | 'mild' | 'moderate' | 'severe';

export interface AnalystContribution {
  analyst: string;
  score: number; // 0-100
  direction: Direction;
  weight: number;
}

export interface TopSignal {
  type: string;
  score: number;
}

export interface Target {
  ticker: string;
  composite: number;
  tier: Tier;
  direction: Direction;
  price: number;
  priceChangePct: number;
  rationale: string;
  analystContributions: AnalystContribution[];
  topSignals: TopSignal[];
  conflictLevel: ConflictLevel;
  scoredAt: string;
  /** Phase 4f W5 — provenance fields. Analysts whose scores
   *  contributed to the composite; analysts excluded as no-data this
   *  scoring call. UI renders LIVE / NO_DATA badges off these. */
  scoredAnalysts?: string[];
  noDataAnalysts?: string[];
  /** Phase 4h W3 — pick display enrichment. companyName comes from
   *  the Polygon ticker-reference cache (falling back to the in-repo
   *  universe table); sector is the value the sector-rotation analyst
   *  already uses for its sector-ETF lookup. Persisted onto every
   *  snapshot pick at scan time so reads serve them for free. */
  companyName?: string;
  sector?: string | null;
}

export interface TargetBoardResponse {
  targets: Target[];
  generatedAt: string;
  source: string;
  error?: string;
  /** Phase 4h W2 — true when the served snapshot is older than its
   *  freshness budget. Russell2k / sp500 may go stale between nightly
   *  scans; UI surfaces "as of {generatedAt}" when this is set. */
  stale?: boolean;
}

// Macro regime (v1 MOCK_REGIME shape)
export interface Regime {
  regime: 'risk_on' | 'risk_off' | 'neutral';
  conviction: 'high' | 'medium' | 'low';
  vol: {
    level: number;
    regime: 'low' | 'medium' | 'high';
    trend: 'rising' | 'falling' | 'stable';
    percentile: number;
  };
  rates: {
    tenYear: number;
    twoTenSpread: number;
    curveRegime: 'normal' | 'flat' | 'inverted';
    trend: 'rising' | 'falling' | 'stable';
  };
  riskAppetite: {
    ratioTrend: string;
    creditSignal: string;
  };
  rationale: string;
  computedAt: string;
}

// Engine test response
export interface EngineTestResponse {
  ticker: string;
  price: number;
  priceChangePct: number;
  durationMs: number;
  target: Target | null;
  analysts: Record<string, AnalystOutput>;
  error?: string;
}

export interface AnalystOutput {
  score: number;
  direction: Direction;
  confidence: number;
  rationale: string;
  signals: Record<string, any>;
}

// Earnings board
// Earnings play categories — pre-print and post-print
export type EarningsPlayType =
  | 'long_volatility'   // straddle/strangle: low IV + history of big moves
  | 'short_volatility'  // iron condor: high IV + history of contained moves
  | 'directional_long'  // pre-print drift bullish
  | 'directional_short' // pre-print drift bearish
  | 'pead_long'         // post-beat continuation
  | 'pead_short'        // post-miss continuation
  | 'reversal'          // gap-and-fade
  | 'skip';             // mixed data, unpredictable

export interface PlayTriggers {
  entry: string;        // "above pre-earnings high on volume"
  stop: number | null;  // dollar level (stock price; meaningful for directional/PEAD/reversal)
  targets: { t1: number | null; t2: number | null; t3: number | null };
  riskReward: number | null;
  positionSizePct: number; // 0.5% for vol, 1% for directional
  // v0.7.24+ options-aware fields (populated for long_volatility / short_volatility)
  options?: OptionsPlay;
  // v0.7.24+ broker-mechanic step-by-step execution guide
  executionSteps?: ExecutionStep[];
}

export interface OptionsLeg {
  action: 'buy' | 'sell';
  optionType: 'call' | 'put';
  strike: number;
  // Quantity is computed client-side from account size; server provides
  // the leg ratio (always 1:1 in our setups, but kept for future combos).
  ratio: number;
}

export interface OptionsPlay {
  structure: 'long_straddle' | 'long_strangle' | 'iron_condor';
  expiry: string;          // ISO date — recommended expiry (nearest weekly post-earnings)
  legs: OptionsLeg[];
  // Estimated economics. These come from the IV-based EM and our scoring;
  // actual fills will differ. Frontend should show "est." prefix.
  estDebitPerContract?: number | null;   // long_volatility: amount paid per straddle/strangle
  estCreditPerContract?: number | null;  // short_volatility: credit collected per IC
  wingWidth?: number | null;             // iron_condor only: distance between short and long strikes
  maxProfitPerContract: number | null;
  maxLossPerContract: number | null;
  breakevens: number[];                  // 1 for directional, 2 for IC/straddle
  profitTakeAt: number;                  // % of max profit to close (0.5 = 50%)
}

export interface ExecutionStep {
  n: number;
  title: string;       // short, e.g. "Set up combo order"
  detail: string;      // 1-2 sentence broker-agnostic instruction
}

export interface HistoricalEdge {
  hits: number;       // setup-similar past prints that worked
  total: number;      // total comparable prints
  ratePct: number;    // hits/total*100
  description: string;
}

export interface EarningsSetup {
  ticker: string;
  price: number;
  reportDate: string;
  reportTime: 'bmo' | 'amc' | 'dmh' | string;
  daysUntil: number;
  bias: 'sell_premium' | 'buy_premium' | 'neutral';
  strategy: string;
  composite: number;
  /** Realized-vol rank 0-100: current 20d RV vs trailing 20d-chunk RV range.
   *  NOT implied vol — real IV needs the Polygon options snapshot
   *  (institutional-flow/), the planned upgrade. */
  rvRank: number;
  /** @deprecated Alias of rvRank — the value was always a realized-vol rank,
   *  never IV. Kept because the frontend (EarningsView table + journal log)
   *  reads `ivr`. */
  ivr: number;
  /** Event-window (2-trading-day) expected move in %, comparable to
   *  avgPriorMove. Invariant to daysUntil. */
  expectedMove: number;
  avgPriorMove: number | null;
  rationale: string;
  // v0.7.21+ pro-grade play fields (all optional for backward compat)
  playType?: EarningsPlayType;
  /** Trade side for direction-bearing plays. For 'reversal' this is the fade
   *  side: 'short' fades a gap-up-on-miss, 'long' fades a gap-down-on-beat.
   *  Unset for vol plays / skip. */
  direction?: 'long' | 'short';
  moveRatio?: number | null;
  triggers?: PlayTriggers;
  historicalEdge?: HistoricalEdge | null;
  prePrintDrift?: { signalCount: number; lean: 'long' | 'short' | 'mixed'; details: string[] };
  postPrint?: boolean; // true if reportDate is in the past (PEAD/reversal)
}

export interface EarningsBoardResponse {
  setups: EarningsSetup[];
  universeChecked: number;
  generatedAt: string;
  windowDays?: number;
  cached?: boolean;
  error?: string;
}

// Insider Board — aggregate insider activity per ticker
export interface InsiderBoardRow {
  ticker: string;
  buyDollars: number;       // code P only — open-market purchases
  awardDollars: number;     // code A — RSU vests / grants (tracked separately)
  sellDollars: number;
  netDollars: number;       // buyDollars - sellDollars (awards excluded)
  buyerCount: number;       // unique names with P-code buys
  totalBuys: number;        // count of P-code transactions
  totalAwards: number;      // count of A-code transactions
  totalSells: number;
  topBuyer: { name: string; role: string; dollars: number } | null;
  latestFilingDate: string | null;
  daysSinceLatest: number | null;
  /** Phase 4l W3: most recent close price for the ticker. Null if the price
   *  fetch failed (Polygon hiccup, delisted, etc.) — UI shows "—". */
  price: number | null;
  filings: Array<{
    name: string;
    role: string;
    shares: number;
    dollars: number;
    filingDate: string;
    transactionDate: string;
    code: 'P' | 'S' | 'A' | 'D' | string;
    daysSince: number;
  }>;
}

export interface InsiderBoardResponse {
  rows: InsiderBoardRow[];
  universeChecked: number;
  windowDays: number;
  generatedAt: string;
  cached?: boolean;
  error?: string;
}

// Options flow
export interface OptionsCandidate {
  ticker: string;
  underlyingPrice: number;
  intradayChangePct: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  score: number;
  volumeRatio: number;
  volRegime: number;
  distFromMa20Pct: number;
  approxAtmStrike: number;
  rationale: string;
}

export interface OptionsFlowResponse {
  candidates: OptionsCandidate[];
  proxyNote?: string;
  generatedAt: string;
  error?: string;
}

// Backtest
export interface BacktestTrade {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  composite: number;
  tier: Tier;
  direction: Direction;
  fwd5?: number;
  fwd10?: number;
  fwd20?: number;
  fwd5_alpha?: number;
  fwd10_alpha?: number;
  fwd20_alpha?: number;
}

export interface BacktestWindowStats {
  n: number;
  winRate: number;
  avgReturn: number;
  avgAlphaVsSPY: number;
  medianReturn: number;
}

export interface BacktestResponse {
  ok: boolean;
  summary: {
    fwd5?: BacktestWindowStats;
    fwd10?: BacktestWindowStats;
    fwd20?: BacktestWindowStats;
  };
  byTier: Record<Tier, { n: number } & Record<string, BacktestWindowStats | number>>;
  byDirection: Record<string, { n: number } & Record<string, BacktestWindowStats | number>>;
  trades: { count: number; sample: BacktestTrade[] } | BacktestTrade[];
  lookbackDays: number;
  tickers: string[];
  error?: string;
}

// Research
export interface ResearchBrief {
  summary?: string;
  bull_case?: string;
  bear_case?: string;
  key_catalyst?: string;
  confidence?: 'high' | 'medium' | 'low';
  time_horizon?: string;
  citations?: string[];
}

export interface ResearchResponse {
  ok: boolean;
  ticker: string;
  brief: ResearchBrief;
  cached?: boolean;
  cacheAgeMs?: number;
  newsCount?: number;
  error?: string;
}
