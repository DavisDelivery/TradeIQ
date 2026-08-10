// PROFILE-1 W3 — assembling the peer pool from the cached Finviz universe.
//
// COMPUTED LAZILY, ON TAP. Nothing here runs on a profile load. The drawer
// asks for one metric when the user opens it, which is why reading the
// sharded universe (a manifest plus every shard) is affordable at all — it
// happens once per curiosity, not once per page.
//
// THE POOL LADDER, and why it is reported rather than hidden: industry first,
// and only if that clears N >= 20 does it stand. Otherwise it falls back to
// sector, and the RESULT SAYS WHICH. A percentile computed against "Technology"
// wearing the label "Consumer Electronics" would be worse than no percentile.

import { getFinvizUniverseSnapshot, type FinvizRow, type FinvizUniverse } from './finviz';
import { buildPeerStat, MIN_POOL_FOR_PERCENTILE, type PeerStat, type PoolLevel } from './peer-stats';

/** The two index exports that together approximate the investable universe. */
export const POOL_UNIVERSES: FinvizUniverse[] = ['sp500', 'russell2k'];

/**
 * Metric key -> the FinvizRow field carrying it.
 *
 * Only metrics present in the export appear here. The five the universe does
 * not carry (EV/EBITDA, P/FCF, FCF yield, operating margin, quick ratio) are
 * deliberately absent and are refused upstream by peer-stats.NO_PEER_POOL —
 * two independent places saying the same no, so adding a mapping here by
 * mistake still cannot produce a rank.
 */
export const METRIC_TO_FINVIZ: Record<string, keyof FinvizRow> = {
  pe: 'pe',
  forwardPe: 'forwardPe',
  ps: 'ps',
  pb: 'pb',
  dividendYield: 'dividendYieldPct',
  beta: 'beta',
  rsi14: 'rsi14',
  instOwnPct: 'instOwnPct',
  insiderOwnPct: 'insiderOwnPct',
  grossMargin: 'grossMarginPct',
  netMargin: 'profitMarginPct',
  roe: 'roePct',
  roa: 'roaPct',
  debtEquity: 'debtToEquity',
  currentRatio: 'currentRatio',
  payoutRatio: 'payoutRatioPct',
  shortFloatPct: 'shortFloatPct',
  shortRatio: 'shortRatio',
  revenueGrowth: 'salesGrowthQoQPct',
  epsGrowth: 'epsGrowthQoQPct',
  // W3.2 — rows that were previously not clickable at all. Market cap is an
  // absolute magnitude but ranking it is the ONE case where size is the
  // question being asked ("how big is this against its industry?"), so it
  // pools rather than sitting in NOT_RANKABLE.
  marketCap: 'marketCapM',
  relativeVolume: 'relVolume',
  insiderTransPct: 'insiderTransPct',
};

/** ATR% is derived, not a column, so it is read specially. */
export const DERIVED_METRICS = new Set(['atrPct']);

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Pull one metric's value off a Finviz row, including the derived ones. */
export function metricValueOf(row: FinvizRow, metricKey: string): number | null {
  if (metricKey === 'atrPct') {
    const atr = num(row.atr);
    const price = num(row.price);
    return atr !== null && price !== null && price > 0 ? (atr / price) * 100 : null;
  }
  const field = METRIC_TO_FINVIZ[metricKey];
  if (!field) return null;
  return num(row[field]);
}

export const canPoolMetric = (metricKey: string): boolean =>
  DERIVED_METRICS.has(metricKey) || metricKey in METRIC_TO_FINVIZ;

/** Deduped union of the configured index exports. */
export async function loadUniverseRows(): Promise<FinvizRow[] | null> {
  const snaps = await Promise.all(POOL_UNIVERSES.map((u) => getFinvizUniverseSnapshot(u)));
  if (snaps.every((s) => s === null)) return null;
  const seen = new Set<string>();
  const rows: FinvizRow[] = [];
  for (const s of snaps) {
    for (const r of s?.rows ?? []) {
      const t = r.ticker?.toUpperCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      rows.push(r);
    }
  }
  return rows;
}

export interface PoolChoice {
  level: PoolLevel;
  name: string;
  rows: FinvizRow[];
}

/**
 * Choose the narrowest pool that clears the percentile floor.
 *
 * FINANCIALS ARE DROPPED FROM DEBT/EQUITY, per the direction table: leverage
 * is the business for a bank, so ranking one against industrials is not a
 * comparison of the same thing.
 */
export function choosePool(
  rows: FinvizRow[],
  subject: FinvizRow,
  metricKey: string,
): PoolChoice {
  const isFinancial = (r: FinvizRow) => (r.sector ?? '').toLowerCase().includes('financial');
  const eligible = metricKey === 'debtEquity' ? rows.filter((r) => !isFinancial(r)) : rows;

  const industry = subject.industry ?? null;
  const sector = subject.sector ?? null;

  if (industry) {
    const pool = eligible.filter((r) => r.industry === industry);
    // Count only rows that actually carry the metric — an industry of 40
    // names where 6 report the field is a pool of 6, not 40.
    const usable = pool.filter((r) => metricValueOf(r, metricKey) !== null).length;
    if (usable >= MIN_POOL_FOR_PERCENTILE + 1) {
      return { level: 'industry', name: industry, rows: pool };
    }
  }

  return {
    level: 'sector',
    name: sector ?? 'Unclassified',
    rows: sector ? eligible.filter((r) => r.sector === sector) : [],
  };
}

export interface PeerStatRequest {
  ticker: string;
  metricKey: string;
}

/**
 * The whole lazy path: universe -> subject -> pool -> statistics.
 *
 * Returns null only when the universe itself is unavailable, which is a
 * different fact from "no peers" and must not be flattened into it.
 */
export async function computePeerStat(
  req: PeerStatRequest,
  loader: () => Promise<FinvizRow[] | null> = loadUniverseRows,
): Promise<PeerStat | null> {
  const ticker = req.ticker.toUpperCase().trim();
  const rows = await loader();
  if (!rows) return null;

  const subject = rows.find((r) => r.ticker?.toUpperCase() === ticker);
  if (!subject) return null;

  const { level, name, rows: poolRows } = choosePool(rows, subject, req.metricKey);

  return buildPeerStat({
    metricKey: req.metricKey,
    subjectTicker: ticker,
    subjectValue: metricValueOf(subject, req.metricKey),
    pool: poolRows.map((r) => ({
      ticker: r.ticker.toUpperCase(),
      value: metricValueOf(r, req.metricKey),
    })),
    poolLevel: level,
    poolName: name,
  });
}
