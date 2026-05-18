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
  side: 'long' | 'short';
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

export async function runLynchScan(opts: RunLynchScanOpts): Promise<RunLynchScanResult> {
  const log = opts.logger;
  const start = Date.now();
  const warnings: string[] = [];

  const all = opts.universe === 'all' ? UNIVERSE : inIndex(opts.universe);
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

  await mapWithConcurrency(
    scanList.map((t) => t.ticker),
    async (ticker) => {
      const t = scanList.find((x) => x.ticker === ticker)!;
      const [fund, earnings, snap] = await Promise.all([
        getFundamentals(ticker).catch(() => null),
        getEarningsHistory(ticker, 4).catch(() => []),
        getPreviousClose(ticker).catch(() => null),
      ]);
      const s = runLynch({
        ticker,
        peRatio: fund?.ttmEps && snap ? snap.c / fund.ttmEps : undefined,
        epsGrowthYoY: fund?.epsGrowthYoY,
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
      const cand: LynchCandidate = {
        ticker,
        name: t.name,
        sector: t.sector,
        score: s.score,
        confidence: s.confidence,
        rationale: s.rationale,
        signals: s.signals,
        side: s.score >= 0 ? 'long' : 'short',
        signal,
        price: snap?.c ?? null,
      };
      candidates.push(cand);
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
