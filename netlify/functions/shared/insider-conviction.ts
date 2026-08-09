// P1-S2 (2026-08-09) — insider CONVICTION: opportunistic Form 4 clusters.
//
// The existing `insider` board measures insider activity in aggregate. This
// module measures something narrower and better evidenced: clusters of
// OPPORTUNISTIC open-market buying.
//
// THE FILTER IS THE WHOLE SIGNAL. Cohen, Malloy & Pomorski split insider
// buys into ROUTINE (the same person buying the same month every year — a
// compensation or diversification habit) and OPPORTUNISTIC (everything
// else), and the split is the difference between a signal and noise:
//
//     routine        +14bp   t = 0.81   — indistinguishable from zero
//     opportunistic  +90bp   t = 4.64
//
// An unfiltered insider-buy screen averages those two together and reports
// the blend as if it were the second number. So the routine-buyer filter is
// not a refinement of this board; it is the reason the board exists.
//
// WHAT IS A GATE AND WHAT IS A BOOST — deliberately separated. The cluster
// definition (two distinct buyers, ten days, $200K) and the routine filter
// are GATES, because they are what the evidence is about. Seniority, size
// relative to holdings, prior weakness and a concurrent buyback are BOOSTS
// that reorder what already qualified; none of them may admit a name that
// failed a gate, because none of them has the replication record the gate
// has. A boost promoted to a gate is a new, untested screen wearing this
// one's evidence.

import type { InsiderTransaction } from './insider-provider';

// --- gates -----------------------------------------------------------------

/** Distinct insiders required inside the window. */
export const MIN_BUYERS = 2;
/** Calendar days the cluster may span. */
export const CLUSTER_WINDOW_DAYS = 10;
/** Minimum aggregate cluster size, USD. */
export const MIN_CLUSTER_DOLLARS = 200_000;
/** Consecutive prior years of same-month buying that marks a buyer routine. */
export const ROUTINE_LOOKBACK_YEARS = 3;

/**
 * Open-market purchase. Form 4 code 'P' only.
 *
 * 'A' (award/grant) is not a purchase — nobody chose to pay. 'M' (option
 * exercise) and 'F' (shares withheld for tax) are mechanical. Including any
 * of them turns a conviction screen into a compensation-calendar screen,
 * which is the routine half of the CMP split by another route.
 */
export const OPEN_MARKET_CODE = 'P';

const dayMs = 86_400_000;
const dnum = (d: string) => Date.parse(`${d}T00:00:00Z`);
const daysApart = (a: string, b: string) => Math.abs(dnum(a) - dnum(b)) / dayMs;
const monthOf = (d: string) => Number(d.slice(5, 7));
const yearOf = (d: string) => Number(d.slice(0, 4));

export const dollarsOf = (t: InsiderTransaction): number => {
  const shares = Math.abs(Number(t.share));
  const px = Number(t.transactionPrice);
  if (!Number.isFinite(shares) || !Number.isFinite(px) || px <= 0) return 0;
  return shares * px;
};

/** Open-market buys only, ignoring anything unparseable. */
export function openMarketBuys(txns: InsiderTransaction[]): InsiderTransaction[] {
  return txns.filter(
    (t) =>
      t?.transactionCode === OPEN_MARKET_CODE &&
      Number(t.share) > 0 &&
      typeof t.transactionDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(t.transactionDate) &&
      dollarsOf(t) > 0,
  );
}

/**
 * Cohen-Malloy-Pomorski: is this buyer's purchase a habit?
 *
 * Routine ⇔ the same insider also bought in the SAME CALENDAR MONTH in EACH
 * of the prior `ROUTINE_LOOKBACK_YEARS` years. All three, not any — a buyer
 * who happened to buy in March twice is not yet exhibiting a schedule, and
 * treating them as routine would throw away real signal to look strict.
 *
 * `history` should be the buyer's full available purchase history, which
 * means the caller needs a lookback well beyond the trading window: with
 * three years of prior Marches to check, a 180-day history can never mark
 * ANYONE routine and the filter silently passes everything through. That
 * failure mode is invisible — the board simply looks like it has more
 * candidates — so `routineVerdict` reports coverage rather than a bare bool.
 */
export interface RoutineVerdict {
  routine: boolean;
  /** Prior years in which a same-month buy was found. */
  matchedYears: number[];
  /** Whether history reaches back far enough to answer at all. */
  decidable: boolean;
}

export function routineVerdict(
  buy: InsiderTransaction,
  history: InsiderTransaction[],
  lookbackYears = ROUTINE_LOOKBACK_YEARS,
): RoutineVerdict {
  const m = monthOf(buy.transactionDate);
  const y = yearOf(buy.transactionDate);
  const mine = openMarketBuys(history).filter((t) => t.name === buy.name);

  const earliest = mine.reduce<string | null>(
    (acc, t) => (acc === null || t.transactionDate < acc ? t.transactionDate : acc),
    null,
  );
  const needFrom = `${y - lookbackYears}-01-01`;
  const decidable = earliest !== null && earliest <= needFrom;

  const matchedYears: number[] = [];
  for (let k = 1; k <= lookbackYears; k++) {
    const target = y - k;
    if (mine.some((t) => yearOf(t.transactionDate) === target && monthOf(t.transactionDate) === m)) {
      matchedYears.push(target);
    }
  }

  return { routine: matchedYears.length === lookbackYears, matchedYears, decidable };
}

// --- clustering ------------------------------------------------------------

export interface ConvictionCluster {
  windowStart: string;
  windowEnd: string;
  buyers: string[];
  buyerCount: number;
  dollars: number;
  /** Latest filing date in the cluster — the earliest we could have acted. */
  lastFilingDate: string;
  droppedRoutineBuyers: string[];
  undecidableBuyers: string[];
}

export interface FindClustersOpts {
  /** Full purchase history, for the routine test. */
  history?: InsiderTransaction[];
  minBuyers?: number;
  windowDays?: number;
  minDollars?: number;
}

/**
 * Find the strongest qualifying cluster of opportunistic buying.
 *
 * Routine buyers are removed BEFORE the gates are applied, not after. Two
 * insiders where one is routine is a one-insider event, and the order
 * matters: filtering afterwards would let a habitual buyer supply the second
 * body that makes a single discretionary purchase look like a cluster.
 */
export function findConvictionClusters(
  txns: InsiderTransaction[],
  opts: FindClustersOpts = {},
): ConvictionCluster[] {
  const minBuyers = opts.minBuyers ?? MIN_BUYERS;
  const windowDays = opts.windowDays ?? CLUSTER_WINDOW_DAYS;
  const minDollars = opts.minDollars ?? MIN_CLUSTER_DOLLARS;
  const history = opts.history ?? txns;

  const buys = openMarketBuys(txns).sort((a, b) =>
    a.transactionDate.localeCompare(b.transactionDate),
  );

  const droppedRoutine = new Set<string>();
  const undecidable = new Set<string>();
  const kept: InsiderTransaction[] = [];
  for (const b of buys) {
    const v = routineVerdict(b, history);
    if (v.routine) { droppedRoutine.add(b.name); continue; }
    if (!v.decidable) undecidable.add(b.name);
    kept.push(b);
  }

  const out: ConvictionCluster[] = [];
  for (let i = 0; i < kept.length; i++) {
    const anchor = kept[i];
    const inWindow = kept.filter(
      (t) =>
        t.transactionDate >= anchor.transactionDate &&
        daysApart(anchor.transactionDate, t.transactionDate) <= windowDays,
    );
    const buyers = [...new Set(inWindow.map((t) => t.name))];
    if (buyers.length < minBuyers) continue;
    const dollars = inWindow.reduce((s, t) => s + dollarsOf(t), 0);
    if (dollars < minDollars) continue;

    out.push({
      windowStart: anchor.transactionDate,
      windowEnd: inWindow[inWindow.length - 1].transactionDate,
      buyers,
      buyerCount: buyers.length,
      dollars,
      lastFilingDate: inWindow.reduce(
        (a, t) => (t.filingDate > a ? t.filingDate : a),
        inWindow[0].filingDate ?? anchor.transactionDate,
      ),
      droppedRoutineBuyers: [...droppedRoutine],
      undecidableBuyers: [...undecidable],
    });
  }

  // Strongest first: dollars, then breadth. Overlapping windows are kept —
  // de-duplicating them would hide a second, larger cluster inside a run.
  out.sort((a, b) => b.dollars - a.dollars || b.buyerCount - a.buyerCount);
  return out;
}

// --- boosts ----------------------------------------------------------------

export interface BoostContext {
  /** Roles of the cluster's buyers, e.g. ['CFO', 'Director']. */
  roles?: string[];
  /** Largest single buy as a fraction of that insider's prior holdings. */
  maxBuyFractionOfHoldings?: number | null;
  /** Trailing 12-month total return, percent. */
  trailing12mPct?: number | null;
  /** Median trailing 12-month return of the universe, percent. */
  universeMedian12mPct?: number | null;
  /** Concurrent buyback authorisation as a fraction of shares outstanding. */
  buybackAuthFraction?: number | null;
}

export interface ConvictionScore {
  /**
   * 0..MAX_SCORE. Named `score` because forward-test.extractScore probes a
   * closed list of keys and takes the first it finds; anything else leaves
   * scoreAtEntry null on every logged pick, permanently.
   */
  score: number;
  base: number;
  boosts: Array<{ name: string; points: number }>;
}

export const BOOST_POINTS = {
  cfo: 8,
  bigRelativeBuy: 8,
  priorWeakness: 6,
  buyback: 5,
} as const;

/** Breadth and size each saturate at 30. */
export const MAX_BREADTH = 30;
export const MAX_SIZE = 30;

/**
 * The real ceiling, DERIVED rather than declared.
 *
 * An earlier draft clamped to 100 and documented the scale as 0-100, but the
 * components top out at 30 + 30 + 27 = 87, so the last 13 points were
 * unreachable. That matters because these scores sit next to other boards'
 * percentiles in the same UI: a number that can never exceed 87 reads as a
 * permanently mediocre 87/100 rather than as a maximum. Deriving the ceiling
 * from the constants means adding or reweighting a boost moves it
 * automatically instead of silently re-opening the same gap.
 */
export const MAX_SCORE =
  MAX_BREADTH + MAX_SIZE + Object.values(BOOST_POINTS).reduce((s, p) => s + p, 0);

/**
 * Score a qualifying cluster.
 *
 * The base is the evidenced part — breadth and size — and boosts only
 * reorder. Capped at 100, and no boost can rescue a cluster that never
 * qualified, because a non-qualifying cluster is never passed here.
 */
export function scoreCluster(cluster: ConvictionCluster, ctx: BoostContext = {}): ConvictionScore {
  // Breadth saturates: the third and fourth buyer say much less than the
  // second, and without saturation a single wide board sweep would dominate
  // the whole screen.
  const breadth = Math.min(MAX_BREADTH, (cluster.buyerCount - MIN_BUYERS + 1) * 12);
  // Size on a log scale — $2M is meaningfully more than $200K, $20M is not
  // ten times more informative than $2M.
  const size = Math.min(
    MAX_SIZE,
    Math.max(0, Math.log10(cluster.dollars / MIN_CLUSTER_DOLLARS) * 18),
  );
  const base = Math.round(breadth + size);

  const boosts: Array<{ name: string; points: number }> = [];
  const roles = (ctx.roles ?? []).map((r) => r.toUpperCase());
  if (roles.some((r) => r.includes('CFO') || r.includes('CHIEF FINANCIAL'))) {
    boosts.push({ name: 'cfo-buying', points: BOOST_POINTS.cfo });
  }
  if ((ctx.maxBuyFractionOfHoldings ?? 0) >= 0.10) {
    boosts.push({ name: 'buy>=10%-of-holdings', points: BOOST_POINTS.bigRelativeBuy });
  }
  if (
    typeof ctx.trailing12mPct === 'number' &&
    typeof ctx.universeMedian12mPct === 'number' &&
    ctx.trailing12mPct < ctx.universeMedian12mPct
  ) {
    boosts.push({ name: 'bottom-half-12m', points: BOOST_POINTS.priorWeakness });
  }
  if ((ctx.buybackAuthFraction ?? 0) >= 0.05) {
    boosts.push({ name: 'buyback>=5%', points: BOOST_POINTS.buyback });
  }

  const score = Math.min(MAX_SCORE, base + boosts.reduce((s, b) => s + b.points, 0));
  return { score, base, boosts };
}
