// PROFILE-1 — the DIRECTION TABLE.
//
// One arrow policy per metric, as code, in ONE place. Both the profile's
// stat rows and the W3 peer sheet read this, so a metric cannot be
// descriptive in one surface and judged in the other.
//
// WHY MOST OF THE TABLE IS "NEUTRAL", WHICH LOOKS LIKE A COP-OUT AND IS NOT:
//
//   A low P/E is not good news. It is the market's price for a set of
//   expectations, and the single most reliable thing about the cheapest
//   decile is that a chunk of it is cheap for cause. Painting it green
//   tells the user something the data does not support, and it is the exact
//   mechanism of the value trap. Same for beta and ATR: low volatility is
//   not virtue, and the low-vol literature exists precisely because the
//   naive ranking is backwards.
//
//   So valuation, volatility and ownership metrics render as COMPARISONS —
//   "cheaper than 72% of peers" — never as verdicts. The user supplies the
//   judgement; we supply the position in the distribution.
//
// This file replaces the `favorability()` helper that shipped in
// KeyMetricsPanel, which gave P/E a `dir: 'lower'` and painted a cheap stock
// emerald. That was a good/bad verdict on a valuation metric, which is the
// thing the profile now forbids.

export type Direction =
  /** Descriptive only. Render position in the distribution, never good/bad. */
  | 'neutral'
  /** Higher is better, WITHIN INDUSTRY ONLY. */
  | 'higher-in-industry'
  /** A healthy band; outside it in either direction is worth noticing. */
  | 'band'
  /** Noteworthy in both directions — state both readings, pick neither. */
  | 'flag';

export interface MetricPolicy {
  /** Stable key, also the peer-pool key. */
  key: string;
  label: string;
  direction: Direction;
  /** Healthy range for `band` metrics, inclusive. */
  band?: { low: number; high: number };
  /**
   * Shown wherever the metric is ranked. These are not footnotes for
   * completeness — each one names a specific way the arrow misleads.
   */
  caveat?: string;
  /** Metrics whose value should be shown alongside, for the caveat to work. */
  showBeside?: string[];
  /** Peer pool must be industry-level, not sector-level, to mean anything. */
  industryOnly?: boolean;
  /** Rows excluded from the pool because the ratio is undefined there. */
  excludes?: 'negative-denominator' | 'financials' | 'non-payers';
}

export const METRIC_POLICY: Record<string, MetricPolicy> = {
  // --- NEUTRAL: descriptive, never a verdict --------------------------------
  pe: { key: 'pe', label: 'P/E', direction: 'neutral', excludes: 'negative-denominator',
    caveat: 'Cheap is not good or bad on its own; the cheapest decile contains both bargains and businesses in decline.' },
  forwardPe: { key: 'forwardPe', label: 'Forward P/E', direction: 'neutral', excludes: 'negative-denominator',
    caveat: 'Rests on consensus estimates, which are revised toward the outcome as it approaches.' },
  ps: { key: 'ps', label: 'P/S', direction: 'neutral' },
  pb: { key: 'pb', label: 'P/B', direction: 'neutral',
    caveat: 'Book value understates intangible-heavy businesses; the ratio is least comparable across industries.' },
  evEbitda: { key: 'evEbitda', label: 'EV/EBITDA', direction: 'neutral', excludes: 'negative-denominator' },
  pfcf: { key: 'pfcf', label: 'P/FCF', direction: 'neutral', excludes: 'negative-denominator' },
  fcfYield: { key: 'fcfYield', label: 'FCF yield', direction: 'neutral' },
  dividendYield: { key: 'dividendYield', label: 'Dividend yield', direction: 'neutral',
    caveat: 'A high yield is often a falling price rather than a rising payout.' },
  beta: { key: 'beta', label: 'Beta', direction: 'neutral',
    caveat: 'Low beta is not safety. The low-volatility literature exists because the naive ranking runs backwards.' },
  rsi14: { key: 'rsi14', label: 'RSI (14)', direction: 'neutral' },
  atrPct: { key: 'atrPct', label: 'ATR %', direction: 'neutral',
    caveat: 'A position-sizing input, not a signal.' },
  instOwnPct: { key: 'instOwnPct', label: 'Institutional own.', direction: 'neutral' },
  insiderOwnPct: { key: 'insiderOwnPct', label: 'Insider own.', direction: 'neutral' },

  // --- HIGHER, within industry only -----------------------------------------
  grossMargin: { key: 'grossMargin', label: 'Gross margin', direction: 'higher-in-industry', industryOnly: true },
  opMargin: { key: 'opMargin', label: 'Operating margin', direction: 'higher-in-industry', industryOnly: true },
  netMargin: { key: 'netMargin', label: 'Net margin', direction: 'higher-in-industry', industryOnly: true,
    caveat: 'Net margin absorbs one-off items; a single disposal or write-down can dominate the quarter.' },
  roa: { key: 'roa', label: 'ROA', direction: 'higher-in-industry', industryOnly: true },
  roe: { key: 'roe', label: 'ROE', direction: 'higher-in-industry', industryOnly: true,
    caveat: 'ROE rises with leverage. Read it next to debt/equity or it rewards balance-sheet risk.',
    showBeside: ['debtEquity'] },
  interestCoverage: { key: 'interestCoverage', label: 'Interest coverage', direction: 'higher-in-industry', industryOnly: true },
  revenueGrowth: { key: 'revenueGrowth', label: 'Revenue growth', direction: 'higher-in-industry', industryOnly: true },
  epsGrowth: { key: 'epsGrowth', label: 'EPS growth', direction: 'higher-in-industry', industryOnly: true,
    caveat: 'Buybacks raise EPS growth without raising earnings. Read it next to revenue growth.',
    showBeside: ['revenueGrowth'] },

  // --- BAND ------------------------------------------------------------------
  debtEquity: { key: 'debtEquity', label: 'Debt / equity', direction: 'band', industryOnly: true,
    excludes: 'financials',
    caveat: 'Only comparable inside an industry, and meaningless for financials, whose balance sheets are the business.' },
  currentRatio: { key: 'currentRatio', label: 'Current ratio', direction: 'band', band: { low: 1.2, high: 3 },
    caveat: 'Far above the band is idle capital, not strength.' },
  quickRatio: { key: 'quickRatio', label: 'Quick ratio', direction: 'band', band: { low: 0.8, high: 3 } },
  payoutRatio: { key: 'payoutRatio', label: 'Payout ratio', direction: 'band', band: { low: 0, high: 60 },
    excludes: 'non-payers',
    caveat: 'Payers only. Above ~60% the dividend depends on earnings holding up.' },

  // --- FLAG -------------------------------------------------------------------
  shortFloatPct: { key: 'shortFloatPct', label: 'Short float', direction: 'flag',
    caveat: 'Elevated short interest is both a bearish position and squeeze fuel. Read it with days-to-cover; neither reading is the default.',
    showBeside: ['shortRatio'] },
  /**
   * Days-to-cover, and a first-class row rather than a decoration.
   *
   * Short interest ALONE lost its predictive significance after 2000 (Hong
   * et al.); the form that survived is short interest scaled by liquidity —
   * how many days of normal volume it would take to buy the position back.
   * So shortFloatPct's caveat points here, and this must exist for that
   * pointer to resolve. Shipping the float percentage without it would be
   * shipping the half of the pair the evidence retired.
   */
  shortRatio: { key: 'shortRatio', label: 'Days to cover', direction: 'flag',
    caveat: 'Short interest scaled by average volume. This is the form that retained significance after 2000; the raw float percentage did not.' },
};

/** Metrics that must never carry a good/bad verdict. */
export const NEUTRAL_METRICS = Object.values(METRIC_POLICY)
  .filter((p) => p.direction === 'neutral')
  .map((p) => p.key);

export const policyFor = (key: string): MetricPolicy | null => METRIC_POLICY[key] ?? null;

/**
 * Whether a metric may render a favourable/unfavourable treatment.
 *
 * The single guard the gate test asserts against. `neutral` and `flag` both
 * return false — a flag is noteworthy in BOTH directions, so colouring it
 * would pick a side the evidence does not.
 */
export function mayRenderVerdict(key: string): boolean {
  const p = policyFor(key);
  if (!p) return false; // unknown metric: descriptive until someone decides
  return p.direction === 'higher-in-industry' || p.direction === 'band';
}

/**
 * Comparative wording for a percentile. Deliberately has no good/bad register.
 *
 * "Cheaper than 72% of peers" is a fact about the distribution. "Attractively
 * valued" is a claim about the future, and it is not ours to make from a
 * cross-sectional rank.
 */
export function comparativePhrase(key: string, percentile: number): string {
  const p = policyFor(key);
  const pct = Math.round(percentile * 100);
  const label = p?.label ?? key;
  if (!p) return `${label}: ${pct}th percentile of peers`;

  switch (p.direction) {
    case 'neutral':
      return `${label} sits at the ${pct}th percentile of its peer group`;
    case 'higher-in-industry':
      return `${label} is higher than ${pct}% of industry peers`;
    case 'band':
      return `${label} sits at the ${pct}th percentile; the reference band matters more than the rank`;
    case 'flag':
      return `${label} is higher than ${pct}% of peers — read with days-to-cover`;
  }
}
