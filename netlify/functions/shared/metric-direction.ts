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
  /**
   * What the number IS, in one plain sentence — required, not optional.
   *
   * PROFILE-1 W3.2. The drawer's job is to answer "what am I looking at?"
   * before it answers "where does it sit?". A metric with no peer pool used
   * to open to a bare refusal, which taught the reader that most rows were
   * not worth tapping. A definition is always available, so a drawer is
   * never empty and the tap is never wasted.
   */
  meaning: string;
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
    meaning: 'Share price divided by earnings per share — what you pay for each dollar the company earns.',
    caveat: 'Cheap is not good or bad on its own; the cheapest decile contains both bargains and businesses in decline.' },
  forwardPe: { key: 'forwardPe', label: 'Forward P/E', direction: 'neutral', excludes: 'negative-denominator',
    meaning: 'The same ratio against next year’s expected earnings rather than the last twelve months’.',
    caveat: 'Rests on consensus estimates, which are revised toward the outcome as it approaches.' },
  ps: { key: 'ps', label: 'P/S', direction: 'neutral',
    meaning: 'Market value divided by revenue — used where earnings are negative or too lumpy to price against.' },
  pb: { key: 'pb', label: 'P/B', direction: 'neutral',
    meaning: 'Market value divided by accounting book value — what you pay for each dollar of net assets on the balance sheet.',
    caveat: 'Book value understates intangible-heavy businesses; the ratio is least comparable across industries.' },
  evEbitda: { key: 'evEbitda', label: 'EV/EBITDA', direction: 'neutral', excludes: 'negative-denominator',
    meaning: 'Enterprise value over pre-tax operating cash earnings — a valuation that includes debt, so it compares across capital structures.' },
  pfcf: { key: 'pfcf', label: 'P/FCF', direction: 'neutral', excludes: 'negative-denominator',
    meaning: 'Market value divided by free cash flow — the same idea as P/E, but on cash actually generated rather than accounting earnings.' },
  fcfYield: { key: 'fcfYield', label: 'FCF yield', direction: 'neutral',
    meaning: 'Free cash flow as a percentage of market value — P/FCF turned upside down and read like an interest rate.' },
  dividendYield: { key: 'dividendYield', label: 'Dividend yield', direction: 'neutral',
    meaning: 'Annual dividend as a percentage of the current share price.',
    caveat: 'A high yield is often a falling price rather than a rising payout.' },
  beta: { key: 'beta', label: 'Beta', direction: 'neutral',
    meaning: 'How far the stock tends to move when the market moves 1% — measured here over the last year of daily returns.',
    caveat: 'Low beta is not safety. The low-volatility literature exists because the naive ranking runs backwards.' },
  rsi14: { key: 'rsi14', label: 'RSI (14)', direction: 'neutral',
    meaning: 'A 0–100 momentum oscillator over 14 sessions; high means it has risen on most recent days, not that it is overpriced.' },
  atrPct: { key: 'atrPct', label: 'ATR %', direction: 'neutral',
    meaning: 'Average daily trading range as a percentage of price — how far this name moves on an ordinary day.',
    caveat: 'A position-sizing input, not a signal.' },
  instOwnPct: { key: 'instOwnPct', label: 'Institutional own.', direction: 'neutral',
    meaning: 'The share of stock held by funds, pensions and other professional managers.' },
  insiderOwnPct: { key: 'insiderOwnPct', label: 'Insider own.', direction: 'neutral',
    meaning: 'The share of stock held by officers and directors — how much of their own wealth is in the outcome.' },
  insiderTransPct: { key: 'insiderTransPct', label: 'Insider net trans.', direction: 'neutral',
    meaning: 'Net change in insider holdings over the recent reporting window, as a percentage of what they held.',
    caveat: 'Static ownership and net transactions are not the cluster signal — a routine scheduled sale looks identical here to a discretionary one.' },
  marketCap: { key: 'marketCap', label: 'Market cap', direction: 'neutral',
    meaning: 'Share price times shares outstanding — the equity value of the whole company.' },
  enterpriseValue: { key: 'enterpriseValue', label: 'Enterprise value', direction: 'neutral',
    meaning: 'Market cap plus debt minus cash — what it would cost to buy the business outright rather than just its equity.' },
  eps: { key: 'eps', label: 'EPS', direction: 'neutral',
    meaning: 'Earnings per share over the last twelve months.',
    caveat: 'Per-share figures depend on how many shares exist, so the raw number says nothing across companies.' },
  range52wPct: { key: 'range52wPct', label: '52w position', direction: 'neutral',
    meaning: 'Where the current price sits between its 52-week low (0%) and high (100%).' },
  relativeVolume: { key: 'relativeVolume', label: 'Rel. volume', direction: 'neutral',
    meaning: 'Today’s volume against this name’s own recent average — 2.0 means twice its normal activity.',
    caveat: 'Unusual volume says attention, not direction.' },

  // --- HIGHER, within industry only -----------------------------------------
  grossMargin: { key: 'grossMargin', label: 'Gross margin', direction: 'higher-in-industry', industryOnly: true,
    meaning: 'What percentage of revenue survives the direct cost of producing it — the pricing power in the product itself.' },
  opMargin: { key: 'opMargin', label: 'Operating margin', direction: 'higher-in-industry', industryOnly: true,
    meaning: 'What percentage of revenue survives after running the business, before interest and tax.' },
  netMargin: { key: 'netMargin', label: 'Net margin', direction: 'higher-in-industry', industryOnly: true,
    meaning: 'What percentage of revenue reaches the bottom line after every cost, including interest and tax.',
    caveat: 'Net margin absorbs one-off items; a single disposal or write-down can dominate the quarter.' },
  roa: { key: 'roa', label: 'ROA', direction: 'higher-in-industry', industryOnly: true,
    meaning: 'Profit as a percentage of everything the company owns — how hard the asset base works.' },
  roe: { key: 'roe', label: 'ROE', direction: 'higher-in-industry', industryOnly: true,
    meaning: 'Profit as a percentage of shareholders’ equity — the return on the capital owners actually put in.',
    caveat: 'ROE rises with leverage. Read it next to debt/equity or it rewards balance-sheet risk.',
    showBeside: ['debtEquity'] },
  interestCoverage: { key: 'interestCoverage', label: 'Interest coverage', direction: 'higher-in-industry', industryOnly: true,
    meaning: 'How many times over operating profit covers the interest bill.' },
  revenueGrowth: { key: 'revenueGrowth', label: 'Revenue growth', direction: 'higher-in-industry', industryOnly: true,
    meaning: 'Change in sales against the same quarter a year ago.' },
  epsGrowth: { key: 'epsGrowth', label: 'EPS growth', direction: 'higher-in-industry', industryOnly: true,
    meaning: 'Change in earnings per share against the same quarter a year ago.',
    caveat: 'Buybacks raise EPS growth without raising earnings. Read it next to revenue growth.',
    showBeside: ['revenueGrowth'] },

  // --- BAND ------------------------------------------------------------------
  debtEquity: { key: 'debtEquity', label: 'Debt / equity', direction: 'band', industryOnly: true,
    excludes: 'financials',
    meaning: 'Borrowings measured against shareholders’ equity — how much of the business is funded by lenders rather than owners.',
    caveat: 'Only comparable inside an industry, and meaningless for financials, whose balance sheets are the business.' },
  currentRatio: { key: 'currentRatio', label: 'Current ratio', direction: 'band', band: { low: 1.2, high: 3 },
    meaning: 'Assets due within a year divided by bills due within a year — whether short-term obligations are covered.',
    caveat: 'Far above the band is idle capital, not strength.' },
  quickRatio: { key: 'quickRatio', label: 'Quick ratio', direction: 'band', band: { low: 0.8, high: 3 },
    meaning: 'The current ratio with inventory removed — the same test using only assets that convert to cash quickly.' },
  payoutRatio: { key: 'payoutRatio', label: 'Payout ratio', direction: 'band', band: { low: 0, high: 60 },
    excludes: 'non-payers',
    meaning: 'The percentage of earnings paid out as dividends rather than retained.',
    caveat: 'Payers only. Above ~60% the dividend depends on earnings holding up.' },

  // --- FLAG -------------------------------------------------------------------
  shortFloatPct: { key: 'shortFloatPct', label: 'Short float', direction: 'flag',
    meaning: 'The percentage of freely tradable shares currently sold short — borrowed and sold by someone betting the price falls.',
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
    meaning: 'How many sessions of normal volume it would take short sellers to buy back their whole position.',
    caveat: 'Short interest scaled by average volume. This is the form that retained significance after 2000; the raw float percentage did not.' },

  // --- ABSOLUTE MAGNITUDES ---------------------------------------------------
  // Real metrics with real meanings, and a cross-sectional rank would be a
  // restatement of company size. See NOT_RANKABLE in peer-stats.ts.
  longTermDebt: { key: 'longTermDebt', label: 'Long-term debt', direction: 'neutral',
    meaning: 'Borrowings not due within the next year, in dollars.',
    caveat: 'The dollar amount alone says nothing — a large balance is ordinary for a large company. Debt/equity is the comparable form.',
    showBeside: ['debtEquity'] },
  freeCashFlow: { key: 'freeCashFlow', label: 'Free cash flow', direction: 'neutral',
    meaning: 'Cash left from operations after the spending needed to maintain the business.',
    caveat: 'An absolute figure scales with company size. P/FCF and FCF yield are the comparable forms.',
    showBeside: ['pfcf'] },
  advDollar: { key: 'advDollar', label: 'Avg $ volume', direction: 'neutral',
    meaning: 'Typical dollars traded per session — the practical ceiling on how much you can buy without moving the price.' },
  atr: { key: 'atr', label: 'ATR', direction: 'neutral',
    meaning: 'Average daily trading range in dollars — the unit a stop is written in.',
    caveat: 'Dollars are not comparable between names at different prices; ATR % is.',
    showBeside: ['atrPct'] },
  floatM: { key: 'floatM', label: 'Float', direction: 'neutral',
    meaning: 'Shares actually available to trade, excluding closely held blocks.',
    caveat: 'A small float amplifies moves in both directions; on its own it favours neither.' },
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
