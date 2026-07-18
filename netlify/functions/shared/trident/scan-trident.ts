// TRIDENT scan orchestrator — fetch + score one universe within a
// background-container budget. Contract: reports/trident/design.md §2/§3.
//
// Two-stage shape (the prophet-sieve lesson, applied from day one):
//   Stage 1 (bars only): gate check — uptrend + liquidity + price floor
//     kills most of the russell2k before any Finnhub/Massive call.
//   Stage 2 (survivors): earnings history, recommendations, fundamentals,
//     insider — ALL behind provider-live-cache, so warm scans are cheap
//     and cold scans self-heal across slots (2026-07-15 incident lesson).
//
// Regime is computed ONCE per scan from QQQ/SPY/IWM bars and applied as
// pre-committed modulation: entry gate flag, size scalar, and breakout
// demotion on BREAKOUT-classified setups (design §3 — the only
// behavior-changing regime surfaces).

import {
  getDailyBars,
  getEarningsHistory,
  getFundamentals,
  getRecommendations,
} from '../data-provider';
import { getInsiderActivity } from '../insider-provider';
import { inIndex, SPY, QQQ, IWM } from '../universe';
import { mapWithConcurrency } from '../full-scan-iterator';
import { computeIndexRegime, type IndexRegime, type RegimeBar } from './regime';
import {
  scoreTrident,
  percentileRanks,
  type TridentBar,
  type TridentInputs,
  type TridentScore,
  type InstitutionalInputs,
} from './scoring';
import type { Logger } from '../logger';

export type TridentUniverse = 'sp500' | 'russell2k';

export interface TridentRow {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  composite: number;
  percentile: number;
  pillars: NonNullable<TridentScore['pillars']>;
  entry: TridentScore['entry'];
  institutionalState: TridentScore['institutionalState'];
  regimeAdjusted: boolean;
  diagnostics: TridentScore['diagnostics'];
}

export interface TridentScanResult {
  rows: TridentRow[];
  regime: { nq: IndexRegime | null; spx: IndexRegime | null; r2k: IndexRegime | null };
  universeSize: number;
  universeChecked: number;
  stage1Survivors: number;
  scored: number;
  scanDurationMs: number;
  warnings: string[];
  partial: boolean;
}

export interface TridentScanOpts {
  universe: TridentUniverse;
  scanBudgetMs: number;
  concurrency?: number;
  logger: Logger;
  /** Test seam / future EDGAR wiring: per-ticker institutional inputs. */
  institutionalFor?: (ticker: string) => Promise<InstitutionalInputs | null>;
}

function isoDaysAgo(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 86400000).toISOString().slice(0, 10);
}

/** Polygon Bar {t,o,h,l,c,v} → TridentBar/RegimeBar {date,open,...}. */
function toTridentBars(bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>): TridentBar[] {
  return bars.map((b) => ({
    date: new Date(b.t).toISOString().slice(0, 10),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));
}

export async function runTridentScan(opts: TridentScanOpts): Promise<TridentScanResult> {
  const start = Date.now();
  const log = opts.logger;
  const warnings: string[] = [];
  let partial = false;
  const concurrency = opts.concurrency ?? 8;
  const from = isoDaysAgo(560); // ~2y2m calendar → >380 trading bars
  const to = new Date().toISOString().slice(0, 10);

  const entries = inIndex(opts.universe); // pre-filtered list
  const universeSize = entries.length;

  // ---- Regime (3 index fetches, always first — cheap and load-bearing) ----
  const [qqqBars, spyBars, iwmBars] = await Promise.all([
    getDailyBars(QQQ, from, to).then(toTridentBars).catch(() => [] as TridentBar[]),
    getDailyBars(SPY, from, to).then(toTridentBars).catch(() => [] as TridentBar[]),
    getDailyBars(IWM, from, to).then(toTridentBars).catch(() => [] as TridentBar[]),
  ]);
  const regime = {
    nq: computeIndexRegime('QQQ', qqqBars as RegimeBar[]),
    spx: computeIndexRegime('SPY', spyBars as RegimeBar[]),
    r2k: computeIndexRegime('IWM', iwmBars as RegimeBar[]),
  };
  const benchBars = opts.universe === 'sp500' ? spyBars : iwmBars;
  const activeRegime = opts.universe === 'sp500' ? regime.spx : regime.r2k;
  if (benchBars.length < 80) warnings.push('benchmark bars unavailable — RS components neutral');

  // ---- Stage 1: bars + gate ----
  const budgetLeft = () => opts.scanBudgetMs - (Date.now() - start);
  let universeChecked = 0;
  const stage1 = await mapWithConcurrency<{ ticker: string; name: string; sector: string; bars: TridentBar[] } | null>(
    entries.map((e) => e.ticker),
    async (ticker) => {
      if (budgetLeft() < 60_000) { partial = true; return null; }
      try {
        const bars = toTridentBars(await getDailyBars(ticker, from, to));
        universeChecked += 1;
        if (bars.length < 220) return null;
        const end = bars.length - 1;
        const last = bars[end].close;
        if (last < 3) return null;
        // cheap liquidity pre-check (final check re-runs inside scoreTrident)
        const dv = bars.slice(end - 19, end + 1).map((b) => b.close * b.volume).sort((a, b) => a - b);
        const med = dv[Math.floor(dv.length / 2)];
        if (med < (opts.universe === 'sp500' ? 10_000_000 : 2_000_000)) return null;
        // uptrend pre-check
        const closes = bars.map((b) => b.close);
        let s200 = 0;
        for (let i = end - 199; i <= end; i++) s200 += closes[i];
        s200 /= 200;
        if (last <= s200) return null;
        const e = entries.find((x) => x.ticker === ticker)!;
        return { ticker, name: e.name, sector: e.sector, bars };
      } catch {
        return null;
      }
    },
    { batchSize: concurrency },
  );
  const survivors = stage1.filter((s): s is NonNullable<typeof s> => s !== null);
  log.info('trident_stage1_done', {
    universe: opts.universe, universeSize, universeChecked,
    survivors: survivors.length, elapsedMs: Date.now() - start,
  });

  // ---- Stage 2: full scoring on survivors ----
  const survivorByTicker = new Map(survivors.map((s) => [s.ticker, s]));
  const scoredRows: Array<{ base: (typeof survivors)[number]; score: TridentScore }> = [];
  await mapWithConcurrency(
    survivors.map((s) => s.ticker),
    async (ticker) => {
      const s = survivorByTicker.get(ticker)!;
      if (budgetLeft() < 45_000) { partial = true; return; }
      try {
        const [earnings, recs, fund, insider, instExtra] = await Promise.all([
          getEarningsHistory(s.ticker, 8).catch(() => []),
          getRecommendations(s.ticker).catch(() => []),
          getFundamentals(s.ticker).catch(() => null),
          getInsiderActivity(s.ticker, 90).catch(() => null),
          opts.institutionalFor ? opts.institutionalFor(s.ticker).catch(() => null) : Promise.resolve(null),
        ]);
        const institutional: InstitutionalInputs | null = instExtra
          ? { ...instExtra, insiderNetBuyDollars: insider ? insider.netDollars : instExtra.insiderNetBuyDollars }
          : insider
            ? {
                activist: null, convictionAdds: [], clusterCount: 0,
                shortInterestPctFloat: null, instShareOfFloatPct: null,
                breadthDecline: null, insiderNetBuyDollars: insider.netDollars,
              }
            : null;
        const inputs: TridentInputs = {
          ticker: s.ticker,
          universe: opts.universe,
          bars: s.bars,
          benchBars,
          earnings: earnings.map((r) => ({ period: r.period, epsActual: r.epsActual, epsEstimate: r.epsEstimate, surprisePct: r.surprisePct })),
          recommendations: recs.map((r) => ({ period: r.period, strongBuy: r.strongBuy, buy: r.buy, hold: r.hold, sell: r.sell, strongSell: r.strongSell })),
          fundamentals: fund
            ? {
                epsGrowthTTM: fund.epsGrowthTTM,
                grossMargin: fund.grossMargin,
                priorGrossMarginYoY: fund.priorGrossMarginYoY,
                operatingMargin: fund.operatingMargin,
                priorOperatingMarginYoY: fund.priorOperatingMarginYoY,
                roe: fund.profitability?.roe ?? null,
                // CashflowGroup exposes FCF (not OCF) — used as the junk
                // screen for the small-cap sleeve; sign is what matters.
                operatingCashflowTTM: fund.cashflow?.freeCashFlow ?? null,
                grossProfitTTM: null,
              }
            : null,
          institutional,
        };
        const score = scoreTrident(inputs);
        if (score.eligible && score.composite !== null) scoredRows.push({ base: s, score });
      } catch (err: any) {
        warnings.push(`score:${s.ticker}:${String(err?.message ?? err).slice(0, 80)}`);
      }
    },
    { batchSize: concurrency },
  );

  // ---- Regime modulation + percentiles ----
  const demotion = activeRegime?.modulation.breakoutDemotion ?? 0;
  const adjusted = scoredRows.map(({ base, score }) => {
    let composite = score.composite as number;
    let regimeAdjusted = false;
    if (score.entry?.kind === 'BREAKOUT' && demotion > 0) {
      composite = demotion >= 999 ? Math.min(composite, 49) : Math.max(0, composite - demotion);
      regimeAdjusted = true;
    }
    return { base, score, composite: +composite.toFixed(1), regimeAdjusted };
  });
  const pct = percentileRanks(adjusted.map((r) => r.composite));
  const rows: TridentRow[] = adjusted
    .map((r, i) => ({
      ticker: r.base.ticker,
      name: r.base.name,
      sector: r.base.sector,
      price: +r.base.bars[r.base.bars.length - 1].close.toFixed(2),
      composite: r.composite,
      percentile: pct[i],
      pillars: r.score.pillars!,
      entry: r.score.entry,
      institutionalState: r.score.institutionalState,
      regimeAdjusted: r.regimeAdjusted,
      diagnostics: r.score.diagnostics,
    }))
    .sort((a, b) => b.composite - a.composite);

  log.info('trident_scan_done', {
    universe: opts.universe, scored: rows.length, partial,
    durationMs: Date.now() - start,
  });

  return {
    rows,
    regime,
    universeSize,
    universeChecked,
    stage1Survivors: survivors.length,
    scored: rows.length,
    scanDurationMs: Date.now() - start,
    warnings,
    partial,
  };
}
