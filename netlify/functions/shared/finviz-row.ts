// PROFILE-1 W1.1 / W1.3 — the Finviz row, finally reaching the profile.
//
// THE GAP THIS CLOSES. `stock-detail.ts` has never imported finviz. Finviz
// data reaches it only as OHLCV through getDailyBars, so the other 50
// columns of a row we ALREADY PAY FOR — short float, days-to-cover, float,
// institutional and insider ownership, ATR, relative volume, RSI, analyst
// recommendation and target, the EPS-growth ladder, the performance ladder —
// have never been on the ticker profile at all.
//
// WHY A PER-TICKER EXPORT AND NOT THE CACHED UNIVERSE. The sharded universe
// snapshot (getFinvizUniverseSnapshot) is the right source for peer
// STATISTICS, where the whole cross-section is the point. For one ticker it
// is the wrong shape: it costs a manifest read plus every shard read from
// Firestore, then a linear scan of ~2,000 rows, to return one row — and it
// misses any name outside the two index filters. A `t=` export is one small
// CSV, and Finviz's ticker list accepts symbols in no index at all.
//
// DERIVED FIELDS ARE COMPUTED HERE, ONCE. ADV$ and ATR% are the two figures
// the tradability block is actually for, and neither is a raw column: ADV$
// is avgVolume x price, ATR% is atr / price. Computing them at the seam
// keeps two components from disagreeing about what "average dollar volume"
// means.

import { fetchFinvizScreener, advDollar, type FinvizRow } from './finviz';
import { liveCacheWrap } from './provider-live-cache';

/** Finviz's universe snapshot uses 15 min; a profile row can be slower. */
const ROW_TTL_MS = 15 * 60_000;

export interface TradabilityBlock {
  /** Average daily dollar volume over Finviz's 3-month average volume. */
  advDollar: number | null;
  avgVolume: number | null;
  /** Today's volume as a multiple of average. */
  relativeVolume: number | null;
  /** Average true range, in dollars. */
  atr: number | null;
  /** ATR as a percentage of price — the position-sizing form. */
  atrPct: number | null;
  /** Free float, in millions of shares. */
  floatM: number | null;
  price: number | null;
}

export interface OwnershipBlock {
  instOwnPct: number | null;
  insiderOwnPct: number | null;
  /** Net insider transactions, percent. Finviz's own sign convention. */
  insiderTransPct: number | null;
  shortFloatPct: number | null;
  /** Days to cover. The form that retained significance after 2000. */
  shortRatio: number | null;
  floatM: number | null;
}

export interface GrowthBlock {
  epsPast5YPct: number | null;
  epsThisYearPct: number | null;
  epsNextYearPct: number | null;
  epsNext5YPct: number | null;
  epsQoQPct: number | null;
  salesQoQPct: number | null;
}

export interface AnalystBlock {
  /** 1.0 strong buy … 5.0 strong sell. */
  recom: number | null;
  targetPrice: number | null;
  /** (target - price) / price, percent. Null unless both sides are real. */
  impliedUpsidePct: number | null;
}

export interface FinvizProfileBlocks {
  tradability: TradabilityBlock;
  ownership: OwnershipBlock;
  growth: GrowthBlock;
  analyst: AnalystBlock;
  /** Next report, vendor opinion. SEC 8-K remains authoritative. */
  earningsDate: string | null;
  earningsSession: 'amc' | 'bmo' | null;
  sector: string | null;
  /** Peer-pool level for W3. Null until the universe cache refills at v4. */
  industry: string | null;
}

const n = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Guarded ratio — null unless both sides are real and the base is positive. */
export function ratio(num: number | null, den: number | null): number | null {
  if (num === null || den === null || !(den > 0)) return null;
  const out = num / den;
  return Number.isFinite(out) ? out : null;
}

/**
 * Shape a Finviz row into the profile's blocks. Pure, so the derivations are
 * testable without a network call.
 */
export function shapeFinvizRow(row: FinvizRow): FinvizProfileBlocks {
  const price = n(row.price);
  const avgVolume = n(row.avgVolume);
  const atr = n(row.atr);
  const targetPrice = n(row.targetPrice);

  return {
    tradability: {
      advDollar: advDollar(avgVolume, price),
      avgVolume,
      relativeVolume: n(row.relVolume),
      atr,
      // As a PERCENT of price, because a $3 ATR means nothing without knowing
      // whether the stock is $20 or $2,000.
      atrPct: (() => {
        const r = ratio(atr, price);
        return r === null ? null : r * 100;
      })(),
      floatM: n(row.floatM),
      price,
    },
    ownership: {
      instOwnPct: n(row.instOwnPct),
      insiderOwnPct: n(row.insiderOwnPct),
      insiderTransPct: n(row.insiderTransPct),
      shortFloatPct: n(row.shortFloatPct),
      shortRatio: n(row.shortRatio),
      floatM: n(row.floatM),
    },
    growth: {
      epsPast5YPct: n(row.epsGrowthPast5YPct),
      epsThisYearPct: n(row.epsGrowthThisYearPct),
      epsNextYearPct: n(row.epsGrowthNextYearPct),
      epsNext5YPct: n(row.epsGrowthNext5YPct),
      epsQoQPct: n(row.epsGrowthQoQPct),
      salesQoQPct: n(row.salesGrowthQoQPct),
    },
    analyst: {
      recom: n(row.analystRecom),
      targetPrice,
      impliedUpsidePct: (() => {
        if (targetPrice === null || price === null || !(price > 0)) return null;
        return ((targetPrice - price) / price) * 100;
      })(),
    },
    earningsDate: typeof row.earningsDate === 'string' ? row.earningsDate : null,
    earningsSession: row.earningsSession ?? null,
    sector: typeof row.sector === 'string' ? row.sector : null,
    industry: typeof row.industry === 'string' && row.industry.trim() !== ''
      ? row.industry
      : null,
  };
}

/**
 * One ticker's Finviz row, cached.
 *
 * Returns null on ANY failure — Finviz serves its login page at HTTP 200, so
 * fetchFinvizScreener already treats a body without a Ticker header as a
 * failure. Null propagates as "this block is unavailable" rather than as a
 * row of zeros.
 */
export async function getFinvizProfileBlocks(
  ticker: string,
): Promise<FinvizProfileBlocks | null> {
  const t = ticker.toUpperCase().trim();
  if (!t) return null;

  return liveCacheWrap<FinvizProfileBlocks>(
    { provider: 'finviz', endpoint: 'screener/row', ticker: t },
    () => ROW_TTL_MS,
    async () => {
      const res = await fetchFinvizScreener([], [t]);
      if (!res) return null;
      // A `t=` export can return a near-miss symbol; take the exact match
      // only, rather than whatever landed in row 0.
      const row = res.rows.find((r) => r.ticker?.toUpperCase() === t);
      return row ? shapeFinvizRow(row) : null;
    },
  );
}
