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
}

export interface EarningsBoardResponse {
  setups: EarningsSetup[];
  universeChecked: number;
  generatedAt: string;
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
