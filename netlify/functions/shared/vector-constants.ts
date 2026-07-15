// VECTOR — frozen constants under test.
//
// Every number here is transcribed from reports/vector/design.md at the
// commit that introduced that file. Per the pre-committed validation rule,
// THESE are the constants under test: no edits after the first validation
// run fires. A scoring-affecting change requires a VECTOR_MODEL_VERSION
// bump and restarts the validation clock.

export const VECTOR_MODEL_VERSION = '1.0.0';

// ---------------------------------------------------------------------
// Universe hygiene (measured at event date t)
// ---------------------------------------------------------------------
export const HYGIENE = {
  minClose: 5, // $5
  minBars: 287, // daily bars required
  minMedianDollarVol63d: 2_000_000, // $2M
  minEpsQuarters: 12, // split-adjusted reported EPS history for E1
} as const;

// Size buckets by 63d median dollar volume at t.
export const SIZE_BUCKETS = {
  LARGE: 50_000_000, // >= $50M
  MID: 10_000_000, // $10M - $50M
  SMALL: 2_000_000, // $2M - $10M (hygiene floor)
} as const;

export type SizeBucket = 'LARGE' | 'MID' | 'SMALL';

export function sizeBucketOf(medianDollarVol63d: number): SizeBucket | null {
  if (medianDollarVol63d >= SIZE_BUCKETS.LARGE) return 'LARGE';
  if (medianDollarVol63d >= SIZE_BUCKETS.MID) return 'MID';
  if (medianDollarVol63d >= SIZE_BUCKETS.SMALL) return 'SMALL';
  return null; // fails hygiene
}

// ---------------------------------------------------------------------
// E1 — earnings surprise
// ---------------------------------------------------------------------
export const E1 = {
  // SUE = (EPS_q - EPS_{q-4}) / sigma of last 8 seasonal differences
  seasonalDiffWindow: 8,
  // Live display trigger ("agreement")
  trigger: {
    minSue: 1.5,
    minReaction: 0.02, // +2% market-adjusted close(d-1)->close(d) vs SPY
    minVolumeShock: 2, // vol(d) / median63 vol
  },
} as const;

// ---------------------------------------------------------------------
// E2 — insider cluster in drawdown
// ---------------------------------------------------------------------
export const E2 = {
  minPurchaseDollars: 25_000, // per qualifying Form 4 purchase (code P)
  minDistinctBuyers: 2, // cluster fires on the 2nd distinct buyer
  clusterWindowDays: 90, // trailing window for distinct buyers
  maxFileLagDays: 30, // filingDate - transactionDate <= 30d
  drawdownGate: 0.8, // close <= 0.80 x max(high, 252d) at filing date
  form4BackfillStart: '2013-01-01',
  // Routine screen (Cohen-Malloy-Pomorski): exclude insiders whose
  // purchases fall in the same calendar month in >= N consecutive prior
  // years. Full = 3; reduced (rate-limit fallback, flagged
  // routineScreen:'reduced') = 2.
  routineScreen: {
    fullConsecutiveYears: 3,
    reducedConsecutiveYears: 2,
  },
  // Sell context: >= 2 distinct sellers, >= $1M aggregate, trailing 90d.
  sellCluster: {
    minDistinctSellers: 2,
    minAggregateDollars: 1_000_000,
    windowDays: 90,
  },
} as const;

// ---------------------------------------------------------------------
// E3 — activist stake initiation (initial SC 13D)
// ---------------------------------------------------------------------
export const E3 = {
  form: 'SC 13D',
  // Structural break: filing deadline 10 -> 5 business days, compliance
  // Feb 2024. Pre/post reported descriptively.
  deadlineChangeCompliance: '2024-02-01',
} as const;

// ---------------------------------------------------------------------
// F axis — "is it fundamentally a good buy" (max 6)
// ---------------------------------------------------------------------
export const F_AXIS = {
  fscoreHigh: { min: 7, points: 2 },
  fscoreMid: { min: 4, max: 6, points: 1 },
  fscoreLow: { max: 3, points: 0 },
  latestSue: { min: 1, points: 1 },
  consecutivePositiveSue: { min: 2, points: 1 },
  insiderNet90d: { min: 100_000, points: 1 },
  sellClusterPenalty: -1,
  instDelta: { min: 2, points: 1 },
  cuts: { strong: 4, weakMax: 1 }, // >= 4 STRONG, 2-3 NEUTRAL, <= 1 WEAK
  max: 6,
} as const;

export type FVerdict = 'STRONG' | 'NEUTRAL' | 'WEAK';

// ---------------------------------------------------------------------
// T axis — "is now a good entry"
// ---------------------------------------------------------------------
export const T_AXIS = {
  trendBothPoints: 2, // close > SMA200 AND SMA50 > SMA200
  trendCloseOnlyPoints: 1, // close > SMA200 only
  extensionOkMax: 0.15, // extension <= 15% -> +1
  extensionForcePoor: 0.35, // > 35% forces POOR
  contractionMax: 0.85, // ATR14/ATR63 <= 0.85 -> +1
  regimeOffensePoints: 1, // regime offense -> +1; panic forces POOR
  cuts: { good: 4, poorMax: 1 }, // >= 4 GOOD, 2-3 NEUTRAL, <= 1 POOR
  // Drawdown variant (drawdown >= 20%, the E2 context): GOOD instead
  // requires close > EMA20 AND a higher 5-day low; extension rule waived.
  drawdownVariant: {
    minDrawdown: 0.2,
    higherLowWindowDays: 5,
    ema: 20,
  },
} as const;

export type TVerdict = 'GOOD' | 'NEUTRAL' | 'POOR';

// ---------------------------------------------------------------------
// Quadrants
// ---------------------------------------------------------------------
export type Quadrant = 'PRIME' | 'WAIT' | 'RENT' | 'PASS';

// PRIME: F STRONG + T GOOD. WAIT: F STRONG, T not GOOD. RENT: F not
// STRONG, T GOOD. PASS: rest.
export function quadrantOf(f: FVerdict, t: TVerdict): Quadrant {
  if (f === 'STRONG' && t === 'GOOD') return 'PRIME';
  if (f === 'STRONG') return 'WAIT';
  if (t === 'GOOD') return 'RENT';
  return 'PASS';
}

// ---------------------------------------------------------------------
// Playbook (fixed)
// ---------------------------------------------------------------------
export const PLAYBOOK = {
  // Entry: next regular-session open after the event is public (t+1 open).
  entry: 't+1-open',
  exits: {
    E1: { maxTradingDays: 60, closeBeforeNextEarningsDays: 2 }, // min(60td, next earnings - 2d)
    E2: { maxTradingDays: 90 },
    E3: { maxTradingDays: 120 },
  },
  disasterStopPct: 0.15, // 15% close-to-close
  maxConcurrent: 15,
  sectorCapPct: 0.3, // 30%
  onePositionPerTicker: true,
  equalWeight: true,
} as const;

// Round-trip costs by sizeBucket at event (bps).
export const COST_BPS: Record<SizeBucket, number> = {
  LARGE: 20,
  MID: 40,
  SMALL: 80,
};

// ---------------------------------------------------------------------
// Pre-committed hypothesis thresholds (validation rule)
// ---------------------------------------------------------------------
export const VALIDATION = {
  window: { start: '2016-01-31', end: '2024-12-31' },
  benchmarks: { LARGE: 'SPY', MID: 'IWM', SMALL: 'IWM' } as Record<SizeBucket, string>,
  h1: { horizonTd: 60, minT: 3 }, // E1 agreement, MID+SMALL pooled
  h2: { horizonTd: 90, minT: 3 }, // E2 cluster-in-drawdown, all buckets
  h3: { horizonTd: 120, minT: 3 }, // E3 13D initiations
  h4: { horizonTd: 60, minT: 2 }, // PRIME minus PASS within E1
  h5: { minT: 2 }, // amihud monotonicity spread AND E2 fscore hi-lo
  book: { benchmark: 'IWM', minT: 2 },
} as const;

// ---------------------------------------------------------------------
// Cohort display floors
// ---------------------------------------------------------------------
export const COHORT = {
  maxActiveDimensions: 2,
  minNForStats: 30, // below => "insufficient history", no stats
  wideCiBelow: 100, // n in [30, 100) => wide-CI warning
} as const;
