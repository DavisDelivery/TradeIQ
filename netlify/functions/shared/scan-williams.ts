// Shared scan orchestrator for the Williams board (mean-reversion / oversold).
//
// Williams is cheap per ticker — one bar fetch + one scoring call. Full
// universe sweep is comfortably within the 14-min scheduled budget even for
// Russell 2K (~2 min at 8 concurrent + Polygon free-tier pacing).

import { UNIVERSE, inIndex, type IndexTag } from './universe';
import { runWilliams } from '../styles/williams';
import { deriveWilliamsSignal, type WilliamsSignal } from '../styles/williams-signal';
import { getDailyBars } from './data-provider';
import { mapWithConcurrency } from './full-scan-iterator';
import { sideFromScore, type StyleSide } from './style-types';
import type { Logger } from './logger';

export type WilliamsUniverseKey = IndexTag | 'all';

export interface WilliamsCandidate {
  ticker: string;
  name: string;
  sector: string;
  score: number;
  confidence: number;
  rationale: string;
  signals: Record<string, any>;
  /** 'neutral' = zero score (typically no scoreable data) — Wave 4C, review m6. */
  side: StyleSide;
  /** Discrete trade signal (Phase 4m): BUY/SELL/HOLD + ATR-based levels. */
  signal: WilliamsSignal;
  /** Latest close at scan time, for reference. */
  price: number | null;
}

export interface RunWilliamsScanOpts {
  universe: WilliamsUniverseKey;
  /** Cap on tickers actually scored. Use Infinity for full sweep. */
  scanCap?: number;
  /** Wall-clock budget. Loop bails between batches once exceeded. */
  scanBudgetMs: number;
  /** Per-batch concurrency. Default 10. */
  concurrency?: number;
  /** Pacing between batches in ms (default 0). */
  pacingMs?: number;
  logger?: Logger;
}

export interface RunWilliamsScanResult {
  candidates: WilliamsCandidate[];
  scanDurationMs: number;
  universeChecked: number;
  scanned: number;
  warnings: string[];
  budgetExceeded: boolean;
}

export function resolveWilliamsUniverse(universe: WilliamsUniverseKey) {
  return universe === 'all' ? UNIVERSE : inIndex(universe);
}

export async function runWilliamsScan(
  opts: RunWilliamsScanOpts,
): Promise<RunWilliamsScanResult> {
  const log = opts.logger;
  const start = Date.now();
  const warnings: string[] = [];

  const all = resolveWilliamsUniverse(opts.universe);
  const universeChecked = all.length;
  const cap = opts.scanCap ?? Infinity;
  const scanList = isFinite(cap) ? all.slice(0, cap) : all;

  log?.info('williams_scan_started', {
    universe: opts.universe,
    universeSize: universeChecked,
    scanCap: cap === Infinity ? 'Infinity' : cap,
    budgetMs: opts.scanBudgetMs,
  });

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);

  let budgetExceeded = false;
  const candidates: WilliamsCandidate[] = [];

  await mapWithConcurrency(
    scanList.map((t) => t.ticker),
    async (ticker) => {
      const t = scanList.find((x) => x.ticker === ticker)!;
      const bars = await getDailyBars(ticker, from, to);
      if (!bars || bars.length < 30) return null;
      const s = runWilliams({ ticker, bars });
      const signal = deriveWilliamsSignal({ score: s.score, signals: s.signals }, bars);
      const cand: WilliamsCandidate = {
        ticker,
        name: t.name,
        sector: t.sector,
        score: s.score,
        confidence: s.confidence,
        rationale: s.rationale,
        signals: s.signals,
        side: sideFromScore(s.score),
        signal,
        price: bars.length > 0 ? bars[bars.length - 1].c : null,
      };
      candidates.push(cand);
      return cand;
    },
    {
      batchSize: opts.concurrency ?? 10,
      pacingMs: opts.pacingMs,
      shouldAbort: () => {
        if (Date.now() - start > opts.scanBudgetMs) {
          budgetExceeded = true;
          warnings.push('williams scan budget exceeded; results may be partial');
          return true;
        }
        return false;
      },
      onError: (err, ticker) => {
        log?.warn('williams_ticker_error', { ticker, err: String(err) });
      },
    },
  );

  candidates.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const scanDurationMs = Date.now() - start;
  log?.info('williams_scan_complete', {
    universe: opts.universe,
    universeChecked,
    scanned: scanList.length,
    candidates: candidates.length,
    scanDurationMs,
    budgetExceeded,
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
