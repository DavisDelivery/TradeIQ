// TREND DETECT — the DETECT step. Trend-first, not ticker-first.
//
// ===========================================================================
// WHAT THIS IS FOR
//
// The social-arbitrage workflow is five steps: DETECT a spike, VALIDATE it
// across independent sources, LINK it to an issuer, take a position, watch
// SATURATION. Everything shipped before this file served steps 3-5.
//
//   `camillo-undiscovered` (shared/finviz-screens.ts) filters the universe by
//   STRUCTURE — small float, low institutional ownership, some sales growth.
//   Those are PRECONDITIONS. A name passes it whether or not anything is
//   happening.
//
//   `camillo-research` reads ONE ticker you already chose.
//
// Neither can answer "what changed this week", and that gap is real IN THE
// APP. It is not true that the step "was never built": `paper/` is a complete
// Python social-arbitrage scanner — consumer velocity, convergence, investor
// saturation — and it is the code that produced the study cited below. What
// was missing is a production surface. Worth knowing, because that scanner's
// composite nets saturation against signal
// (`SAS = ... - 0.65*investor_total`), which is precisely the move this
// module refuses to make.
//
// ===========================================================================
// THE THREE LINES THIS DOES NOT CROSS
//
// 1. IT DOES NOT RANK.
//
//    `reports/trend/social-arb-study.md` closes with a PRE-COMMITTED GATE,
//    written before this was built and binding on it:
//
//      "Do not add a ranked or scored version of this board without, in
//       order: 1. 6-12 months of timestamped forward paper signals with a
//       random control cohort drawn from the same universe, showing the
//       signal beats the control. 2. A point-in-time universe on which the
//       placebo-adjusted 12w excess is positive with a ticker-clustered
//       t > 2."
//
//    The gate says RANKED **or** scored. "It emits a count, not a score" does
//    not clear it — sorting names by that count is a ranked board with the
//    ranking key renamed. So the output of this module is ordered
//    ALPHABETICALLY and by nothing else. Every measurement travels with each
//    row and the client sorts; what is refused is a SHIPPED ordering that
//    reads as "these are the good ones".
//
//    That is not pedantry about a document. The same study already measured
//    "convergence — count of independent consumer sources confirming" as one
//    of its three legs, and the whole construct failed its placebo test.
//    Convergence is not the untested honest core; it is one of the things
//    that was tested and did not survive.
//
// 2. IT DOES NOT PRETEND THE SOURCES SHARE A CLOCK.
//
//    Each source is measured over its own window and REPORTS that window in
//    its own row. The two convergence legs are aligned on 7-vs-28 for exactly
//    this reason; the off-exchange gauge is fixed at 5d-vs-60d upstream in
//    `quiver-offexchange.ts` and prints that, rather than being quietly
//    described as though it shared the others' clock. Measurements taken over
//    different lookbacks have not "agreed about an event".
//
// 3. IT RECORDS A CONTROL COHORT, EVERY TIME IT RUNS.
//
//    The gate's first clause needs timestamped forward signals AND a random
//    control drawn from the same universe. A control cohort that gets
//    invented later, once the results are known, is worthless. So every scan
//    emits one: a seeded, reproducible random draw of the same size from the
//    same scanned universe, excluding the flagged names. It costs almost
//    nothing and it is the only reason the NO_EDGE verdict is falsifiable
//    rather than permanent.
//
// ===========================================================================
// WHY 7-vs-28 AND NOT THE 28-vs-28 THE PAGEVIEW MODULE ALREADY HAS
//
// `trend-exposure.ts` exports `mom()` — mean of the trailing 28 days over the
// mean of the 28 before that. That is the right statistic for the question
// that module asks ("is this name structurally more looked-at than it was"),
// and the wrong one here, because a 28-day mean cannot move quickly.
//
// Measured against live Wikimedia pageviews, 32 real attention onsets across
// 8 consumer names (onset := a 5-day stretch averaging >=1.5x the prior 28d):
//
//   28d-vs-prior-28d >= 25%   fired on 22 of 32 onsets (10 NEVER fired),
//                             median lag ~8 days, worst 40 days
//   7d-vs-prior-28d  >= 25%   fired on 32 of 32, lag 0-4 days, median 3-4
//
// Crocs' August-2025 shift is the clean case: the 28/28 statistic never
// crosses 25% at all; 7/28 catches it on day 3. A detector whose own
// arithmetic is a week-to-never behind cannot serve a step called DETECT.

import { fetchOffExchange } from './quiver-offexchange';
import { fetchPageviews, resolveArticle } from './trend-exposure';
import {
  readAppRatingHistory, readMentionHistory, readTicker,
  type AppRatingDay, type MentionSnapshot,
} from './social-mentions';
import { enrichTickerNames } from './ticker-reference';
import { logger } from './logger';

const log = logger.child({ mod: 'trend-detect' });

// ---------------------------------------------------------------------------
// Constants — all explicit, all arguable, none fitted to anything
// ---------------------------------------------------------------------------

/** The window this detector asks its question over, where it gets a choice. */
export const WINDOW = { recentDays: 7, baseDays: 28 } as const;

/** Days of pageview history to pull. recentDays + baseDays + slack for gaps. */
export const PAGEVIEW_DAYS = 90;

/** Minimum recorded days before the mention leg will compute anything. */
export const MIN_MENTION_HISTORY_DAYS = WINDOW.recentDays + WINDOW.baseDays;

/**
 * App ratings need ONE MORE DAY than the mention leg.
 *
 * Apple reports a LIFETIME CUMULATIVE rating count, so the series has to be
 * first-differenced into "new ratings that day" before it means anything —
 * and N differences need N+1 observations. Comparing the cumulative levels
 * directly is the trap: a big app's count barely moves week to week, so the
 * leg would report ~0% growth forever and look like a dead feed rather than a
 * quiet one.
 */
export const MIN_APP_HISTORY_DAYS = WINDOW.recentDays + WINDOW.baseDays + 1;

/**
 * A source has to clear this to be reported as "moved". NOT fitted — chosen
 * to be obviously material, and stated as constants so a reader can disagree
 * with the numbers rather than with the code.
 */
export const THRESHOLDS = {
  /** Wikipedia pageviews, 7d mean vs prior 28d mean. */
  wikiSpikePct: 25,
  /** Recorded retail mentions, 7d mean vs prior 28d mean. */
  mentionSpikePct: 100,
  /**
   * NEW app ratings per day, 7d mean vs prior 28d mean.
   *
   * Lower bar than chatter (100%) on purpose: forum mentions are spiky and
   * routinely double on noise, whereas the number of people who open an app
   * and tap a star is a slow, high-inertia quantity. A sustained 40% lift in
   * daily new ratings is a much larger real-world event than a doubling of
   * WSB posts, and holding both to the same number would have meant only ever
   * seeing the app leg during an outright mania.
   */
  appRatingSpikePct: 40,
} as const;

/**
 * Below this many daily pageviews the baseline is too thin to take a
 * percentage of: 3 views/day going to 5 is +67% and means nothing. This
 * threshold is also what catches a MIS-RESOLVED article — the recurring
 * failure is not a wrong-looking title, it is a plausible title with 20
 * views a day where the real company page has 400.
 */
export const MIN_BASELINE_VIEWS = 30;

/** Crowding, reported alongside and never subtracted from anything. */
export const SATURATION = {
  /** Retail-forum rank inside the tracked list. Lower rank = louder. */
  loudRank: 150,
  instOwnPct: 70,
  /**
   * Off-exchange volume vs its own 60d baseline, in sd. A POSITIVE reading is
   * crowding, not signal — see the `DetectSource` note. Its window is fixed
   * upstream in `quiver-offexchange.ts` and is not this detector's window.
   */
  offExchangeZ: 1.0,
} as const;

/**
 * MEASURED false-positive rate for the wikipedia leg.
 *
 * Not a guess and not from a paper — measured on 2026-08-07 against live
 * Wikimedia data: 25 of the scanned consumer names, ~544 daily observations
 * each (2025-01 to 2026-08), 8,741 name-days in total. On 7.3% of those
 * name-days the leg fires with no event of any kind specified. Both the mean
 * and the median statistic give the same 7.3%.
 *
 * WHY THIS HAS TO BE IN THE PAYLOAD: 7.3% across 40 names is ~2.9 wikipedia
 * hits per scan BY CHANCE. The live board on the day this was measured
 * returned exactly 3 candidates, every one of them flagged by wikipedia alone.
 * That result is statistically indistinguishable from noise, and a candidate
 * generator that prints three names without saying so is overstating itself
 * even though every individual number on the row is true.
 *
 * Re-measure if the threshold, the window or the universe changes — all three
 * move this number.
 */
export const MEASURED_FALSE_POSITIVE_RATE = {
  wikipedia: 0.073,
  /** No history recorded yet, so no honest figure exists for these two. */
  mentions: null as number | null,
  appRatings: null as number | null,
  measuredOn: '2026-08-07',
  basis: '25 names x ~544 days = 8,741 name-days of live Wikimedia pageviews',
} as const;

/**
 * How many names this scan would expect to flag by chance alone.
 *
 * Only the legs with a MEASURED rate contribute; an unmeasured leg is left out
 * rather than assigned a plausible-looking number, so the figure is a floor
 * and says so.
 */
export function expectedByChance(universeSize: number): {
  wikipedia: number;
  totalMeasured: number;
  unmeasuredLegs: string[];
  note: string;
} {
  const wiki = universeSize * MEASURED_FALSE_POSITIVE_RATE.wikipedia;
  const unmeasured = ['mentions', 'appRatings'];
  return {
    wikipedia: Math.round(wiki * 10) / 10,
    totalMeasured: Math.round(wiki * 10) / 10,
    unmeasuredLegs: unmeasured,
    note:
      `Across ${universeSize} names, roughly ${wiki.toFixed(1)} wikipedia hits are expected by CHANCE — ` +
      'measured, not assumed. Compare that number with how many candidates came back before reading any ' +
      'of them as a finding: a board returning about this many names has told you nothing. The mention and ' +
      'app-rating legs have no recorded history yet, so this is a FLOOR on the expected false positives, ' +
      'not the whole of it.',
  };
}

export const DETECT_CAVEAT =
  'A CANDIDATE GENERATOR, not a signal, and deliberately NOT RANKED. Rows are ordered alphabetically; ' +
  'every measurement is attached so you can sort them yourself. This system measured NO_EDGE on the ' +
  'attention leg (reports/trend/social-arb-study.md) and that finding stands — the study\'s own ' +
  'pre-committed gate forbids shipping a ranked or scored version of this until 6-12 months of forward ' +
  'paper signals beat a random control cohort. Each source is measured over its OWN window, printed on ' +
  'each row: sources measured over different lookbacks have not "agreed about an event". Saturation is ' +
  'reported separately and never netted against anything. Nothing here says a stock will move.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The sources that can count toward convergence.
 *
 * OFF-EXCHANGE VOLUME IS NOT ONE OF THEM, and that is a correction rather
 * than an omission. This app's own Camillo doctrine — the system prompt in
 * `shared/camillo-research.ts` — reads:
 *
 *   "Off-exchange volume against its own baseline is a RETAIL-crowding gauge:
 *    a positive z means the crowd is already here, which argues AGAINST an
 *    undiscovered setup."
 *
 * Counting that same measurement as evidence FOR a candidate would have put
 * two endpoints in this one app on opposite sides of the same number:
 * `/api/camillo-research` calling a +1.8sd reading a discovery warning while
 * `/api/trend-scanner` called it a reason to look. It moves to `saturation`,
 * where the doctrine already puts it.
 *
 * The honest cost: that leaves TWO convergence sources, and the mention leg
 * is UNCHECKED until the daily snapshot accumulates 35 days. App review
 * velocity — a "what consumers DO" flow, the class the study found does not
 * reverse — is the next leg and the one that restores a second live source.
 */
export type DetectSource = 'wikipedia' | 'mentions' | 'appRatings';

export interface SourceObservation {
  source: DetectSource;
  /**
   * Measured change. Units differ per source and are NEVER summed.
   *
   * Null means EITHER unmeasured OR unbounded — read `checked` and
   * `unbounded` to tell those apart, never `value === null` alone.
   */
  value: number | null;
  /**
   * The baseline was zero and the recent window was not: the percentage is
   * unbounded, so no number is printed.
   *
   * This is not an edge case to tidy away, it is the loudest event the tool
   * can see — a name going from zero recorded mentions to forty. `Infinity`
   * cannot be carried here because `JSON.stringify(Infinity)` is `null`, and
   * a null would land downstream as "no data", silently dropping the single
   * most interesting observation on the floor.
   */
  unbounded: boolean;
  unit: string;
  /** The lookback this number was actually measured over. Printed, not assumed. */
  window: string;
  /** We obtained a usable measurement. `sourcesAvailable` counts these. */
  checked: boolean;
  /** True when the measurement cleared this source's threshold, upward. */
  moved: boolean;
  /** Why it could not be judged, when it could not. */
  reason: string | null;
}

export interface TrendCandidate {
  ticker: string;
  companyName: string | null;
  /**
   * Independent sources that moved UP, 0-2. A COUNT, reported for filtering.
   * It is NOT the sort key and must not become one — see the header.
   */
  convergence: number;
  /** Sources that could actually be checked. `convergence` is out of THIS. */
  sourcesAvailable: number;
  observations: SourceObservation[];
  /** Crowding, reported alongside and never netted against convergence. */
  saturation: {
    mentionRank: number | null;
    mentionState: 'TRACKED' | 'BELOW_FLOOR' | 'UNAVAILABLE';
    /** Retail participation vs the name's OWN 60d baseline, in sd. A
     *  positive reading is crowding, not signal. */
    offExchangeZ: number | null;
    crowded: boolean;
    /** Which gauges fired, so `crowded` is never a bare assertion. */
    reasons: string[];
    note: string;
  };
  /** Columns a trader needs before a name is actionable. Never scored. */
  context: {
    marketCapM: number | null;
    price: number | null;
    perfWeekPct: number | null;
    perfMonthPct: number | null;
    avgVolume: number | null;
    shortFloatPct: number | null;
    instOwnPct: number | null;
    earningsDate: string | null;
  };
}

/** The forward-test record. Written the day it happens and never edited. */
export interface PaperTrail {
  date: string;
  /** Reproducible: same date + same universe re-draws the same control. */
  seed: string;
  candidates: string[];
  control: string[];
  universeScanned: string[];
}

export interface TrendDetectResult {
  asOf: string;
  universeChecked: number;
  /** ALPHABETICAL. Not a ranking. */
  candidates: TrendCandidate[];
  order: string;
  paperTrail: PaperTrail;
  mentionHistory: { daysRecorded: number; daysRequired: number; usable: boolean };
  appRatingHistory: { daysRecorded: number; daysRequired: number; usable: boolean };
  /** How many of these names you would expect by chance. Measured. */
  falsePositives: ReturnType<typeof expectedByChance>;
  /** Sources that failed wholesale, so a thin result is explainable. */
  degraded: string[];
  caveat: string;
}

// ---------------------------------------------------------------------------
// Pure statistics
// ---------------------------------------------------------------------------

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Median. The detector's windows are compared on this, NOT on the mean, and
 * the reason is measured rather than stylistic.
 *
 * Audited against the live board on 2026-08-07. Of the three candidates it was
 * returning, TWO were produced by a single day:
 *
 *   URBN  last 7 days [187,182,178,229,222,900,264] vs a 185/day baseline.
 *         One 900-view day — 4.9x baseline — drags the 7-day MEAN to 309 and
 *         reports +67%. Drop that one day and the week is +13%, under the bar.
 *   EAT   last 7 days [154,200,268,246,180,167,175] vs 145/day. Elevated on
 *         every single day of the week.
 *
 * On the median URBN reads +19% and drops out; EAT reads +29% and stays. That
 * is exactly the discrimination this tool needs, because a one-day Wikipedia
 * spike is a headline, a bot or a link from somewhere — and the thesis being
 * screened for is a SUSTAINED change in consumer behaviour, which is a
 * different object entirely.
 *
 * HONEST LIMIT: swapping to the median does NOT reduce how often the leg
 * fires. Measured over 25 names x ~544 days, both statistics fire on 7.3% of
 * name-days. It fires on BETTER days, not fewer of them.
 */
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/**
 * Percent change of one number against another.
 *
 * The zero case is the one that matters and the reason this is not inlined: a
 * name going from 0 mentions to 40 is the single most important thing a
 * DETECT tool can see, and `(40 - 0) / 0` is `Infinity`. Reporting `null`
 * there — "no data" — would drop the loudest possible event on the floor, so
 * a rise FROM zero is reported as a large finite number instead, and a
 * genuine 0 -> 0 is what it looks like: no change.
 */
export function pctChange(now: number, base: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(base)) return null;
  if (base === 0) return now === 0 ? 0 : Number.POSITIVE_INFINITY;
  return ((now - base) / Math.abs(base)) * 100;
}

/**
 * The detector's core statistic: mean of the last `recentDays` against the
 * mean of the `baseDays` immediately before them.
 *
 * `points` is oldest-first, as the Wikimedia pageviews API returns it.
 */
export function recentVsBase(
  points: Array<{ views: number }>,
  recentDays: number = WINDOW.recentDays,
  baseDays: number = WINDOW.baseDays,
): { pct: number | null; baselineMean: number | null; reason: string | null } {
  const need = recentDays + baseDays;
  if (points.length < need) {
    return { pct: null, baselineMean: null, reason: `only ${points.length} days of history; need ${need}` };
  }
  const recent = median(points.slice(-recentDays).map((p) => p.views));
  const base = median(points.slice(-need, -recentDays).map((p) => p.views));
  if (base < MIN_BASELINE_VIEWS) {
    return {
      pct: null,
      baselineMean: base,
      reason:
        `baseline averages ${base.toFixed(1)}/day, below the ${MIN_BASELINE_VIEWS}/day floor — a percentage ` +
        'move on a series this thin is noise, and it is also what a mis-resolved article looks like',
    };
  }
  return { pct: pctChange(recent, base), baselineMean: base, reason: null };
}

const CORPORATE_SUFFIXES = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'companies',
  'holdings', 'holding', 'group', 'ltd', 'limited', 'plc', 'sa', 'nv', 'ag',
  'the', 'class', 'common', 'stock', 'shares', 'lp', 'llc', 'trust', 'brands',
]);

/** Lowercase alphanumeric tokens of 3+ chars, minus corporate boilerplate. */
export function significantTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !CORPORATE_SUFFIXES.has(t));
}

/**
 * Does this Wikipedia article plausibly belong to this company?
 *
 * `resolveArticle` is a search that returns its top hit and nothing else, so
 * it ALWAYS returns something. Left unguarded it silently attaches a person,
 * a product, an animal or a disambiguation page to a ticker, and the series
 * that comes back looks like real data. Probed against live Wikipedia,
 * 3 of 10 well-known consumer names failed this way.
 *
 * The guard is deliberately weak — one shared significant token — because a
 * strict one would reject legitimate renames. Names with NO significant token
 * ("On Holding AG" reduces to nothing) are unverifiable rather than verified,
 * and the caller must treat that as unchecked.
 */
export function articleMatchesCompany(companyName: string, article: string): boolean {
  if (/\(disambiguation\)/i.test(article)) return false;
  const want = significantTokens(companyName);
  if (!want.length) return false;
  const got = new Set(significantTokens(article));
  return want.some((t) => got.has(t));
}

// ---------------------------------------------------------------------------
// Assessment — pure, so the whole contract is testable without a network
// ---------------------------------------------------------------------------

export interface AssessInputs {
  wikiSpikePct?: number | null;
  wikiReason?: string | null;
  mentions?: {
    state: 'TRACKED' | 'BELOW_FLOOR' | 'UNAVAILABLE';
    rank: number | null;
    /** 7d mean vs prior 28d mean, from the RECORDED series. */
    spikePct?: number | null;
    reason?: string | null;
  };
  offExchangeZ?: number | null;
  /** 7d vs prior 28d growth in NEW app ratings per day. A "do" signal. */
  appRatingSpikePct?: number | null;
  appRatingReason?: string | null;
  context?: Partial<TrendCandidate['context']>;
}

const EMPTY_CONTEXT: TrendCandidate['context'] = {
  marketCapM: null, price: null, perfWeekPct: null, perfMonthPct: null,
  avgVolume: null, shortFloatPct: null, instOwnPct: null, earningsDate: null,
};

export function assessCandidate(
  ticker: string,
  companyName: string | null,
  inputs: AssessInputs,
): TrendCandidate {
  const ourWindow = `${WINDOW.recentDays}d mean vs prior ${WINDOW.baseDays}d mean`;
  const observations: SourceObservation[] = [];

  /** Shared shaping for the two percentage legs, including the zero baseline. */
  const percentObservation = (
    source: DetectSource,
    raw: number | null | undefined,
    threshold: number,
    fallbackReason: string,
    explicitReason?: string | null,
  ): SourceObservation => {
    const unbounded = raw === Number.POSITIVE_INFINITY;
    const value = raw == null || !Number.isFinite(raw) ? null : raw;
    const checked = unbounded || value != null;
    return {
      source,
      value,
      unbounded,
      unit: '%',
      window: ourWindow,
      checked,
      moved: unbounded || (value != null && value >= threshold),
      reason: unbounded
        ? 'rose from a zero baseline — the change is unbounded, not unmeasured'
        : checked
          ? null
          : (explicitReason ?? fallbackReason),
    };
  };

  // 1. WIKIPEDIA — absolute pageviews, comparable between names.
  observations.push(
    percentObservation(
      'wikipedia',
      inputs.wikiSpikePct,
      THRESHOLDS.wikiSpikePct,
      'no pageview history resolved',
      inputs.wikiReason,
    ),
  );

  // 2. RETAIL MENTIONS — growth off our OWN recorded series, not the level.
  //    A name that has always been loud is not news; a name that just got
  //    loud is. The level is the saturation reading, further down.
  const m = inputs.mentions;
  observations.push(
    percentObservation(
      'mentions',
      m?.spikePct,
      THRESHOLDS.mentionSpikePct,
      m?.state === 'BELOW_FLOOR'
        ? 'below the tracking floor — quiet, which is the expected state for an undiscovered name'
        : 'no recorded mention history to compare against',
      m?.reason,
    ),
  );

  // 3. APP RATINGS — new ratings per day, off our OWN recorded series.
  //    The study's finding is that signals from what consumers DO do not
  //    reverse, while signals from what people LOOK AT do. Wikipedia and forum
  //    chatter are both look-at. This is the only do leg here: somebody opened
  //    the app and tapped a star.
  observations.push(
    percentObservation(
      'appRatings',
      inputs.appRatingSpikePct,
      THRESHOLDS.appRatingSpikePct,
      'no recorded app-rating history to compare against',
      inputs.appRatingReason,
    ),
  );

  // OFF-EXCHANGE VOLUME IS NOT AN OBSERVATION — it is a saturation gauge, and
  // it lives below. Measured live on the deploy preview before this was
  // corrected, 4 of 7 candidates were flagged SOLELY by a positive
  // off-exchange z, and 3 of those were simultaneously marked crowded: the
  // board was surfacing names on the strength of the one number this app's
  // own Camillo doctrine reads as "the crowd already got here".

  const sourcesAvailable = observations.filter((s) => s.checked).length;
  const convergence = observations.filter((s) => s.moved).length;

  const loud = m?.state === 'TRACKED' && m.rank != null && m.rank <= SATURATION.loudRank;
  const instOwn = inputs.context?.instOwnPct ?? null;
  const heldByInstitutions = instOwn != null && instOwn >= SATURATION.instOwnPct;
  const oez = inputs.offExchangeZ ?? null;
  const retailCrowded = oez != null && oez >= SATURATION.offExchangeZ;

  const reasons: string[] = [];
  if (loud) reasons.push(`loud on retail forums (rank ${m?.rank}) — the crowd is here, which argues the gap has closed`);
  if (heldByInstitutions) reasons.push(`institutional ownership ${instOwn?.toFixed(0)}% — already discovered by professionals`);
  if (retailCrowded) reasons.push(`off-exchange volume ${oez?.toFixed(2)}sd above its own baseline — retail is already trading it`);
  const crowded = reasons.length > 0;

  return {
    ticker,
    companyName,
    convergence,
    sourcesAvailable,
    observations,
    saturation: {
      mentionRank: m?.rank ?? null,
      mentionState: m?.state ?? 'UNAVAILABLE',
      offExchangeZ: oez,
      crowded,
      reasons,
      note: crowded
        ? reasons.join('; ')
        : 'not crowded on the measures available — consistent with an undiscovered setup, not evidence for one',
    },
    context: { ...EMPTY_CONTEXT, ...(inputs.context ?? {}) },
  };
}

/**
 * Select the names where at least `minSources` independent sources moved, and
 * return them IN ALPHABETICAL ORDER.
 *
 * The ordering is the point. Sorting by convergence would make this a ranked
 * board, which `reports/trend/social-arb-study.md` pre-commits against until a
 * forward test clears; and it would also be a lie about precision, since
 * convergence is a 0-3 integer over three sources measured on different
 * clocks, where dozens of names tie. Alphabetical is honest about the fact
 * that this module does not know which of these is the good one.
 *
 * Saturation deliberately does not enter the selection either: burying crowded
 * names would hide exactly the ones a holder needs to see.
 */
export function selectMoved(all: TrendCandidate[], minSources = 1): TrendCandidate[] {
  const floor = Math.max(1, Math.floor(minSources));
  return [...all]
    .filter((c) => c.convergence >= floor)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

// ---------------------------------------------------------------------------
// The control cohort
// ---------------------------------------------------------------------------

/** FNV-1a. Small, dependency-free, and stable across Node versions. */
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — deterministic PRNG, so a recorded seed re-draws the cohort. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random cohort of the same size as the flagged set, drawn from the same
 * scanned universe and excluding the flagged names.
 *
 * This is the comparison the study's gate demands and the thing that makes a
 * forward record worth keeping. Without it, "the detector's picks were up 6%"
 * is unreadable — the universe may have been up 8%. It is SEEDED off the date
 * and the universe so the draw is reproducible from the stored seed alone and
 * cannot be quietly re-rolled once returns are known.
 */
export function controlCohort(universe: string[], flagged: string[], seed: string): string[] {
  const exclude = new Set(flagged);
  const pool = [...new Set(universe)].filter((t) => !exclude.has(t)).sort();
  const rng = mulberry32(hashSeed(seed));
  // Fisher-Yates, seeded.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(flagged.length, pool.length)).sort();
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** Bounded-concurrency map. A thrown task yields `null` rather than killing
 *  the run — one bad ticker must not lose the other thirty-nine. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<Array<R | null>> {
  const out: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e: any) {
        log.warn('scan_item_failed', { index: i, err: String(e?.message ?? e) });
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export interface ScanInput {
  ticker: string;
  companyName?: string | null;
  context?: Partial<TrendCandidate['context']>;
}

/** Per-ticker mention series (newest-first snapshots -> oldest-first counts). */
export function mentionSeries(ticker: string, history: MentionSnapshot[]): number[] {
  const t = ticker.toUpperCase();
  return [...history]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((snap) => {
      const row = (snap.rows ?? []).find((r) => r.ticker?.toUpperCase() === t);
      // ABSENCE IS THE FLOOR, NOT ZERO — but for a CHANGE measurement the
      // floor is the best available lower bound, and the snapshot records it.
      // Using the floor rather than 0 keeps a name that dipped below tracking
      // from reading as a total collapse in interest.
      return row ? row.mentions : (snap.floor ?? 0);
    });
}

/**
 * Mention growth off a recorded daily series (oldest first).
 *
 * Separate from `recentVsBase` on purpose: mentions have no minimum-baseline
 * floor. A jump from the tracking floor is the signal, not noise to suppress.
 * Returns `Infinity` for a rise off a zero baseline — `assessCandidate`
 * turns that into an `unbounded` observation rather than a fabricated number.
 */
export function mentionSpikeOf(series: number[]): number | null {
  const need = WINDOW.recentDays + WINDOW.baseDays;
  if (series.length < need) return null;
  const recent = median(series.slice(-WINDOW.recentDays));
  const base = median(series.slice(-need, -WINDOW.recentDays));
  return pctChange(recent, base);
}

/**
 * Per-ticker cumulative app-rating counts (oldest first), from the recorded
 * daily snapshots. Days where this ticker had no HIGH-confidence app match are
 * absent rather than zero — a missing observation is not a collapse to nought.
 */
export function appRatingSeries(ticker: string, history: AppRatingDay[]): number[] {
  const t = ticker.toUpperCase();
  const out: number[] = [];
  for (const day of history) {
    const row = (day.rows ?? []).find((r) => r.ticker?.toUpperCase() === t);
    if (row?.ratingCount != null) out.push(row.ratingCount);
  }
  return out;
}

/**
 * NEW ratings per day, from a cumulative series.
 *
 * A NEGATIVE delta is not a real-world event — a lifetime count cannot fall.
 * It means the app identity changed underneath us (a re-listing, a different
 * appId matched, Apple resetting a region). Averaging across that break would
 * invent a demand collapse and then a demand explosion the day after, so the
 * series is treated as broken and nothing is reported.
 */
export function dailyNewRatings(cumulative: number[]): number[] | null {
  if (cumulative.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < cumulative.length; i++) {
    const d = cumulative[i] - cumulative[i - 1];
    if (d < 0) return null;
    deltas.push(d);
  }
  return deltas;
}

/**
 * The app-rating leg: 7d mean of new ratings/day against the prior 28d mean.
 *
 * This is the study's "what consumers DO" class — the one it found does not
 * reverse, unlike the look-at signals. Returns `Infinity` for a rise off a
 * zero baseline, which `assessCandidate` renders as `unbounded`.
 */
export function appRatingSpikeOf(cumulative: number[]): number | null {
  const deltas = dailyNewRatings(cumulative);
  if (!deltas) return null;
  const need = WINDOW.recentDays + WINDOW.baseDays;
  if (deltas.length < need) return null;
  const recent = median(deltas.slice(-WINDOW.recentDays));
  const base = median(deltas.slice(-need, -WINDOW.recentDays));
  return pctChange(recent, base);
}

export async function scanForTrends(
  universe: ScanInput[],
  opts: { concurrency?: number; asOf?: string } = {},
): Promise<TrendDetectResult> {
  const degraded: string[] = [];
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);

  // The mention snapshot is a single ranked list, not a per-ticker lookup, so
  // the whole history is read ONCE per run rather than ~40x for identical data.
  let history: MentionSnapshot[] = [];
  try {
    history = await readMentionHistory(MIN_MENTION_HISTORY_DAYS, 'all-stocks', asOf);
  } catch (e: any) {
    degraded.push(`retail mentions history: ${String(e?.message ?? e)}`);
  }
  const historyUsable = history.length >= MIN_MENTION_HISTORY_DAYS;
  if (!historyUsable) {
    degraded.push(
      `retail mentions: ${history.length}/${MIN_MENTION_HISTORY_DAYS} days recorded — ApeWisdom publishes no ` +
        'per-ticker history, so this leg only becomes measurable once the daily snapshot cron has accumulated ' +
        'enough days. Reported as UNCHECKED, never as a negative.',
    );
  }
  const latest: MentionSnapshot | null = history[0] ?? null;

  // App-rating history — the "what consumers DO" leg. Read ONCE per run for
  // the same reason as the mentions: it is a day-per-doc collection, not a
  // per-ticker lookup.
  let appHistory: AppRatingDay[] = [];
  try {
    appHistory = await readAppRatingHistory(MIN_APP_HISTORY_DAYS, asOf);
  } catch (e: any) {
    degraded.push(`app ratings history: ${String(e?.message ?? e)}`);
  }
  const appUsable = appHistory.length >= MIN_APP_HISTORY_DAYS;
  if (!appUsable) {
    degraded.push(
      `app ratings: ${appHistory.length}/${MIN_APP_HISTORY_DAYS} days recorded — Apple reports a lifetime ` +
        'cumulative count, so daily new-rating flow only exists once the snapshot cron has differenced enough ' +
        'days. Reported as UNCHECKED, never as a negative.',
    );
  }

  // Bulk name lookup — ONE Firestore round trip for the whole universe rather
  // than forty. `enrichTickerNames` is the reader the scans already use for
  // exactly this, and forty sequential gets against a slow-but-alive Firestore
  // is how a scan quietly eats its entire time budget.
  const names = await enrichTickerNames(universe.map((u) => u.ticker.toUpperCase())).catch(
    () => ({}) as Record<string, string>,
  );

  // Wholesale failure has to be distinguishable from "nothing is trending".
  // Counting per-source failures is what makes an empty board explainable:
  // without it, Wikipedia being down for every name returns 200 with an empty
  // list and an empty `degraded`, which is exactly the lie this handler
  // refuses to tell about a dead Finviz feed.
  let wikiAttempted = 0;
  let wikiFailed = 0;
  let offExchangeAttempted = 0;
  let offExchangeFailed = 0;

  const results = await pool(universe, opts.concurrency ?? 6, async (row) => {
    const t = row.ticker.toUpperCase();
    const name = row.companyName ?? names[t] ?? null;
    const usableName = name && name !== t ? name : null;

    // --- Wikipedia. Needs a company name; a bare ticker resolves to the
    //     wrong article ("CROX" is not "Crocs").
    let wikiSpikePct: number | null = null;
    let wikiReason: string | null = usableName ? null : 'no company name resolved, so no article to look up';
    if (usableName) {
      wikiAttempted++;
      try {
        const article = await resolveArticle(usableName);
        if (!article) {
          wikiReason = 'no Wikipedia article found';
        } else if (!articleMatchesCompany(usableName, article)) {
          wikiReason = `resolved article "${article}" does not match "${usableName}" — refusing to measure the wrong page`;
        } else {
          const series = await fetchPageviews(article, { days: PAGEVIEW_DAYS });
          const spike = recentVsBase(series.points);
          wikiSpikePct = spike.pct;
          wikiReason = spike.reason;
        }
      } catch (e: any) {
        wikiFailed++;
        wikiReason = `pageview lookup failed: ${String(e?.message ?? e)}`;
      }
    }

    // --- Off-exchange volume. A SATURATION gauge, not a detect source.
    let offExchangeZ: number | null = null;
    offExchangeAttempted++;
    try {
      const oe = await fetchOffExchange(t);
      offExchangeZ = oe.available ? oe.volumeZ : null;
      if (!oe.available) offExchangeFailed++;
    } catch {
      offExchangeFailed++; // per-name gap; only a RUN failure if it is all of them
    }

    // --- Retail mentions, off our own recorded series.
    const read = readTicker(t, latest);
    let mentionSpike: number | null = null;
    let mentionReason: string | null = null;
    if (!historyUsable) {
      mentionReason = `only ${history.length} of ${MIN_MENTION_HISTORY_DAYS} required days recorded — UNCHECKED, not negative`;
    } else {
      // NOT `recentVsBase` — that applies MIN_BASELINE_VIEWS, which is a
      // PAGEVIEW floor. Applying it here would reject exactly the event this
      // leg exists to catch: a name sitting at the 1-mention tracking floor
      // that jumps to thirty.
      const series = mentionSeries(t, history);
      mentionSpike = mentionSpikeOf(series);
      if (mentionSpike == null) {
        mentionReason = `only ${series.length} of ${MIN_MENTION_HISTORY_DAYS} required days available for this ticker`;
      }
    }

    // --- App ratings, off our own recorded series.
    let appRatingSpikePct: number | null = null;
    let appRatingReason: string | null = null;
    if (!appUsable) {
      appRatingReason = `only ${appHistory.length} of ${MIN_APP_HISTORY_DAYS} required days recorded — UNCHECKED, not negative`;
    } else {
      const cumulative = appRatingSeries(t, appHistory);
      appRatingSpikePct = appRatingSpikeOf(cumulative);
      if (appRatingSpikePct == null) {
        appRatingReason = cumulative.length < MIN_APP_HISTORY_DAYS
          ? `only ${cumulative.length} recorded observations for this ticker — no HIGH-confidence app match on the rest`
          : 'the cumulative rating count fell, so the app identity changed — series treated as broken rather than averaged across the break';
      }
    }

    return assessCandidate(t, usableName, {
      wikiSpikePct,
      wikiReason,
      appRatingSpikePct,
      appRatingReason,
      mentions: {
        state: read.state,
        rank: read.rank,
        spikePct: mentionSpike,
        reason: mentionReason,
      },
      offExchangeZ,
      context: row.context,
    });
  });

  const assessed = results.filter((c): c is TrendCandidate => c !== null);

  // A source that failed for EVERY name it was tried on did not measure
  // "no movement" — it measured nothing, and an empty board built on it is
  // not a finding.
  if (wikiAttempted > 0 && wikiFailed === wikiAttempted) {
    degraded.push(`wikipedia: every one of ${wikiAttempted} lookups failed — this board cannot claim nothing moved`);
  }
  if (offExchangeAttempted > 0 && offExchangeFailed === offExchangeAttempted) {
    degraded.push(`off-exchange: unavailable for all ${offExchangeAttempted} names — saturation is unmeasured, not clear`);
  }
  if (assessed.length < universe.length) {
    degraded.push(`${universe.length - assessed.length} of ${universe.length} names failed outright`);
  }

  const candidates = selectMoved(assessed, 1);
  const scanned = universe.map((u) => u.ticker.toUpperCase()).sort();
  // The seed identifies the SHAPE of the scan, not just the day. Observed on
  // the deploy preview: a ?limit=5 call wrote the day's record first, and the
  // real 40-name scan then could not record at all because the date key was
  // taken. A cohort has to be pinned to the universe it was actually drawn
  // from, or the forward record compares a 40-name board to a 5-name control.
  const seed = `${asOf}:${scanned.length}:${scanned[0] ?? ''}:${scanned[scanned.length - 1] ?? ''}`;

  log.info('scan', {
    appDays: appHistory.length,
    universe: universe.length,
    assessed: assessed.length,
    candidates: candidates.length,
    mentionDays: history.length,
    degraded: degraded.length,
  });

  return {
    asOf,
    universeChecked: universe.length,
    candidates,
    order: 'alphabetical by ticker — this is NOT a ranking; sort client-side on any column',
    paperTrail: {
      date: asOf,
      seed,
      candidates: candidates.map((c) => c.ticker),
      control: controlCohort(scanned, candidates.map((c) => c.ticker), seed),
      universeScanned: scanned,
    },
    mentionHistory: {
      daysRecorded: history.length,
      daysRequired: MIN_MENTION_HISTORY_DAYS,
      usable: historyUsable,
    },
    appRatingHistory: {
      daysRecorded: appHistory.length,
      daysRequired: MIN_APP_HISTORY_DAYS,
      usable: appUsable,
    },
    falsePositives: expectedByChance(universe.length),
    degraded,
    caveat: DETECT_CAVEAT,
  };
}
