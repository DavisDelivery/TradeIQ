// Shared scan orchestrator for the Lynch board (growth-at-reasonable-price).
//
// Lynch is data-heavy per ticker (3 parallel API calls: fundamentals,
// earnings history, snapshot). Run once daily after close, not intraday.

import { UNIVERSE, inIndex, type IndexTag } from './universe';
import { runLynch } from '../styles/lynch';
import { deriveLynchSignalFromAnalyst, type LynchSignal } from '../styles/lynch-signal';
import {
  getFundamentals,
  getEarningsHistory,
  getPreviousClose,
} from './data-provider';
import { mapWithConcurrency } from './full-scan-iterator';
import { sideFromScore, type StyleSide } from './style-types';
import type { Logger } from './logger';

export type LynchUniverseKey = IndexTag | 'all';

export interface LynchCandidate {
  ticker: string;
  name: string;
  sector: string;
  score: number;
  confidence: number;
  rationale: string;
  signals: Record<string, any>;
  /** 'neutral' = zero score (typically no scoreable data) — Wave 4C, review m6. */
  side: StyleSide;
  /** Discrete investment signal (Phase 4m): BUY/HOLD/AVOID + fair-value band. */
  signal: LynchSignal;
  /** Latest close at scan time, for reference. */
  price: number | null;
}

export interface RunLynchScanOpts {
  universe: LynchUniverseKey;
  /** Cap on tickers actually scored. Use Infinity for full sweep. */
  scanCap?: number;
  scanBudgetMs: number;
  concurrency?: number;
  pacingMs?: number;
  /** Drop candidates below this confidence. Live default 0.5; snapshot stores all. */
  minConfidence?: number;
  logger?: Logger;
}

export interface RunLynchScanResult {
  candidates: LynchCandidate[];
  scanDurationMs: number;
  universeChecked: number;
  scanned: number;
  warnings: string[];
  budgetExceeded: boolean;
}

// Universe meta entry the Lynch scan iterates over (ticker + display +
// sector). Kept structural so both the full scan and the batch slice
// share the same shape.
type LynchUniverseEntry = { ticker: string; name: string; sector: string };

/** Resolve the ordered universe ticker list for a Lynch universe key.
 *  The order is stable, so a checkpoint-resume worker can slice it by
 *  index across invocations and never double-scan or skip a ticker. */
export function resolveLynchUniverse(universe: LynchUniverseKey): LynchUniverseEntry[] {
  return (universe === 'all' ? UNIVERSE : inIndex(universe)) as LynchUniverseEntry[];
}

// Score a single ticker. Shared by the full single-pass scan and the
// checkpoint-resume batch worker so both produce identical candidates.
// Returns null when the candidate falls below minConfidence.
async function scoreLynchTicker(
  t: LynchUniverseEntry,
  minConfidence: number,
): Promise<LynchCandidate | null> {
  const ticker = t.ticker;
  const [fund, earnings, snap] = await Promise.all([
    getFundamentals(ticker).catch(() => null),
    getEarningsHistory(ticker, 4).catch(() => []),
    getPreviousClose(ticker).catch(() => null),
  ]);
  const s = runLynch({
    ticker,
    peRatio: fund?.ttmEps && snap ? snap.c / fund.ttmEps : undefined,
    epsGrowthTTM: fund?.epsGrowthTTM,
    revenueGrowthYoY: fund?.revenueGrowthYoY,
    debtToEquity: fund?.debtToEquity,
    operatingMargin: fund?.operatingMargin,
    earningsHistory: earnings,
    marketCapUsd: undefined,
    recentReturnPct: undefined,
    sector: t.sector,
  });
  if (s.confidence < minConfidence) return null;
  const signal = deriveLynchSignalFromAnalyst(
    { score: s.score, signals: s.signals },
    { currentPrice: snap?.c, ttmEps: fund?.ttmEps },
  );
  return {
    ticker,
    name: t.name,
    sector: t.sector,
    score: s.score,
    confidence: s.confidence,
    rationale: s.rationale,
    signals: s.signals,
    side: sideFromScore(s.score),
    signal,
    price: snap?.c ?? null,
  };
}

export interface RunLynchScanBatchOpts {
  universe: LynchUniverseKey;
  /** Index into the resolved universe to start this batch at. */
  startIdx: number;
  /** Number of tickers to consume this batch. */
  batchSize: number;
  concurrency?: number;
  pacingMs?: number;
  minConfidence?: number;
  logger?: Logger;
}

export interface RunLynchScanBatchResult {
  candidates: LynchCandidate[];
  /** Tickers actually consumed (clamped at the universe boundary). The
   *  resume worker advances its cursor by this. */
  tickersConsumed: number;
  warnings: string[];
}

/** Score one contiguous slice of the universe. Stateless — the
 *  checkpoint-resume worker owns cursor/partial persistence and calls this
 *  per batch. No internal time budget: the worker's watchdog bounds the
 *  invocation, and a batch is small enough to finish well inside it. */
export async function runLynchScanBatch(
  opts: RunLynchScanBatchOpts,
): Promise<RunLynchScanBatchResult> {
  const log = opts.logger;
  const all = resolveLynchUniverse(opts.universe);
  const slice = all.slice(opts.startIdx, opts.startIdx + opts.batchSize);
  const minConfidence = opts.minConfidence ?? 0;
  const warnings: string[] = [];
  const candidates: LynchCandidate[] = [];

  const byTicker = new Map(slice.map((t) => [t.ticker, t]));
  await mapWithConcurrency(
    slice.map((t) => t.ticker),
    async (ticker) => {
      const cand = await scoreLynchTicker(byTicker.get(ticker)!, minConfidence);
      if (cand) candidates.push(cand);
      return cand;
    },
    {
      batchSize: opts.concurrency ?? 8,
      pacingMs: opts.pacingMs,
      onError: (err, ticker) => {
        log?.warn('lynch_ticker_error', { ticker, err: String(err) });
      },
    },
  );

  return { candidates, tickersConsumed: slice.length, warnings };
}

export async function runLynchScan(opts: RunLynchScanOpts): Promise<RunLynchScanResult> {
  const log = opts.logger;
  const start = Date.now();
  const warnings: string[] = [];

  const all = resolveLynchUniverse(opts.universe);
  const universeChecked = all.length;
  const cap = opts.scanCap ?? Infinity;
  const scanList = isFinite(cap) ? all.slice(0, cap) : all;
  const minConfidence = opts.minConfidence ?? 0;

  log?.info('lynch_scan_started', {
    universe: opts.universe,
    universeSize: universeChecked,
    scanCap: cap === Infinity ? 'Infinity' : cap,
    budgetMs: opts.scanBudgetMs,
  });

  let budgetExceeded = false;
  const candidates: LynchCandidate[] = [];

  const byTicker = new Map(scanList.map((t) => [t.ticker, t]));
  await mapWithConcurrency(
    scanList.map((t) => t.ticker),
    async (ticker) => {
      const cand = await scoreLynchTicker(byTicker.get(ticker)!, minConfidence);
      if (cand) candidates.push(cand);
      return cand;
    },
    {
      batchSize: opts.concurrency ?? 8,
      pacingMs: opts.pacingMs,
      shouldAbort: () => {
        if (Date.now() - start > opts.scanBudgetMs) {
          budgetExceeded = true;
          warnings.push('lynch scan budget exceeded; results may be partial');
          return true;
        }
        return false;
      },
      onError: (err, ticker) => {
        log?.warn('lynch_ticker_error', { ticker, err: String(err) });
      },
    },
  );

  candidates.sort((a, b) => b.score - a.score);
  const scanDurationMs = Date.now() - start;
  log?.info('lynch_scan_complete', {
    universe: opts.universe,
    universeChecked,
    scanned: scanList.length,
    candidates: candidates.length,
    scanDurationMs,
  });

  return {
    candidates,
    scanDurationMs,
    universeChecked,
    scanned: scanList.length,
    warnings,
    budgetExceeded,
  };
}
