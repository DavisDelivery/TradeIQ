// Unified earnings intelligence — single source of truth used by Prophet, Lynch,
// Earnings, Catalyst, Williams, and Target boards. Returns everything earnings-
// related in one object so each board can reference the same metrics.

import {
  getFundamentals, getEarningsHistory, getUpcomingEarnings,
  type FundamentalsSnapshot, type EarningsSurprise, type UpcomingEarning,
} from './data-provider';

export interface EarningsIntel {
  ticker: string;

  // Growth metrics (TTM / YoY from Polygon fundamentals)
  revenueGrowthYoY?: number;
  epsGrowthYoY?: number;
  ttmEps?: number;
  operatingMargin?: number;
  grossMargin?: number;

  // Quarterly acceleration: is the growth rate itself speeding up?
  // Positive = latest quarter's YoY growth exceeds prior quarter's YoY growth.
  // This is the single strongest CANSLIM "C" signal.
  epsAcceleration?: number;  // in percentage-point terms, e.g. 0.05 = growth accelerated by 5pp

  // Earnings surprise history (Finnhub)
  beatsLast4?: number;         // 0-4: count of beats in last 4 quarters
  avgSurpriseMagnitude?: number; // average actual-vs-estimate % (positive = beat bias)
  latestSurprisePct?: number;  // most recent quarter's surprise %
  streak?: 'beats' | 'misses' | 'mixed';  // consistency pattern

  // Forward-looking timing
  nextEarningsDate?: string;   // ISO date
  daysUntilEarnings?: number;  // positive = ahead, null if none known
  epsEstimateNext?: number;
  postEarningsDrift?: boolean; // true if last report was a beat AND reported 3-10 trading days ago

  // Pre-computed flags for UI chips
  flags: string[];
}

export async function getEarningsIntel(
  ticker: string,
  opts: { asOfDate?: string } = {},
): Promise<EarningsIntel> {
  const [fund, history, upcoming] = await Promise.all([
    getFundamentals(ticker, { asOfDate: opts.asOfDate }).catch(() => null),
    getEarningsHistory(ticker, 8, { asOfDate: opts.asOfDate }).catch(() => [] as EarningsSurprise[]),
    getUpcomingEarnings(ticker, 90, { asOfDate: opts.asOfDate }).catch(() => null),
  ]);

  const flags: string[] = [];

  // Quarterly acceleration: compute growth rate two consecutive quarters and compare.
  // Use history rather than fundamentals since history has more consistent quarterly cadence.
  let epsAcceleration: number | undefined;
  if (history.length >= 5) {
    // Latest vs 4q ago (YoY for latest quarter)
    const latestYoY = safeGrowth(history[0].epsActual, history[4].epsActual);
    // Prior quarter vs 5q ago (YoY for prior quarter)
    const priorYoY = history.length >= 6 ? safeGrowth(history[1].epsActual, history[5].epsActual) : undefined;
    if (latestYoY !== undefined && priorYoY !== undefined) {
      epsAcceleration = latestYoY - priorYoY;
      if (epsAcceleration > 0.10) flags.push('eps_accelerating');
      else if (epsAcceleration < -0.15) flags.push('eps_decelerating');
    }
  }

  // Surprise metrics from the last 4 reports
  const last4 = history.slice(0, 4);
  const surprises = last4
    .map((r) => r.surprisePct ?? safeSurprise(r.epsActual, r.epsEstimate))
    .filter((n): n is number => Number.isFinite(n));

  const beatsLast4 = surprises.filter((s) => s > 0).length;
  const avgSurpriseMagnitude = surprises.length
    ? surprises.reduce((a, b) => a + b, 0) / surprises.length
    : undefined;
  const latestSurprisePct = surprises[0];

  let streak: EarningsIntel['streak'];
  if (surprises.length >= 3) {
    const allBeats = surprises.slice(0, 4).every((s) => s > 0);
    const allMisses = surprises.slice(0, 4).every((s) => s < 0);
    streak = allBeats ? 'beats' : allMisses ? 'misses' : 'mixed';
    if (allBeats && beatsLast4 >= 3) flags.push('beats_streak');
    if (allMisses) flags.push('misses_streak');
  }

  if (latestSurprisePct !== undefined) {
    if (latestSurprisePct > 10) flags.push('blowout_beat');
    else if (latestSurprisePct < -10) flags.push('big_miss');
  }

  // PIT-correct "now" — when asOfDate is supplied (backtest path), we
  // compute days-until / days-since relative to it, not the wall clock.
  const nowMs = opts.asOfDate
    ? new Date(`${opts.asOfDate}T12:00:00Z`).getTime()
    : Date.now();

  // Earnings proximity
  const daysUntilEarnings = upcoming?.date
    ? Math.round((new Date(upcoming.date).getTime() - nowMs) / 86400000)
    : undefined;

  if (daysUntilEarnings !== undefined) {
    if (daysUntilEarnings >= 0 && daysUntilEarnings <= 5) flags.push('earnings_imminent');
    else if (daysUntilEarnings > 5 && daysUntilEarnings <= 14) flags.push('earnings_soon');
  }

  // Post-earnings drift: was the most recent report a beat, within the past 3-10 trading days?
  // This is a well-documented edge (PEAD) — post-earnings-announcement drift.
  let postEarningsDrift = false;
  if (history.length > 0 && latestSurprisePct !== undefined && latestSurprisePct > 0) {
    const lastReportDate = new Date(history[0].date);
    const daysSince = (nowMs - lastReportDate.getTime()) / 86400000;
    if (daysSince >= 3 && daysSince <= 14) {
      postEarningsDrift = true;
      flags.push('post_earnings_drift');
    }
  }

  // Growth magnitude flags
  if (fund?.epsGrowthYoY !== undefined) {
    if (fund.epsGrowthYoY > 0.25) flags.push('eps_growth_strong');
    else if (fund.epsGrowthYoY > 0.10) flags.push('eps_growth_healthy');
    else if (fund.epsGrowthYoY < -0.10) flags.push('eps_contracting');
  }
  if (fund?.revenueGrowthYoY !== undefined) {
    if (fund.revenueGrowthYoY > 0.20) flags.push('rev_growth_strong');
  }

  return {
    ticker,
    revenueGrowthYoY: fund?.revenueGrowthYoY,
    epsGrowthYoY: fund?.epsGrowthYoY,
    ttmEps: fund?.ttmEps,
    operatingMargin: fund?.operatingMargin,
    grossMargin: fund?.grossMargin,
    epsAcceleration,
    beatsLast4,
    avgSurpriseMagnitude,
    latestSurprisePct,
    streak,
    nextEarningsDate: upcoming?.date,
    daysUntilEarnings,
    epsEstimateNext: upcoming?.epsEstimate,
    postEarningsDrift,
    flags,
  };
}

function safeGrowth(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return undefined;
  return (a - b) / Math.abs(b);
}

function safeSurprise(actual: number | undefined, est: number | undefined): number | undefined {
  if (actual === undefined || est === undefined) return undefined;
  if (!Number.isFinite(actual) || !Number.isFinite(est) || est === 0) return undefined;
  return ((actual - est) / Math.abs(est)) * 100;
}

// ---------------------------------------------------------------------------
// Scoring helpers — used by any board that wants an earnings-quality score
// ---------------------------------------------------------------------------

/**
 * Produces a 0-100 earnings quality score. Weighting:
 *   +30  EPS growth YoY > 25%
 *   +20  Acceleration (Q/Q YoY rate rising)
 *   +25  Beats streak (3+ of 4)
 *   +15  Post-earnings drift (recent beat, still in drift window)
 *   +10  Revenue growth confirmation (>15% YoY)
 *   -20  EPS contraction
 *   -15  Recent big miss
 *   -10  Misses streak
 */
export function scoreEarningsQuality(intel: EarningsIntel): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 50; // neutral baseline

  const epsGrowth = intel.epsGrowthYoY ?? 0;
  if (epsGrowth > 0.50) { score += 35; flags.push('eps_growth_>50%'); }
  else if (epsGrowth > 0.25) { score += 25; flags.push('eps_growth_>25%'); }
  else if (epsGrowth > 0.10) score += 15;
  else if (epsGrowth > 0) score += 5;
  else if (epsGrowth < -0.10) { score -= 20; flags.push('eps_contracting'); }

  if (intel.epsAcceleration !== undefined) {
    if (intel.epsAcceleration > 0.10) { score += 20; flags.push('accelerating'); }
    else if (intel.epsAcceleration > 0) score += 8;
    else if (intel.epsAcceleration < -0.15) { score -= 15; flags.push('decelerating'); }
  }

  if (intel.beatsLast4 !== undefined) {
    if (intel.beatsLast4 === 4 && intel.streak === 'beats') { score += 25; flags.push('4/4_beats'); }
    else if (intel.beatsLast4 >= 3) { score += 15; flags.push('3+of4_beats'); }
    else if (intel.beatsLast4 <= 1) { score -= 10; flags.push('weak_beats'); }
  }

  if (intel.postEarningsDrift) { score += 15; flags.push('pead_window'); }

  if (intel.avgSurpriseMagnitude !== undefined) {
    if (intel.avgSurpriseMagnitude > 5) score += 10;
    else if (intel.avgSurpriseMagnitude < -3) score -= 8;
  }

  if (intel.latestSurprisePct !== undefined && intel.latestSurprisePct < -10) {
    score -= 15; flags.push('big_miss_recent');
  }

  if ((intel.revenueGrowthYoY ?? 0) > 0.15 && epsGrowth > 0.15) {
    score += 10; flags.push('twin_double_digit_growth');
  }

  return { score: Math.max(0, Math.min(100, score)), flags };
}

// ---------------------------------------------------------------------------
// Earnings proximity risk — used by technical boards as a warning
// ---------------------------------------------------------------------------

export type EarningsRisk = 'none' | 'imminent' | 'soon' | 'post_drift';

export function earningsProximityRisk(intel: EarningsIntel | null): EarningsRisk {
  if (!intel) return 'none';
  if (intel.daysUntilEarnings !== undefined && intel.daysUntilEarnings >= 0) {
    if (intel.daysUntilEarnings <= 5) return 'imminent';
    if (intel.daysUntilEarnings <= 14) return 'soon';
  }
  if (intel.postEarningsDrift) return 'post_drift';
  return 'none';
}
