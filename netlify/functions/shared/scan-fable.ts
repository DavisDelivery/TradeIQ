// FABLE scan orchestrator — my board (Claude / claude-fable-5).
//
// Two-phase, bars-first design (deliberate reliability choice, learned
// from FIX-2's serverless pain):
//   Phase A: Polygon daily bars for the whole universe (fast, generous
//            rate limits) → evaluate the FOUNDATION gate.
//   Phase B: Finnhub Form-4 insider transactions ONLY for gate-passers
//            (typically 30-120 names) → INSIDER EDGE pillar.
// This caps the Finnhub call count far below the rate limit, so the sp500
// sweep completes in a SINGLE background invocation — no reinvoke chain,
// no cursor, no resume machinery to go wrong.
//
// EDGAR role enrichment is intentionally OMITTED (v1): the exec-role bonus
// is inactive both live and in the PIT backtest, keeping the two paths
// identical (design.md: validation integrity by construction).

import { inIndex, SPY, type IndexTag } from './universe';
import { getDailyBars, getFinnhubInsiderTransactions } from './data-provider';
import type { Logger } from './logger';

/** Local generic worker pool (full-scan-iterator's helper is string-keyed). */
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
import {
  scoreFable,
  percentileAmong,
  suggestEntry,
  classifyFableRegime,
  FABLE_CONSTANTS,
  type FableBar,
  type FableRegime,
  type FableScore,
} from './fable-scoring';

export interface FableRow {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  composite: number;
  /** Percentile among gate-passers — the tradable display number. */
  percentile: number;
  pillars: {
    ascent: number;
    smoothPath: number;
    highGround: number;
    coiledSpring: number;
    insiderEdge: number;
  };
  diagnostics: {
    rsRaw: number;
    fip: number;
    imomIr: number;
    proximity52w: number;
    atrRatio: number;
    volDryup: number;
    extensionPct: number;
    insiderBuyers90d: number;
    insiderNetUsd90d: number;
    insiderSellVeto: boolean;
  };
  entry: { pivot: number; stop: number };
}

export interface RunFableScanResult {
  rows: FableRow[];
  regime: FableRegime;
  gatePassers: number;
  universeChecked: number;
  scanDurationMs: number;
  warnings: string[];
}

const BARS_LOOKBACK_DAYS = 460; // calendar days → ~310 trading bars

function isoDaysAgo(days: number, now: number): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

export async function runFableScan(opts: {
  universe: IndexTag;
  concurrency?: number;
  budgetMs: number;
  logger?: Logger;
}): Promise<RunFableScanResult> {
  const start = Date.now();
  const log = opts.logger;
  const warnings: string[] = [];
  const todayIso = new Date(start).toISOString().slice(0, 10);
  const from = isoDaysAgo(BARS_LOOKBACK_DAYS, start);

  const entries = inIndex(opts.universe); // returns the filtered UNIVERSE list

  // SPY context first (regime + residual benchmark)
  const spyBars = (await getDailyBars(SPY, isoDaysAgo(2200, start), todayIso).catch(
    () => [],
  )) as FableBar[];
  if (spyBars.length < 400) warnings.push('spy-bars-short: regime/imom degraded');
  const regime = classifyFableRegime(spyBars);

  // Phase A — bars + gate + pillars for the whole universe
  interface PhaseA {
    ticker: string;
    name: string;
    sector: string;
    bars: FableBar[];
    prelim: FableScore | null; // insider pillar filled in Phase B
  }
  const phaseA: PhaseA[] = [];
  let barFailures = 0;
  await pool(entries, opts.concurrency ?? 8, async (e) => {
    if (Date.now() - start > opts.budgetMs * 0.6) return; // leave room for Phase B
    try {
      const bars = (await getDailyBars(e.ticker, from, todayIso)) as FableBar[];
      if (!bars || bars.length < FABLE_CONSTANTS.MIN_BARS) return;
      // liquidity hygiene: 63d median dollar volume
      const dv = bars
        .slice(-63)
        .map((b) => b.c * (b.v || 0))
        .sort((a, b) => a - b);
      if ((dv[Math.floor(dv.length / 2)] ?? 0) < FABLE_CONSTANTS.MIN_MEDIAN_DOLLAR_VOL) return;
      const prelim = scoreFable(bars, spyBars, [], todayIso);
      phaseA.push({ ticker: e.ticker, name: e.name, sector: e.sector, bars, prelim });
    } catch {
      barFailures++;
    }
  });
  if (barFailures > entries.length * 0.2) {
    warnings.push(`bars-failure-rate-high: ${barFailures}/${entries.length}`);
  }

  const passers = phaseA.filter((p) => p.prelim !== null);
  log?.info?.('fable_gate', {
    universeChecked: phaseA.length,
    gatePassers: passers.length,
    regime,
  });

  // Phase B — insider transactions for gate-passers only
  let insiderFailures = 0;
  const scored = await pool(passers, 3, async (p) => {
    let txs: Awaited<ReturnType<typeof getFinnhubInsiderTransactions>> = [];
    if (Date.now() - start < opts.budgetMs * 0.92) {
      try {
        txs = await getFinnhubInsiderTransactions(p.ticker, 200);
      } catch {
        insiderFailures++;
      }
    }
    const full = scoreFable(p.bars, spyBars, txs as any, todayIso)!;
    return { p, full };
  });
  if (insiderFailures > Math.max(3, passers.length * 0.3)) {
    warnings.push(`insider-failure-rate-high: ${insiderFailures}/${passers.length}`);
  }

  const composites = scored.map((s) => s.full.composite);
  const pctls = percentileAmong(composites);
  const rows: FableRow[] = scored
    .map((s, i) => {
      const { p, full } = s;
      const last = p.bars[p.bars.length - 1];
      return {
        ticker: p.ticker,
        name: p.name,
        sector: p.sector,
        price: last.c,
        composite: +full.composite.toFixed(2),
        percentile: +pctls[i].toFixed(1),
        pillars: {
          ascent: +full.pillars.ascent.toFixed(1),
          smoothPath: +full.pillars.smoothPath.toFixed(1),
          highGround: +full.pillars.highGround.toFixed(1),
          coiledSpring: +full.pillars.coiledSpring.toFixed(1),
          insiderEdge: +full.insider.score.toFixed(1),
        },
        diagnostics: {
          rsRaw: +full.pillars.rsRaw.toFixed(4),
          fip: +full.pillars.fip.toFixed(4),
          imomIr: +full.pillars.imomIr.toFixed(2),
          proximity52w: +full.pillars.proximity52w.toFixed(3),
          atrRatio: +full.pillars.atrRatio.toFixed(3),
          volDryup: +full.pillars.volDryup.toFixed(3),
          extensionPct: +full.pillars.extensionPct.toFixed(3),
          insiderBuyers90d: full.insider.buyers90d,
          insiderNetUsd90d: Math.round(full.insider.netBuyUsd90d),
          insiderSellVeto: full.insider.sellVeto,
        },
        entry: suggestEntry(p.bars),
      };
    })
    .sort((a, b) => b.composite - a.composite);

  return {
    rows,
    regime,
    gatePassers: passers.length,
    universeChecked: phaseA.length,
    scanDurationMs: Date.now() - start,
    warnings,
  };
}
