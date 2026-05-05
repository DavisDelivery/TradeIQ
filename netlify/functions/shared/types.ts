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
}

export interface TargetBoardResponse {
  targets: Target[];
  generatedAt: string;
  source: string;
  error?: string;
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
  stop: number | null;  // dollar level
  targets: { t1: number | null; t2: number | null; t3: number | null };
  riskReward: number | null;
  positionSizePct: number; // 0.5% for vol, 1% for directional
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
  ivr: number;
  expectedMove: number;
  avgPriorMove: number | null;
  rationale: string;
  // v0.7.21+ pro-grade play fields (all optional for backward compat)
  playType?: EarningsPlayType;
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
