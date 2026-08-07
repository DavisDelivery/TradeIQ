// RESEARCH-POLICY-1 (2026-08-07) — the standing rules every screen must obey.
//
// These are OWNER DECISIONS, ratified 2026-08-07 after two commissioned
// evidence reviews (reports/research-2026-08/screener-evidence.md and
// sector-evidence.md). They exist as executable policy rather than prose in
// a doc because this repo has already shipped one "standing rule" that lived
// only in a comment and drifted.
//
// WHY EACH ONE EXISTS — the measured justification, not a preference:
//
// 1. UNIVERSE: no microcaps, all of the Russell.
//    Hou, Xue & Zhang (2020) re-tested 447 published anomalies with NYSE
//    breakpoints and value-weighting and found 64% insignificant — 85% at
//    t>3. Their decisive lever is microcaps: 3% of total market cap but 60%
//    of the stock count, so equal-weighted tests overweight them enormously.
//    "Because of high costs in trading these stocks, anomalies in microcaps
//    are more apparent than real." We cannot trade them at ~$500/order
//    without paying the spread twice, so they are excluded — but the small-
//    cap Russell body above the floor stays in, which is where a retail
//    account has a genuine capacity advantage over a $50B fund.
//
// 2. HAIRCUT: halve every backtest number before display.
//    Chen, Lopez-Lira & Zimmermann find ~50% of predictability survives
//    post-sample — for peer-reviewed AND brute-force-mined signals alike.
//    Research Affiliates measured live smart-beta at +2.77%/yr before launch
//    and −0.44%/yr after, a median 73% Sharpe deterioration. A backtest
//    number shown raw is a forecast the data does not support.
//
// 3. DISCOVERY BAR: t > 3, not t > 2.
//    Harvey, Liu & Zhu (2016) show that with the breadth of search this app
//    performs, t>2 yields 27–53% false discoveries. At our search breadth we
//    would be mining, not discovering.
//
// 4. NET OF COSTS ONLY.
//    AAII's paper CAN SLIM screen reports +24%/yr. FFTY — the real-money
//    IBD-methodology ETF — has returned 5.2%/yr with −7.14% annualised
//    alpha, Sharpe 0.37 vs SPY 0.74. The entire gap is costs, slippage and
//    capacity. A gross number is not a smaller version of the truth; it is a
//    different claim.

/** Ratification date, for provenance in anything that renders these. */
export const POLICY_VERSION = '2026-08-07';

// ---------------------------------------------------------------------------
// 1. UNIVERSE FLOORS
// ---------------------------------------------------------------------------

/**
 * Market-cap floor, USD millions.
 *
 * $300M is the conventional microcap/small-cap line and sits comfortably
 * below the Russell 2000's median constituent, so "all of the Russell" is
 * preserved while the microcap tail — where the anomaly literature's
 * apparent edges live and where we cannot transact — is cut.
 */
export const MIN_MARKET_CAP_M = 300;

/**
 * Median daily dollar-volume floor.
 *
 * The binding constraint for tradeability is liquidity, not cap: a $400M
 * name that trades $200k/day cannot absorb an order without moving. $3M/day
 * is deliberately looser than the $10M FABLE used (that floor was tuned for
 * large caps and would have excluded most of the Russell), while still
 * meaning a $500 order is a rounding error against daily flow.
 */
export const MIN_MEDIAN_DOLLAR_VOL = 3_000_000;

/** Price floor. Sub-$5 names carry wide relative spreads and borrow quirks. */
export const MIN_PRICE = 5;

export interface UniverseCandidate {
  ticker: string;
  marketCapM?: number | null;
  medianDollarVol?: number | null;
  price?: number | null;
}

export type ExclusionReason = 'microcap' | 'illiquid' | 'price-floor' | 'no-data';

/**
 * Why a candidate is out, or null if it is in.
 *
 * MISSING DATA EXCLUDES. A name whose market cap we cannot read is not
 * assumed large — that assumption is how a microcap sneaks into a universe
 * that claims to have none, and the whole point of this module is that the
 * universe label is true.
 */
export function exclusionReason(c: UniverseCandidate): ExclusionReason | null {
  const cap = c.marketCapM;
  const dv = c.medianDollarVol;
  const px = c.price;
  if (!Number.isFinite(cap as number) || !Number.isFinite(px as number)) return 'no-data';
  if ((cap as number) < MIN_MARKET_CAP_M) return 'microcap';
  if ((px as number) < MIN_PRICE) return 'price-floor';
  // Dollar volume is optional input; when absent we cannot verify liquidity,
  // so it excludes for the same reason as above.
  if (!Number.isFinite(dv as number)) return 'no-data';
  if ((dv as number) < MIN_MEDIAN_DOLLAR_VOL) return 'illiquid';
  return null;
}

export interface UniverseFilterResult<T extends UniverseCandidate> {
  kept: T[];
  /** Ticker -> reason, so a screen can report exactly what it dropped. */
  excluded: Record<string, ExclusionReason>;
  counts: Record<ExclusionReason, number>;
}

/** Apply the universe policy, reporting every exclusion by reason. */
export function applyUniversePolicy<T extends UniverseCandidate>(
  candidates: T[],
): UniverseFilterResult<T> {
  const kept: T[] = [];
  const excluded: Record<string, ExclusionReason> = {};
  const counts: Record<ExclusionReason, number> = {
    microcap: 0, illiquid: 0, 'price-floor': 0, 'no-data': 0,
  };
  for (const c of candidates ?? []) {
    const reason = exclusionReason(c);
    if (reason) {
      excluded[c.ticker] = reason;
      counts[reason] += 1;
    } else {
      kept.push(c);
    }
  }
  return { kept, excluded, counts };
}

// ---------------------------------------------------------------------------
// 2. BACKTEST HAIRCUT
// ---------------------------------------------------------------------------

/** Fraction of a backtested edge assumed to survive out of sample. */
export const HAIRCUT_SURVIVAL = 0.5;

/**
 * Haircut an excess-return figure for display.
 *
 * Applies ONLY to positive edges. A backtested LOSS is not halved: halving
 * −74pp to −37pp would understate a measured failure, and the asymmetry is
 * the point — optimism gets discounted, pessimism does not get flattered.
 */
export function haircutExcess(excessPp: number | null | undefined): number | null {
  if (typeof excessPp !== 'number' || !Number.isFinite(excessPp)) return null;
  return excessPp > 0 ? excessPp * HAIRCUT_SURVIVAL : excessPp;
}

/** Display string for a haircut figure, always naming that it is haircut. */
export function haircutLabel(excessPp: number | null | undefined): string {
  const h = haircutExcess(excessPp);
  if (h === null) return 'not measured';
  const sign = h > 0 ? '+' : h < 0 ? '−' : '';
  const body = `${sign}${Math.abs(h).toFixed(1)}pp`;
  return excessPp! > 0 ? `${body} (50% haircut)` : body;
}

// ---------------------------------------------------------------------------
// 3. DISCOVERY BAR
// ---------------------------------------------------------------------------

/** Minimum |t| for an internally-discovered effect to be called an edge. */
export const MIN_DISCOVERY_T = 3;

/**
 * Does an effect clear the bar?
 *
 * Null t (unmeasured, or a standard error we never computed) is NOT a pass.
 * The lynch registry row shipped a bare IC of 0.0011 for months precisely
 * because nothing forced the question "compared to what error?".
 */
export function clearsDiscoveryBar(t: number | null | undefined): boolean {
  return typeof t === 'number' && Number.isFinite(t) && Math.abs(t) >= MIN_DISCOVERY_T;
}

/** Plain-language verdict for a measured effect. */
export function discoveryVerdict(t: number | null | undefined): string {
  if (typeof t !== 'number' || !Number.isFinite(t)) return 'NOT MEASURED (no t-statistic)';
  if (Math.abs(t) >= MIN_DISCOVERY_T) return `CLEARS BAR (|t| ${Math.abs(t).toFixed(2)} ≥ 3)`;
  if (Math.abs(t) >= 2) return `BELOW BAR (|t| ${Math.abs(t).toFixed(2)} — t>2 is mining at our search breadth)`;
  return `NO EVIDENCE (|t| ${Math.abs(t).toFixed(2)})`;
}

// ---------------------------------------------------------------------------
// 4. COSTS
// ---------------------------------------------------------------------------

/**
 * Round-trip cost assumption in basis points, by liquidity tier.
 *
 * Applied to every displayed backtest. Wider for small caps because that is
 * where the spread actually is — using a single large-cap number across the
 * Russell is how a paper portfolio beats a real one.
 */
export const ROUND_TRIP_BPS = {
  largeCap: 10,
  smallCap: 30,
} as const;

/** Tier a name by market cap for cost purposes. */
export function costTier(marketCapM: number | null | undefined): keyof typeof ROUND_TRIP_BPS {
  return typeof marketCapM === 'number' && marketCapM >= 10_000 ? 'largeCap' : 'smallCap';
}

/** True when a figure may be shown to the user (i.e. it is net of costs). */
export function isDisplayable(opts: { netOfCosts: boolean }): boolean {
  return opts.netOfCosts === true;
}
