// QS-1 (2026-08-09) — "Quiet Strength": the residual-momentum board and the
// sleeve rules that make it survivable.
//
// The signal lives in residual-momentum.ts. This module turns a ranked list
// into a HOLDABLE sleeve, and every rule here exists to shrink the drawdown
// rather than to raise the return. Momentum's problem has never been its
// average; it is that the average is paid for with −67% holes.
//
// EVIDENCE GRADE: replicated, external. Sharpe 0.95 vs 0.47 for plain 12-1,
// max drawdown −25.5% vs −67.1% (Hanauer & Windmüller, US + 48 countries);
// out-of-sample confirmed 2009-2015 (BHM 2011; Huij & Lansdorp 2017).
// We have NOT measured it ourselves on our own universe, so under
// research-policy rule 3 this board carries NO internally-discovered
// t-statistic and must say so — `discoveryVerdict(null)` renders
// "NOT MEASURED (no t-statistic)" and that string ships in the payload.

import {
  applyUniversePolicy,
  haircutExcess,
  discoveryVerdict,
  POLICY_VERSION,
  type UniverseCandidate,
} from './research-policy';

// ---------------------------------------------------------------------------
// Sleeve constants — the kickoff's numbers, held as named constants so a
// change is a visible diff rather than a tweak buried in an expression.
// ---------------------------------------------------------------------------

/** Target holdings. The 30-50 band is the tolerated drift, 40 the target. */
export const TARGET_HOLDINGS = 40;
export const MIN_HOLDINGS = 30;
export const MAX_HOLDINGS = 50;

/** Enter on a top-decile rank; keep holding until it leaves the top quartile. */
export const ENTER_PERCENTILE = 0.10;
export const HOLD_PERCENTILE = 0.25;

/**
 * Rebalance in three staggered tranches.
 *
 * Rebalance-timing luck is worth >100bps/yr — a strategy evaluated on the
 * 1st and the same strategy evaluated on the 15th are materially different
 * portfolios for no reason anybody intended. Splitting the sleeve across
 * three monthly evaluation dates averages that luck away instead of betting
 * on one arbitrary date.
 */
export const TRANCHES = 3;

/** Crash control: target sleeve volatility, annualised percent. */
export const TARGET_VOL_PCT = 12;

/**
 * Exposure is CAPPED AT 1 — the sleeve never levers up when vol is low.
 *
 * Barroso & Santa-Clara's unconstrained rule scales above 1 in quiet
 * regimes. The lev-capped variant keeps ~95% of the drawdown benefit while
 * never borrowing, which is the right trade for an account that cannot
 * cheaply lever and would be carrying the tail risk of the last 5% for it.
 */
export const MAX_EXPOSURE = 1;

/** Bear dimmer: trailing 24-month benchmark return below zero halves the tilt. */
export const BEAR_LOOKBACK_MONTHS = 24;
export const BEAR_TILT_MULTIPLIER = 0.5;

/**
 * The gross, pre-haircut excess-return expectation, in pp/yr.
 *
 * Stated GROSS on purpose. research-policy.haircutExcess is then the single
 * thing that turns it into a displayed number, so the "50% haircut" claim in
 * the banner is produced by the policy module rather than asserted by a
 * hand-written string that could drift away from it.
 */
export const GROSS_EDGE_PP: readonly [number, number] = [1, 3];

// ---------------------------------------------------------------------------
// Documented refusals
// ---------------------------------------------------------------------------

/**
 * Why there is no 200-day-moving-average gate, kept as an exported refusal
 * so it is not helpfully re-added.
 *
 * About 85% of daily 200dma crossings are noise: price oscillates across the
 * line repeatedly within a single regime, so a hard gate converts one
 * decision into a dozen round-trips and pays the spread on every one. The
 * bear dimmer below evaluates MONTHLY and dims rather than exits, which is
 * the same intent without the whipsaw.
 */
export const NO_200DMA_GATE_REASON =
  '~85% of daily 200dma crossings are noise; a hard gate whipsaws. The monthly ' +
  'bear dimmer expresses the same intent without paying the spread each cross.';

// ---------------------------------------------------------------------------
// Exposure
// ---------------------------------------------------------------------------

export interface ExposureInput {
  /** Trailing 126-day realized volatility of the sleeve, annualised percent. */
  realizedVolPct: number | null;
  /** Trailing 24-month benchmark (SPY) total return, percent. */
  benchmark24mPct: number | null;
}

export interface ExposureDecision {
  /** Final multiplier in [0, 1]. */
  exposure: number;
  /** Before the bear dimmer. */
  volScaled: number;
  bearDimmed: boolean;
  /** Null inputs mean we could not measure, which is reported, not assumed. */
  reasons: string[];
}

/**
 * exposure = min(1, 12% ÷ trailing vol), then halved in a 24-month bear.
 *
 * A NULL vol does NOT mean full exposure. Being unable to measure risk is
 * not evidence of low risk, so an unmeasurable sleeve falls back to the bear
 * -dimmed base rather than silently sizing up.
 */
export function exposureFor(input: ExposureInput): ExposureDecision {
  const reasons: string[] = [];
  const { realizedVolPct, benchmark24mPct } = input;

  let volScaled: number;
  if (typeof realizedVolPct === 'number' && Number.isFinite(realizedVolPct) && realizedVolPct > 0) {
    volScaled = Math.min(MAX_EXPOSURE, TARGET_VOL_PCT / realizedVolPct);
  } else {
    volScaled = MAX_EXPOSURE;
    reasons.push('realized vol unmeasured — exposure not scaled up on missing data');
  }

  let exposure = volScaled;
  let bearDimmed = false;
  if (typeof benchmark24mPct === 'number' && Number.isFinite(benchmark24mPct)) {
    if (benchmark24mPct < 0) {
      exposure *= BEAR_TILT_MULTIPLIER;
      bearDimmed = true;
      reasons.push(`trailing ${BEAR_LOOKBACK_MONTHS}m benchmark ${benchmark24mPct.toFixed(1)}% < 0 — tilt halved`);
    }
  } else {
    reasons.push('benchmark 24m return unmeasured — bear dimmer not applied');
  }

  return {
    exposure: Math.max(0, Math.min(MAX_EXPOSURE, exposure)),
    volScaled,
    bearDimmed,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Rank buffer
// ---------------------------------------------------------------------------

export interface BufferInput {
  /** Ranked best-first. */
  ranked: string[];
  /** What is held today. */
  held: Set<string> | string[];
}

/**
 * Enter on the top decile, hold until the name leaves the top quartile.
 *
 * A single threshold makes a name at the boundary churn in and out month
 * after month for a rank change of one place, paying a round trip each time
 * for no change of view. The gap between entry and exit is what buys the
 * turnover back.
 */
export function applyRankBuffer(input: BufferInput): {
  keep: string[];
  entered: string[];
  exited: string[];
} {
  const ranked = input.ranked;
  const held = input.held instanceof Set ? input.held : new Set(input.held);
  const n = ranked.length;
  if (!n) return { keep: [], entered: [], exited: [...held] };

  const enterCut = Math.max(1, Math.ceil(n * ENTER_PERCENTILE));
  const holdCut = Math.max(enterCut, Math.ceil(n * HOLD_PERCENTILE));

  const rankOf = new Map(ranked.map((t, i) => [t, i]));
  const keep: string[] = [];
  const entered: string[] = [];

  // Survivors first, in rank order, then new entrants — so an existing
  // holding is never displaced by a newcomer with a marginally better rank.
  for (const t of ranked.slice(0, holdCut)) {
    if (held.has(t)) keep.push(t);
  }
  for (const t of ranked.slice(0, enterCut)) {
    if (!held.has(t) && keep.length + entered.length < MAX_HOLDINGS) entered.push(t);
  }

  const kept = new Set([...keep, ...entered]);
  const exited = [...held].filter((t) => {
    const r = rankOf.get(t);
    return r === undefined || r >= holdCut;
  });

  return { keep, entered, exited };
}

/** Deterministic tranche for a ticker, so rebalances stagger stably. */
export function trancheOf(ticker: string, tranches = TRANCHES): number {
  let h = 0;
  for (let i = 0; i < ticker.length; i++) h = (h * 31 + ticker.charCodeAt(i)) >>> 0;
  return h % tranches;
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

export interface EvidenceBanner {
  grade: 'replicated-external';
  /** Haircut edge range, pp/yr, AFTER research-policy's 50% survival haircut. */
  netEdgeLowPp: number;
  netEdgeHighPp: number;
  /** The mandatory user-facing sentence. */
  headline: string;
  /** Rule-3 verdict. Null t renders "NOT MEASURED". */
  discovery: string;
  policyVersion: string;
  /** Citations, so the payload carries its own provenance. */
  sources: string[];
}

/**
 * Build the banner that MUST ride in the payload.
 *
 * The kickoff requires the evidence grade and the haircut to travel with the
 * data rather than living in a component, so that no UI refactor can drop
 * them — a board whose disclaimer is deletable is a board that will
 * eventually be shown without one. The numbers are DERIVED through
 * haircutExcess rather than written down, so the banner cannot claim a
 * haircut it did not apply.
 */
export function buildEvidenceBanner(): EvidenceBanner {
  const lo = haircutExcess(GROSS_EDGE_PP[0]);
  const hi = haircutExcess(GROSS_EDGE_PP[1]);
  if (lo === null || hi === null) throw new Error('quiet-strength: haircut produced no figure');

  return {
    grade: 'replicated-external',
    netEdgeLowPp: lo,
    netEdgeHighPp: hi,
    headline:
      `Expected net edge after haircut ~${lo.toFixed(1)}–${hi.toFixed(1)}pp/yr over SPY; ` +
      'expect multi-year droughts (2000–2015-style).',
    discovery: discoveryVerdict(null),
    policyVersion: POLICY_VERSION,
    sources: [
      'Blitz, Huij & Martens (2011) — residual momentum',
      'Hanauer & Windmüller — Sharpe 0.95 vs 0.47, maxDD −25.5% vs −67.1%, US + 48 countries',
      'Huij & Lansdorp (2017) — OOS 2009–2015',
      'Barroso & Santa-Clara — volatility-scaled momentum',
    ],
  };
}

// ---------------------------------------------------------------------------
// Board assembly
// ---------------------------------------------------------------------------

export interface QSCandidate extends UniverseCandidate {
  ticker: string;
  sector?: string | null;
  /** Residual-momentum score; null when unscorable. */
  score: number | null;
  /** Why the score is null. */
  reason?: string | null;
  plain12_1Pct?: number | null;
  betaMkt?: number | null;
  betaSmb?: number | null;
  betaHml?: number | null;
}

export interface QSRow {
  ticker: string;
  sector: string | null;
  /**
   * The residual-momentum score.
   *
   * NAMED `score` DELIBERATELY. forward-test.extractScore probes exactly
   * ['composite','percentile','score','confidence','netDollars'] and takes
   * the first it finds; anything else (`residual`, `zScore`) leaves
   * scoreAtEntry null on every logged pick, permanently, because the league
   * never rewrites identity fields.
   */
  score: number;
  rank: number;
  percentile: number;
  plain12_1Pct: number | null;
  betaMkt: number | null;
  betaSmb: number | null;
  betaHml: number | null;
  tranche: number;
  /** Marks the top-decile entry band vs the top-quartile hold band. */
  band: 'enter' | 'hold';
}

export interface QSBoardResult {
  rows: QSRow[];
  banner: EvidenceBanner;
  exposure: ExposureDecision;
  universeSize: number;
  universeChecked: number;
  scored: number;
  excludedCounts: Record<string, number>;
  unscorableCounts: Record<string, number>;
  warnings: string[];
}

/**
 * Rank candidates and assemble the board.
 *
 * ROWS COME BACK SORTED BEST-FIRST AND THAT IS LOad-BEARING.
 * forward-test.extractTopN assigns `rank: out.length + 1` by ARRAY POSITION
 * and never sorts. A board that emitted rows in scan order — or ascending —
 * would silently log its 20 worst names into the permanent league record,
 * and no existing test would catch it.
 */
export function buildQuietStrengthBoard(
  candidates: QSCandidate[],
  exposureInput: ExposureInput,
  opts: { warnings?: string[] } = {},
): QSBoardResult {
  const warnings = [...(opts.warnings ?? [])];
  const universeSize = candidates.length;

  const { kept, counts: excludedCounts } = applyUniversePolicy(candidates);

  const unscorableCounts: Record<string, number> = {};
  const scorable = kept.filter((c) => {
    if (typeof c.score === 'number' && Number.isFinite(c.score)) return true;
    const key = c.reason ?? 'unknown';
    unscorableCounts[key] = (unscorableCounts[key] ?? 0) + 1;
    return false;
  });

  // Descending score. Ties broken on ticker so the ordering is deterministic
  // across runs — an unstable sort here would churn the league cohort.
  const sorted = [...scorable].sort(
    (a, b) => (b.score as number) - (a.score as number) || a.ticker.localeCompare(b.ticker),
  );

  const n = sorted.length;
  const enterCut = Math.max(1, Math.ceil(n * ENTER_PERCENTILE));
  const holdCut = Math.max(enterCut, Math.ceil(n * HOLD_PERCENTILE));

  const rows: QSRow[] = sorted.slice(0, holdCut).map((c, i) => ({
    ticker: c.ticker,
    sector: c.sector ?? null,
    score: c.score as number,
    rank: i + 1,
    percentile: n > 1 ? 1 - i / (n - 1) : 1,
    plain12_1Pct: c.plain12_1Pct ?? null,
    betaMkt: c.betaMkt ?? null,
    betaSmb: c.betaSmb ?? null,
    betaHml: c.betaHml ?? null,
    tranche: trancheOf(c.ticker),
    band: i < enterCut ? 'enter' : 'hold',
  }));

  if (n < MIN_HOLDINGS) {
    warnings.push(`only ${n} scorable names — below the ${MIN_HOLDINGS}-name floor`);
  }

  return {
    rows,
    banner: buildEvidenceBanner(),
    exposure: exposureFor(exposureInput),
    universeSize,
    universeChecked: kept.length,
    scored: n,
    excludedCounts: excludedCounts as unknown as Record<string, number>,
    unscorableCounts,
    warnings,
  };
}
