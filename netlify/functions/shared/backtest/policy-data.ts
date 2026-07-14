// FABLE-2 R1 — data layer for the policy engine. All I/O lives here so
// policy-engine.ts stays pure.
//
// Fetch strategy (one full series per ticker, NOT per-checkpoint windows):
//   - bars: getDailyBars(ticker, warmupFrom, endDate) — pit-cached when the
//     window end is in the past (immutable). ~500 calls per cold universe,
//     then pure cache for every subsequent exploration run with the same
//     (warmupFrom, endDate).
//   - insider: fetched ONLY for (checkpoint, gate-passer) pairs, with the
//     EXACT SAME pit-cache key shape v1's scoreFableAtDate used
//     ({finnhub, insider, ticker, asOfDate, 'daysBack=200:fable'}) — v1's
//     84 month-end sweeps already warmed sp500 passers 2018-2024, so R2
//     exploration is nearly Finnhub-free. Transport failure THROWS (M8
//     discipline); verified-empty caches fine.

import { inIndex, SPY, type IndexTag } from '../universe';
import { getDailyBars, getFinnhubInsiderTransactionsWithStatus } from '../data-provider';
import { pitCacheWrap } from '../pit-cache';
import { evaluateFoundationGate, FABLE_CONSTANTS, type FableBar, type FableInsiderTx } from '../fable-scoring';
import { monthEndCheckpoints, type PolicyInputs, type PolicyConfig, type PolicyTickerData } from './policy-engine';
import type { Logger } from '../logger';

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function isoOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export interface LoadPolicyInputsOpts {
  universe: IndexTag;
  config: PolicyConfig;
  /** Bars fetched from here so the first checkpoint has ≥MIN_BARS history. */
  warmupFrom: string; // e.g. '2016-06-01' for a 2018 start
  concurrency?: number;
  logger?: Logger;
}

export interface LoadPolicyInputsResult {
  inputs: PolicyInputs;
  stats: {
    universeSize: number;
    tickersWithBars: number;
    barFetchFailures: number;
    insiderFetches: number;
    insiderFailures: number;
    checkpoints: number;
  };
}

export async function loadPolicyInputs(opts: LoadPolicyInputsOpts): Promise<LoadPolicyInputsResult> {
  const { universe, config, warmupFrom } = opts;
  const log = opts.logger;
  const entries = inIndex(universe);

  // --- SPY full series (pit-cached; endDate is historical for train runs)
  const spyBars = (await pitCacheWrap(
    { provider: 'polygon', dataClass: 'bars', ticker: SPY, asOfDate: config.endDate, extra: `from=${warmupFrom}:fable2-full` },
    () => getDailyBars(SPY, warmupFrom, config.endDate),
  )) as FableBar[];
  if (!spyBars || spyBars.length < 500) {
    throw new Error(`policy-data: SPY series too short (${spyBars?.length ?? 0})`);
  }
  const checkpoints = monthEndCheckpoints(spyBars, config.startDate, config.endDate);

  // --- Universe bars (one full series per ticker)
  let barFetchFailures = 0;
  const tickers: PolicyTickerData[] = (
    await pool(entries, opts.concurrency ?? 8, async (e) => {
      try {
        const bars = (await pitCacheWrap(
          { provider: 'polygon', dataClass: 'bars', ticker: e.ticker, asOfDate: config.endDate, extra: `from=${warmupFrom}:fable2-full` },
          () => getDailyBars(e.ticker, warmupFrom, config.endDate),
        )) as FableBar[];
        if (!bars || bars.length < FABLE_CONSTANTS.MIN_BARS) return null;
        return { ticker: e.ticker, bars } as PolicyTickerData;
      } catch {
        barFetchFailures++;
        return null;
      }
    })
  ).filter((t): t is PolicyTickerData => t !== null);

  // --- Insider: (checkpoint × gate-passer) pairs only, v1 cache keys.
  let insiderFetches = 0;
  let insiderFailures = 0;
  const work: Array<{ t: PolicyTickerData; cpIdx: number; cp: string }> = [];
  for (const t of tickers) {
    const dateToIdx = new Map<string, number>();
    t.bars.forEach((b, i) => dateToIdx.set(isoOf(b.t), i));
    t.insiderByCheckpoint = new Array(checkpoints.length).fill(undefined);
    for (let ci = 0; ci < checkpoints.length; ci++) {
      const bi = dateToIdx.get(checkpoints[ci]);
      if (bi === undefined || bi + 1 < FABLE_CONSTANTS.MIN_BARS) continue;
      if (!evaluateFoundationGate(t.bars.slice(0, bi + 1)).pass) continue;
      work.push({ t, cpIdx: ci, cp: checkpoints[ci] });
    }
  }
  log?.info?.('fable2_insider_plan', { pairs: work.length, tickers: tickers.length, checkpoints: checkpoints.length });

  await pool(work, 4, async (w) => {
    const txs = (await pitCacheWrap(
      { provider: 'finnhub', dataClass: 'insider', ticker: w.t.ticker, asOfDate: w.cp, extra: 'daysBack=200:fable' },
      async () => {
        insiderFetches++;
        const status = await getFinnhubInsiderTransactionsWithStatus(w.t.ticker, 200, { asOfDate: w.cp });
        if (status.rateLimitExhausted || status.errorMessage) {
          insiderFailures++;
          throw new Error(`fable2 insider fetch failed ${w.t.ticker}@${w.cp}: ${status.errorMessage ?? 'rate-limit exhausted'}`);
        }
        return status.data;
      },
    )) as FableInsiderTx[];
    w.t.insiderByCheckpoint![w.cpIdx] = txs ?? [];
  });

  return {
    inputs: { tickers, spyBars, checkpoints, config },
    stats: {
      universeSize: entries.length,
      tickersWithBars: tickers.length,
      barFetchFailures,
      insiderFetches,
      insiderFailures,
      checkpoints: checkpoints.length,
    },
  };
}
