// Shared scan orchestrator for the Prophet board (7-layer ensemble).
//
// Both the live endpoint (prophet-picks.ts) and the scheduled full-universe
// scan (scan-prophet.ts) route through runProphetScan. Pre-fetches
// SPY + sector ETFs + sector rank once, then fans out per-ticker scoring.
//
// CRITICAL: this scan does NOT call Anthropic. Narrative generation is a
// request-time AI feature and stays in the live endpoint, generated on
// snapshot read for top-N picks only. The brief's budget guardrail
// (scheduled scans must not burn Anthropic credits) hangs on this.

import { UNIVERSE, inIndex, SECTOR_ETFS, SPY } from './universe';
import {
  getDailyBars,
  getFundamentals,
  type Bar,
} from './data-provider';
import { getEarningsIntel } from './earnings-intel';
import { getInsiderActivity } from './insider-provider';
import { getPoliticalActivity } from './political-provider';
import { getGovContractActivity } from './govcontracts-provider';
import { getPatentActivity } from './patent-provider';
import { computeRegime } from './regime';
import {
  layerStructure,
  layerMomentum,
  layerVolume,
  layerVolatility,
  layerRelativeStrength,
  layerFundamental,
  layerCatalyst,
  composeProphet,
  type ProphetScore,
  type FundInput,
  type CatalystInput,
} from './prophet-layers';
import { mapWithConcurrency } from './full-scan-iterator';
import type { Logger } from './logger';

export type ProphetUniverseKey = 'largecap' | 'russell' | 'all';

export interface ProphetPick extends ProphetScore {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  priceChangePct: number;
  /** Set lazily by the live endpoint — never populated by scheduled scan. */
  narrative?: string;
  earnings?: {
    epsGrowthYoY?: number;
    revenueGrowthYoY?: number;
    epsAcceleration?: number;
    beatsLast4?: number;
    avgSurpriseMagnitude?: number;
    streak?: 'beats' | 'misses' | 'mixed';
    nextEarningsDate?: string;
    daysUntilEarnings?: number;
    postEarningsDrift?: boolean;
  };
}

export interface RunProphetScanOpts {
  universe: ProphetUniverseKey;
  /** Cap on tickers actually scored. Use Infinity for full sweep. */
  scanCap?: number;
  scanBudgetMs: number;
  concurrency?: number;
  /** Stop scanning once we have this many qualified picks (live mode). Set to Infinity for scheduled. */
  sufficientQualified?: number;
  logger?: Logger;
}

export interface RunProphetScanResult {
  picks: ProphetPick[];
  scanDurationMs: number;
  universeChecked: number;
  tickersScanned: number;
  warnings: string[];
  budgetExceeded: boolean;
  regime: Awaited<ReturnType<typeof computeRegime>> | null;
}

export function resolveProphetUniverse(universe: ProphetUniverseKey) {
  if (universe === 'largecap') {
    // sp500 ∪ ndx ∪ dow, deduped
    const seen = new Set<string>();
    const out: typeof UNIVERSE = [];
    for (const u of UNIVERSE) {
      if (!u.indices.some((i) => i === 'sp500' || i === 'ndx' || i === 'dow')) continue;
      if (seen.has(u.ticker)) continue;
      seen.add(u.ticker);
      out.push(u);
    }
    return out;
  }
  if (universe === 'russell') return inIndex('russell2k');
  return UNIVERSE;
}

export async function runProphetScan(
  opts: RunProphetScanOpts,
): Promise<RunProphetScanResult> {
  const log = opts.logger;
  const start = Date.now();
  const warnings: string[] = [];

  const all = resolveProphetUniverse(opts.universe);
  const universeChecked = all.length;
  const cap = opts.scanCap ?? Infinity;
  const scanList = isFinite(cap) ? all.slice(0, cap) : all;

  log?.info('prophet_scan_started', {
    universe: opts.universe,
    universeSize: universeChecked,
    scanCap: cap === Infinity ? 'Infinity' : cap,
    budgetMs: opts.scanBudgetMs,
  });

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 300 * 86_400_000).toISOString().slice(0, 10);

  // Shared context: SPY bars, sector ETF bars, regime. Fetched once.
  const [spyBars, regime] = await Promise.all([
    getDailyBars(SPY, from, to),
    computeRegime().catch(() => null),
  ]);
  const macroBias =
    regime?.regime === 'risk_on' ? 0.5 : regime?.regime === 'risk_off' ? -0.5 : 0;

  const sectorEtfCache: Record<string, Bar[]> = {};
  await Promise.all(
    Object.entries(SECTOR_ETFS).map(async ([sector, etf]) => {
      try {
        sectorEtfCache[sector] = await getDailyBars(etf, from, to);
      } catch {
        sectorEtfCache[sector] = [];
      }
    }),
  );

  const sectorRank: Record<string, number> = {};
  Object.entries(sectorEtfCache)
    .map(([sector, bars]) => {
      if (bars.length < 21) return { sector, ret: 0 };
      const ret =
        (bars[bars.length - 1].c - bars[bars.length - 21].c) / bars[bars.length - 21].c;
      return { sector, ret };
    })
    .sort((a, b) => b.ret - a.ret)
    .forEach((s, i) => {
      sectorRank[s.sector] = i + 1;
    });

  log?.info('prophet_context_ready', {
    spyBars: spyBars.length,
    sectorEtfs: Object.keys(sectorEtfCache).length,
    regime: regime?.regime ?? 'unknown',
    elapsedMs: Date.now() - start,
  });

  let budgetExceeded = false;
  let tickersScanned = 0;
  const picks: ProphetPick[] = [];
  const sufficientQualified = opts.sufficientQualified ?? Infinity;

  await mapWithConcurrency(
    scanList.map((t) => t.ticker),
    async (ticker) => {
      const entry = scanList.find((x) => x.ticker === ticker)!;
      const pick = await scoreTicker(
        entry,
        from,
        to,
        spyBars,
        sectorEtfCache[entry.sector] ?? null,
        sectorRank[entry.sector] ?? 6,
        macroBias,
      );
      tickersScanned += 1;
      if (pick && pick.conviction) picks.push(pick);
      return pick;
    },
    {
      batchSize: opts.concurrency ?? 7,
      shouldAbort: () => {
        if (Date.now() - start > opts.scanBudgetMs) {
          budgetExceeded = true;
          warnings.push('prophet scan budget exceeded; results may be partial');
          return true;
        }
        if (picks.length >= sufficientQualified) {
          warnings.push('sufficient qualified picks reached; early stop');
          return true;
        }
        return false;
      },
      onError: (err, ticker) => {
        log?.warn('prophet_ticker_error', { ticker, err: String(err) });
      },
    },
  );

  picks.sort((a, b) => b.composite - a.composite);

  const scanDurationMs = Date.now() - start;
  log?.info('prophet_scan_complete', {
    universe: opts.universe,
    universeChecked,
    tickersScanned,
    qualified: picks.length,
    scanDurationMs,
    budgetExceeded,
  });

  return {
    picks,
    scanDurationMs,
    universeChecked,
    tickersScanned,
    warnings,
    budgetExceeded,
    regime,
  };
}

export function filterProphetByConviction(
  picks: ProphetPick[],
  min: 'low' | 'medium' | 'high',
): ProphetPick[] {
  if (min === 'high') return picks.filter((p) => p.conviction === 'HIGH');
  if (min === 'medium')
    return picks.filter((p) => p.conviction === 'HIGH' || p.conviction === 'MEDIUM');
  return picks.filter((p) => p.conviction !== null);
}

// ---------- per-ticker scoring (lifted from prophet-picks.ts) ----------

async function scoreTicker(
  entry: { ticker: string; name: string; sector: string },
  from: string,
  to: string,
  spyBars: Bar[],
  sectorBars: Bar[] | null,
  sectorRank: number,
  macroBias: number,
): Promise<ProphetPick | null> {
  const [bars, fund, intel, insider, political, contracts, patents] = await Promise.all([
    getDailyBars(entry.ticker, from, to),
    getFundamentals(entry.ticker).catch(() => null),
    getEarningsIntel(entry.ticker).catch(() => null),
    getInsiderActivity(entry.ticker, 90).catch(() => null),
    getPoliticalActivity(entry.ticker, 180).catch(() => null),
    getGovContractActivity(entry.ticker, 180).catch(() => null),
    getPatentActivity(entry.ticker, entry.name, 180).catch(() => null),
  ]);

  if (bars.length < 200) return null;

  const latestBar = bars[bars.length - 1];
  const pe = fund?.ttmEps && fund.ttmEps > 0 ? latestBar.c / fund.ttmEps : undefined;
  const peg =
    pe !== undefined && fund?.epsGrowthYoY && fund.epsGrowthYoY > 0
      ? pe / (fund.epsGrowthYoY * 100)
      : undefined;

  const fundInput: FundInput = {
    revenueGrowthYoY: fund?.revenueGrowthYoY,
    epsGrowthYoY: fund?.epsGrowthYoY,
    operatingMargin: fund?.operatingMargin,
    grossMargin: fund?.grossMargin,
    pe,
    peg,
    epsSurpriseBeats: intel?.beatsLast4,
    epsAcceleration: intel?.epsAcceleration,
    avgSurpriseMagnitude: intel?.avgSurpriseMagnitude,
    postEarningsDrift: intel?.postEarningsDrift,
    streak: intel?.streak,
  };

  const daysUntilEarnings = intel?.daysUntilEarnings ?? null;

  const catInput: CatalystInput = {
    insiderScore: insider ? scoreInsider(insider) : undefined,
    insiderCluster: !!(insider && insider.clusters.length > 0),
    cSuiteBuy: !!insider?.transactions.some((t) =>
      /CEO|CFO|CHIEF|PRESIDENT|CHAIR/i.test(t.position),
    ),
    firstBuyInYear: insider?.firstBuyInAYear,
    politicalScore: political ? scorePolitical(political) : undefined,
    bipartisanPolitical: political?.bipartisan ?? false,
    govContractScore: contracts ? scoreContracts(contracts) : undefined,
    patentScore: patents ? scorePatents(patents) : undefined,
    patentVelocity: patents ? patents.velocityChangePct / 100 : undefined,
    daysUntilEarnings,
    postEarningsDrift: intel?.postEarningsDrift,
    macroBias,
    sectorRank,
  };

  const layers = {
    structure: layerStructure(bars),
    momentum: layerMomentum(bars),
    volume: layerVolume(bars),
    volatility: layerVolatility(bars),
    relativeStrength: layerRelativeStrength(bars, spyBars, sectorBars),
    fundamental: layerFundamental(fundInput),
    catalyst: layerCatalyst(catInput),
  };

  const composed = composeProphet(bars, layers, macroBias);
  const prevBar = bars[bars.length - 2];
  const priceChangePct = prevBar
    ? +(((latestBar.c - prevBar.c) / prevBar.c) * 100).toFixed(2)
    : 0;

  return {
    ticker: entry.ticker,
    name: entry.name,
    sector: entry.sector,
    price: latestBar.c,
    priceChangePct,
    layers,
    ...composed,
    earnings: intel
      ? {
          epsGrowthYoY: intel.epsGrowthYoY,
          revenueGrowthYoY: intel.revenueGrowthYoY,
          epsAcceleration: intel.epsAcceleration,
          beatsLast4: intel.beatsLast4,
          avgSurpriseMagnitude: intel.avgSurpriseMagnitude,
          streak: intel.streak,
          nextEarningsDate: intel.nextEarningsDate,
          daysUntilEarnings: intel.daysUntilEarnings,
          postEarningsDrift: intel.postEarningsDrift,
        }
      : undefined,
  };
}

export function scoreInsider(a: any): number {
  if (a.totalBuys === 0 && a.totalSells === 0) return 50;
  let raw = 0;
  if (a.clusters.length > 0) {
    const biggest = a.clusters.reduce((x: any, y: any) =>
      y.buyerCount > x.buyerCount ? y : x,
    );
    raw += Math.min(40, biggest.buyerCount * 10);
  }
  if (a.netDollars > 5_000_000) raw += 20;
  else if (a.netDollars > 1_000_000) raw += 12;
  else if (a.netDollars < -5_000_000) raw -= 10;
  if (a.firstBuyInAYear) raw += 15;
  return Math.max(0, Math.min(100, 50 + Math.max(-50, Math.min(50, raw))));
}

export function scorePolitical(p: any): number {
  const net = p.netTrades ?? 0;
  const lobbyChange = (p.lobbyingVelocityPct ?? 0) / 100;
  const raw = net * 5 + (p.bipartisan ? 15 : 0) + (lobbyChange > 0.2 ? 10 : 0);
  return Math.max(0, Math.min(100, 50 + Math.max(-30, Math.min(40, raw))));
}

export function scoreContracts(c: any): number {
  const total = c.totalDollars ?? 0;
  const diversity = c.topAgencies?.length ?? 0;
  let raw = 0;
  if (total > 100_000_000) raw += 30;
  else if (total > 10_000_000) raw += 18;
  else if (total > 1_000_000) raw += 8;
  if (diversity >= 3) raw += 10;
  return Math.max(0, Math.min(100, 50 + raw));
}

export function scorePatents(p: any): number {
  const velocity = p.velocityChange ?? 0;
  let raw = 0;
  if (velocity > 0.5) raw += 25;
  else if (velocity > 0.2) raw += 12;
  else if (velocity < -0.3) raw -= 10;
  if ((p.highValueGrants ?? 0) > 0) raw += 10;
  return Math.max(0, Math.min(100, 50 + raw));
}
