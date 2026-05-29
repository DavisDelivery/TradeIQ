// Phase 6 W1 — strategy-specific falsifiable risk callouts.
//
// Each generator returns an array of concrete, falsifiable trigger strings —
// the conditions under which the thesis breaks. No hedging language. These
// feed the detail-panel RiskCallouts component (Phase 6 W5).
//
// The Lynch set reuses the same thresholds as the existing Lynch discrete
// signal (lynch-signal.ts) so the breaks are consistent with how the board
// actually exits. Presentation only — no scoring change.

import type { ScoreComponent } from './score-breakdown';
import {
  PEG_AVOID_THRESHOLD,
  DE_AVOID_THRESHOLD,
} from '../styles/lynch-signal';

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Williams — short-term technical / momentum
// ---------------------------------------------------------------------------

export function williamsRiskCallouts(
  components: ScoreComponent[],
  score: number,
): string[] {
  if (components.every((c) => c.noData)) {
    return ['No setup to falsify — insufficient price history.'];
  }

  const callouts: string[] = [];
  const byName = (n: string) => components.find((c) => c.name === n);

  const momentum = byName('Momentum (%R)');
  const breakout = byName('Volatility Breakout');
  const trend = byName('Trend Confirmation');

  if (score >= 20) {
    // Long setup — what breaks the long.
    if (momentum && momentum.score > 0) {
      callouts.push('If Williams %R climbs back above −20, the oversold-reversal leg is exhausted.');
    }
    if (breakout && breakout.score > 0) {
      callouts.push('If price closes back below the volatility-breakout trigger, the entry signal is invalidated.');
    }
    callouts.push('If price closes below the 50-day EMA, the trend leg of the setup breaks.');
    if (trend?.signals.uptrend !== true) {
      callouts.push('Trend is not confirmed up (price under 20/50 EMA alignment) — the long lacks a trend tailwind.');
    }
  } else if (score <= -20) {
    // Short setup — what breaks the short.
    if (momentum && momentum.score < 0) {
      callouts.push('If Williams %R falls back below −80, the overbought-rollover leg is exhausted.');
    }
    if (breakout && breakout.score < 0) {
      callouts.push('If price reclaims the downside volatility-breakout trigger, the short signal is invalidated.');
    }
    callouts.push('If price closes above the 50-day EMA, the downtrend leg of the setup breaks.');
  } else {
    callouts.push('No confluence — the setup score sits below ±20, so there is no active trade thesis to falsify.');
    callouts.push('A Williams %R turn from oversold plus a volatility breakout would be needed to trigger a long.');
  }

  return callouts;
}

// ---------------------------------------------------------------------------
// Lynch — growth at a reasonable price
// ---------------------------------------------------------------------------

export function lynchRiskCallouts(
  components: ScoreComponent[],
  score: number,
): string[] {
  if (components.every((c) => c.noData)) {
    return ['No thesis to falsify — insufficient fundamentals.'];
  }

  const callouts: string[] = [];
  const byName = (n: string) => components.find((c) => c.name === n);

  const peg = byName('PEG (valuation)');
  const debt = byName('Debt / Equity');
  const growth = byName('Revenue Growth');
  const earnings = byName('Earnings Quality');

  // Unprofitable — already broken; surface the single decisive condition.
  if (peg && !peg.noData && peg.rationale.includes('unprofitable')) {
    callouts.push('Already outside GARP — the company must return to trailing profitability before a Lynch thesis can form.');
    return callouts;
  }

  callouts.push(`If PEG expands above ${PEG_AVOID_THRESHOLD.toFixed(1)}, the stock is no longer growth at a reasonable price.`);
  callouts.push('If EPS growth turns negative for two consecutive quarters, the fast-grower thesis breaks.');

  const de = debt ? num(debt.signals.debtToEquity) : undefined;
  if (de !== undefined) {
    callouts.push(`If debt-to-equity exceeds ${DE_AVOID_THRESHOLD.toFixed(1)} (now ${de.toFixed(2)}), financial flexibility is compromised.`);
  } else {
    callouts.push(`If debt-to-equity exceeds ${DE_AVOID_THRESHOLD.toFixed(1)}, financial flexibility is compromised.`);
  }

  callouts.push('If revenue growth turns negative year-over-year, the growth pillar of the thesis fails.');

  if (earnings && !earnings.noData) {
    const pq = num(earnings.signals.positiveQtrs);
    if (pq !== undefined && pq < 4) {
      callouts.push(`If profitable quarters fall below ${pq}/4, earnings consistency — a Lynch staple — deteriorates further.`);
    }
  }

  if (growth && !growth.noData && (num(growth.signals.revGrowthYoYPct) ?? 0) > 50) {
    callouts.push('Hypergrowth above 50% is hard to sustain — a deceleration to single digits would compress the multiple.');
  }

  return callouts;
}
