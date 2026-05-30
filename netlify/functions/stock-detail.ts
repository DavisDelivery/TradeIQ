// GET /api/stock-detail?ticker=AAPL
//
// Phase 6 W1 — comprehensive on-demand detail bundle for the stock detail
// panel (the data behind everything in the panel that ISN'T the strategy
// rationale: metrics, sector-median context, catalysts, fundamentals history,
// relative strength). Aggregated from the existing data-provider abstractions.
//
// **No snapshot bloat (Phase 4u lesson):** this is per-ticker, on-demand, and
// session-memoized in the SPA. None of it is carried on board snapshots.
//
// **Honest no-data:** metrics that can't be sourced from the currently-wired
// providers are returned as `null` (never a fabricated zero). The richer
// ratios (P/S, EV/EBITDA, P/B, ROE, ROA, current ratio, interest coverage,
// short interest, dividend yield) await Phase 4w's fundamentals migration and
// are null today — the frontend renders them as explicit "no data".

import type { Handler } from '@netlify/functions';
import {
  getDailyBars,
  getFundamentals,
  getEarningsHistory,
  getUpcomingEarnings,
  getNews,
  getPreviousClose,
  type Bar,
} from './shared/data-provider';
import { getInsiderActivity } from './shared/insider-provider';
import { getSectorMedians, type SectorMedians } from './shared/sector-medians';
import { quarterlyFromStatements, type QuarterlyFundamental } from './shared/quarterly-fundamentals';
import { findEntry, SECTOR_ETFS, SPY } from './shared/universe';
import { getTickerInfo } from './shared/ticker-reference';
import { createLogger } from './shared/logger';

const log = createLogger('stock-detail');

interface MetricGroup {
  [k: string]: number | null;
}

interface StockDetailResponse {
  ok: boolean;
  ticker: string;
  error?: string;
  name?: string;
  sector?: string;
  price?: number | null;
  dayChangePct?: number | null;
  marketCap?: number | null;
  metrics?: {
    valuation: MetricGroup;
    profitability: MetricGroup;
    health: MetricGroup;
    market: {
      beta: number | null;
      shortInterest: number | null;
      dividendYield: number | null;
      freeCashFlow: number | null;
      range52w: { low: number; high: number; currentPctile: number } | null;
    };
    _reason?: string;
  };
  sectorMedians?: {
    valuation: MetricGroup;
    profitability: MetricGroup;
    health: MetricGroup;
    sampleSize: number;
  };
  catalysts?: {
    lastEarnings: {
      date: string;
      epsActual: number | null;
      epsEstimate: number | null;
      surprisePct: number | null;
      priceReactionPct: number | null;
    } | null;
    nextEarnings: { date: string; daysUntil: number; epsEstimate: number | null } | null;
    news: Array<{ headline: string; source: string | null; date: string; url: string; sentiment: string | null }>;
    insider: {
      net90dDollarVolume: number;
      last: { role: string; action: string; dollarValue: number; date: string } | null;
    } | null;
    upcomingEvents: Array<{ type: string; date: string; description: string }>;
  };
  fundamentalsHistory?: {
    quarterly: QuarterlyFundamental[];
    _reason?: string;
  };
  relativeStrength?: {
    vsSpy: Array<{ date: string; cumulativeOutperformancePct: number }>;
    vsSector: Array<{ date: string; cumulativeOutperformancePct: number }>;
    sectorEtf: string | null;
    _reason?: string;
  };
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase().trim();
  if (!ticker) {
    return json(400, { ok: false, ticker: '', error: 'ticker required' });
  }

  log.info('request', { ticker });
  try {
    const entry = findEntry(ticker);
    const sector = entry?.sector ?? 'Unknown';
    const sectorEtf = SECTOR_ETFS[sector] ?? null;

    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);

    // Fire everything in parallel — one slow provider must not serialize the
    // others. Each is independently graceful.
    const [
      bars,
      spyBars,
      sectorBars,
      fund,
      earnings,
      upcoming,
      news,
      insider,
      sectorMedianResult,
      info,
    ] = await Promise.all([
      getDailyBars(ticker, from, to).catch(() => [] as Bar[]),
      getDailyBars(SPY, from, to).catch(() => [] as Bar[]),
      sectorEtf ? getDailyBars(sectorEtf, from, to).catch(() => [] as Bar[]) : Promise.resolve([] as Bar[]),
      getFundamentals(ticker).catch(() => null),
      getEarningsHistory(ticker, 8).catch(() => []),
      getUpcomingEarnings(ticker, 90).catch(() => null),
      getNews(ticker, { limit: 5 }).catch(() => []),
      getInsiderActivity(ticker, 90).catch(() => null),
      getSectorMedians(sector, { excludeTicker: ticker }).catch(
        () => ({ medians: {} as SectorMedians, sampleSize: 0, sector, cached: false }),
      ),
      getTickerInfo(ticker).catch(() => null),
    ]);

    // Phase 6 PR-D: the quarterly chart series is now a pure transform over
    // the statements bundle that 4w's getFundamentals already returns — no
    // second fetch, no remaining VX dependency.
    const quarterly: QuarterlyFundamental[] = quarterlyFromStatements(fund?.statements, 20);

    if (!bars || bars.length === 0) {
      log.warn('no_bars', { ticker, durationMs: Date.now() - start });
      return json(404, { ok: false, ticker, error: 'no price bars available for ticker' });
    }

    const name = info?.name ?? entry?.name ?? ticker;
    const last = bars[bars.length - 1];
    const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
    const price = last?.c ?? null;
    const dayChangePct =
      prev && prev.c > 0 && last ? round(((last.c - prev.c) / prev.c) * 100, 2) : null;

    // --- Metrics ---
    // PR-A scoring-facing fields kept verbatim for backward compat (PR-B/C/D
    // already wired against these). PR-E adds pass-through of the Phase 4w
    // comprehensive groups (fund.valuation / .profitability / .liquidity /
    // .leverage / .cashflow) so the metrics grid lights up real values
    // for pe/pb/ps/evToEbitda/evToSales/enterpriseValue/marketCap, roe/roa/
    // netMargin/eps, current/quick/cash, longTermDebt, freeCashFlow,
    // dividendYield — every metric the brief enumerated.
    const pe = fund?.valuation?.pe
      ?? (fund?.ttmEps && fund.ttmEps > 0 && price ? round(price / fund.ttmEps, 1) : null);
    const grossMargin = fund?.profitability?.grossMargin !== undefined && fund?.profitability?.grossMargin !== null
      ? fund.profitability.grossMargin
      : fund?.grossMargin !== undefined ? round(fund.grossMargin * 100, 1) : null;
    const opMargin = fund?.profitability?.operatingMargin !== undefined && fund?.profitability?.operatingMargin !== null
      ? fund.profitability.operatingMargin
      : fund?.operatingMargin !== undefined ? round(fund.operatingMargin * 100, 1) : null;
    const debtEquity = fund?.leverage?.debtToEquity !== undefined && fund?.leverage?.debtToEquity !== null
      ? fund.leverage.debtToEquity
      : fund?.debtToEquity !== undefined ? round(fund.debtToEquity, 2) : null;
    const beta = computeBeta(bars, spyBars);
    const range52w = compute52wRange(bars);

    const metrics: NonNullable<StockDetailResponse['metrics']> = {
      valuation: {
        // Backward-compat shape
        pe,
        ps: fund?.valuation?.ps ?? null,
        evEbitda: fund?.valuation?.evToEbitda ?? null,
        pb: fund?.valuation?.pb ?? null,
        // Phase 4w pass-through additions
        pcf: fund?.valuation?.pcf ?? null,
        pfcf: fund?.valuation?.pfcf ?? null,
        evToSales: fund?.valuation?.evToSales ?? null,
        enterpriseValue: fund?.valuation?.enterpriseValue ?? null,
        marketCap: fund?.valuation?.marketCap ?? (typeof info?.marketCap === 'number' ? info.marketCap : null),
      },
      profitability: {
        grossMargin,
        opMargin,
        roe: fund?.profitability?.roe !== undefined && fund?.profitability?.roe !== null
          ? round(fund.profitability.roe * 100, 2)
          : null,
        roa: fund?.profitability?.roa !== undefined && fund?.profitability?.roa !== null
          ? round(fund.profitability.roa * 100, 2)
          : null,
        netMargin: fund?.profitability?.netMargin !== undefined && fund?.profitability?.netMargin !== null
          ? round(fund.profitability.netMargin * 100, 1)
          : null,
        eps: fund?.profitability?.eps ?? null,
      },
      health: {
        debtEquity,
        currentRatio: fund?.liquidity?.currentRatio ?? null,
        quickRatio: fund?.liquidity?.quickRatio ?? null,
        cashRatio: fund?.liquidity?.cashRatio ?? null,
        longTermDebt: fund?.leverage?.longTermDebt ?? null,
        interestCoverage: null, // not currently sourced
      },
      market: {
        beta,
        shortInterest: null,
        dividendYield: fund?.cashflow?.dividendYield ?? null,
        freeCashFlow: fund?.cashflow?.freeCashFlow ?? null,
        range52w,
      },
    };
    if (!fund) metrics._reason = 'fundamentals_unavailable';

    // --- Sector medians ---
    const sm = sectorMedianResult.medians;
    const sectorMedians: NonNullable<StockDetailResponse['sectorMedians']> = {
      valuation: { pe: sm.pe ?? null, ps: null, evEbitda: null, pb: null },
      profitability: { grossMargin: sm.grossMargin ?? null, opMargin: sm.opMargin ?? null, roe: null, roa: null, netMargin: null, eps: null },
      health: { debtEquity: sm.debtEquity ?? null, currentRatio: null, interestCoverage: null },
      sampleSize: sectorMedianResult.sampleSize,
    };

    // --- Catalysts ---
    const lastEarnings = buildLastEarnings(earnings, bars);
    const nextEarnings = buildNextEarnings(upcoming);
    const newsItems = (news ?? [])
      .filter((n) => withinDays(n.publishedUtc, 30))
      .slice(0, 5)
      .map((n) => ({
        headline: n.title,
        source: n.publisher ?? null,
        date: n.publishedUtc.slice(0, 10),
        url: n.url,
        sentiment: null as string | null,
      }));
    const insiderBlock = insider
      ? {
          net90dDollarVolume: Math.round(insider.netDollars),
          last: insider.latestBuy
            ? {
                role: insider.latestBuy.role,
                action: 'buy',
                dollarValue: insider.latestBuy.dollars,
                date: insider.latestBuy.date,
              }
            : null,
        }
      : null;
    const upcomingEvents: Array<{ type: string; date: string; description: string }> = [];
    if (nextEarnings) {
      upcomingEvents.push({
        type: 'earnings',
        date: nextEarnings.date,
        description:
          nextEarnings.epsEstimate !== null
            ? `Next earnings — Street EPS estimate ${nextEarnings.epsEstimate.toFixed(2)}`
            : 'Next earnings report',
      });
    }

    // --- Relative strength ---
    const relativeStrength = buildRelativeStrength(bars, spyBars, sectorBars, sectorEtf);

    const body: StockDetailResponse = {
      ok: true,
      ticker,
      name,
      sector,
      price,
      dayChangePct,
      marketCap: info?.marketCap ?? null,
      metrics,
      sectorMedians,
      catalysts: {
        lastEarnings,
        nextEarnings,
        news: newsItems,
        insider: insiderBlock,
        upcomingEvents,
      },
      fundamentalsHistory: {
        quarterly,
        ...(quarterly.length === 0 ? { _reason: 'quarterly_history_unavailable' } : {}),
      },
      relativeStrength,
    };

    log.info('response', { status: 200, ticker, bars: bars.length, durationMs: Date.now() - start });
    return json(200, body);
  } catch (err: any) {
    log.error('failed', { ticker, error: err, durationMs: Date.now() - start });
    return json(500, { ok: false, ticker, error: String(err?.message ?? err) });
  }
};

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

function compute52wRange(bars: Bar[]): { low: number; high: number; currentPctile: number } | null {
  // Last ~252 trading days.
  const window = bars.slice(-252);
  if (window.length < 2) return null;
  const lows = window.map((b) => b.l);
  const highs = window.map((b) => b.h);
  const low = Math.min(...lows);
  const high = Math.max(...highs);
  const current = window[window.length - 1].c;
  const pctile = high > low ? round(((current - low) / (high - low)) * 100, 1) : 0;
  return { low: round(low, 2), high: round(high, 2), currentPctile: pctile };
}

function computeBeta(bars: Bar[], spyBars: Bar[]): number | null {
  const stock = returnsByDate(bars);
  const spy = returnsByDate(spyBars);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [date, r] of stock) {
    const m = spy.get(date);
    if (m !== undefined) {
      ys.push(r);
      xs.push(m);
    }
  }
  if (xs.length < 30) return null;
  const meanX = avg(xs);
  const meanY = avg(ys);
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - meanX) * (ys[i] - meanY);
    varX += (xs[i] - meanX) ** 2;
  }
  if (varX === 0) return null;
  return round(cov / varX, 2);
}

function returnsByDate(bars: Bar[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].c;
    if (prev > 0) {
      out.set(new Date(bars[i].t).toISOString().slice(0, 10), (bars[i].c - prev) / prev);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Catalyst helpers
// ---------------------------------------------------------------------------

function buildLastEarnings(
  earnings: Array<{ date: string; epsActual: number; epsEstimate: number; surprisePct?: number }>,
  bars: Bar[],
): NonNullable<StockDetailResponse['catalysts']>['lastEarnings'] {
  if (!earnings || earnings.length === 0) return null;
  const sorted = [...earnings].sort((a, b) => b.date.localeCompare(a.date));
  const e = sorted[0];
  const surprisePct =
    e.surprisePct !== undefined && Number.isFinite(e.surprisePct)
      ? round(e.surprisePct, 1)
      : e.epsEstimate !== 0 && Number.isFinite(e.epsEstimate)
        ? round(((e.epsActual - e.epsEstimate) / Math.abs(e.epsEstimate)) * 100, 1)
        : null;
  return {
    date: e.date,
    epsActual: Number.isFinite(e.epsActual) ? e.epsActual : null,
    epsEstimate: Number.isFinite(e.epsEstimate) ? e.epsEstimate : null,
    surprisePct,
    priceReactionPct: priceReactionAround(e.date, bars),
  };
}

function priceReactionAround(date: string, bars: Bar[]): number | null {
  // Find the first bar on/after the earnings date and the one before it; the
  // 1-day reaction is the close-to-close change spanning the report.
  const idx = bars.findIndex((b) => new Date(b.t).toISOString().slice(0, 10) >= date);
  if (idx <= 0 || idx >= bars.length) return null;
  const before = bars[idx - 1].c;
  const after = bars[idx].c;
  if (before <= 0) return null;
  return round(((after - before) / before) * 100, 1);
}

function buildNextEarnings(
  upcoming: { date: string; epsEstimate?: number } | null,
): NonNullable<StockDetailResponse['catalysts']>['nextEarnings'] {
  if (!upcoming) return null;
  const daysUntil = Math.max(
    0,
    Math.round((Date.parse(`${upcoming.date}T12:00:00Z`) - Date.now()) / 86400000),
  );
  return {
    date: upcoming.date,
    daysUntil,
    epsEstimate: upcoming.epsEstimate !== undefined && Number.isFinite(upcoming.epsEstimate) ? upcoming.epsEstimate : null,
  };
}

function withinDays(iso: string, days: number): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= days * 86400000;
}

// ---------------------------------------------------------------------------
// Relative strength
// ---------------------------------------------------------------------------

function buildRelativeStrength(
  bars: Bar[],
  spyBars: Bar[],
  sectorBars: Bar[],
  sectorEtf: string | null,
): NonNullable<StockDetailResponse['relativeStrength']> {
  // ~1y of common dates, stock cumulative return minus benchmark cumulative
  // return, in percentage points, relative to the first common date.
  const window = bars.slice(-252);
  const vsSpy = cumulativeOutperformance(window, spyBars);
  const vsSector = sectorEtf ? cumulativeOutperformance(window, sectorBars) : [];
  const out: NonNullable<StockDetailResponse['relativeStrength']> = {
    vsSpy,
    vsSector,
    sectorEtf,
  };
  if (vsSpy.length === 0) out._reason = 'insufficient_overlap';
  return out;
}

function cumulativeOutperformance(
  stockWindow: Bar[],
  benchBars: Bar[],
): Array<{ date: string; cumulativeOutperformancePct: number }> {
  if (stockWindow.length === 0 || benchBars.length === 0) return [];
  const bench = new Map<string, number>();
  for (const b of benchBars) bench.set(new Date(b.t).toISOString().slice(0, 10), b.c);

  const common: Array<{ date: string; s: number; b: number }> = [];
  for (const sb of stockWindow) {
    const date = new Date(sb.t).toISOString().slice(0, 10);
    const bc = bench.get(date);
    if (bc !== undefined && bc > 0 && sb.c > 0) common.push({ date, s: sb.c, b: bc });
  }
  if (common.length < 2) return [];

  const s0 = common[0].s;
  const b0 = common[0].b;
  return common.map((p) => ({
    date: p.date,
    cumulativeOutperformancePct: round(((p.s / s0 - 1) - (p.b / b0 - 1)) * 100, 2),
  }));
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

function json(statusCode: number, body: StockDetailResponse) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Detail data includes intraday-ish price; keep the browser cache short.
      'Cache-Control': 'public, max-age=120',
    },
    body: JSON.stringify(body),
  };
}
