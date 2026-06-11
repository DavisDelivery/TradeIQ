// Wave 4C (code-review-2026-06 track-1, M4 + m8) — technical-setups deck.
//
// M4: `multi_tf_aligned` and `oversold_bounce` require >= 200 trading bars
// (200d EMA). The catalyst scan used to fetch 220 CALENDAR days (~150 bars),
// so both setups were permanently dead — a silent 5-setup deck under
// weights/comments that assume 7. The scan now fetches
// CATALYST_BAR_LOOKBACK_DAYS (320 calendar days ≈ 220 bars); these tests
// pin that a 250-bar series actually fires both setups, and that the old
// ~150-bar window could not.
//
// m8: neutral setups (compression) previously added 0.5×pts to BOTH
// longPts and shortPts, cancelling exactly in the net — zero effect despite
// the "amplify" comment. scoreSetups now adds the neutral weight to the
// dominant directional side only.

import { describe, expect, it } from 'vitest';
import { detectSetups, scoreSetups, type TechnicalSetup } from '../technical-setups';
import { CATALYST_BAR_LOOKBACK_DAYS } from '../scan-catalyst';
import type { Bar } from '../data-provider';

function bar(t: number, c: number, o = c, v = 1_000_000): Bar {
  return { t, o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v } as Bar;
}

/** Steady uptrend with mild alternating noise (keeps BB width from being
 *  degenerate-constant) — stacks price > ema21 > ema50 > ema200. */
function uptrendBars(n: number): Bar[] {
  const bars: Bar[] = [];
  let c = 50;
  const t0 = Date.parse('2025-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const o = c;
    c = c * (1 + (i % 7 === 0 ? -0.004 : 0.005));
    bars.push(bar(t0 + i * 86400000, c, o));
  }
  return bars;
}

/** Long uptrend, then a 18-bar controlled pullback: price stays well above
 *  the 200d EMA while RSI(14) collapses below 40. */
function pullbackInUptrendBars(n: number): Bar[] {
  const bars: Bar[] = [];
  let c = 50;
  const t0 = Date.parse('2025-01-01T00:00:00Z');
  for (let i = 0; i < n - 18; i++) {
    const o = c;
    c = c * (1 + (i % 7 === 0 ? -0.004 : 0.006));
    bars.push(bar(t0 + i * 86400000, c, o));
  }
  for (let i = n - 18; i < n; i++) {
    const o = c;
    c = c * 0.994; // every bar down → RSI(14) ≈ 0
    bars.push(bar(t0 + i * 86400000, c, o));
  }
  return bars;
}

describe('detectSetups — 200-bar setups fire with a catalyst-sized window (M4)', () => {
  it('fires multi_tf_aligned long on a 250-bar stacked uptrend', () => {
    const setups = detectSetups(uptrendBars(250));
    const aligned = setups.find((s) => s.name === 'multi_tf_aligned');
    expect(aligned).toBeTruthy();
    expect(aligned!.direction).toBe('long');
    expect(aligned!.strength).toBeGreaterThan(0);
  });

  it('fires oversold_bounce on a 250-bar uptrend with an RSI<40 pullback above the 200d EMA', () => {
    const setups = detectSetups(pullbackInUptrendBars(250));
    const bounce = setups.find((s) => s.name === 'oversold_bounce');
    expect(bounce).toBeTruthy();
    expect(bounce!.direction).toBe('long');
  });

  it('CANNOT fire either setup at the old ~150-bar production window (the M4 bug)', () => {
    // Same price paths truncated to the pre-fix bar count: the ema200 gate
    // (bars.length >= 200) kills both setups regardless of structure.
    const names1 = detectSetups(uptrendBars(150)).map((s) => s.name);
    const names2 = detectSetups(pullbackInUptrendBars(150)).map((s) => s.name);
    expect(names1).not.toContain('multi_tf_aligned');
    expect(names1).not.toContain('oversold_bounce');
    expect(names2).not.toContain('multi_tf_aligned');
    expect(names2).not.toContain('oversold_bounce');
  });

  it('catalyst scan lookback covers the 200-trading-bar requirement (320 calendar ≈ 220 bars)', () => {
    // 200 trading bars need ≈ 290 calendar days (×1.45); 320 leaves headroom.
    expect(CATALYST_BAR_LOOKBACK_DAYS).toBeGreaterThanOrEqual(300);
  });
});

describe('scoreSetups — neutral setups amplify the dominant side (m8)', () => {
  const mk = (direction: TechnicalSetup['direction'], strength: number): TechnicalSetup => ({
    name: 'volatility_compression',
    label: direction === 'neutral' ? 'coiled spring' : 'setup',
    strength,
    direction,
    rationale: 'fixture',
    signals: {},
  });

  it('adding compression to a long deck RAISES the score (pre-fix it cancelled to zero effect)', () => {
    const withoutNeutral = scoreSetups([mk('long', 0.5)]);
    const withNeutral = scoreSetups([mk('long', 0.5), mk('neutral', 1)]);
    // long 0.5×15 = 7.5 → 58; + neutral 1×15×0.5 = 7.5 amplification → 65.
    expect(withoutNeutral.score).toBe(58);
    expect(withNeutral.score).toBe(65);
    expect(withNeutral.score).toBeGreaterThan(withoutNeutral.score);
    expect(withNeutral.direction).toBe('long');
  });

  it('adding compression to a short deck LOWERS the score', () => {
    const withoutNeutral = scoreSetups([mk('short', 0.5)]);
    const withNeutral = scoreSetups([mk('short', 0.5), mk('neutral', 1)]);
    expect(withNeutral.score).toBeLessThan(withoutNeutral.score);
    expect(withNeutral.direction).toBe('short');
  });

  it('compression alone has nothing to amplify — stays at the 50/neutral baseline', () => {
    const r = scoreSetups([mk('neutral', 1)]);
    expect(r.score).toBe(50);
    expect(r.direction).toBe('neutral');
    expect(r.tags).toContain('coiled spring');
  });

  it('balanced long/short decks stay neutral and compression does not break the tie', () => {
    const r = scoreSetups([mk('long', 0.3), mk('short', 0.3), mk('neutral', 1)]);
    expect(r.score).toBe(50);
    expect(r.direction).toBe('neutral');
  });

  it('empty deck → 50/neutral', () => {
    expect(scoreSetups([])).toEqual({ score: 50, direction: 'neutral', tags: [] });
  });
});
