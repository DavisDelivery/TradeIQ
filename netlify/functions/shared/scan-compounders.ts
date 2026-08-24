// COMP-1 (2026-08-22) — the Compounders scan: a two-stage funnel.
//
// The board's thesis lives in compounders.ts. This file is the assembly, and
// its whole shape is dictated by one cost fact:
//
//   universe        3 calls  — sp500 ∪ ndx ∪ dji, ~36 columns per name, ONE
//                              HTTP call each (finviz.ts)
//   month-end close 2 calls  — the two anchors of the 12-1 window, whole-tape
//                              grouped daily (vector-data.ts)
//   statements      2 calls PER FINALIST — income + balance (massive)
//   ------------------------------------------------------------------------
//   ~505 calls at the default 250 finalists.
//
// The un-funnelled version — statements for every name in the universe — is
// ~1,200 per-ticker calls and does not fit a 15-minute container. So this is
// the scan-trident shape: a cheap stage that ranks the WHOLE universe on
// bulk data, then an expensive stage only the finalists reach.
//
// WHAT STAGE 1 CAN AND CANNOT DECIDE. Finviz's bulk row carries roePct, which
// is a quality proxy with a known leverage problem (compounders.qualityOf
// documents it). It is good enough to ORDER a funnel — it is not good enough
// to rank the board, which is exactly why stage 2 exists.

import type { Logger } from './logger';
import type { GroupedRow } from './vector-data';
import { getGroupedDaily } from './vector-data';
import { fetchFinvizScreener, FINVIZ_UNIVERSE_FILTERS, type FinvizRow,
  advDollar,} from './finviz';
import { mapWithConcurrency } from './full-scan-iterator';
import {
  fetchIncomeStatementsWithStatus,
  fetchBalanceSheetsWithStatus,
  type MassiveFetchStatus,
} from './massive-fundamentals';
import type { MassiveIncomeStatement, MassiveBalanceSheet } from './schemas';
import { addMonths, ymOf } from './ff-factors';
// The month-end date arithmetic is QS's, imported rather than re-derived: two
// scans that disagree about which session is "the end of June" would produce
// two different momentum numbers for the same stock on the same night.
import {
  lastTradingDateOfMonth,
  recentTradingDates,
  trailingReturnPct,
} from './scan-quiet-strength';
import { percentileRank, type QualityBasis } from './quality-value';
import {
  exclusionReason,
  haircutExcess,
  discoveryVerdict,
  POLICY_VERSION,
} from './research-policy';
import {
  scoreCompounders,
  QUALITY_WEIGHT,
  MOMENTUM_WEIGHT,
  type CompounderInput,
} from './compounders';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Trailing window of the momentum axis, in months. */
export const MOMENTUM_MONTHS = 12;

/**
 * The one-month skip, and it is not optional.
 *
 * A plain trailing-12m return is contaminated by short-term reversal — itself
 * a dead factor at our universe (Jegadeesh 1990, and screener-evidence.md
 * lists it under "do not ship") pointing the OTHER way. Dropping the most
 * recent month is what makes this the 12-1 momentum that replicated across
 * 212 years and 40 countries rather than a number that merely looks like it.
 */
export const MOMENTUM_SKIP_MONTHS = 1;

/** How many names reach the per-ticker statement stage. */
export const DEFAULT_FINALISTS = 250;

/**
 * Below this share of finalists on the exact Novy-Marx basis, the scan scores
 * the whole board on the ROE proxy instead — and says so. See
 * `resolveQualityBasis` for why it is all-or-nothing.
 *
 * The worker re-applies the same fraction to the SCORED names as its
 * partial-status rule. One constant, so the scan's mode switch and the
 * snapshot's honesty check can never drift apart.
 */
export const MIN_EXACT_BASIS_SHARE = 0.6;

/** Quarters summed for the TTM gross-profit numerator. */
export const TTM_QUARTERS = 4;

/**
 * Quarters requested per finalist: the four the TTM window needs plus slack
 * for an amended or duplicated filing. Small on purpose — this multiplies by
 * the finalist count.
 */
export const STATEMENT_QUARTERS = 6;

/** Sessions tried per month-end anchor before the anchor is given up on. */
export const MONTH_END_ATTEMPTS = 3;

/** Stop starting new statement fetches with less than this left. */
export const STAGE2_RESERVE_MS = 45_000;

/**
 * 'largecap' = sp500 ∪ ndx ∪ dji, the same three indices
 * scan-prophet.resolveProphetUniverse means by the word.
 */
export const LARGECAP_FILTERS = [
  FINVIZ_UNIVERSE_FILTERS.sp500,
  FINVIZ_UNIVERSE_FILTERS.ndx,
  FINVIZ_UNIVERSE_FILTERS.dji,
];

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

/**
 * The gross, pre-haircut edge expectation — DELIBERATELY NULL.
 *
 * Both axes are externally replicated, but THIS blend (quality-led,
 * momentum-confirming, no value axis) has never been measured here: no
 * t-statistic, no forward test, nothing run against research-policy's
 * MIN_DISCOVERY_T. Publishing a number would be inventing one.
 *
 * It is kept as a null CONSTANT rather than omitted so that the day someone
 * measures an edge, the figure enters through `haircutExcess` below and the
 * board cannot ship a gross-of-cost number by accident.
 */
export const GROSS_EDGE_PP: readonly [number, number] | null = null;

export interface CompoundersBanner {
  /** Not 'replicated-external': the AXES are, the combination is not. */
  grade: 'axes-replicated-blend-unmeasured';
  /** Haircut edge range, pp/yr. Null until this board is actually measured. */
  netEdgeLowPp: number | null;
  netEdgeHighPp: number | null;
  headline: string;
  /** Rule-3 verdict. Null t renders "NOT MEASURED". */
  discovery: string;
  /** The value-axis departure, carried in the payload rather than in a component. */
  departure: string;
  policyVersion: string;
  sources: string[];
}

/**
 * Build the banner that MUST ride in the snapshot.
 *
 * Same discipline as quiet-strength.buildEvidenceBanner: the evidence grade
 * and the haircut travel with the data, so no UI refactor can drop them.
 */
export function buildCompoundersBanner(): CompoundersBanner {
  const lo = haircutExcess(GROSS_EDGE_PP?.[0] ?? null);
  const hi = haircutExcess(GROSS_EDGE_PP?.[1] ?? null);

  return {
    grade: 'axes-replicated-blend-unmeasured',
    netEdgeLowPp: lo,
    netEdgeHighPp: hi,
    headline:
      lo === null || hi === null
        ? 'UNMEASURED. Both axes replicate externally; this combination of them has ' +
          'never been forward-tested here, so no edge figure is published.'
        : `Expected net edge after haircut ~${lo.toFixed(1)}–${hi.toFixed(1)}pp/yr over SPY.`,
    discovery: discoveryVerdict(null),
    departure:
      'No value axis. The house construction is integrated quality-VALUE; a cheapness ' +
      'axis is precisely what excludes a high-multiple franchise, so it was dropped on ' +
      'purpose and the board is labelled rather than quietly re-weighted.',
    policyVersion: POLICY_VERSION,
    sources: [
      'Novy-Marx (2013) — gross profits / total assets',
      'Hou, Xue & Zhang — operating-profits-to-book-equity fails; assets-denominated survives',
      'Asness et al. (2014) — momentum 12-1, 212 years, 40 countries',
      'Fisher, Shah & Titman (2016) — integrated scoring beats independent sleeves',
    ],
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — the whole universe, on bulk data only
// ---------------------------------------------------------------------------

/** The 12-1 window: [startYm, endYm], with the skipped month named. */
export interface MomentumWindow {
  startYm: number;
  endYm: number;
  /** The month the skip drops. Reported so the payload states its own recipe. */
  skippedYm: number;
}

/**
 * Anchor the window to the last COMPLETE month, then skip it.
 *
 * Anchoring to the current month instead would measure a partial month and
 * change the answer every night of it — the same class of bug as the QS
 * window drift (scan-quiet-strength.ts), where the fetch window and the
 * scoring window were derived separately and disagreed by one month.
 */
export function momentumWindow(now: Date): MomentumWindow {
  const lastComplete = addMonths(ymOf(now), -1);
  const endYm = addMonths(lastComplete, -MOMENTUM_SKIP_MONTHS);
  return {
    // ANCHORED TO t-12, NOT TO t-2. Stepping back MOMENTUM_MONTHS from the
    // SKIPPED month yields the house window — residual-momentum.ts defines
    // 12-1 as WINDOW_START_LAG 12 … WINDOW_END_LAG 2, eleven monthly returns.
    //
    // This previously stepped back from `endYm`, giving a 13-month lookback
    // and twelve returns. It was a real divergence, not a rounding argument:
    // at 2026-08-22 this board scored 202507…202606 while Quiet Strength
    // scored 202507…202605, so two boards in the same app printed a column
    // labelled "12-1" over different windows, and the docstring described the
    // eleven-month statistic the code did not compute.
    startYm: addMonths(lastComplete, -MOMENTUM_MONTHS),
    endYm,
    skippedYm: lastComplete,
  };
}

/**
 * Monthly returns covered by a window — endYm minus startYm, in months.
 *
 * The house 12-1 is ELEVEN returns (residual-momentum.WINDOW_MONTHS: t-12 to
 * t-2), not twelve. Exported so the test can pin it against the shared
 * constant rather than against a literal.
 */
export function windowSpanMonths(w: MomentumWindow): number {
  return (
    (Math.floor(w.endYm / 100) - Math.floor(w.startYm / 100)) * 12 +
    ((w.endYm % 100) - (w.startYm % 100))
  );
}

/**
 * Percentile assumed for a candidate whose provisional input is missing.
 *
 * The MIDDLE, not the floor. At the funnel a missing value is an unknown,
 * not a bad value, and ranking it last would guarantee its statements are
 * never fetched — turning one absent Finviz cell into a permanent exclusion
 * from a board it might well top. The scoring stage is where refusals belong
 * (compounders.scoreCompounders marks such a name unscorable rather than
 * scoring it on half the evidence).
 */
export const UNKNOWN_PROVISIONAL_PCT = 0.5;

/**
 * Order the universe by a provisional score and take the top `take`.
 *
 * Provisional quality is roePct — the leverage-gameable proxy — blended with
 * momentum on the SAME weights the real score uses, so the funnel is at least
 * pointed the way the board is. It is deliberately generous: the default
 * takes roughly half a ~600-name largecap universe, because ROE and gross
 * profitability disagree exactly where leverage differs and a tight funnel
 * would decide the board on the proxy it was built to avoid.
 */
export function selectFinalists(
  candidates: CompounderInput[],
  take: number,
): CompounderInput[] {
  const qualityPcts = percentileRank(candidates.map((c) => c.roePct ?? null), true);
  const momentumPcts = percentileRank(candidates.map((c) => c.momentum12_1Pct ?? null), true);

  const ranked = candidates.map((c, i) => ({
    candidate: c,
    provisional:
      QUALITY_WEIGHT * (qualityPcts[i] ?? UNKNOWN_PROVISIONAL_PCT) +
      MOMENTUM_WEIGHT * (momentumPcts[i] ?? UNKNOWN_PROVISIONAL_PCT),
  }));

  // Ties broken on ticker: an unstable order here would churn which names get
  // statements fetched, and therefore which names can score at all, night to
  // night — for no reason a reader could ever see.
  ranked.sort(
    (a, b) =>
      b.provisional - a.provisional || a.candidate.ticker.localeCompare(b.candidate.ticker),
  );
  return ranked.slice(0, Math.max(0, take)).map((r) => r.candidate);
}

// ---------------------------------------------------------------------------
// Stage 2 — statements for the finalists
// ---------------------------------------------------------------------------

/**
 * TTM gross profit from quarterly income statements (newest first — the
 * endpoint sorts `period_end.desc`).
 *
 * ALL FOUR QUARTERS OR NOTHING. Summing whatever is present produces a
 * half-year "TTM" that is silently half the true numerator, which halves the
 * name's gross profitability and drops it down the board for a data reason
 * the reader would never see. This is the same ok-flag discipline Wave 4C
 * had to retrofit onto ttmEps in data-provider.ts.
 */
export function ttmGrossProfit(rows: MassiveIncomeStatement[]): number | null {
  if (rows.length < TTM_QUARTERS) return null;
  let sum = 0;
  for (const r of rows.slice(0, TTM_QUARTERS)) {
    const v = r.gross_profit;
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    sum += v;
  }
  return sum;
}

/**
 * Total assets from the most recent balance sheet.
 *
 * A stock, not a flow: it is not summed across quarters. Non-positive is
 * refused rather than passed on — grossProfitsToAssets would reject it
 * anyway, and refusing here keeps the reason attributable.
 */
export function latestTotalAssets(rows: MassiveBalanceSheet[]): number | null {
  const v = rows[0]?.total_assets;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** Per-finalist statement outcome. */
export interface StatementEnrichment {
  grossProfit: number | null;
  totalAssets: number | null;
  failed: boolean;
  rateLimited: boolean;
}

/**
 * How the whole board's quality axis will be measured.
 *
 * ALL-OR-NOTHING, AND THIS IS THE LOAD-BEARING DECISION IN THIS FILE.
 *
 * scoreCompounders ranks quality with ONE call to percentileRank over
 * whatever qualityOf returns per name — and qualityOf returns a RATIO
 * (gross profits / assets, ~0.1-0.7) for names with statements and a PERCENT
 * (roePct, ~5-40) for names without. Those are not the same scale. Pooled,
 * every proxy name ranks above every exact name on arithmetic alone: a
 * handful of failed statement fetches would take the top of the board, and
 * nothing in the payload would say why.
 *
 * So the pool is uniform by construction. Exact when the exact basis covers
 * enough of the finalists; otherwise the proxy for everyone, with the loss of
 * measurement stated in `warnings` and visible in `exactBasisCount` — which
 * is what makes the worker's partial-status rule bite.
 */
export function resolveQualityBasis(
  exactCount: number,
  finalistCount: number,
): 'exact' | 'roe-proxy' {
  if (finalistCount <= 0) return 'exact';
  return exactCount / finalistCount >= MIN_EXACT_BASIS_SHARE ? 'exact' : 'roe-proxy';
}

// ---------------------------------------------------------------------------
// Result contract
// ---------------------------------------------------------------------------

export interface CompounderRow {
  rank: number;
  ticker: string;
  sector: string | null;
  /** NAMED `composite` DELIBERATELY — forward-test.extractScore probes
   *  ['composite','percentile','score',...] in that order and takes the
   *  first it finds; anything else logs a null score into the league record
   *  permanently. */
  composite: number;
  qualityPct: number | null;
  momentumPct: number | null;
  grossProfitability: number | null;
  momentum12_1Pct: number | null;
  qualityBasis: QualityBasis;
}

export interface RunCompoundersResult {
  rows: CompounderRow[];
  banner: CompoundersBanner;
  universeSize: number;
  /** The UNIVERSE size — what the publish guard's denominator arms need. */
  universeChecked: number;
  /** How many finalists reached scoreCompounders, kept separate from the above. */
  finalistsScored: number;
  /** How many index legs the universe fetch asked for, and how many answered. */
  universeLegsRequested: number;
  universeLegsAnswered: number;
  scored: number;
  excludedCounts: Record<string, number>;
  unscorableCounts: Record<string, number>;
  exactBasisCount: number;
  /** Which basis the whole board was ranked on — see resolveQualityBasis. */
  qualityBasis: 'exact' | 'roe-proxy';
  finalistCount: number;
  /** Provenance: the payload states the window it was computed over. */
  momentumStartYm: number;
  momentumEndYm: number;
  momentumSkippedYm: number;
  datesFetched: number;
  /** Publish-guard inputs — assessSnapshotPublish's failure-rate arm. */
  statementCalls: number;
  statementErrors: number;
  statementRateLimited: number;
  warnings: string[];
  budgetExceeded: boolean;
  scanDurationMs: number;
}

export interface RunCompoundersOpts {
  now?: Date;
  scanBudgetMs?: number;
  concurrency?: number;
  finalists?: number;
  logger?: Logger;
  // Injected for tests; default to the real providers.
  getUniverse?: () => Promise<
    { rows: FinvizRow[]; legsRequested: number; legsAnswered: number } | FinvizRow[] | null
  >;
  getGrouped?: (date: string) => Promise<GroupedRow[]>;
  getIncome?: (ticker: string) => Promise<MassiveFetchStatus<MassiveIncomeStatement>>;
  getBalance?: (ticker: string) => Promise<MassiveFetchStatus<MassiveBalanceSheet>>;
}

/**
 * The largecap universe, and an honest count of which index legs answered.
 *
 * fetchFinvizScreener RETURNS NULL rather than throwing on an HTTP failure, an
 * empty body, or an expired-token login page. Reporting only the all-three-
 * failed case hid the more likely outage: if the S&P leg dies and the Dow leg
 * answers, the scan ranks 30 names, nothing is empty, no warning fires, and a
 * 30-name board silently replaces a 250-name one as 'complete'. The caller
 * needs to know a leg is missing even when rows came back.
 */
async function defaultUniverse(): Promise<
  { rows: FinvizRow[]; legsRequested: number; legsAnswered: number } | null
> {
  const parts = await Promise.all(
    LARGECAP_FILTERS.map((f) => fetchFinvizScreener([f])),
  );
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
  return {
    rows,
    legsRequested: LARGECAP_FILTERS.length,
    legsAnswered: parts.filter((p) => p !== null).length,
  };
}

/**
 * One month-end anchor's closes, stepping back a session at a time.
 *
 * lastTradingDateOfMonth reads the holiday calendar, which can disagree with
 * the tape (an unscheduled close, or a date the vendor has not published
 * yet). Both anchors feed EVERY name's momentum, so one empty response would
 * cost the entire board its second axis — cheap insurance at one extra call,
 * and only on the days it is needed.
 */
async function fetchAnchorCloses(
  ym: number,
  getGrouped: (date: string) => Promise<GroupedRow[]>,
  log?: Logger,
): Promise<{ ym: number; date: string | null; rows: GroupedRow[] }> {
  const anchor = lastTradingDateOfMonth(ym);
  const attempts = recentTradingDates(
    new Date(`${anchor}T00:00:00Z`),
    MONTH_END_ATTEMPTS,
  ).reverse(); // newest first — the true month end is tried before its predecessors
  for (const date of attempts) {
    try {
      const rows = await getGrouped(date);
      if (rows.length) return { ym, date, rows };
    } catch (err: any) {
      log?.warn?.('grouped_daily_failed', { date, err: String(err?.message ?? err) });
    }
  }
  return { ym, date: null, rows: [] };
}

export async function runCompoundersScan(
  opts: RunCompoundersOpts = {},
): Promise<RunCompoundersResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const budgetMs = opts.scanBudgetMs ?? 11 * 60_000;
  const concurrency = opts.concurrency ?? 8;
  const take = opts.finalists ?? DEFAULT_FINALISTS;
  const log = opts.logger;
  const getUniverse = opts.getUniverse ?? defaultUniverse;
  const getGrouped = opts.getGrouped ?? getGroupedDaily;
  const getIncome =
    opts.getIncome ??
    ((t: string) => fetchIncomeStatementsWithStatus(t, { limit: STATEMENT_QUARTERS }));
  const getBalance =
    opts.getBalance ??
    ((t: string) => fetchBalanceSheetsWithStatus(t, { limit: STATEMENT_QUARTERS }));

  const warnings: string[] = [];
  let budgetExceeded = false;

  // --- Stage 1a: the universe -------------------------------------------
  const fetched = await getUniverse();
  const universe = Array.isArray(fetched) ? fetched : (fetched?.rows ?? []);
  const universeLegsRequested = Array.isArray(fetched)
    ? 1
    : (fetched?.legsRequested ?? LARGECAP_FILTERS.length);
  const universeLegsAnswered = Array.isArray(fetched)
    ? 1
    : (fetched?.legsAnswered ?? 0);
  if (!universe.length) warnings.push('universe fetch returned no rows');
  // A PARTIAL universe is the dangerous case, not the empty one: rows come
  // back, nothing looks broken, and a third of the intended board silently
  // becomes the whole board. Say so loudly enough that the worker can refuse.
  else if (universeLegsAnswered < universeLegsRequested) {
    warnings.push(
      `universe incomplete: ${universeLegsAnswered}/${universeLegsRequested} index legs answered ` +
        `(${universe.length} names) — ranking a partial universe`,
    );
  }

  // --- Stage 1b: momentum, from two whole-tape snapshots ------------------
  const window = momentumWindow(now);
  const anchors = await Promise.all(
    [window.startYm, window.endYm].map((ym) => fetchAnchorCloses(ym, getGrouped, log)),
  );
  for (const a of anchors) {
    if (!a.date) warnings.push(`month-end closes for ${a.ym} unavailable — momentum unscorable`);
  }

  const closesByTicker = new Map<string, Map<number, number>>();
  for (const a of anchors) {
    for (const r of a.rows) {
      if (typeof r?.T !== 'string' || !(r.c > 0)) continue;
      let byYm = closesByTicker.get(r.T);
      if (!byYm) {
        byYm = new Map<number, number>();
        closesByTicker.set(r.T, byYm);
      }
      byYm.set(a.ym, r.c);
    }
  }

  // --- Stage 1c: candidates + the universe policy -------------------------
  const excludedCounts: Record<string, number> = {
    microcap: 0, illiquid: 0, 'price-floor': 0, 'no-data': 0,
  };
  const eligible: CompounderInput[] = [];
  for (const u of universe) {
    const ticker = u.ticker?.toUpperCase();
    if (!ticker) continue;
    const closes = closesByTicker.get(ticker);
    const candidate: CompounderInput = {
      ticker,
      sector: u.sector ?? null,
      industry: u.industry ?? null,
      marketCapM: u.marketCapM ?? null,
      // Average dollar volume stands in for the median. Via advDollar() so the
      // thousands-of-shares conversion lives in one place: open-coding
      // `avgVolume * price` here (copying finviz-row.ts, which had the same
      // bug) made the $3M liquidity floor behave like a $3B one and threw out
      // 487 of 518 large caps, KO and JNJ included, on the first live run.
      // The alternative — a 126-session daily window, as QS fetches — is ~126
      // calls to reject names a largecap universe does not contain.
      medianDollarVol: advDollar(u.avgVolume, u.price),
      price: u.price ?? null,
      roePct: u.roePct ?? null,
      // SPAN COMES FROM THE WINDOW, NOT FROM A SECOND CONSTANT.
      // trailingReturnPct derives its start as endYm - months, so passing
      // MOMENTUM_MONTHS here asked for a month the anchors never fetched the
      // moment the window was corrected to the house t-12..t-2 span — every
      // name silently scored momentum null. Deriving the span from the same
      // object that chose the anchors makes that divergence unrepresentable.
      momentum12_1Pct: closes
        ? trailingReturnPct(closes, window.endYm, windowSpanMonths(window))
        : null,
    };

    // Applied HERE, before the funnel, because an illiquid or sub-$5 name
    // that cannot be in the board must not consume two statement calls that
    // a rankable name needs. scoreCompounders re-applies the same policy —
    // this is a budget filter, not a second definition of the universe.
    const reason = exclusionReason(candidate);
    if (reason) {
      excludedCounts[reason] += 1;
      continue;
    }
    eligible.push(candidate);
  }

  const finalists = selectFinalists(eligible, take);
  log?.info?.('compounders_stage1_done', {
    universeSize: universe.length,
    eligible: eligible.length,
    finalists: finalists.length,
    elapsedMs: Date.now() - started,
  });

  // --- Stage 2: statements for the finalists ------------------------------
  const enriched = new Map<string, StatementEnrichment>();
  let statementCalls = 0;
  let statementErrors = 0;
  let statementRateLimited = 0;
  const budgetLeft = () => budgetMs - (Date.now() - started);

  await mapWithConcurrency(
    finalists.map((f) => f.ticker),
    async (ticker) => {
      if (budgetLeft() < STAGE2_RESERVE_MS) {
        budgetExceeded = true;
        return;
      }
      // Counted BEFORE the await: a pair that throws is still two calls the
      // publish guard's failure-rate arm has to see, and an error counted
      // against a smaller denominator understates exactly the run that is
      // going wrong.
      statementCalls += 2;
      const [income, balance] = await Promise.all([getIncome(ticker), getBalance(ticker)]);
      for (const r of [income, balance]) {
        if (r.errorMessage) statementErrors += 1;
        if (r.rateLimited || r.rateLimitExhausted) statementRateLimited += 1;
      }
      enriched.set(ticker, {
        grossProfit: ttmGrossProfit(income.data),
        totalAssets: latestTotalAssets(balance.data),
        failed: Boolean(income.errorMessage || balance.errorMessage),
        rateLimited: Boolean(
          income.rateLimitExhausted || balance.rateLimitExhausted,
        ),
      });
    },
    {
      batchSize: concurrency,
      // Checked once per batch — the per-ticker guard above is what stops the
      // work; this stops the loop from walking the remaining hundreds of
      // names to do nothing.
      shouldAbort: () => {
        if (budgetLeft() >= STAGE2_RESERVE_MS) return false;
        budgetExceeded = true;
        return true;
      },
      onError: (err, ticker) => {
        statementErrors += 1;
        log?.warn?.('statements_failed', { ticker, err: String((err as any)?.message ?? err) });
      },
    },
  );

  if (budgetExceeded) {
    warnings.push(
      `scan budget exceeded — statements for ${enriched.size}/${finalists.length} finalists`,
    );
  }

  const exactCount = [...enriched.values()].filter(
    (e) => e.grossProfit !== null && e.totalAssets !== null,
  ).length;
  const qualityBasis = resolveQualityBasis(exactCount, finalists.length);
  if (qualityBasis === 'roe-proxy') {
    warnings.push(
      `exact gross-profits-to-assets basis on only ${exactCount}/${finalists.length} finalists ` +
        `(< ${(MIN_EXACT_BASIS_SHARE * 100).toFixed(0)}%) — whole board scored on the ROE proxy`,
    );
  } else if (exactCount < finalists.length) {
    warnings.push(
      `${finalists.length - exactCount} finalists had no usable statements and are unscorable`,
    );
  }

  // --- Score --------------------------------------------------------------
  //
  // One basis for the whole pool. See resolveQualityBasis: mixing a ratio
  // and a percent in one percentile ranking is not a degraded measurement,
  // it is a wrong one.
  const inputs: CompounderInput[] = finalists.map((c) => {
    const e = enriched.get(c.ticker);
    return qualityBasis === 'exact'
      ? { ...c, grossProfit: e?.grossProfit ?? null, totalAssets: e?.totalAssets ?? null, roePct: null }
      : { ...c, grossProfit: null, totalAssets: null };
  });

  const result = scoreCompounders(inputs);
  for (const [reason, n] of Object.entries(result.excluded)) {
    excludedCounts[reason] = (excludedCounts[reason] ?? 0) + n;
  }

  const rows: CompounderRow[] = result.scored
    .filter((s) => s.composite !== null)
    .map((s, i) => ({
      rank: i + 1,
      ticker: s.ticker,
      sector: s.sector,
      composite: s.composite as number,
      qualityPct: s.qualityPct,
      momentumPct: s.momentumPct,
      grossProfitability: s.grossProfitability,
      momentum12_1Pct: s.momentum12_1Pct,
      qualityBasis: s.qualityBasis,
    }));

  return {
    rows,
    banner: buildCompoundersBanner(),
    universeSize: universe.length,
    // The UNIVERSE, not the finalists. assessSnapshotPublish gates its arms on
    // this being >= 100; passing the finalist count meant a total universe
    // outage arrived at the guard as universeChecked 0, missed every arm, and
    // was cleared to overwrite a good snapshot with an empty one.
    universeChecked: universe.length,
    finalistsScored: result.universeChecked,
    universeLegsRequested,
    universeLegsAnswered,
    scored: rows.length,
    excludedCounts,
    unscorableCounts: result.unscorable as unknown as Record<string, number>,
    exactBasisCount: result.exactBasisCount,
    qualityBasis,
    finalistCount: finalists.length,
    momentumStartYm: window.startYm,
    momentumEndYm: window.endYm,
    momentumSkippedYm: window.skippedYm,
    datesFetched: anchors.filter((a) => a.date !== null).length,
    statementCalls,
    statementErrors,
    statementRateLimited,
    warnings,
    budgetExceeded,
    scanDurationMs: Date.now() - started,
  };
}
