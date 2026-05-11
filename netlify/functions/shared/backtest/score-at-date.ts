// PIT-aware per-ticker scoring for the backtest engine.
//
// Why this file exists:
//   The live scan functions (scan-prophet-*.ts, scan-catalyst-*.ts, ...) inline
//   the per-ticker fetch+score into the scan loop, computing fetch windows
//   from `new Date()`. Rewriting the live scan loops to be asOfDate-aware
//   risks regressing production code; instead, we mirror only the
//   per-ticker scoring path here, threading asOfDate through every fetch.
//
//   The scoring math itself — layerStructure, layerMomentum, composeProphet
//   etc. — is pure (same inputs → same output), so we reuse those imports
//   verbatim from the live modules. The only PIT-sensitive surface is the
//   data fetches at the top of the function.
//
//   Cache: every call wraps through pitCacheWrap on a (board, ticker,
//   asOfDate) key. Composite scoring is deterministic in those inputs so
//   the cache is safe forever.

import { UNIVERSE } from '../universe';
import { SECTOR_ETFS, SPY } from '../universe';
import {
  getDailyBars,
  getFundamentals,
  type Bar,
} from '../data-provider';
import { getEarningsIntel } from '../earnings-intel';
import { getInsiderActivity } from '../insider-provider';
import { getPoliticalActivity } from '../political-provider';
import { getGovContractActivity } from '../govcontracts-provider';
import { getPatentActivity } from '../patent-provider';
import {
  layerStructure,
  layerMomentum,
  layerVolume,
  layerVolatility,
  layerRelativeStrength,
  layerFundamental,
  layerCatalyst,
  composeProphet,
  type CatalystInput,
  type FundInput,
} from '../prophet-layers';
import {
  scoreInsider,
  scorePolitical,
  scoreContracts,
  scorePatents,
} from '../scan-prophet';
import { computeRegime } from '../regime';
import { pitCacheWrap, type PitCacheKey } from '../pit-cache';
import { addDays } from './trading-calendar';
import { getPoliticalActivityForBacktest } from './stock-act-shift';
import type { BacktestBoard, ScoredCandidate } from './types';

/**
 * Shared market context for one rebalance date. Computed once per
 * (asOfDate, board) tuple instead of per-ticker — saves 1000+ duplicate
 * SPY/sector-ETF fetches inside a single scan.
 */
export interface MarketContextAtDate {
  asOfDate: string;
  spyBars: Bar[];
  sectorEtfCache: Record<string, Bar[]>;
  sectorRank: Record<string, number>;
  regime: Awaited<ReturnType<typeof computeRegime>> | null;
  macroBias: number;
}

const CONTEXT_WINDOW_DAYS = 300;

/** Compute (or cache-fetch) the shared per-rebalance market context. */
export async function buildMarketContextAtDate(
  asOfDate: string,
): Promise<MarketContextAtDate> {
  const to = asOfDate;
  const from = addDays(asOfDate, -CONTEXT_WINDOW_DAYS);

  const spyKey: PitCacheKey = {
    provider: 'polygon',
    dataClass: 'bars',
    ticker: SPY,
    asOfDate,
    extra: `from=${from}`,
  };
  const spyBars = await pitCacheWrap(spyKey, () => getDailyBars(SPY, from, to));

  // Regime PIT — Phase 3 macro provider is asOfDate-aware.
  const regime = await computeRegime({ asOfDate }).catch(() => null);
  const macroBias =
    regime?.regime === 'risk_on' ? 0.5 : regime?.regime === 'risk_off' ? -0.5 : 0;

  // Sector ETFs — fetch in parallel, each cached.
  const sectorEtfCache: Record<string, Bar[]> = {};
  await Promise.all(
    Object.entries(SECTOR_ETFS).map(async ([sector, etf]) => {
      const key: PitCacheKey = {
        provider: 'polygon',
        dataClass: 'bars',
        ticker: etf,
        asOfDate,
        extra: `from=${from}`,
      };
      try {
        sectorEtfCache[sector] = await pitCacheWrap(key, () =>
          getDailyBars(etf, from, to),
        );
      } catch {
        sectorEtfCache[sector] = [];
      }
    }),
  );

  // 21-day relative strength rank — deterministic from bars.
  const sectorRank: Record<string, number> = {};
  Object.entries(sectorEtfCache)
    .map(([sector, bars]) => {
      if (bars.length < 21) return { sector, ret: 0 };
      const ret =
        (bars[bars.length - 1].c - bars[bars.length - 21].c) /
        bars[bars.length - 21].c;
      return { sector, ret };
    })
    .sort((a, b) => b.ret - a.ret)
    .forEach((s, i) => {
      sectorRank[s.sector] = i + 1;
    });

  return { asOfDate, spyBars, sectorEtfCache, sectorRank, regime, macroBias };
}

/**
 * Score a single ticker at a given asOfDate using the prophet board's
 * scoring math. PIT-correct: every data fetch threads asOfDate.
 *
 * Returns null when bars are insufficient (<200 daily bars in the lookback).
 */
async function scoreProphetAtDate(
  ticker: string,
  asOfDate: string,
  ctx: MarketContextAtDate,
): Promise<ScoredCandidate | null> {
  const entry = UNIVERSE.find((u) => u.ticker === ticker);
  if (!entry) return null;

  const to = asOfDate;
  const from = addDays(asOfDate, -CONTEXT_WINDOW_DAYS);

  // Bars (cached separately — high reuse across boards)
  const barsKey: PitCacheKey = {
    provider: 'polygon',
    dataClass: 'bars',
    ticker,
    asOfDate,
    extra: `from=${from}`,
  };
  const bars = await pitCacheWrap(barsKey, () => getDailyBars(ticker, from, to));
  if (bars.length < 200) return null;

  // All other PIT-aware fetches in parallel, each wrapped in the cache.
  const [fund, intel, insider, political, contracts, patents] = await Promise.all([
    pitCacheWrap<unknown>(
      { provider: 'polygon', dataClass: 'fundamentals', ticker, asOfDate },
      () => getFundamentals(ticker, { asOfDate }).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getFundamentals>> | null),
    pitCacheWrap<unknown>(
      { provider: 'derived', dataClass: 'earnings_intel', ticker, asOfDate },
      () => getEarningsIntel(ticker, { asOfDate }).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getEarningsIntel>> | null),
    pitCacheWrap<unknown>(
      { provider: 'finnhub', dataClass: 'insider', ticker, asOfDate, extra: 'lb=90' },
      () => getInsiderActivity(ticker, 90, { asOfDate }).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getInsiderActivity>> | null),
    pitCacheWrap<unknown>(
      { provider: 'quiver', dataClass: 'political', ticker, asOfDate, extra: 'lb=180:stockact-shifted' },
      () => getPoliticalActivityForBacktest(ticker, 180, asOfDate).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getPoliticalActivity>> | null),
    pitCacheWrap<unknown>(
      { provider: 'quiver', dataClass: 'contracts', ticker, asOfDate, extra: 'lb=180' },
      () => getGovContractActivity(ticker, 180, { asOfDate }).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getGovContractActivity>> | null),
    pitCacheWrap<unknown>(
      { provider: 'quiver', dataClass: 'patents', ticker, asOfDate, extra: `lb=180:${entry.name}` },
      () => getPatentActivity(ticker, entry.name, 180, { asOfDate }).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getPatentActivity>> | null),
  ]);

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
    cSuiteBuy: !!insider?.transactions.some((t: { position: string }) =>
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
    macroBias: ctx.macroBias,
    sectorRank: ctx.sectorRank[entry.sector] ?? 6,
  };

  const layers = {
    structure: layerStructure(bars),
    momentum: layerMomentum(bars),
    volume: layerVolume(bars),
    volatility: layerVolatility(bars),
    relativeStrength: layerRelativeStrength(
      bars,
      ctx.spyBars,
      ctx.sectorEtfCache[entry.sector] ?? null,
    ),
    fundamental: layerFundamental(fundInput),
    catalyst: layerCatalyst(catInput),
  };

  const composed = composeProphet(bars, layers, ctx.macroBias);

  // Flatten layers to score map for storage / attribution.
  const layerScores: Record<string, number> = {
    structure: layers.structure.score,
    momentum: layers.momentum.score,
    volume: layers.volume.score,
    volatility: layers.volatility.score,
    relativeStrength: layers.relativeStrength.score,
    fundamental: layers.fundamental.score,
    catalyst: layers.catalyst.score,
  };

  return {
    ticker,
    composite: composed.composite,
    layers: layerScores,
    sector: entry.sector,
    metadata: {
      price: latestBar.c,
      conviction: composed.conviction,
      direction: composed.direction,
      regime: ctx.regime?.regime ?? null,
      daysUntilEarnings: daysUntilEarnings ?? undefined,
    },
  };
}

/**
 * Public entry point. Dispatches to per-board scoring. Currently V1
 * supports the prophet board — the brief makes prophet the workhorse;
 * other boards return null with a warning until a per-board scoring
 * function is added.
 *
 * The market context is shared across one rebalance — callers should
 * pre-build it once via buildMarketContextAtDate and pass it here.
 */
export async function scoreTickerAtDate(
  ticker: string,
  asOfDate: string,
  board: BacktestBoard,
  ctx: MarketContextAtDate,
): Promise<ScoredCandidate | null> {
  if (ctx.asOfDate !== asOfDate) {
    throw new Error(
      `scoreTickerAtDate: ctx.asOfDate (${ctx.asOfDate}) does not match asOfDate (${asOfDate}). ` +
        `Build a fresh context per rebalance date.`,
    );
  }
  // V1: prophet is the only board with a full PIT scoring path. Catalyst,
  // insider, target, williams, lynch boards build on the same primitives
  // (insider/political/contracts/patents + bars + earnings_intel) and can
  // be added in Phase 4a follow-up commits. For now non-prophet boards
  // emit null and the engine emits a warning; the brief notes that the
  // metric machinery is board-agnostic so the engine is still useful.
  if (board === 'prophet') {
    return scoreProphetAtDate(ticker, asOfDate, ctx);
  }
  return null;
}
