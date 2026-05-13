// 4c-2 sieve types. Shared across stages so the orchestrator (russell
// scanner) and the UI (SieveCoverageStrip) read the same shape.

import type { UniverseEntry } from '../universe';

export interface StageMeta {
  /** Tickers fed in to this stage. */
  scored: number;
  /** Tickers that passed this stage's threshold. */
  survived: number;
  /** Threshold score applied (Stage 1/2 emit a composite-derived cutoff; Stage 3 emits qualified-count). */
  thresholdScore: number | null;
  /** Wall-time spent in this stage. */
  budgetMs: number;
  /** Set true if the stage hit its budget cap and skipped the remainder. */
  partial: boolean;
  /** Free-form warnings emitted during the stage (e.g. data-source 429s). */
  warnings: string[];
}

export interface SieveMeta {
  stage1: StageMeta;
  stage2: StageMeta;
  stage3: StageMeta;
}

export interface Stage1Result {
  /** Entry plus the cheap signals; passed forward to Stage 2. */
  ticker: string;
  composite: number;
  /** Whether this ticker survived the Stage 1 threshold. */
  passed: boolean;
  /** Optional per-signal breakdown for debugging / UI. */
  signals: {
    trendQualifier: boolean;
    momentum20d: number | null;
    volumeSurge: number | null;
    volatilityRegime: number | null;
    above52wLowPct: number | null;
  };
}

export interface Stage2Result {
  ticker: string;
  composite: number;
  passed: boolean;
  /** Whether the earnings-quality gate passed (Chad's product priority — gates Stage 3 entry). */
  earningsGate: boolean;
  earningsGateReason?: string;
  signals: {
    stage1Composite: number;
    epsGrowthYoY: number | null;
    revenueGrowthYoY: number | null;
    operatingMarginTrendPp: number | null;
    peExpansionPct: number | null;
    rsVsSpy: number | null;
  };
}

export interface SieveContext {
  /** Universe entries to score. The russell scanner passes the full 2037; other callers can pass a subset. */
  entries: UniverseEntry[];
  /** Date range for bar fetch. */
  from: string;
  to: string;
  /** Pre-fetched SPY bars used in Stage 1 (volatility regime) and Stage 2 (RS-vs-SPY). */
  spyBars: import('../data-provider').Bar[];
}
