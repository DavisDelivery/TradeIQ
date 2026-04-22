// Shared types for TradeIQ v2
// All analysts, synthesis modules, and endpoints consume these shapes.

export type Tier = 'A' | 'B' | 'C';
export type Side = 'long' | 'short';
export type Regime = 'risk_on' | 'risk_off' | 'neutral';
export type ConflictLevel = 'none' | 'mild' | 'moderate' | 'severe';

export interface AnalystScore {
  analyst:
    | 'technical'
    | 'sector-rotation'
    | 'fundamental'
    | 'flow'
    | 'news-sentiment'
    | 'earnings';
  score: number; // -100 (strong short) to +100 (strong long)
  confidence: number; // 0-1
  rationale: string; // 1-2 sentence human-readable reason
  signals: Record<string, number | string | boolean>;
}

export interface MacroState {
  regime: Regime;
  vix: number;
  yield10y: number;
  spread2s10s: number; // basis points
  narrative?: string; // optional Claude-written narrative
  updatedAt: string; // ISO
}

export interface Candidate {
  ticker: string;
  price: number;
  changePct: number;
  side: Side;
  tier: Tier;
  composite: number; // 0-100, macro-regime multiplier already applied
  conflictLevel: ConflictLevel;
  analystScores: AnalystScore[];
  blurb: string; // short human summary
  sector?: string;
}

export interface TargetBoard {
  regime: MacroState;
  candidates: Candidate[];
  generatedAt: string;
  schemaVersion: 2;
}

// Claude-as-PM output contract
export interface PMSelection {
  ticker: string;
  side: Side;
  conviction: 'high' | 'medium' | 'low';
  positionSizePct: number; // % of book, Claude decides based on conviction + vol
  thesis: string; // why Claude picked this
  risks: string; // what could go wrong
  invalidation: string; // price/event that would kill the thesis
}

export interface PMDecision {
  date: string;
  regime: Regime;
  selections: PMSelection[]; // 3-7 positions, Claude's final cut
  passes: Array<{
    ticker: string;
    reason: string;
  }>; // candidates Claude rejected + why
  portfolioNotes: string; // overall construction logic (correlation, sector balance, etc.)
  grossExposurePct: number;
  netExposurePct: number;
  tokensUsed?: number;
  modelUsed: string;
}

// Backtest types
export interface BacktestTrade {
  ticker: string;
  side: Side;
  tier: Tier;
  entry: string; // ISO date
  exit: string;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  positionSizePct: number;
  alpha: number; // vs SPY over same window
  compositeAtEntry: number;
}

export interface BacktestResult {
  startDate: string;
  endDate: string;
  trades: BacktestTrade[];
  equityCurve: Array<{ date: string; portfolio: number; spy: number }>;
  totalAlpha: number;
  sharpe: number;
  maxDrawdown: number;
  winRate: number;
  alphaByTier: Record<Tier, number>;
  alphaBySide: Record<Side, number>;
  alphaByScoreBucket: Array<{ bucket: string; alpha: number; n: number }>;
}
