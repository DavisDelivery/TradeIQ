// PROFILE-1 W3 — the peer-rank engine.
//
// Where a metric sits among comparable companies, computed so that the
// answer is either defensible or absent. Every rule below exists because the
// naive version of it produces a number that looks authoritative and is not.
//
// THE PERCENTILE CONVENTION — declared once, because this repo already has
// four. Some modules use 0..1, some 0..100; some tie-averaged, some
// upper-bound; some best=1, some best=100. A fifth dialect would make
// cross-module comparison meaningless, so this module adds none: it calls
// quality-value.percentileRank with higherIsBetter ALWAYS TRUE, which turns
// it into a pure MAGNITUDE percentile — "larger than this fraction of the
// pool" — and never a statement about better. Direction is applied later, by
// metric-direction.ts, at the point of phrasing. 0..1, tie-averaged.
//
// WHY N >= 20. A percentile over nine names says "78th percentile" while
// meaning "7th of 9", and the decimal implies a precision the sample cannot
// carry. Below the floor this module refuses the percentile and returns an
// ORDINAL plus the actual peer list, which is both honest and more useful at
// that size — you can read the nine names.
//
// WHY NM NAMES LEAVE THE POOL AND GET COUNTED. A loss-making company has no
// meaningful P/E. Leaving it in ranks it as infinitely expensive; dropping it
// silently shrinks the denominator and nobody knows. So it is excluded AND
// disclosed: "34 of 41 profitable".
//
// WHY THE CENTRE LINE IS A MEDIAN. A cap-weighted mean of a peer group is
// one mega-cap's number wearing the group's name.

import { percentileRank } from './quality-value';
import { policyFor, comparativePhrase } from './metric-direction';

/** Minimum pool size for a percentile to be reported at all. */
export const MIN_POOL_FOR_PERCENTILE = 20;

/** Display winsorization bounds. Applied to the STRIP, never to the rank. */
export const WINSOR_LOW = 0.025;
export const WINSOR_HIGH = 0.975;

export type PoolLevel = 'industry' | 'industry-group' | 'sector';

export interface PeerCandidate {
  ticker: string;
  value: number | null | undefined;
}

export interface PeerStat {
  metricKey: string;
  subjectTicker: string;
  subjectValue: number | null;
  /** Which level the pool was drawn at — ALWAYS reported. */
  poolLevel: PoolLevel;
  poolLabel: string;
  /** Usable peers AFTER exclusions. Always reported. */
  n: number;
  /** How many candidates were dropped, and why. */
  excludedCount: number;
  exclusionNote: string | null;
  /** 0..1 magnitude percentile, or null when the pool is too small. */
  percentile: number | null;
  /** 1-based position by descending value, when the pool is too small. */
  ordinal: number | null;
  /** The peer list, supplied for small pools where names beat a statistic. */
  peers: Array<{ ticker: string; value: number }> | null;
  median: number | null;
  /** Winsorized display bounds for the distribution strip. */
  displayLow: number | null;
  displayHigh: number | null;
  winsorNote: string;
  /** True when the SUBJECT itself has no meaningful value for this metric. */
  subjectNotMeaningful: boolean;
  /** One falsifiable sentence. Never a verdict. */
  phrase: string;
}

/** Sample quantile by linear interpolation. Ascending input. */
export function quantile(sortedAsc: number[], p: number): number | null {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/**
 * Median. Returns NULL on an empty set.
 *
 * Stated because the repo has five median implementations with three
 * different empty-set contracts — one of them returns 0, which turns "no
 * peers" into "the peer median is zero" and is indistinguishable downstream.
 */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  return quantile([...xs].sort((a, b) => a - b), 0.5);
}

/**
 * Does this candidate belong in the pool for this metric?
 *
 * Only NEGATIVE-DENOMINATOR exclusion is decided here, from the metric's
 * declared policy; financials and non-payers are membership questions the
 * caller answers when it assembles the pool, because this module cannot see
 * a sector.
 */
export function isMeaningful(metricKey: string, value: number | null | undefined): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const p = policyFor(metricKey);
  if (p?.excludes === 'negative-denominator' && value <= 0) return false;
  return true;
}

const POOL_LABEL: Record<PoolLevel, string> = {
  industry: 'industry',
  'industry-group': 'industry group',
  sector: 'sector',
};

export interface BuildPeerStatInput {
  metricKey: string;
  subjectTicker: string;
  subjectValue: number | null | undefined;
  /** Candidates EXCLUDING the subject. */
  pool: PeerCandidate[];
  poolLevel: PoolLevel;
  /** Human name of the group, e.g. "Specialty Retail". */
  poolName: string;
}

/**
 * Compute one metric's peer statistics.
 *
 * The subject is never in its own pool — including it makes a company
 * marginally more average than it is, and at small N that is not marginal.
 */
export function buildPeerStat(input: BuildPeerStatInput): PeerStat {
  const { metricKey, subjectTicker, poolLevel, poolName } = input;
  const subjectValue =
    typeof input.subjectValue === 'number' && Number.isFinite(input.subjectValue)
      ? input.subjectValue
      : null;

  const candidates = input.pool.filter((c) => c.ticker !== subjectTicker);
  const usable = candidates.filter((c) => isMeaningful(metricKey, c.value)) as Array<{
    ticker: string; value: number;
  }>;
  const excludedCount = candidates.length - usable.length;
  const n = usable.length;

  const subjectNotMeaningful = !isMeaningful(metricKey, subjectValue);

  const values = usable.map((u) => u.value);
  const sorted = [...values].sort((a, b) => a - b);
  const med = median(values);
  const displayLow = quantile(sorted, WINSOR_LOW);
  const displayHigh = quantile(sorted, WINSOR_HIGH);

  const p = policyFor(metricKey);
  const exclusionNote =
    excludedCount > 0 && p?.excludes === 'negative-denominator'
      ? `${n} of ${candidates.length} have positive earnings; the rest are excluded from this ratio`
      : excludedCount > 0
        ? `${excludedCount} peer${excludedCount === 1 ? '' : 's'} excluded for missing data`
        : null;

  const base = {
    metricKey,
    subjectTicker,
    subjectValue,
    poolLevel,
    poolLabel: `${poolName} (${POOL_LABEL[poolLevel]})`,
    n,
    excludedCount,
    exclusionNote,
    median: med,
    displayLow,
    displayHigh,
    winsorNote: 'Distribution clipped at the 2.5th and 97.5th percentiles for display; ranks use every value.',
    subjectNotMeaningful,
  };

  // The subject has nothing to rank.
  if (subjectNotMeaningful) {
    return {
      ...base,
      percentile: null,
      ordinal: null,
      peers: null,
      phrase: p?.excludes === 'negative-denominator'
        ? 'Not meaningful (loss-making) — no peer rank for this metric.'
        : 'Not meaningful — no peer rank for this metric.',
    };
  }

  // Too small for a percentile: an ordinal and the names instead.
  if (n < MIN_POOL_FOR_PERCENTILE) {
    const desc = [...usable].sort((a, b) => b.value - a.value);
    const ordinal = desc.filter((u) => u.value > (subjectValue as number)).length + 1;
    return {
      ...base,
      percentile: null,
      ordinal,
      peers: desc,
      phrase: n === 0
        ? `No comparable peers with this metric in ${poolName}.`
        : `${ordinal}${ordinalSuffix(ordinal)} highest of ${n + 1} in ${poolName} — too few peers for a percentile.`,
    };
  }

  // Magnitude percentile. `true` always: this is "larger than", not "better
  // than"; metric-direction supplies the reading.
  const ranks = percentileRank([subjectValue, ...values], true);
  const percentile = ranks[0];

  return {
    ...base,
    percentile,
    ordinal: null,
    peers: null,
    phrase:
      percentile === null
        ? `No peer rank available in ${poolName}.`
        : `${comparativePhrase(metricKey, percentile)} — ${pctLabel(percentile)} of ${n} ${poolName} peers.`,
  };
}

function pctLabel(p: number): string {
  return `${Math.round(p * 100)}th percentile`;
}

export function ordinalSuffix(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}
