// QS-1 (2026-08-09) — the Quiet Strength scan.
//
// Assembles: universe + market cap (Finviz) × 36 monthly returns (Polygon
// grouped-daily) × Fama-French 3 (Ken French) → residual momentum → sleeve.
//
// COST SHAPE, because it is the reason this is built the way it is:
//   universe      1 call per index filter (2)
//   factors       1 call (cached monthly in practice)
//   daily window  DAILY_WINDOW consecutive sessions, 1 call each
//   older months  ~31 month-end dates outside that window, 1 call each
//   ------------------------------------------------------------------
//   ~160 calls TOTAL, and — the point — independent of universe size.
//   The per-ticker alternative is one call per name, i.e. 1,500+.

import type { Logger } from './logger';
import type { GroupedRow } from './vector-data';
import { getGroupedDaily } from './vector-data';
import { fetchFinvizScreener, FINVIZ_UNIVERSE_FILTERS, type FinvizRow } from './finviz';
import { isMarketClosed } from './us-market-holidays';
import {
  fetchFrenchFactors,
  factorCoverage,
  factorWindow,
  addMonths,
  ymOf,
  type FactorMonth,
  type FetchFactorsResult,
} from './ff-factors';
import {
  buildMonthlyCloses,
  toMonthlyReturns,
  indexDollarVolume,
  annualisedVol,
  monthEndDates,
  ymOfDate,
} from './monthly-returns';
import { residualMomentum, ESTIMATION_MONTHS, WINDOW_END_LAG } from './residual-momentum';
import {
  buildQuietStrengthBoard,
  type QSCandidate,
  type QSBoardResult,
} from './quiet-strength';

/** Consecutive recent sessions fetched, for daily liquidity and sleeve vol. */
export const DAILY_WINDOW = 126;
/** Month-end closes needed for ESTIMATION_MONTHS returns. */
export const MONTH_ENDS = ESTIMATION_MONTHS + 1;
export const BENCH = 'SPY';

/**
 * The month-end closes required to produce the scoring window's returns.
 *
 * ONE function, so the fetch list and the factor window cannot disagree.
 * A return is dated to the LATER of the two months it spans, so covering
 * returns [end-35 .. end] needs closes [end-36 .. end] — one extra month at
 * the START, not at the end. Getting that backwards is what made every
 * ticker unscorable on the first production run.
 */
export function closeMonthsFor(scoringEndYm: number): number[] {
  const first = addMonths(scoringEndYm, -ESTIMATION_MONTHS);
  return Array.from({ length: MONTH_ENDS }, (_, i) => addMonths(first, i));
}

export interface RunQuietStrengthOpts {
  now?: Date;
  scanBudgetMs?: number;
  concurrency?: number;
  logger?: Logger;
  // Injected for tests; default to the real providers.
  getGrouped?: (date: string) => Promise<GroupedRow[]>;
  getFactors?: () => Promise<FetchFactorsResult>;
  getUniverse?: () => Promise<FinvizRow[] | null>;
}

export interface RunQuietStrengthResult extends QSBoardResult {
  scanDurationMs: number;
  budgetExceeded: boolean;
  /** Provenance so the snapshot can state what it was computed from. */
  factorLatestYm: number | null;
  scoringEndYm: number;
  returnBasis: 'price';
  datesFetched: number;
}

/**
 * Walk back from a calendar month end to the last plausible trading day.
 *
 * Uses the holiday calendar rather than probing Polygon: a non-trading date
 * returns an empty grouped response, which is indistinguishable from an
 * outage, so guessing costs both a call and a false alarm.
 */
export function lastTradingDateOfMonth(ym: number, isClosed = isMarketClosed): string {
  const y = Math.floor(ym / 100);
  const m = ym % 100;
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last of this
  for (let i = 0; i < 10; i++) {
    if (!isClosed(d)) return d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

/** The most recent `n` trading dates at or before `from`, newest last. */
export function recentTradingDates(from: Date, n: number, isClosed = isMarketClosed): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let guard = 0;
  while (out.length < n && guard++ < n * 3 + 30) {
    if (!isClosed(d)) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Build the candidate set. Pure, so the assembly logic is testable without
 * touching a provider.
 */
export function assembleCandidates(
  universe: FinvizRow[],
  monthly: Map<string, { returnsPct: number[]; ym: number[] }>,
  dollarVol: Map<string, number>,
  lastClose: Map<string, number>,
  factors: FactorMonth[],
  scoringEndYm: number,
): QSCandidate[] {
  const window = factorWindow(factors, scoringEndYm, ESTIMATION_MONTHS);
  const out: QSCandidate[] = [];

  for (const u of universe) {
    const t = u.ticker?.toUpperCase();
    if (!t) continue;

    const base: QSCandidate = {
      ticker: t,
      sector: u.sector ?? null,
      marketCapM: u.marketCapM ?? null,
      medianDollarVol: dollarVol.get(t) ?? null,
      price: lastClose.get(t) ?? null,
      score: null,
      reason: null,
    };

    if (!window) {
      out.push({ ...base, reason: 'factor-gap' });
      continue;
    }
    const series = monthly.get(t);
    if (!series || series.returnsPct.length < ESTIMATION_MONTHS) {
      out.push({ ...base, reason: 'insufficient-history' });
      continue;
    }

    // Align the return series to the factor window by month, so a ticker
    // whose history ends early is refused rather than silently regressed
    // against months it does not have.
    const byYm = new Map(series.ym.map((y, i) => [y, series.returnsPct[i]]));
    const aligned: number[] = [];
    let complete = true;
    for (const f of window) {
      const r = byYm.get(f.ym);
      if (r === undefined) { complete = false; break; }
      aligned.push(r);
    }
    if (!complete) {
      out.push({ ...base, reason: 'insufficient-history' });
      continue;
    }

    const rm = residualMomentum({ monthlyReturnsPct: aligned, factors: window });
    out.push({
      ...base,
      score: rm.score,
      reason: rm.reason,
      plain12_1Pct: rm.plain12_1Pct,
      betaMkt: rm.betaMkt,
      betaSmb: rm.betaSmb,
      betaHml: rm.betaHml,
    });
  }
  return out;
}

/** Compound a benchmark's monthly closes into a trailing N-month return. */
export function trailingReturnPct(
  closesByYm: Map<number, number>,
  endYm: number,
  months: number,
): number | null {
  const startYm = addMonths(endYm, -months);
  const a = closesByYm.get(startYm);
  const b = closesByYm.get(endYm);
  if (!(a! > 0) || !Number.isFinite(b as number)) return null;
  return ((b as number) - a!) / a! * 100;
}

export async function runQuietStrengthScan(
  opts: RunQuietStrengthOpts = {},
): Promise<RunQuietStrengthResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const budgetMs = opts.scanBudgetMs ?? 11 * 60_000;
  const concurrency = opts.concurrency ?? 8;
  const log = opts.logger;
  const getGrouped = opts.getGrouped ?? getGroupedDaily;
  const getFactors = opts.getFactors ?? (() => fetchFrenchFactors());
  const getUniverse =
    opts.getUniverse ??
    (async () => {
      const parts = await Promise.all([
        fetchFinvizScreener([FINVIZ_UNIVERSE_FILTERS.sp500]),
        fetchFinvizScreener([FINVIZ_UNIVERSE_FILTERS.russell2k]),
      ]);
      if (parts.every((p) => p === null)) return null;
      const seen = new Set<string>();
      const rows: FinvizRow[] = [];
      for (const p of parts) {
        for (const r of p?.rows ?? []) {
          const t = r.ticker?.toUpperCase();
          if (!t || seen.has(t)) continue;
          seen.add(t);
          rows.push(r);
        }
      }
      return rows;
    });

  const warnings: string[] = [];

  // --- universe -----------------------------------------------------------
  const universe = (await getUniverse()) ?? [];
  if (!universe.length) warnings.push('universe fetch returned no rows');

  // --- factors ------------------------------------------------------------
  // The scoring window ends at t-2. French publishes in arrears, so this is
  // the constraint most likely to bite in production.
  const scoringEndYm = addMonths(ymOf(now), -WINDOW_END_LAG);
  let factors: FactorMonth[] = [];
  let factorLatestYm: number | null = null;
  try {
    const f = await getFactors();
    factors = f.factors;
    const cov = factorCoverage(factors, scoringEndYm, ESTIMATION_MONTHS);
    factorLatestYm = cov.latestYm;
    if (!cov.covered) {
      warnings.push(
        `factor coverage short: French ends ${cov.latestYm}, window needs ${scoringEndYm}` +
          (cov.gaps.length ? ` (interior gaps: ${cov.gaps.join(',')})` : ''),
      );
    }
  } catch (err: any) {
    warnings.push(`factor fetch failed: ${String(err?.message ?? err)}`);
  }

  // --- dates --------------------------------------------------------------
  //
  // THE CLOSE WINDOW IS ANCHORED TO scoringEndYm, NOT TO `now`.
  //
  // It used to walk back from ymOf(now), which put the earliest close at
  // scoringEndYm-35 instead of scoringEndYm-36. A return is dated to the
  // LATER of its two months (see toMonthlyReturns), so the earliest close can
  // only ever produce a return one month after itself — the window came up
  // exactly one month short at the start and one month long at the end, and
  // the alignment loop refused EVERY ticker as 'insufficient-history'. That
  // is universe-independent and permanent: 0 of 1851 on 2026-08-10, and it
  // would have been 0 every night after.
  //
  // Deriving the two windows separately from `now` is what let them drift, so
  // the fetch list is now computed FROM the scoring window it has to feed.
  const daily = recentTradingDates(now, DAILY_WINDOW);
  const dailySet = new Set(daily);
  const monthEnds: string[] = [];
  for (const ym of closeMonthsFor(scoringEndYm)) {
    const d = lastTradingDateOfMonth(ym);
    if (!dailySet.has(d)) monthEnds.push(d);
  }
  const allDates = [...new Set([...monthEnds, ...daily])].sort();

  // --- grouped daily ------------------------------------------------------
  const snapshots = new Map<string, GroupedRow[]>();
  let budgetExceeded = false;
  const fetched = await mapLimit(allDates, concurrency, async (date) => {
    if (Date.now() - started > budgetMs) { budgetExceeded = true; return null; }
    try {
      return { date, rows: await getGrouped(date) };
    } catch (err: any) {
      log?.warn?.('grouped_daily_failed', { date, err: String(err?.message ?? err) });
      return null;
    }
  });
  for (const f of fetched) if (f) snapshots.set(f.date, f.rows);
  if (budgetExceeded) warnings.push(`scan budget exceeded — ${snapshots.size}/${allDates.length} dates fetched`);

  // --- monthly series -----------------------------------------------------
  const monthEndSnaps = new Map<string, GroupedRow[]>();
  const byMonth = monthEndDates([...snapshots.keys()]);
  for (const d of byMonth) monthEndSnaps.set(d, snapshots.get(d)!);

  const closes = buildMonthlyCloses(monthEndSnaps);
  const monthly = new Map<string, { returnsPct: number[]; ym: number[] }>();
  for (const [t, c] of closes) {
    const s = toMonthlyReturns(c);
    if (s.returnsPct.length) monthly.set(t, { returnsPct: s.returnsPct, ym: s.ym });
  }

  // --- liquidity + last close --------------------------------------------
  const dailySnaps = daily.map((d) => snapshots.get(d)).filter(Boolean) as GroupedRow[][];
  const dollarVol = indexDollarVolume(dailySnaps);
  const lastClose = new Map<string, number>();
  for (const d of [...snapshots.keys()].sort()) {
    for (const r of snapshots.get(d) ?? []) {
      if (typeof r?.T === 'string' && Number.isFinite(r.c) && r.c > 0) lastClose.set(r.T, r.c);
    }
  }

  // --- benchmark + sleeve vol --------------------------------------------
  const benchCloses = closes.get(BENCH);
  const benchByYm = new Map<number, number>();
  if (benchCloses) benchCloses.ym.forEach((y, i) => benchByYm.set(y, benchCloses.close[i]));
  const benchmark24mPct = trailingReturnPct(benchByYm, scoringEndYm, 24);
  if (benchmark24mPct === null) warnings.push('benchmark 24m return unavailable — bear dimmer inactive');

  // Sleeve vol proxied by the benchmark's realized vol until the sleeve has
  // its own live history. Stated as a proxy in the payload rather than
  // presented as the sleeve's own measurement.
  const benchDaily: number[] = [];
  let prev: number | null = null;
  for (const d of daily) {
    const row = (snapshots.get(d) ?? []).find((r) => r.T === BENCH);
    if (!row || !(row.c > 0)) continue;
    if (prev !== null) benchDaily.push(((row.c - prev) / prev) * 100);
    prev = row.c;
  }
  const realizedVolPct = annualisedVol(benchDaily);
  if (realizedVolPct === null) warnings.push('realized vol unavailable — exposure not scaled');
  else warnings.push('exposure uses BENCHMARK realized vol as a proxy for the sleeve (no live sleeve history yet)');

  // --- score --------------------------------------------------------------
  const candidates = factors.length
    ? assembleCandidates(universe, monthly, dollarVol, lastClose, factors, scoringEndYm)
    : universe.map((u) => ({
        ticker: u.ticker.toUpperCase(),
        sector: u.sector ?? null,
        marketCapM: u.marketCapM ?? null,
        medianDollarVol: dollarVol.get(u.ticker.toUpperCase()) ?? null,
        price: lastClose.get(u.ticker.toUpperCase()) ?? null,
        score: null,
        reason: 'factor-gap',
      }) as QSCandidate);

  const board = buildQuietStrengthBoard(
    candidates,
    { realizedVolPct, benchmark24mPct },
    { warnings },
  );

  return {
    ...board,
    scanDurationMs: Date.now() - started,
    budgetExceeded,
    factorLatestYm,
    scoringEndYm,
    returnBasis: 'price',
    datesFetched: snapshots.size,
  };
}

export { ymOfDate };
