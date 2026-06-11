// Peter Lynch style analyst — "Growth At a Reasonable Price" (GARP).
//
// Lynch's core principles:
//   1. PEG ratio — PE divided by EPS growth rate. Lynch liked PEG < 1.0 (cheap for
//      the growth), avoided PEG > 2.0 (priced for perfection). PEG 1-2 is "fair".
//
//   2. Consistent earnings growth — Lynch hated erratic earnings. He wanted 5+
//      years of steady 15-25% annual growth. Hypergrowth (>50%) was a red flag
//      (unsustainable, often followed by multiple compression).
//
//   3. Low debt — Lynch checked debt-to-equity. Under 0.3 is strong, 0.3-1.0 is
//      acceptable, over 1.0 is a problem unless the business has hard assets.
//
//   4. Small-to-mid cap preference — Lynch found his "tenbaggers" in companies
//      the Street hadn't discovered yet. We give a small-cap bias.
//
//   5. "Know what you own" — Lynch wanted a comprehensible story. We can't
//      measure that quantitatively, but we can penalize obviously complex
//      businesses (conglomerates, holding companies) by sector. [Not in v1]
//
//   6. Insider buying — Lynch loved when insiders were buying with real money.
//      Proxied here by negative stock performance + fundamentals intact (likely
//      moment of pessimism when insiders step up). Real insider data needs
//      Finnhub insider-transactions or SEC Form 4 data.
//
// Output: AnalystScore -100 to +100, focused on LONG. Lynch was generally not a
// short seller, so short signals are weak (just "avoid") unless thesis is strong.

import type { AnalystScore } from '../shared/style-types';

export interface LynchInput {
  ticker: string;
  // From Polygon fundamentals
  peRatio?: number;
  epsGrowthYoY?: number;
  revenueGrowthYoY?: number;
  debtToEquity?: number;
  operatingMargin?: number;
  // From Finnhub history (only the EPS fields are read — date semantics
  // live in the provider's EarningsSurprise: period vs announceDate)
  earningsHistory?: Array<{
    epsActual: number;
    epsEstimate: number;
  }>;
  // Market data
  marketCapUsd?: number; // optional; we use bar latest * shares if available
  recentReturnPct?: number; // last 30 days
  sector?: string;
}

export function runLynch(input: LynchInput): AnalystScore {
  let score = 0;
  const signals: Record<string, any> = { ticker: input.ticker };
  const rationaleParts: string[] = [];

  // --- 1. PEG ratio (the Lynch staple) ---
  if (
    input.peRatio !== undefined &&
    input.peRatio > 0 &&
    input.epsGrowthYoY !== undefined &&
    input.epsGrowthYoY > 0
  ) {
    const pegPct = input.peRatio / (input.epsGrowthYoY * 100);
    signals.peg = +pegPct.toFixed(2);
    signals.peRatio = +input.peRatio.toFixed(1);
    signals.epsGrowthYoYPct = +(input.epsGrowthYoY * 100).toFixed(1);

    if (pegPct < 0.7) {
      score += 40;
      rationaleParts.push(`PEG ${pegPct.toFixed(2)} — cheap for growth`);
    } else if (pegPct < 1.0) {
      score += 25;
      rationaleParts.push(`PEG ${pegPct.toFixed(2)} — reasonable`);
    } else if (pegPct < 1.5) {
      score += 5;
      rationaleParts.push(`PEG ${pegPct.toFixed(2)} — fair`);
    } else if (pegPct < 2.0) {
      score -= 10;
      rationaleParts.push(`PEG ${pegPct.toFixed(2)} — expensive`);
    } else {
      score -= 25;
      rationaleParts.push(`PEG ${pegPct.toFixed(2)} — priced for perfection`);
    }
  } else if (input.peRatio !== undefined && input.peRatio < 0) {
    // Loss-making company — Lynch generally avoided unless clear turnaround story
    score -= 15;
    rationaleParts.push('unprofitable (Lynch avoids)');
  } else {
    // No PEG computable
    signals.pegMissing = true;
  }

  // --- 2. Earnings growth consistency ---
  if (input.earningsHistory && input.earningsHistory.length >= 4) {
    const recent = input.earningsHistory.slice(0, 4);
    const positive = recent.filter((q) => q.epsActual > 0).length;
    const beats = recent.filter((q) => q.epsActual > q.epsEstimate).length;

    signals.positiveQtrs = positive;
    signals.beats4q = beats;

    if (positive === 4 && beats >= 3) {
      score += 20;
      rationaleParts.push(`4/4 profitable quarters, ${beats}/4 beats`);
    } else if (positive === 4) {
      score += 10;
      rationaleParts.push('4/4 profitable quarters');
    } else if (positive <= 2) {
      score -= 15;
      rationaleParts.push(`only ${positive}/4 profitable quarters`);
    }
  }

  // Revenue growth — supplementary confirm
  if (input.revenueGrowthYoY !== undefined) {
    const rev = input.revenueGrowthYoY;
    signals.revGrowthYoYPct = +(rev * 100).toFixed(1);
    if (rev > 0.15 && rev < 0.5) {
      // Lynch sweet spot: 15-50% growth, sustainable
      score += 15;
      rationaleParts.push(`revenue +${(rev * 100).toFixed(0)}% (Lynch sweet spot)`);
    } else if (rev > 0.5) {
      // Hypergrowth — Lynch was skeptical of anything over 50%, hard to sustain
      score -= 5;
      rationaleParts.push(`revenue +${(rev * 100).toFixed(0)}% (hypergrowth, risky)`);
    } else if (rev < 0) {
      score -= 15;
      rationaleParts.push(`revenue ${(rev * 100).toFixed(0)}% (declining)`);
    }
  }

  // --- 3. Debt-to-equity ---
  if (input.debtToEquity !== undefined) {
    signals.debtToEquity = +input.debtToEquity.toFixed(2);
    if (input.debtToEquity < 0.3) {
      score += 15;
      rationaleParts.push(`low debt (D/E ${input.debtToEquity.toFixed(2)})`);
    } else if (input.debtToEquity < 1.0) {
      score += 5;
    } else if (input.debtToEquity > 2.0) {
      score -= 20;
      rationaleParts.push(`high debt (D/E ${input.debtToEquity.toFixed(2)})`);
    } else if (input.debtToEquity > 1.0) {
      score -= 8;
    }
  }

  // --- 4. Operating margin quality ---
  if (input.operatingMargin !== undefined) {
    signals.operatingMarginPct = +(input.operatingMargin * 100).toFixed(1);
    if (input.operatingMargin > 0.2) {
      score += 10;
      rationaleParts.push(`strong op margin ${(input.operatingMargin * 100).toFixed(0)}%`);
    } else if (input.operatingMargin < 0.05) {
      score -= 8;
    }
  }

  // --- 5. Small/mid-cap bias ---
  if (input.marketCapUsd !== undefined) {
    signals.marketCapBillion = +(input.marketCapUsd / 1e9).toFixed(2);
    if (input.marketCapUsd < 2e9) {
      // Small cap — Lynch's hunting ground
      score += 10;
      rationaleParts.push('small-cap (Lynch territory)');
    } else if (input.marketCapUsd < 10e9) {
      // Mid cap
      score += 5;
    } else if (input.marketCapUsd > 200e9) {
      // Mega cap — Lynch thought these were fully discovered
      score -= 5;
    }
  }

  // --- 6. "Insider buying" proxy: pessimism opportunity ---
  // Strong fundamentals + recent drawdown = possible insider-buying moment
  // Real insider transaction data should replace this when wired.
  if (
    input.recentReturnPct !== undefined &&
    input.recentReturnPct < -10 &&
    score > 20 // fundamentals already positive
  ) {
    score += 8;
    rationaleParts.push(`down ${input.recentReturnPct.toFixed(0)}% on strong fundamentals`);
  }

  score = clamp(score, -100, 100);
  const confidence = estimateConfidence(input);

  return {
    analyst: 'lynch-style',
    score,
    confidence,
    rationale: rationaleParts.join('; ') || 'no Lynch setup — insufficient fundamentals',
    signals,
  };
}

function estimateConfidence(input: LynchInput): number {
  // Lynch relies on fundamentals — confidence proportional to data completeness
  let c = 0;
  if (input.peRatio !== undefined) c += 0.25;
  if (input.epsGrowthYoY !== undefined) c += 0.25;
  if (input.revenueGrowthYoY !== undefined) c += 0.15;
  if (input.debtToEquity !== undefined) c += 0.15;
  if (input.earningsHistory && input.earningsHistory.length >= 4) c += 0.15;
  if (input.operatingMargin !== undefined) c += 0.05;
  return clamp(c, 0, 1);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
