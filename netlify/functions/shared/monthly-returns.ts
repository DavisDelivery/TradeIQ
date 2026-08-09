// QS-1 (2026-08-09) — monthly return series for the WHOLE universe, built
// from grouped-daily snapshots.
//
// WHY GROUPED DAILY AND NOT PER-TICKER BARS — this is the decision that
// makes the board affordable at all:
//
//   Residual momentum needs 36 monthly returns per name, i.e. ~37 month-end
//   closes. Fetching that per ticker (getDailyBarsClamped) is ONE HTTP call
//   per name — 1,500+ calls for the Russell body above the policy floor,
//   which does not fit the 13-minute background budget and would burn the
//   Polygon quota nightly.
//
//   getGroupedDaily(date) returns EVERY US ticker's OHLCV for one date. So
//   the same 36 monthly returns for the entire universe cost ~37 calls
//   TOTAL, independent of universe size. Two orders of magnitude cheaper,
//   and it reuses the exact source the forward league already trusts for
//   entry prices, so no second price semantics enter the app.
//
//   It also inherits grouped-daily's survivorship property: the endpoint
//   includes names that later delisted.
//
// WHAT THESE RETURNS ARE, PRECISELY. Polygon's `adjusted=true` is SPLIT
// adjustment, not total return — dividends are not reinvested. So these are
// PRICE returns, while the Fama-French factors they are regressed on are
// TOTAL returns. The mismatch is a roughly uniform drag of the dividend
// yield, which for a cross-sectional RANKING is largely common-mode and
// mostly differences out; it is nonetheless a real approximation and is
// recorded in the snapshot as `returnBasis: 'price'` rather than left for a
// reader to assume otherwise.

import type { GroupedRow } from './vector-data';

/** A per-ticker monthly close series, oldest first. */
export interface MonthlyCloses {
  ticker: string;
  /** Parallel arrays: ym[i] is the month of close[i]. */
  ym: number[];
  close: number[];
}

export interface MonthlySeries {
  ticker: string;
  /** Monthly percent returns, oldest first. Length is closes − 1. */
  returnsPct: number[];
  /** The month each return ENDS in. */
  ym: number[];
}

/**
 * Pick the last available trading date in each calendar month.
 *
 * Deliberately takes the set of dates that actually traded rather than
 * computing calendar month-ends: month-end lands on a weekend or a holiday
 * roughly a third of the time, and asking Polygon for those dates returns an
 * empty grouped response that is indistinguishable from an outage.
 */
export function monthEndDates(tradingDates: string[]): string[] {
  const byMonth = new Map<string, string>();
  for (const d of tradingDates) {
    const key = d.slice(0, 7); // YYYY-MM
    const prev = byMonth.get(key);
    if (!prev || d > prev) byMonth.set(key, d);
  }
  return [...byMonth.values()].sort();
}

/** YYYYMM for an ISO date string. */
export const ymOfDate = (ymd: string): number =>
  Number(ymd.slice(0, 4)) * 100 + Number(ymd.slice(5, 7));

/**
 * Fold a set of month-end grouped snapshots into per-ticker close series.
 *
 * `snapshotsByDate` must be keyed by trading date (YYYY-MM-DD); ordering of
 * the map is irrelevant, the output is sorted by month.
 */
export function buildMonthlyCloses(
  snapshotsByDate: Map<string, GroupedRow[]>,
): Map<string, MonthlyCloses> {
  const dates = [...snapshotsByDate.keys()].sort();
  const out = new Map<string, MonthlyCloses>();
  for (const date of dates) {
    const ym = ymOfDate(date);
    for (const row of snapshotsByDate.get(date) ?? []) {
      const t = row?.T;
      const c = row?.c;
      if (typeof t !== 'string' || !Number.isFinite(c) || c <= 0) continue;
      let series = out.get(t);
      if (!series) {
        series = { ticker: t, ym: [], close: [] };
        out.set(t, series);
      }
      series.ym.push(ym);
      series.close.push(c);
    }
  }
  return out;
}

/**
 * Convert closes to returns, requiring a CONTIGUOUS run of months.
 *
 * A ticker that stopped trading for two months and resumed has a gap. Naively
 * differencing consecutive available closes would silently splice across it
 * and present a 3-month return as a 1-month return — the sort of thing that
 * produces a spectacular, entirely fictional momentum score. When a gap is
 * found the series is truncated to the most recent contiguous run instead.
 */
export function toMonthlyReturns(closes: MonthlyCloses): MonthlySeries {
  const { ym, close } = closes;
  let start = 0;
  for (let i = 1; i < ym.length; i++) {
    const gap = (Math.floor(ym[i] / 100) - Math.floor(ym[i - 1] / 100)) * 12 +
      ((ym[i] % 100) - (ym[i - 1] % 100));
    if (gap !== 1) start = i; // discard everything before the break
  }
  const returnsPct: number[] = [];
  const outYm: number[] = [];
  for (let i = start + 1; i < close.length; i++) {
    const prev = close[i - 1];
    const cur = close[i];
    if (!(prev > 0) || !Number.isFinite(cur)) continue;
    returnsPct.push(((cur - prev) / prev) * 100);
    outYm.push(ym[i]);
  }
  return { ticker: closes.ticker, returnsPct, ym: outYm };
}

/**
 * Median dollar volume from the sampled snapshots.
 *
 * NOTE ON WHAT THIS MEASURES. research-policy's liquidity floor is specified
 * on MEDIAN DAILY dollar volume; what we have here is one observation per
 * sampled date. When the sample is month-ends, the result is a median of
 * month-end days — and month-end carries index-rebalance and expiry flow, so
 * it runs HIGH relative to a typical day. Passing a month-end median into a
 * floor designed for daily medians would admit names that are quieter than
 * they look, so the scan samples a run of consecutive recent sessions for
 * this figure instead of reusing the month-end set.
 */
export function medianDollarVolume(
  ticker: string,
  snapshots: GroupedRow[][],
): number | null {
  const vals: number[] = [];
  for (const rows of snapshots) {
    for (const r of rows) {
      if (r?.T !== ticker) continue;
      if (Number.isFinite(r.c) && Number.isFinite(r.v) && r.c > 0 && r.v >= 0) {
        vals.push(r.c * r.v);
      }
    }
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const mid = vals.length >> 1;
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

/** Index a run of snapshots by ticker once, for repeated median lookups. */
export function indexDollarVolume(snapshots: GroupedRow[][]): Map<string, number> {
  const acc = new Map<string, number[]>();
  for (const rows of snapshots) {
    for (const r of rows) {
      if (typeof r?.T !== 'string') continue;
      if (!Number.isFinite(r.c) || !Number.isFinite(r.v) || r.c <= 0 || r.v < 0) continue;
      const list = acc.get(r.T);
      if (list) list.push(r.c * r.v);
      else acc.set(r.T, [r.c * r.v]);
    }
  }
  const out = new Map<string, number>();
  for (const [t, vals] of acc) {
    vals.sort((a, b) => a - b);
    const mid = vals.length >> 1;
    out.set(t, vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2);
  }
  return out;
}

/**
 * Trailing realized volatility, ANNUALISED, from daily percent returns.
 *
 * Used for the crash-control exposure rule, which is specified against
 * "trailing 126d realized vol" of the sleeve. 252 trading days per year.
 */
export function annualisedVol(dailyReturnsPct: number[]): number | null {
  const xs = dailyReturnsPct.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const varr = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  const out = Math.sqrt(varr) * Math.sqrt(252);
  return Number.isFinite(out) ? out : null;
}
