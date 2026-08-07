// QV-1 (2026-08-07) — integrated quality-value scoring.
//
// The strongest-evidence construction in reports/research-2026-08/
// screener-evidence.md, built to the letter of what actually replicated:
//
//   * QUALITY = gross profits / total assets (Novy-Marx 2013). Top-vs-bottom
//     quintile +0.31%/month over 1963-2010, replicated across 19 developed
//     markets, adopted by Fama-French as RMW, and per CFA Institute's 2022
//     review "the power of the factor has not diminished".
//
//     THE DEFINITION IS LOAD-BEARING. Hou/Xue/Zhang found Fama-French's
//     operating-profits-to-BOOK-EQUITY fails replication while cash-based
//     operating-profits-to-ASSETS survives even their q-factor model. The
//     denominator is the whole point, and it is why this module refuses to
//     substitute gross MARGIN (gross profit / revenue) for gross
//     PROFITABILITY (gross profit / assets) — see `qualityFromMargin`.
//
//   * VALUE = a composite of several cheapness ratios, never P/B alone.
//     HML's book-to-market operationalisation is what broke in the 2010s
//     (55% drawdown over 13.3 years); Arnott et al. (2021) attribute it to
//     spread-widening and intangibles, not to the premium disappearing.
//
//   * INTEGRATED, not two sleeves. Fisher, Shah & Titman (2016): scoring
//     each stock on both signals simultaneously beats blending two
//     independently-formed portfolios — lower turnover, and it avoids buying
//     names that are excellent on one axis and terrible on the other.
//     Novy-Marx: "cheap, profitable firms tend to outperform firms that are
//     just cheap or just profitable."
//
// Scores are CROSS-SECTIONAL PERCENTILES, not raw ratios. A P/E of 12 means
// nothing absolute; being cheaper than 80% of a comparable universe means
// something. Percentiles also make the two axes commensurable so they can be
// averaged without one silently dominating on units.

import { applyUniversePolicy, type UniverseCandidate } from './research-policy';

export interface QVInput extends UniverseCandidate {
  ticker: string;
  sector?: string | null;
  // --- quality, best first ---
  /** Novy-Marx numerator, absolute currency. */
  grossProfit?: number | null;
  /** Novy-Marx denominator, absolute currency. */
  totalAssets?: number | null;
  /** Fallback quality proxy when the statements are unavailable. */
  roicPct?: number | null;
  // --- value ---
  pe?: number | null;
  ps?: number | null;
  pb?: number | null;
  /** Free-cash-flow yield in percent, when available. */
  fcfYieldPct?: number | null;
}

export type QualityBasis = 'gross-profits-to-assets' | 'roic-proxy' | 'none';

/**
 * Novy-Marx gross profitability. Null unless BOTH statement inputs are real.
 *
 * Deliberately strict: a quality score computed from a missing denominator
 * is not a weaker measurement, it is a different one.
 */
export function grossProfitsToAssets(
  grossProfit: number | null | undefined,
  totalAssets: number | null | undefined,
): number | null {
  if (!Number.isFinite(grossProfit as number) || !Number.isFinite(totalAssets as number)) return null;
  if ((totalAssets as number) <= 0) return null;
  return (grossProfit as number) / (totalAssets as number);
}

/**
 * Why gross MARGIN is not accepted as a substitute — kept as an exported,
 * documented refusal so nobody re-adds it as a convenience.
 *
 * Gross margin is GP/revenue; gross profitability is GP/assets. They differ
 * by asset turnover, and the asset scaling is precisely what Novy-Marx's
 * result rests on. A capital-light software firm and a capital-heavy
 * manufacturer can share a gross margin and sit at opposite ends of gross
 * profitability.
 */
export function qualityFromMargin(): null {
  return null;
}

/** Rank-percentile of each value, 0..1, best-first per `higherIsBetter`. */
export function percentileRank(
  values: Array<number | null | undefined>,
  higherIsBetter: boolean,
): Array<number | null> {
  const idx: Array<{ i: number; v: number }> = [];
  values.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) idx.push({ i, v });
  });
  if (idx.length === 0) return values.map(() => null);
  idx.sort((a, b) => (higherIsBetter ? b.v - a.v : a.v - b.v));
  const out: Array<number | null> = values.map(() => null);
  // Average ranks within ties so equal inputs get equal scores.
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
    const avgRank = (k + j) / 2;
    const pct = idx.length === 1 ? 1 : 1 - avgRank / (idx.length - 1);
    for (let m = k; m <= j; m++) out[idx[m].i] = pct;
    k = j + 1;
  }
  return out;
}

export interface QVScore {
  ticker: string;
  /** 0..1, higher = cheaper AND more profitable. Null if either axis is unscorable. */
  composite: number | null;
  qualityPct: number | null;
  valuePct: number | null;
  qualityBasis: QualityBasis;
  /** How many of the value ratios were available for this name. */
  valueInputs: number;
  gpToAssets: number | null;
}

export interface QVResult {
  scored: QVScore[];
  /** Universe-policy exclusions, by reason. */
  excluded: Record<string, string>;
  /** Names that passed the universe but could not be scored, and why. */
  unscorable: Record<string, 'no-quality' | 'no-value'>;
  /** How many names used the true metric vs the fallback proxy. */
  qualityBasisCounts: Record<QualityBasis, number>;
}

/** Minimum value ratios required before a value percentile is trusted. */
export const MIN_VALUE_INPUTS = 2;

/**
 * Score a candidate set.
 *
 * Order of operations matters and is deliberate:
 *   1. Universe policy first (research-policy.ts) — percentiles computed over
 *      a universe that includes microcaps would rank every survivor against
 *      names we cannot trade, distorting both axes.
 *   2. Percentile each axis over the SURVIVING set.
 *   3. Average the two percentiles into one integrated score.
 */
export function scoreQualityValue(candidates: QVInput[]): QVResult {
  const { kept, excluded } = applyUniversePolicy(candidates ?? []);

  const gp = kept.map((c) => grossProfitsToAssets(c.grossProfit, c.totalAssets));
  const qualityBasis: QualityBasis[] = kept.map((c, i) =>
    gp[i] !== null ? 'gross-profits-to-assets'
      : Number.isFinite(c.roicPct as number) ? 'roic-proxy'
        : 'none',
  );
  // One percentile per basis, computed within its own cohort: ranking a
  // GP/A value against an ROIC value would be comparing different units.
  const gpPct = percentileRank(gp, true);
  const roicPct = percentileRank(
    kept.map((c, i) => (qualityBasis[i] === 'roic-proxy' ? c.roicPct : null)),
    true,
  );

  // Value: lower is better on every ratio except FCF yield.
  const pePct = percentileRank(kept.map((c) => (num(c.pe) && c.pe > 0 ? c.pe : null)), false);
  const psPct = percentileRank(kept.map((c) => (num(c.ps) && c.ps > 0 ? c.ps : null)), false);
  const pbPct = percentileRank(kept.map((c) => (num(c.pb) && c.pb > 0 ? c.pb : null)), false);
  const fcfPct = percentileRank(kept.map((c) => c.fcfYieldPct), true);

  const unscorable: Record<string, 'no-quality' | 'no-value'> = {};
  const qualityBasisCounts: Record<QualityBasis, number> = {
    'gross-profits-to-assets': 0, 'roic-proxy': 0, none: 0,
  };

  const scored: QVScore[] = kept.map((c, i) => {
    qualityBasisCounts[qualityBasis[i]] += 1;

    const qp = qualityBasis[i] === 'gross-profits-to-assets' ? gpPct[i]
      : qualityBasis[i] === 'roic-proxy' ? roicPct[i]
        : null;

    const parts = [pePct[i], psPct[i], pbPct[i], fcfPct[i]].filter(
      (v): v is number => v !== null,
    );
    const vp = parts.length >= MIN_VALUE_INPUTS
      ? parts.reduce((a, b) => a + b, 0) / parts.length
      : null;

    if (qp === null) unscorable[c.ticker] = 'no-quality';
    else if (vp === null) unscorable[c.ticker] = 'no-value';

    return {
      ticker: c.ticker,
      // Integrated: one score from both axes. A name unscorable on either
      // axis gets NO composite rather than a half-score — a stock ranked on
      // cheapness alone is exactly the Dreman failure mode (his fund held
      // Fannie, Freddie, Wachovia and WaMu into 2008 and lost 46%).
      composite: qp !== null && vp !== null ? (qp + vp) / 2 : null,
      qualityPct: qp,
      valuePct: vp,
      qualityBasis: qualityBasis[i],
      valueInputs: parts.length,
      gpToAssets: gp[i],
    };
  });

  scored.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
  return { scored, excluded, unscorable, qualityBasisCounts };
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
