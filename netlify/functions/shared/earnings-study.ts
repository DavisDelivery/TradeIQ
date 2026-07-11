// FIX-2 W2 — PEAD / earnings-reaction event study: the pure aggregation
// engine behind `GET /api/earnings-edge-study`.
//
// This module answers ONE question and answers it honestly: over the
// study window, does the earnings-reaction taxonomy have a realized,
// measurable edge? It takes raw per-event records (surprise, announce-day
// reaction, forward returns, regime) and produces the surprise-quintile ×
// reaction-sign bucket table the pre-committed decision rule
// (reports/fix-2/pead-study.md) is evaluated against.
//
// Everything here is PURE (no I/O, no wall clock): the background job
// (earnings-edge-study-background.ts) does the fetching + windowing and
// hands events in; this module does the math. That split is what makes
// the statistics unit-testable on fixtures with hand-checkable answers.
//
// NOT a scorer. It never decides a trade. It measures base rates. W3
// consumes the OUTPUT of this to (maybe) re-derive scoring — the anti-
// p-hack firewall is that the numbers are computed here, before any
// scoring change, and the rule that reads them is committed before they
// exist.

/** The primary forward-return horizon the decision rule is judged on. */
export const PRIMARY_HORIZON = 'fwdRet20' as const;

export type RegimeTag = 'risk_on' | 'neutral' | 'risk_off';

/**
 * One earnings event, fully resolved to its price reaction. Produced by
 * the background job from PIT price + surprise data; consumed by the
 * aggregation below. `null` forward returns mean the bar window ran off
 * the end of available data (recent events) — they are excluded from that
 * horizon's stats, never treated as zero.
 */
export interface StudyEvent {
  ticker: string;
  /** Announcement date (when the print hit the tape), YYYY-MM-DD. */
  announceDate: string;
  /** EPS surprise %, announcement-dated. */
  surprisePct: number;
  /** Signed % move: announce-day close → +1 trading-bar close (the gap). */
  reaction0_1: number;
  /** Forward return +2 bar → +N bar, as a fraction (0.03 = +3%). */
  fwdRet5: number | null;
  fwdRet20: number | null;
  fwdRet60: number | null;
  /** Regime tag at the event date. Null when regime resolution failed. */
  regime: RegimeTag | null;
}

export type Horizon = 'fwdRet5' | 'fwdRet20' | 'fwdRet60';
export type ReactionSign = 'up' | 'down';

// ---------------------------------------------------------------------------
// Event windowing — turn (announceDate, surprise, bars) into a StudyEvent.
// Pure so the price-reaction math is testable independent of any fetch.
// ---------------------------------------------------------------------------

/** Minimal daily-bar shape (matches data-provider's Bar). */
export interface StudyBar {
  t: number; // epoch ms of the bar (UTC)
  c: number; // close
}

/** Forward-return horizons the study measures, in trading bars past +1. */
export const FWD_HORIZONS = { fwdRet5: 5, fwdRet20: 20, fwdRet60: 60 } as const;

/**
 * Index of the announce-day bar: the first bar whose date is ≥ the
 * announcement date. Earnings often print after the close, so the "day 0"
 * bar is the session the tape first fully reflected the number is a
 * modelling choice — we anchor on the announce-DATE session close and
 * measure the gap to the NEXT session (reaction0_1). Returns -1 if no bar
 * on/after the announcement exists in the array.
 */
export function announceBarIndex(announceDate: string, bars: StudyBar[]): number {
  const anchorMs = Date.parse(`${announceDate}T00:00:00Z`);
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t >= anchorMs) return i;
  }
  return -1;
}

/**
 * Build a StudyEvent from an announcement and the ticker's full bar array.
 *
 * Windows (all bar-relative, so trading-day-correct and gap/holiday-safe):
 *   - day 0     = announce-day session (bar at announceBarIndex)
 *   - reaction  = close[0] → close[+1]                 (the initial gap)
 *   - fwdRet[N] = close[+2] → close[+2+ (N-... )]  measured +2 → +N bars,
 *                 i.e. AFTER the reaction bar (no overlap with reaction0_1)
 *
 * A horizon whose end bar runs off the end of `bars` is null (recent
 * event), never fabricated. Returns null when there is no day-0 bar or no
 * +1 bar (can't measure any reaction) — the caller drops the event.
 */
export function buildEvent(
  ticker: string,
  announceDate: string,
  surprisePct: number,
  bars: StudyBar[],
  regime: RegimeTag | null,
): StudyEvent | null {
  const d0 = announceBarIndex(announceDate, bars);
  if (d0 < 0 || d0 + 1 >= bars.length) return null;
  const c0 = bars[d0].c;
  const c1 = bars[d0 + 1].c;
  if (!(c0 > 0) || !(c1 > 0)) return null;
  const reaction0_1 = ((c1 - c0) / c0) * 100;

  // Forward returns start at +2 (the bar after the reaction bar) so they
  // never overlap the reaction window. fwdRet[N] = close[+2] → close[N-anchor].
  const baseIdx = d0 + 2;
  const fwd = (n: number): number | null => {
    const endIdx = d0 + n; // +N bar relative to day 0
    if (baseIdx >= bars.length || endIdx >= bars.length) return null;
    const cb = bars[baseIdx].c;
    const ce = bars[endIdx].c;
    if (!(cb > 0) || !(ce > 0)) return null;
    return (ce - cb) / cb;
  };

  return {
    ticker,
    announceDate,
    surprisePct,
    reaction0_1,
    fwdRet5: fwd(FWD_HORIZONS.fwdRet5),
    fwdRet20: fwd(FWD_HORIZONS.fwdRet20),
    fwdRet60: fwd(FWD_HORIZONS.fwdRet60),
    regime,
  };
}

// ---------------------------------------------------------------------------
// Statistics — small, dependency-free, and individually testable.
// ---------------------------------------------------------------------------

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n−1). Returns 0 for n<2. */
export function sampleStd(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((a, b) => a + (b - m) * (b - m), 0);
  return Math.sqrt(ss / (n - 1));
}

/**
 * One-sample t-statistic of `xs` against a null of 0: mean / (s/√n).
 * This is the statistic the rule's threshold (|t| ≥ 2.0) is applied to —
 * "is the mean forward return reliably different from zero?" Returns 0
 * when n<2 or the sample has no dispersion (degenerate — not significant).
 */
export function tStatOneSample(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const s = sampleStd(xs);
  if (s === 0) return 0;
  return mean(xs) / (s / Math.sqrt(n));
}

/**
 * Pearson correlation of two equal-length series. Used for the IC —
 * "does the driving signal (surprise) RANK the forward return, not just
 * shift its mean?" Returns 0 for n<2 or a flat series (no information).
 */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

// ---------------------------------------------------------------------------
// Bucketing.
// ---------------------------------------------------------------------------

/**
 * Assign each surprise to a 1..5 quintile by rank. Ties share a rank
 * band; the split is by sorted position so quintile sizes are as even as
 * the sample allows. Returns a parallel array of quintile labels (1=most
 * negative surprise … 5=most positive).
 */
export function assignSurpriseQuintiles(surprises: number[]): number[] {
  const n = surprises.length;
  if (n === 0) return [];
  const order = surprises
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s - b.s);
  const q = new Array<number>(n);
  for (let rank = 0; rank < n; rank++) {
    // Position-based quintile: floor(rank / n * 5), clamped to 1..5.
    const bucket = Math.min(5, Math.floor((rank / n) * 5) + 1);
    q[order[rank].i] = bucket;
  }
  return q;
}

/** Reaction sign: a non-negative gap is 'up', a negative gap is 'down'. */
export function reactionSign(reaction0_1: number): ReactionSign {
  return reaction0_1 >= 0 ? 'up' : 'down';
}

export interface BucketStats {
  quintile: number;
  reactionSign: ReactionSign;
  n: number;
  meanFwdRet5: number | null;
  meanFwdRet20: number | null;
  meanFwdRet60: number | null;
  /** Fraction of events with positive fwdRet on the primary horizon. */
  hitRate: number | null;
  /** One-sample t-stat of the primary-horizon fwdRet vs 0. */
  tStat: number | null;
  /** IC: corr(surprise, primary-horizon fwdRet) within the bucket. */
  ic: number | null;
}

function horizonValues(events: StudyEvent[], h: Horizon): number[] {
  return events.map((e) => e[h]).filter((v): v is number => v !== null);
}

function meanOrNull(xs: number[]): number | null {
  return xs.length === 0 ? null : mean(xs);
}

/** Aggregate one cell of events into its stats (primary horizon = 20d). */
export function statsForEvents(
  quintile: number,
  sign: ReactionSign,
  events: StudyEvent[],
): BucketStats {
  const primary = horizonValues(events, PRIMARY_HORIZON);
  // IC pairs surprise with the primary-horizon return over the SAME
  // events that have a non-null primary return (kept in lockstep).
  const paired = events.filter((e) => e[PRIMARY_HORIZON] !== null);
  const ic =
    paired.length >= 2
      ? pearson(
          paired.map((e) => e.surprisePct),
          paired.map((e) => e[PRIMARY_HORIZON] as number),
        )
      : null;
  return {
    quintile,
    reactionSign: sign,
    n: events.length,
    meanFwdRet5: meanOrNull(horizonValues(events, 'fwdRet5')),
    meanFwdRet20: meanOrNull(primary),
    meanFwdRet60: meanOrNull(horizonValues(events, 'fwdRet60')),
    hitRate:
      primary.length === 0
        ? null
        : primary.filter((v) => v > 0).length / primary.length,
    tStat: primary.length >= 2 ? tStatOneSample(primary) : null,
    ic,
  };
}

/**
 * The full surprise-quintile × reaction-sign table (up to 10 cells).
 * Quintiles are assigned across the WHOLE event set passed in (so a
 * per-regime slice re-quintiles within that regime, which is the honest
 * cut — "a big beat FOR THAT REGIME").
 */
export function buildBuckets(events: StudyEvent[]): BucketStats[] {
  if (events.length === 0) return [];
  const quintiles = assignSurpriseQuintiles(events.map((e) => e.surprisePct));
  const cells = new Map<string, StudyEvent[]>();
  events.forEach((e, i) => {
    const q = quintiles[i];
    const sign = reactionSign(e.reaction0_1);
    const key = `${q}|${sign}`;
    const list = cells.get(key) ?? [];
    list.push(e);
    cells.set(key, list);
  });
  const out: BucketStats[] = [];
  for (const [key, cellEvents] of cells) {
    const [qStr, sign] = key.split('|');
    out.push(statsForEvents(Number(qStr), sign as ReactionSign, cellEvents));
  }
  return out.sort(
    (a, b) => a.quintile - b.quintile || a.reactionSign.localeCompare(b.reactionSign),
  );
}

// ---------------------------------------------------------------------------
// Reversal hypothesis — tested, not assumed.
// ---------------------------------------------------------------------------

export interface ReversalStats {
  /** Events where the gap direction DISAGREES with the surprise sign. */
  n: number;
  /** Mean primary-horizon fwdRet, signed as the GAP (reaction) direction. */
  meanFwdRetInGapDirection: number | null;
  /** t-stat of that gap-direction return vs 0. */
  tStat: number | null;
  /**
   * Interpretation flag: >0 mean ⇒ the gap CONTINUES (momentum wins);
   * <0 mean ⇒ the gap REVERSES (the `reversal` play has continuation to
   * fade). Null when too few events.
   */
  verdict: 'continues' | 'reverses' | null;
}

/** sign helper: +1 / -1 / 0. */
function sgn(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/**
 * Isolate gap-AGAINST-surprise events (gap up on a miss / gap down on a
 * beat) and ask whether they continue or mean-revert. The return is
 * re-signed into the GAP direction so a positive mean means "the gap kept
 * going." This is the empirical test the `reversal` playType lives or
 * dies on.
 */
export function reversalHypothesis(events: StudyEvent[]): ReversalStats {
  const against = events.filter(
    (e) =>
      sgn(e.reaction0_1) !== 0 &&
      sgn(e.surprisePct) !== 0 &&
      sgn(e.reaction0_1) !== sgn(e.surprisePct),
  );
  const gapDir = against
    .map((e) => {
      const v = e[PRIMARY_HORIZON];
      return v === null ? null : v * sgn(e.reaction0_1);
    })
    .filter((v): v is number => v !== null);
  if (gapDir.length < 2) {
    return { n: against.length, meanFwdRetInGapDirection: null, tStat: null, verdict: null };
  }
  const m = mean(gapDir);
  return {
    n: against.length,
    meanFwdRetInGapDirection: m,
    tStat: tStatOneSample(gapDir),
    verdict: m >= 0 ? 'continues' : 'reverses',
  };
}

// ---------------------------------------------------------------------------
// The pre-committed decision rule (reports/fix-2/pead-study.md).
// ---------------------------------------------------------------------------

/**
 * Round-trip cost model, in basis points, matching FIX-1. Earnings
 * turnover is not cheap; a statistically-significant sub-cost edge does
 * NOT survive.
 */
export const COST_MODEL_BPS: Record<string, number> = {
  sp500: 20, // ~10 bps/leg
  ndx: 20,
  dow: 20,
  russell2k: 80, // ~40 bps/leg
};

export interface RuleEvaluation {
  survives: boolean;
  /** |t| ≥ 2.0 on the primary horizon. */
  passStat: boolean;
  /** IC > 0. */
  passIc: boolean;
  /** |mean edge| in bps > the round-trip cost model. */
  passEconomic: boolean;
  meanEdgeBps: number | null;
  costBps: number;
  reason: string;
}

/**
 * Apply the three-part pre-committed rule to one bucket's stats. A bucket
 * SURVIVES only if ALL THREE hold: statistical reliability (|t| ≥ 2),
 * ranking information (IC > 0), and economic size (|mean edge| > cost).
 * The magnitude is compared in absolute value because a short-side bucket
 * earns its edge on the down move — direction is the playType's business,
 * not the survival test's.
 */
export function evaluateRule(stats: BucketStats, costBps: number): RuleEvaluation {
  const meanEdgeBps =
    stats.meanFwdRet20 === null ? null : stats.meanFwdRet20 * 10_000;
  const passStat = stats.tStat !== null && Math.abs(stats.tStat) >= 2.0;
  const passIc = stats.ic !== null && stats.ic > 0;
  const passEconomic = meanEdgeBps !== null && Math.abs(meanEdgeBps) > costBps;
  const survives = passStat && passIc && passEconomic;
  const parts: string[] = [];
  parts.push(`|t|${passStat ? '≥' : '<'}2 (${stats.tStat?.toFixed(2) ?? 'n/a'})`);
  parts.push(`IC${passIc ? '>' : '≤'}0 (${stats.ic?.toFixed(4) ?? 'n/a'})`);
  parts.push(
    `edge ${meanEdgeBps === null ? 'n/a' : meanEdgeBps.toFixed(1)}bps ${
      passEconomic ? '>' : '≤'
    } cost ${costBps}bps`,
  );
  return {
    survives,
    passStat,
    passIc,
    passEconomic,
    meanEdgeBps,
    costBps,
    reason: `${survives ? 'SURVIVES' : 'fails'}: ${parts.join(' AND ')}`,
  };
}

// ---------------------------------------------------------------------------
// Top-level study assembly (what the endpoint serializes).
// ---------------------------------------------------------------------------

export interface EarningsStudyResult {
  universe: string;
  windowStart: string;
  windowEnd: string;
  /** Total events with a resolvable reaction (the study's n). */
  eventCount: number;
  /** Members that contributed ≥1 event. */
  tickerCount: number;
  costBps: number;
  buckets: BucketStats[];
  perRegime: Record<RegimeTag, BucketStats[]>;
  reversal: ReversalStats;
  /** Per-bucket survival verdicts (rule applied to the overall buckets). */
  ruleByBucket: Array<{ quintile: number; reactionSign: ReactionSign; evaluation: RuleEvaluation }>;
  /** True iff ANY bucket survives — gates the W3 branch. */
  anySurvives: boolean;
  /**
   * Survivorship note: our universe snapshots are current-membership
   * seeds (survivorship-biased upward — delisted/acquired names are
   * absent). Stated so the reader discounts accordingly.
   */
  survivorshipNote: string;
}

const EMPTY_REGIME_BUCKETS = (): Record<RegimeTag, BucketStats[]> => ({
  risk_on: [],
  neutral: [],
  risk_off: [],
});

/**
 * Assemble the full study from the raw event set. Pure: the endpoint
 * gathers events (I/O), this turns them into the report + verdict inputs.
 */
export function assembleStudy(
  universe: string,
  windowStart: string,
  windowEnd: string,
  events: StudyEvent[],
  survivorshipNote: string,
): EarningsStudyResult {
  const costBps = COST_MODEL_BPS[universe] ?? 20;
  const buckets = buildBuckets(events);
  const perRegime = EMPTY_REGIME_BUCKETS();
  for (const tag of ['risk_on', 'neutral', 'risk_off'] as RegimeTag[]) {
    perRegime[tag] = buildBuckets(events.filter((e) => e.regime === tag));
  }
  const ruleByBucket = buckets.map((b) => ({
    quintile: b.quintile,
    reactionSign: b.reactionSign,
    evaluation: evaluateRule(b, costBps),
  }));
  return {
    universe,
    windowStart,
    windowEnd,
    eventCount: events.length,
    tickerCount: new Set(events.map((e) => e.ticker)).size,
    costBps,
    buckets,
    perRegime,
    reversal: reversalHypothesis(events),
    ruleByBucket,
    anySurvives: ruleByBucket.some((r) => r.evaluation.survives),
    survivorshipNote,
  };
}
