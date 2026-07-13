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
import { getFinnhubInsiderTransactionsWithStatus,
  getDailyBars,
  getFundamentals,
  getEarningsHistory,
  getNews,
  getUpcomingEarnings,
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
import { scoreFable, evaluateFoundationGate, FABLE_CONSTANTS } from '../fable-scoring';
import { pitCacheWrap, type PitCacheKey } from '../pit-cache';
import { addDays } from './trading-calendar';
import { getPoliticalActivityForBacktest } from './stock-act-shift';
import { runWilliams } from '../../styles/williams';
import {
  deriveWilliamsSignal,
  type WilliamsSignal,
} from '../../styles/williams-signal';
import { runLynch } from '../../styles/lynch';
import {
  deriveLynchSignalFromAnalyst,
  type LynchSignal,
} from '../../styles/lynch-signal';
// Phase 4t — ten-analyst composite (the "target" board). The analyst
// modules are pure: each takes already-fetched data and returns an
// AnalystOutput, so we can drive them from a PIT-correct fetch wave
// just like the live scan does — but with every fetch threading
// asOfDate. See reports/phase-4t/pit-audit.md for the per-factor
// classification.
import { runTechnical } from '../../analysts/technical';
import { runSectorRotation } from '../../analysts/sector-rotation';
import {
  runFundamental,
  runFlow,
  runEarnings,
  runNewsSentiment,
} from '../../analysts/core';
import { runInsider } from '../../analysts/insider';
import { runPatents } from '../../analysts/patents';
import { runPolitical } from '../../analysts/political';
import { composeTarget } from '../analyst-runner';
import {
  classifyEarnings,
  scoreEarningsComposite,
  computeDriftLean,
  annVol,
  chunksAnnVol,
} from '../earnings-scoring';
import type {
  AnalystOutput,
  Direction,
} from '../types';
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

// ---------------------------------------------------------------------------
// Ticker metadata resolution (CR-2, 2026-06 review)
// ---------------------------------------------------------------------------
//
// Scoring must NOT be gated on membership in the CURRENT universe seed.
// The PIT pool (universe-history) correctly includes delisted/acquired
// names (DWDP, BBBY, ATVI, …); the previous `if (!UNIVERSE.find(...))
// return null` gate silently dropped 27-41% of historical index members
// — disproportionately the non-survivors — re-introducing exactly the
// survivorship bias the pool was built to remove, while runs stayed
// stamped `survivorshipCorrected: true`.
//
// UNIVERSE is now a metadata lookup only: company name (needed for the
// patent-activity search) and sector (sector-relative signals). Tickers
// outside the seed score with a degraded entry — the patent fetch is
// skipped (it genuinely requires a company name) and sector-relative
// inputs fall back to their existing no-sector branches. Such candidates
// carry `metadata.outsideCurrentUniverse = true` so the engines surface
// a `scoredOutsideCurrentUniverse` metric per run.

interface ScoringEntry {
  ticker: string;
  name: string | null;
  sector: string | null;
  inCurrentUniverse: boolean;
}

function resolveScoringEntry(ticker: string): ScoringEntry {
  const entry = UNIVERSE.find((u) => u.ticker === ticker);
  if (entry) {
    return {
      ticker,
      name: entry.name,
      sector: entry.sector,
      inCurrentUniverse: true,
    };
  }
  return { ticker, name: null, sector: null, inCurrentUniverse: false };
}

/** metadata fragment marking a degraded (outside-current-universe) score. */
function universeFlag(entry: ScoringEntry): Record<string, unknown> {
  return entry.inCurrentUniverse ? {} : { outsideCurrentUniverse: true };
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
  const entry = resolveScoringEntry(ticker);

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
      // v2announce — Wave 2C: pre-fix cache entries were built from
      // period-end-filtered earnings history (look-ahead) and period-end
      // drift windows; the key bump orphans them.
      { provider: 'derived', dataClass: 'earnings_intel', ticker, asOfDate, extra: 'v2announce' },
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
    // Patent search requires a company name; outside-current-universe
    // tickers have none, so the patent sub-signal is dropped (null →
    // the existing no-patent-data path) rather than the whole score.
    entry.name === null
      ? Promise.resolve(null as Awaited<ReturnType<typeof getPatentActivity>> | null)
      : pitCacheWrap<unknown>(
          { provider: 'quiver', dataClass: 'patents', ticker, asOfDate, extra: `lb=180:${entry.name}` },
          () => getPatentActivity(ticker, entry.name!, 180, { asOfDate }).catch(() => null),
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
    epsSurpriseBeats: intel?.beatsLast4 ?? undefined,
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
    sectorRank: entry.sector ? (ctx.sectorRank[entry.sector] ?? 6) : 6,
  };

  const layers = {
    structure: layerStructure(bars),
    momentum: layerMomentum(bars),
    volume: layerVolume(bars),
    volatility: layerVolatility(bars),
    relativeStrength: layerRelativeStrength(
      bars,
      ctx.spyBars,
      (entry.sector ? ctx.sectorEtfCache[entry.sector] : null) ?? null,
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
      ...universeFlag(entry),
    },
  };
}

// ---------------------------------------------------------------------------
// Williams PIT scoring (Phase 4n, W4)
// ---------------------------------------------------------------------------
//
// Williams' inputs are price bars only — Williams %R, volatility breakout,
// closing-strength proxy, EMA trend gate. Daily bars are PIT-clean by
// nature (they don't get restated after publication), so a Williams score
// at date D is honest as long as we feed bars ≤ D into runWilliams. The
// `addDays(asOfDate, -CONTEXT_WINDOW_DAYS)` window plus the asOfDate `to`
// is exactly that — no future bars are visible.
//
// The discrete trade signal (BUY/SELL/HOLD + ATR-based levels) is derived
// from the same (score, bars) pair. We carry both the continuous score
// (as the engine's composite) and the discrete verdict (in metadata) so
// downstream consumers — including the backtest harness in W5 — can
// rank by composite OR filter to BUY-verdict candidates as they choose.

const WILLIAMS_MIN_BARS = 30;

async function scoreWilliamsAtDate(
  ticker: string,
  asOfDate: string,
  opts: { discreteSignalOnly?: boolean } = {},
): Promise<ScoredCandidate | null> {
  const entry = resolveScoringEntry(ticker);

  const to = asOfDate;
  // 180 calendar-day lookback gives ~125 trading bars — comfortably above
  // the 30-bar minimum runWilliams requires.
  const from = addDays(asOfDate, -180);

  const barsKey: PitCacheKey = {
    provider: 'polygon',
    dataClass: 'bars',
    ticker,
    asOfDate,
    extra: `from=${from}:williams`,
  };
  const bars = await pitCacheWrap(barsKey, () => getDailyBars(ticker, from, to));
  if (!bars || bars.length < WILLIAMS_MIN_BARS) return null;

  const analyst = runWilliams({ ticker, bars });
  const signal: WilliamsSignal = deriveWilliamsSignal(
    { score: analyst.score, signals: analyst.signals },
    bars,
  );

  if (opts.discreteSignalOnly && signal.verdict !== 'BUY') return null;

  const latestBar = bars[bars.length - 1];
  return {
    ticker,
    composite: analyst.score,
    layers: { williamsScore: analyst.score },
    sector: entry.sector,
    metadata: {
      price: latestBar.c,
      direction: analyst.score >= 0 ? 'long' : 'short',
      conviction: analyst.confidence,
      // The discrete signal — backtest harnesses filter on this for the
      // 4n "BUY-only portfolio" validation.
      verdict: signal.verdict,
      entry: signal.entry,
      stop: signal.stop,
      target: signal.target,
      atr: signal.atr,
      rationale: analyst.rationale,
      ...universeFlag(entry),
    },
  };
}

// ---------------------------------------------------------------------------
// Lynch PIT scoring (Phase 4n, W4)
// ---------------------------------------------------------------------------
//
// Lynch's inputs are fundamentals (PEG, EPS growth, revenue growth, debt,
// earnings consistency) plus a current price for the fair-value band.
// Fundamentals are the hard case: they get RESTATED. The look-ahead-bias
// hazard the brief (PART V) warns about is real.
//
// PIT integrity story for the Lynch scoring path:
//   - Filing-date filter: `getFundamentals(ticker, { asOfDate })` filters
//     on `filing_date <= asOfDate`; `getEarningsHistory(ticker, 4,
//     { asOfDate })` filters on the ANNOUNCEMENT date (Wave 2C — the old
//     `period <= asOfDate` filter leaked reports announced after D whose
//     fiscal quarter ended before D; rows with unresolved announcement
//     dates are excluded outright). The agent at date D cannot see
//     filings made AFTER D — that part is correct.
//   - Restatement risk: Polygon's `/vX/reference/financials` silently
//     incorporates later restatements into earlier filings. If a company
//     restated 2021 revenue downward in 2023, scoring a 2021 date today
//     uses the restated 2021 numbers, not what was publicly available
//     on 2021. This is documented in `docs/POINT_IN_TIME_AUDIT.md` and
//     is residual look-ahead risk we CANNOT eliminate without snapshot
//     storage of fundamentals at scan time (Phase 1 extension, out of
//     scope here).
//   - Price (current close at asOfDate): PIT-clean by construction.
//   - Earnings beats/positive-quarter counts: PIT-correct only as far
//     as the announcement-date filter goes; the EPS-actual values inside
//     those rows can also be restated (less common than financials).
//
// 4n's report MUST surface this caveat. The PIT path here is wired
// correctly; the residual restatement risk lives in the data provider.

const LYNCH_MIN_BARS = 30; // we need a recent price for the fair-value band

async function scoreLynchAtDate(
  ticker: string,
  asOfDate: string,
  opts: { discreteSignalOnly?: boolean } = {},
): Promise<ScoredCandidate | null> {
  const entry = resolveScoringEntry(ticker);

  const to = asOfDate;
  const from = addDays(asOfDate, -90);

  // Bars (for the latest close — fair-value band needs a price)
  const barsKey: PitCacheKey = {
    provider: 'polygon',
    dataClass: 'bars',
    ticker,
    asOfDate,
    extra: `from=${from}:lynch`,
  };
  const bars = await pitCacheWrap(barsKey, () => getDailyBars(ticker, from, to));
  if (!bars || bars.length < LYNCH_MIN_BARS) return null;
  const latestBar = bars[bars.length - 1];

  const [fund, earnings] = await Promise.all([
    pitCacheWrap<unknown>(
      { provider: 'polygon', dataClass: 'fundamentals', ticker, asOfDate, extra: 'lynch' },
      () => getFundamentals(ticker, { asOfDate }).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getFundamentals>> | null),
    pitCacheWrap<unknown>(
      // v2announce — Wave 2C: pre-fix entries were period-end filtered
      // (look-ahead) and lack announceDate; the key bump orphans them.
      { provider: 'finnhub', dataClass: 'earnings_history', ticker, asOfDate, extra: 'lb=4:lynch:v2announce' },
      () => getEarningsHistory(ticker, 4, { asOfDate }).catch(() => [] as Awaited<ReturnType<typeof getEarningsHistory>>),
    ).then((v) => v as Awaited<ReturnType<typeof getEarningsHistory>>),
  ]);

  // If we have neither fundamentals nor earnings, there's nothing to score on.
  if (!fund && (!earnings || earnings.length === 0)) return null;

  const peRatio =
    fund?.ttmEps && fund.ttmEps !== 0 ? latestBar.c / fund.ttmEps : undefined;

  const analyst = runLynch({
    ticker,
    peRatio,
    epsGrowthTTM: fund?.epsGrowthTTM,
    revenueGrowthYoY: fund?.revenueGrowthYoY,
    debtToEquity: fund?.debtToEquity,
    operatingMargin: fund?.operatingMargin,
    earningsHistory: earnings,
    marketCapUsd: undefined,
    recentReturnPct: undefined,
    sector: entry.sector ?? undefined,
  });

  const signal: LynchSignal = deriveLynchSignalFromAnalyst(
    { score: analyst.score, signals: analyst.signals },
    { currentPrice: latestBar.c, ttmEps: fund?.ttmEps },
  );

  if (opts.discreteSignalOnly && signal.verdict !== 'BUY') return null;

  return {
    ticker,
    composite: analyst.score,
    layers: { lynchScore: analyst.score },
    sector: entry.sector,
    metadata: {
      price: latestBar.c,
      direction: analyst.score >= 0 ? 'long' : 'short',
      conviction: analyst.confidence,
      verdict: signal.verdict,
      fairValueLow: signal.fairValueLow,
      fairValueHigh: signal.fairValueHigh,
      peg: signal.peg,
      rationale: analyst.rationale,
      // Surfaced for the 4n report — a flag set when the data layer
      // could not provide PIT-correct fundamentals for this date.
      pitCaveat: 'restatement-risk: Polygon may serve restated fundamentals',
      ...universeFlag(entry),
    },
  };
}

// ---------------------------------------------------------------------------
// Target-board (ten-analyst composite) PIT scoring — Phase 4t W1
// ---------------------------------------------------------------------------
//
// The "target" board is TradeIQ's core multi-factor model: ten analysts
// (Technical, Sector, Fundamental, Flow, News, Earnings, Macro,
// Insider, Patents, Political) blended into a single 0-100 directional
// composite by `composeTarget` in `shared/analyst-runner.ts`. Phase 4s
// fixed the composite math (directional, conflict-aware); Phase 4t is
// the FIRST honest backtest of the result.
//
// This scorer mirrors `runAnalystsForTicker` but threads `asOfDate`
// through every fetch and pulls bars / SPY / sector ETFs from the
// already-built `MarketContextAtDate`. The per-analyst PIT integrity is
// audited in `reports/phase-4t/pit-audit.md`:
//
//   - PIT-clean (5):       technical, sector-rotation, flow, insider,
//                          political-contracts (action-date)
//   - PIT-with-caveat (3): political (STOCK Act shift), fundamental
//                          (restatement risk), earnings-history
//                          (EPS-actual restatement)
//   - PIT-with-caveat (1): news-sentiment (coverage density caveat
//                          in early years; cutoff itself is hard)
//   - Excluded by weight=0 (2): patent-analyst (Phase 4f no_upstream),
//                               macro-regime (Phase 4f no_upstream)
//
// The two weight-0 analysts are still SCORED (so a future weight bump
// doesn't silently surface a missing path), but their composite
// contribution is zero. `composeTarget` rescales the surviving
// weight-positive analysts to sum to 1.

const TARGET_MIN_BARS = 50; // matches runAnalystsForTicker

async function scoreTargetAtDate(
  ticker: string,
  asOfDate: string,
  ctx: MarketContextAtDate,
): Promise<ScoredCandidate | null> {
  const entry = resolveScoringEntry(ticker);

  const to = asOfDate;
  const from = addDays(asOfDate, -CONTEXT_WINDOW_DAYS);

  // Bars (PIT-clean — same cache key shape as the prophet path so the
  // two boards share the bar cache).
  const barsKey: PitCacheKey = {
    provider: 'polygon',
    dataClass: 'bars',
    ticker,
    asOfDate,
    extra: `from=${from}`,
  };
  const bars = await pitCacheWrap(barsKey, () =>
    getDailyBars(ticker, from, to),
  );
  if (!bars || bars.length < TARGET_MIN_BARS) return null;

  // Every other PIT-aware fetch in parallel, each wrapped in the cache.
  // News: 15 items is what the live runner uses; `getNews` filters by
  // published_utc.lte. Upcoming earnings: 45-day forward window from
  // asOfDate. Earnings history: 4 quarters back, announcement-filtered.
  // Insider/political/contracts/patents: live scan defaults (90/180-
  // day lookbacks). Political uses the STOCK-Act-shifted backtest
  // helper, not the raw getPoliticalActivity.
  const [
    fundamentals,
    news,
    upcoming,
    history,
    insiderActivity,
    patentActivity,
    politicalActivity,
    contractActivity,
  ] = await Promise.all([
    pitCacheWrap<unknown>(
      { provider: 'polygon', dataClass: 'fundamentals', ticker, asOfDate, extra: 'target' },
      () => getFundamentals(ticker, { asOfDate }).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getFundamentals>> | null),
    pitCacheWrap<unknown>(
      { provider: 'polygon', dataClass: 'news', ticker, asOfDate, extra: 'lim=15' },
      () => getNews(ticker, { asOfDate, limit: 15 }).catch(() => []),
    ).then((v) => v as Awaited<ReturnType<typeof getNews>>),
    pitCacheWrap<unknown>(
      { provider: 'polygon', dataClass: 'upcoming_earnings', ticker, asOfDate, extra: 'ahead=45' },
      () => getUpcomingEarnings(ticker, 45, { asOfDate }).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getUpcomingEarnings>> | null),
    pitCacheWrap<unknown>(
      // v2announce — Wave 2C: pre-fix entries were period-end filtered
      // (look-ahead) and lack announceDate; the key bump orphans them.
      { provider: 'finnhub', dataClass: 'earnings_history', ticker, asOfDate, extra: 'lb=4:target:v2announce' },
      () => getEarningsHistory(ticker, 4, { asOfDate }).catch(() => []),
    ).then((v) => v as Awaited<ReturnType<typeof getEarningsHistory>>),
    pitCacheWrap<unknown>(
      { provider: 'finnhub', dataClass: 'insider', ticker, asOfDate, extra: 'lb=90' },
      () => getInsiderActivity(ticker, 90, { asOfDate }).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getInsiderActivity>> | null),
    // Patent search requires a company name (see scoreProphetAtDate);
    // outside-current-universe tickers drop the patent sub-signal only.
    entry.name === null
      ? Promise.resolve(null as Awaited<ReturnType<typeof getPatentActivity>> | null)
      : pitCacheWrap<unknown>(
          { provider: 'quiver', dataClass: 'patents', ticker, asOfDate, extra: `lb=180:${entry.name}` },
          () => getPatentActivity(ticker, entry.name!, 180, { asOfDate }).catch(() => null),
        ).then((v) => v as Awaited<ReturnType<typeof getPatentActivity>> | null),
    pitCacheWrap<unknown>(
      { provider: 'quiver', dataClass: 'political', ticker, asOfDate, extra: 'lb=180:stockact-shifted' },
      () => getPoliticalActivityForBacktest(ticker, 180, asOfDate).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getPoliticalActivity>> | null),
    pitCacheWrap<unknown>(
      { provider: 'quiver', dataClass: 'contracts', ticker, asOfDate, extra: 'lb=180' },
      () => getGovContractActivity(ticker, 180, { asOfDate }).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getGovContractActivity>> | null),
  ]);

  // Shared bars from the rebalance context (PIT-clipped at build time).
  // Unknown sector (outside-current-universe ticker) → empty sector bars
  // → runSectorRotation's existing insufficient-history neutral branch.
  const sectorBars = (entry.sector ? ctx.sectorEtfCache[entry.sector] : null) ?? [];
  const spyBars = ctx.spyBars;

  // Run the analysts — same wiring as runAnalystsForTicker, including
  // the no-data fallbacks for insider/patents/political that emit
  // _noData so composeTarget can rescale the surviving weights.
  const tech = runTechnical(bars);
  const sec = runSectorRotation(bars, sectorBars, spyBars, entry.sector ?? 'Unknown');
  const fun = runFundamental(fundamentals);
  const flow = runFlow(bars);
  const earn = runEarnings(upcoming, history);
  const news_ = runNewsSentiment(news);

  const ins: AnalystOutput = insiderActivity
    ? runInsider(insiderActivity)
    : {
        score: 50,
        direction: 'neutral' as Direction,
        confidence: 0,
        rationale: 'insider data unavailable',
        signals: { _noData: true, _reason: 'no_data' },
      };
  const pat: AnalystOutput = patentActivity
    ? runPatents(patentActivity)
    : {
        score: 50,
        direction: 'neutral' as Direction,
        confidence: 0,
        rationale: 'patent data unavailable',
        signals: { _noData: true, _reason: 'no_data' },
      };
  let pol: AnalystOutput;
  if (politicalActivity == null && contractActivity == null) {
    pol = {
      score: 50,
      direction: 'neutral' as Direction,
      confidence: 0,
      rationale: 'political + contract data unavailable',
      signals: { _noData: true, _reason: 'no_data' },
    };
  } else {
    pol = runPolitical(politicalActivity, contractActivity);
  }

  // Macro-regime: scored from the context's macroBias for completeness.
  // ANALYST_WEIGHTS pins macro-regime to 0 (Phase 4f no_upstream), so
  // this contributes zero to the composite even when computed. We score
  // it anyway so a future weight bump finds a wired-in path, not a stub.
  const macroBias = ctx.macroBias;
  const macroScore = Math.round(50 + macroBias * 20);
  const macroDir: Direction =
    macroBias > 0.2 ? 'long' : macroBias < -0.2 ? 'short' : 'neutral';
  const macro: AnalystOutput = {
    score: macroScore,
    direction: macroDir,
    confidence: Math.abs(macroBias),
    rationale:
      macroDir === 'long'
        ? 'risk-on tailwind'
        : macroDir === 'short'
          ? 'risk-off headwind'
          : 'neutral macro',
    signals: { bias: macroBias },
  };

  const allAnalysts: Record<string, AnalystOutput> = {
    'technical-analyst': tech,
    'sector-rotation': sec,
    'fundamental-analyst': fun,
    'flow-analyst': flow,
    'news-sentiment': news_,
    'earnings-analyst': earn,
    'macro-regime': macro,
    'insider-analyst': ins,
    'patent-analyst': pat,
    'political-analyst': pol,
  };

  // composeTarget owns the weight table + the directional, conflict-
  // aware composite math (Phase 4s). We pass the live ANALYST_WEIGHTS
  // shape verbatim so 4t measures the composite EXACTLY as production
  // computes it — no tuning.
  const composed = composeTarget(allAnalysts, TARGET_ANALYST_WEIGHTS);

  // Map each analyst's individual score onto a `layers` map so the
  // backtest engine's per-rebalance attribution carries them. W3
  // leave-one-out / per-factor IC reads this map.
  const layerScores: Record<string, number> = {
    technical: tech.score,
    'sector-rotation': sec.score,
    fundamental: fun.score,
    flow: flow.score,
    news: news_.score,
    earnings: earn.score,
    macro: macro.score,
    insider: ins.score,
    patents: pat.score,
    political: pol.score,
  };

  const latestBar = bars[bars.length - 1];
  return {
    ticker,
    composite: composed.composite,
    layers: layerScores,
    sector: entry.sector,
    metadata: {
      price: latestBar.c,
      direction: composed.direction,
      conviction: confidenceFromConflict(composed.conflictLevel),
      regime: ctx.regime?.regime ?? null,
      conflictLevel: composed.conflictLevel,
      tier: composed.tier,
      signedNet: composed.signedNet,
      scoredAnalysts: composed.scoredAnalysts,
      noDataAnalysts: composed.noDataAnalysts,
      // 4t PIT caveat surfacing — mirrors the Lynch metadata pattern.
      // The verdict report surfaces this on every target backtest
      // result so the restatement / news-coverage caveats are not
      // buried.
      pitCaveat:
        'restatement-risk: Polygon may serve restated fundamentals + EPS-actual; ' +
        'news-coverage density lower in 2018',
      ...universeFlag(entry),
    },
  };
}

// Phase 4t — must mirror `ANALYST_WEIGHTS` in shared/analyst-runner.ts
// EXACTLY. If those weights ever shift, this constant must shift with
// them; tests assert equality so a drift surfaces immediately. We
// duplicate the values here rather than import the const because
// analyst-runner pulls in the live data-provider modules at import
// time (network), and score-at-date.ts is on the hot test path. The
// `compose-weights-import` test pins the values.
const TARGET_ANALYST_WEIGHTS: Record<string, number> = {
  'technical-analyst': 0.15,
  'sector-rotation': 0.08,
  'fundamental-analyst': 0.13,
  'flow-analyst': 0.10,
  'news-sentiment': 0.10,
  'earnings-analyst': 0.07,
  'macro-regime': 0,
  'insider-analyst': 0.14,
  'patent-analyst': 0,
  'political-analyst': 0.10,
};

// Approximate conviction from conflict level. The composite Tier is
// also exposed in metadata; this is a single 0-1 scalar for backtest
// consumers that want a numeric confidence (the engine's existing
// `metadata.conviction` slot).
function confidenceFromConflict(
  level: 'severe' | 'moderate' | 'mild' | 'none',
): number {
  switch (level) {
    case 'severe':
      return 0.25;
    case 'moderate':
      return 0.5;
    case 'mild':
      return 0.75;
    case 'none':
      return 1.0;
  }
}

// Exposed for tests that want to assert the weight table mirrors the
// live ANALYST_WEIGHTS verbatim.
export const _internalsTarget = { TARGET_ANALYST_WEIGHTS };

// ---------------------------------------------------------------------------
// Earnings-board PIT scoring — FIX-2 W1
// ---------------------------------------------------------------------------
//
// The earnings board is EVENT-anchored, not always-on: a ticker only has
// a tradable setup near an earnings print. At a rebalance date D we score
// a ticker ONLY when it is inside an event window relative to D:
//   - POST-PRINT: the most recent print (announcement date) is within
//     EARNINGS_POST_PRINT_LOOKBACK_DAYS BEFORE D  (PEAD / reversal), or
//   - PRE-PRINT:  the next scheduled print is within
//     EARNINGS_SCHEDULED_WINDOW_DAYS AFTER D       (vol / drift).
// Otherwise → null (no setup). Because most tickers have no setup on a
// given monthly date, the earnings backtest runs with
// `discreteSignalOnly: true` so the FIX-1 W2 null-rate guard treats
// "no setup" as valid no-trade, not missing data.
//
// PIT integrity: bars are clipped to ≤ D; the earnings calendar uses the
// asOfDate-aware getUpcomingEarnings / getEarningsHistory (announcement-
// date filtered). daysUntil / postPrint are computed relative to D, NEVER
// `Date.now()` — that is exactly the PIT-hostile line in the live scorer.
// Classification + composite come from the pure shared `earnings-scoring`
// module (same code as the live scan). EPS-actual restatement is the
// residual caveat (surfaced in metadata + the verdict), same class as the
// Lynch/target fundamentals caveat.

const EARNINGS_MIN_BARS = 30;
const EARNINGS_CONTEXT_DAYS = 300; // enough trailing bars for the RV-chunk history
const EARNINGS_SCHEDULED_WINDOW_DAYS = 30;
const EARNINGS_POST_PRINT_LOOKBACK_DAYS = 5;

function daysBetweenIso(fromIso: string, toIso: string): number {
  return (
    Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)
  ) / 86_400_000;
}

async function scoreEarningsAtDate(
  ticker: string,
  asOfDate: string,
  ctx: MarketContextAtDate,
  opts: { discreteSignalOnly?: boolean } = {},
): Promise<ScoredCandidate | null> {
  const entry = resolveScoringEntry(ticker);
  const to = asOfDate;
  const from = addDays(asOfDate, -EARNINGS_CONTEXT_DAYS);

  const barsKey: PitCacheKey = {
    provider: 'polygon',
    dataClass: 'bars',
    ticker,
    asOfDate,
    extra: `from=${from}:earnings`,
  };
  const bars = await pitCacheWrap(barsKey, () => getDailyBars(ticker, from, to));
  if (!bars || bars.length < EARNINGS_MIN_BARS) return null;

  // Earnings calendar — PIT. Next scheduled print (≥ D, within window) and
  // past prints announced ≤ D.
  const [upcoming, history] = await Promise.all([
    pitCacheWrap<unknown>(
      { provider: 'finnhub', dataClass: 'upcoming_earnings', ticker, asOfDate, extra: `ahead=${EARNINGS_SCHEDULED_WINDOW_DAYS}:earnings` },
      () => getUpcomingEarnings(ticker, EARNINGS_SCHEDULED_WINDOW_DAYS, { asOfDate }).catch(() => null),
    ).then((v) => v as Awaited<ReturnType<typeof getUpcomingEarnings>> | null),
    pitCacheWrap<unknown>(
      { provider: 'finnhub', dataClass: 'earnings_history', ticker, asOfDate, extra: 'lb=8:earnings:v2announce' },
      () => getEarningsHistory(ticker, 8, { asOfDate, withAnnounceDates: true }).catch(() => []),
    ).then((v) => v as Awaited<ReturnType<typeof getEarningsHistory>>),
  ]);

  // Resolve the event window relative to D.
  const lastAnnounce = history.find((h) => h.announceDate)?.announceDate ?? null;
  const daysSinceLastPrint = lastAnnounce !== null ? daysBetweenIso(lastAnnounce, asOfDate) : null;
  const postPrint =
    daysSinceLastPrint !== null &&
    daysSinceLastPrint >= 0 &&
    daysSinceLastPrint <= EARNINGS_POST_PRINT_LOOKBACK_DAYS;

  const daysUntilScheduled = upcoming?.date ? daysBetweenIso(asOfDate, upcoming.date) : null;
  const prePrint =
    !postPrint &&
    daysUntilScheduled !== null &&
    daysUntilScheduled >= 0 &&
    daysUntilScheduled <= EARNINGS_SCHEDULED_WINDOW_DAYS;

  // No event window around D ⇒ no setup. (discreteSignalOnly semantics:
  // null = valid no-trade, not missing data.)
  if (!postPrint && !prePrint) return null;

  const daysUntil = postPrint
    ? -Math.round(daysSinceLastPrint as number)
    : Math.round(daysUntilScheduled as number);
  const reportDate = postPrint ? (lastAnnounce as string) : (upcoming as { date: string }).date;

  // ---- Metrics from bars ≤ D (PIT-clean) — mirrors scoreEarningsForTicker ----
  const returns: number[] = [];
  for (let j = 1; j < bars.length; j++) {
    if (bars[j].c > 0 && bars[j - 1].c > 0) returns.push(Math.log(bars[j].c / bars[j - 1].c));
  }
  const rv20 = annVol(returns.slice(-20));
  const chunked = chunksAnnVol(returns, 20).filter((v) => v > 0);
  const rv90Min = chunked.length ? Math.min(...chunked) : 0;
  const rv90Max = chunked.length ? Math.max(...chunked) : 0;
  const rvRankRaw = rv90Max > rv90Min ? ((rv20 - rv90Min) / (rv90Max - rv90Min)) * 100 : 50;
  const rvRank = Math.max(0, Math.min(100, Math.round(rvRankRaw)));
  const expectedMove = (rv20 / Math.sqrt(252)) * Math.sqrt(2) * 100;

  // Prior announcement-anchored T-1→T+1 reactions (all announce dates ≤ D).
  const priorMoves: number[] = [];
  let lastMove: number | null = null;
  for (const [k, h] of history.slice(0, 6).entries()) {
    if (!h.announceDate) continue;
    const hd = Date.parse(`${h.announceDate}T12:00:00Z`);
    const barIdx = bars.findIndex((b) => Math.abs(b.t - hd) < 3 * 86_400_000);
    if (barIdx > 0 && barIdx < bars.length - 1) {
      const pre = bars[barIdx - 1].c;
      const post = bars[barIdx + 1].c;
      if (pre > 0) {
        const signed = ((post - pre) / pre) * 100;
        priorMoves.push(Math.abs(signed));
        if (k === 0) lastMove = signed;
      }
    }
  }
  const avgPriorMove = priorMoves.length > 0 ? avgArr(priorMoves) : null;

  const last5 = bars.slice(-6);
  const last20 = bars.slice(-21);
  const drift5 = last5.length >= 6 && last5[0].c > 0 ? ((last5[last5.length - 1].c - last5[0].c) / last5[0].c) * 100 : 0;
  const drift20 = last20.length >= 21 && last20[0].c > 0 ? ((last20[last20.length - 1].c - last20[0].c) / last20[0].c) * 100 : 0;

  const recentVol = bars.slice(-5).reduce((a, b) => a + (b.v || 0), 0) / 5;
  const avg20Vol = bars.slice(-25, -5).reduce((a, b) => a + (b.v || 0), 0) / 20;
  const volRatio = avg20Vol > 0 ? recentVol / avg20Vol : 1;

  // ---- Classify + score via the shared pure module (same as live scan) ----
  const { lean: driftLean } = computeDriftLean(drift5, drift20);
  const surprise = history[0]?.surprisePct ?? null;
  const { playType, direction } = classifyEarnings({
    postPrint, surprise, lastMove, volRatio, rvRank, avgPriorMove, expectedMove, drift20, driftLean,
  });
  const composite = scoreEarningsComposite(playType, {
    rvRank, drift20, surprisePct: history[0]?.surprisePct ?? 0, daysUntil, postPrint,
  });

  // discreteSignalOnly: a 'skip' classification is a valid no-trade, dropped.
  if (opts.discreteSignalOnly && playType === 'skip') return null;

  const latestBar = bars[bars.length - 1];
  return {
    ticker,
    composite,
    layers: { earningsComposite: composite },
    sector: entry.sector,
    metadata: {
      price: latestBar.c,
      direction: direction ?? 'neutral',
      playType,
      postPrint,
      daysUntil,
      reportDate,
      rvRank,
      expectedMove: +expectedMove.toFixed(2),
      drift20: +drift20.toFixed(2),
      volRatio: +volRatio.toFixed(2),
      surprisePct: surprise ?? undefined,
      lastMove: lastMove ?? undefined,
      regime: ctx.regime?.regime ?? null,
      pitCaveat:
        'earnings history EPS-actual may be restated (residual look-ahead); ' +
        'news-coverage density lower in 2018',
      ...universeFlag(entry),
    },
  };
}

// ---------------------------------------------------------------------------
// FABLE (Claude's board) — bars + insider-filings PIT path.
//
// The composite is cross-section-free by design (fixed squashes, see
// shared/fable-scoring.ts), so this per-ticker path computes EXACTLY the
// number the live scan computes — the backtest tests the shipped board.
// Gate-fail returns null: a valid no-trade (run with discreteSignalOnly).
// The EDGAR exec-role bonus is inactive here AND in the live scan (v1),
// and the quality veto is live-only — neither participates in validation.
// ---------------------------------------------------------------------------

const FABLE_BARS_LOOKBACK_DAYS = 460;

async function scoreFableAtDate(
  ticker: string,
  asOfDate: string,
  ctx: MarketContextAtDate,
  _opts: { discreteSignalOnly?: boolean } = {},
): Promise<ScoredCandidate | null> {
  const entry = resolveScoringEntry(ticker);
  const from = addDays(asOfDate, -FABLE_BARS_LOOKBACK_DAYS);

  const bars = await pitCacheWrap(
    { provider: 'polygon', dataClass: 'bars', ticker, asOfDate, extra: `from=${from}:fable` },
    () => getDailyBars(ticker, from, asOfDate),
  );
  if (!bars || bars.length < FABLE_CONSTANTS.MIN_BARS) return null;

  // Gate FIRST, before any further I/O — mirrors the live scan's two-phase
  // bars-first design. ~80-95% of the universe fails the FOUNDATION gate on
  // any date; skipping their SPY/insider fetches cuts Finnhub volume ~10x
  // per rebalance. scoreFable re-evaluates the same pure gate on the same
  // bars, so behavior is identical — this is purely an I/O short-circuit.
  if (!evaluateFoundationGate(bars as any).pass) return null;

  // SPY window for the residual/regime — pitCached once per rebalance date.
  const spyFrom = addDays(asOfDate, -FABLE_BARS_LOOKBACK_DAYS);
  const spyBars = await pitCacheWrap(
    { provider: 'polygon', dataClass: 'bars', ticker: 'SPY', asOfDate, extra: `from=${spyFrom}:fable-spy` },
    () => getDailyBars('SPY', spyFrom, asOfDate),
  );

  const txs = await pitCacheWrap(
    { provider: 'finnhub', dataClass: 'insider', ticker, asOfDate, extra: 'daysBack=200:fable' },
    async () => {
      const status = await getFinnhubInsiderTransactionsWithStatus(ticker, 200, { asOfDate });
      // M8 failure discipline (and the 4t-W1c cache-poisoning lesson):
      // transport failure is MISSING data, not absent data. Throw so
      // pitCacheWrap never caches a failure-shaped [] for this
      // (ticker, asOfDate) and the engine books a visible TickerFailure
      // instead of silently scoring insiderEdge=0. Verified-empty
      // (HTTP 200, zero rows) is PIT-stable and caches fine.
      if (status.rateLimitExhausted || status.errorMessage) {
        throw new Error(
          `fable insider fetch failed ${ticker}@${asOfDate}: ${status.errorMessage ?? 'rate-limit exhausted'}`,
        );
      }
      return status.data;
    },
  );

  const res = scoreFable(
    bars as any,
    (spyBars ?? []) as any,
    (txs ?? []) as any,
    asOfDate,
  );
  if (!res) return null; // gate fail = valid no-trade

  const latestBar = (bars as any[])[(bars as any[]).length - 1];
  return {
    ticker,
    composite: res.composite,
    layers: { fableComposite: res.composite },
    sector: entry.sector,
    metadata: {
      price: latestBar.c,
      ascent: +res.pillars.ascent.toFixed(1),
      smoothPath: +res.pillars.smoothPath.toFixed(1),
      highGround: +res.pillars.highGround.toFixed(1),
      coiledSpring: +res.pillars.coiledSpring.toFixed(1),
      insiderEdge: +res.insider.score.toFixed(1),
      fip: +res.pillars.fip.toFixed(4),
      imomIr: +res.pillars.imomIr.toFixed(2),
      proximity52w: +res.pillars.proximity52w.toFixed(3),
      regime: ctx.regime?.regime ?? null,
      ...universeFlag(entry),
    },
  };
}

/** Local pure mean (avoid importing `avg` name-collision into this module). */
function avgArr(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Public entry point. Dispatches to per-board scoring.
 *
 * As of Phase 4t: prophet, williams, lynch, AND target boards have PIT
 * scoring paths. Catalyst and insider remain stubs returning null
 * (their PIT story has not been audited).
 *
 * The market context is shared across one rebalance — callers should
 * pre-build it once via buildMarketContextAtDate and pass it here.
 * Williams and Lynch don't currently use `ctx` (no sector-relative or
 * macro inputs); target uses spyBars, sector ETFs, regime, and
 * macroBias.
 */
export async function scoreTickerAtDate(
  ticker: string,
  asOfDate: string,
  board: BacktestBoard,
  ctx: MarketContextAtDate,
  opts: { discreteSignalOnly?: boolean } = {},
): Promise<ScoredCandidate | null> {
  if (ctx.asOfDate !== asOfDate) {
    throw new Error(
      `scoreTickerAtDate: ctx.asOfDate (${ctx.asOfDate}) does not match asOfDate (${asOfDate}). ` +
        `Build a fresh context per rebalance date.`,
    );
  }
  if (board === 'prophet') return scoreProphetAtDate(ticker, asOfDate, ctx);
  if (board === 'williams') return scoreWilliamsAtDate(ticker, asOfDate, opts);
  if (board === 'lynch') return scoreLynchAtDate(ticker, asOfDate, opts);
  if (board === 'target') return scoreTargetAtDate(ticker, asOfDate, ctx);
  if (board === 'earnings') return scoreEarningsAtDate(ticker, asOfDate, ctx, opts);
  if (board === 'fable') return scoreFableAtDate(ticker, asOfDate, ctx, opts);
  // catalyst / insider remain stubs — no PIT path yet.
  return null;
}
