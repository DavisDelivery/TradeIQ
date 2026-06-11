// Advanced technical setup detector.
//
// Returns a list of named setups currently active on a ticker's daily bars,
// each with a strength (0-1), direction, and human-readable rationale. Used
// everywhere in the app — Lynch picks, Williams picks, target board, catalyst
// board, engine test. A ticker can have multiple setups active at once, and
// that stacking is itself a signal (more setups aligning = higher conviction).
//
// These are the setups that actually matter for swing-to-position timeframes,
// ordered by how often they fire and how reliable they are:
//
//   1. VOLATILITY COMPRESSION — Bollinger Band width in the bottom decile of
//      its trailing 120-day range. Classic "coiled spring". Directionless on
//      its own, but pairs beautifully with a fundamental catalyst to trigger
//      the expansion. Every major breakout starts here.
//
//   2. ACCUMULATION (OBV divergence) — On-Balance Volume making higher highs
//      while price is flat or making equal-or-lower highs. This is the
//      textbook "smart money accumulating while the crowd is asleep" pattern.
//      OBV is a rough proxy for net flow but it works.
//
//   3. VOLUME-CONFIRMED BREAKOUT — New 20-day high on volume 1.5x+ the 20d
//      average. Simple but reliable. Without the volume confirmation, most
//      breakouts fail within 5 days.
//
//   4. MULTI-TIMEFRAME ALIGNMENT — Price above 21d EMA (daily trend), 21d EMA
//      above 50d EMA (intermediate trend), 50d EMA above 200d EMA (primary
//      trend). When all three stack, pullbacks are buyable.
//
//   5. BASE AND HANDLE — Tight base of 4-8 weeks (range < 12% of price) with
//      a shallow pullback in the final week (3-8%, low volume). Approximation
//      of O'Neil's cup-and-handle; we don't attempt the full pattern because
//      reliable detection needs weekly bars and manual judgment.
//
//   6. OVERSOLD BOUNCE IN UPTREND — 14-period RSI under 40 while price is
//      above the 200d EMA. The classic "buy the dip in a bull market" setup.
//      Fails in bear markets, hence the 200d filter.
//
//   7. FAILED BREAKDOWN (reclaim) — Stock broke below a prior support low and
//      reclaimed it within 3 days. The trapped-shorts pattern. Often produces
//      the fastest moves.
//
// All functions operate on daily OHLCV bars in the same shape used by the
// data provider: { t, o, h, l, c, v }.
//
// BAR-WINDOW REQUIREMENT (Wave 4C, review M4): setups 4 (multi_tf_aligned)
// and 6 (oversold_bounce) need >= 200 trading bars for the 200d EMA and are
// silently skipped below that. Callers that want the FULL 7-setup deck must
// fetch at least ~300 CALENDAR days of daily bars (calendar days ≈ 1.45×
// trading bars). The catalyst scan fetches CATALYST_BAR_LOOKBACK_DAYS (320)
// for exactly this reason; chart-analysis defaults to a 180-day lookback and
// therefore intentionally runs the 5-setup subset.

import type { Bar } from './data-provider';

export type SetupName =
  | 'volatility_compression'
  | 'accumulation'
  | 'volume_breakout'
  | 'multi_tf_aligned'
  | 'base_and_handle'
  | 'oversold_bounce'
  | 'failed_breakdown';

export interface TechnicalSetup {
  name: SetupName;
  label: string;               // short human label for UI chips
  strength: number;            // 0-1
  direction: 'long' | 'short' | 'neutral';
  rationale: string;
  signals: Record<string, number | string>;
}

export function detectSetups(bars: Bar[]): TechnicalSetup[] {
  if (bars.length < 60) return [];
  const setups: TechnicalSetup[] = [];

  const closes = bars.map((b) => b.c);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const vols = bars.map((b) => b.v);
  const latest = closes.at(-1)!;

  // Precompute indicators once — cheaper and avoids drift between checks.
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = bars.length >= 200 ? ema(closes, 200) : null;
  const rsi14 = rsi(closes, 14);
  const obvSeries = computeObv(bars);
  const avgVol20 = avg(vols.slice(-20));

  // ---- 1. Volatility compression ----
  const compression = detectCompression(closes);
  if (compression) setups.push(compression);

  // ---- 2. Accumulation (OBV higher highs while price flat/lower) ----
  const accumulation = detectAccumulation(closes, obvSeries);
  if (accumulation) setups.push(accumulation);

  // ---- 3. Volume-confirmed breakout ----
  if (avgVol20 > 0) {
    const twentyDayHigh = Math.max(...highs.slice(-21, -1));
    const volRatio = vols.at(-1)! / avgVol20;
    if (latest > twentyDayHigh && volRatio > 1.5) {
      setups.push({
        name: 'volume_breakout',
        label: '20d breakout',
        strength: Math.min(1, (volRatio - 1.5) / 1.5 + 0.5),
        direction: 'long',
        rationale: `new 20d high on ${volRatio.toFixed(1)}x avg volume`,
        signals: { volRatio: +volRatio.toFixed(2), twentyDayHigh: +twentyDayHigh.toFixed(2) },
      });
    } else if (latest < Math.min(...lows.slice(-21, -1)) && volRatio > 1.5) {
      setups.push({
        name: 'volume_breakout',
        label: '20d breakdown',
        strength: Math.min(1, (volRatio - 1.5) / 1.5 + 0.5),
        direction: 'short',
        rationale: `new 20d low on ${volRatio.toFixed(1)}x avg volume`,
        signals: { volRatio: +volRatio.toFixed(2) },
      });
    }
  }

  // ---- 4. Multi-timeframe alignment ----
  if (ema200 !== null) {
    const aligned = latest > ema21 && ema21 > ema50 && ema50 > ema200;
    const invertedAligned = latest < ema21 && ema21 < ema50 && ema50 < ema200;
    if (aligned) {
      // Strength scales with spread between the fastest and slowest MAs —
      // wider = stronger trend, narrower = trend exhausting.
      const spread = (ema21 - ema200) / ema200;
      setups.push({
        name: 'multi_tf_aligned',
        label: 'stacked trend',
        strength: Math.min(1, spread * 10),
        direction: 'long',
        rationale: 'price > 21ema > 50ema > 200ema',
        signals: { spread: +(spread * 100).toFixed(1) },
      });
    } else if (invertedAligned) {
      const spread = (ema200 - ema21) / ema200;
      setups.push({
        name: 'multi_tf_aligned',
        label: 'stacked downtrend',
        strength: Math.min(1, spread * 10),
        direction: 'short',
        rationale: 'price < 21ema < 50ema < 200ema',
        signals: { spread: +(spread * 100).toFixed(1) },
      });
    }
  }

  // ---- 5. Base and handle (approximation) ----
  const baseHandle = detectBaseAndHandle(closes, vols);
  if (baseHandle) setups.push(baseHandle);

  // ---- 6. Oversold bounce in uptrend ----
  if (ema200 !== null && rsi14 !== null && rsi14 < 40 && latest > ema200) {
    setups.push({
      name: 'oversold_bounce',
      label: `RSI ${Math.round(rsi14)} in uptrend`,
      strength: Math.min(1, (40 - rsi14) / 15),
      direction: 'long',
      rationale: `RSI ${rsi14.toFixed(0)} with price above 200ema — dip in bull trend`,
      signals: { rsi: +rsi14.toFixed(1) },
    });
  }

  // ---- 7. Failed breakdown (reclaim) ----
  const failedBreakdown = detectFailedBreakdown(closes, lows);
  if (failedBreakdown) setups.push(failedBreakdown);

  return setups;
}

// ===== Individual setup detectors =====

function detectCompression(closes: number[]): TechnicalSetup | null {
  if (closes.length < 140) return null;
  // Compute BB width across trailing 120 days
  const widths: number[] = [];
  for (let i = closes.length - 120; i < closes.length; i++) {
    const w = closes.slice(Math.max(0, i - 19), i + 1);
    if (w.length < 20) continue;
    const bb = bollinger(w, 20, 2);
    if (!bb) continue;
    widths.push((bb.upper - bb.lower) / bb.mid);
  }
  if (widths.length < 60) return null;
  const current = widths[widths.length - 1];
  const sorted = [...widths].sort((a, b) => a - b);
  const pctile = sorted.indexOf(current) / sorted.length;
  if (pctile > 0.15) return null; // only fire in bottom 15th percentile

  return {
    name: 'volatility_compression',
    label: 'coiled spring',
    strength: 1 - pctile / 0.15,
    direction: 'neutral',
    rationale: `BB width in bottom ${Math.round(pctile * 100)}% of 120d range`,
    signals: { bbWidthPctile: +(pctile * 100).toFixed(1), bbWidth: +(current * 100).toFixed(2) },
  };
}

function detectAccumulation(closes: number[], obv: number[]): TechnicalSetup | null {
  if (closes.length < 40 || obv.length < 40) return null;
  const lookback = 30;
  const priceSeries = closes.slice(-lookback);
  const obvSeries = obv.slice(-lookback);

  // Check if OBV is trending up (linear slope > 0) while price is flat
  // (absolute change < 4% over the window).
  const obvSlope = linearSlope(obvSeries);
  const priceChangePct = (priceSeries[priceSeries.length - 1] - priceSeries[0]) / priceSeries[0];
  const obvStart = obvSeries[0];
  const obvEnd = obvSeries[obvSeries.length - 1];
  const obvChangePct = obvStart !== 0 ? (obvEnd - obvStart) / Math.abs(obvStart) : 0;

  if (obvSlope > 0 && obvChangePct > 0.05 && Math.abs(priceChangePct) < 0.04) {
    return {
      name: 'accumulation',
      label: 'OBV divergence',
      strength: Math.min(1, obvChangePct * 3),
      direction: 'long',
      rationale: `OBV +${(obvChangePct * 100).toFixed(0)}% while price flat — accumulation`,
      signals: {
        obvChangePct: +(obvChangePct * 100).toFixed(1),
        priceChangePct: +(priceChangePct * 100).toFixed(1),
      },
    };
  }
  return null;
}

function detectBaseAndHandle(closes: number[], vols: number[]): TechnicalSetup | null {
  if (closes.length < 45) return null;
  // Base: last 30 days, range-bound (high-low within 12% of average price)
  const base = closes.slice(-30, -5);
  const handle = closes.slice(-5);
  const baseHi = Math.max(...base);
  const baseLo = Math.min(...base);
  const baseMid = avg(base);
  const baseRange = (baseHi - baseLo) / baseMid;
  if (baseRange > 0.12) return null;

  // Handle: shallow pullback from base high, 3-8%
  const handleLow = Math.min(...handle);
  const pullback = (baseHi - handleLow) / baseHi;
  if (pullback < 0.02 || pullback > 0.08) return null;

  // Volume in handle should be below base average (drying up)
  const baseVol = avg(vols.slice(-30, -5));
  const handleVol = avg(vols.slice(-5));
  if (handleVol > baseVol) return null;

  return {
    name: 'base_and_handle',
    label: 'base + handle',
    strength: 0.5 + (0.05 - Math.abs(pullback - 0.05)) * 10,
    direction: 'long',
    rationale: `tight ${(baseRange * 100).toFixed(1)}% base with ${(pullback * 100).toFixed(1)}% handle on dry volume`,
    signals: {
      baseRangePct: +(baseRange * 100).toFixed(1),
      pullbackPct: +(pullback * 100).toFixed(1),
      volContractionPct: +(((baseVol - handleVol) / baseVol) * 100).toFixed(0),
    },
  };
}

function detectFailedBreakdown(closes: number[], lows: number[]): TechnicalSetup | null {
  if (closes.length < 30) return null;
  const priorLow = Math.min(...lows.slice(-25, -4));
  // Did we break below prior low in the last 5 days?
  const last5Lows = lows.slice(-5);
  const brokeBelow = last5Lows.some((l) => l < priorLow);
  // Are we now back above it?
  const latest = closes.at(-1)!;
  if (brokeBelow && latest > priorLow * 1.005) {
    const reclaim = (latest - priorLow) / priorLow;
    return {
      name: 'failed_breakdown',
      label: 'failed breakdown',
      strength: Math.min(1, reclaim * 20),
      direction: 'long',
      rationale: `broke prior low of ${priorLow.toFixed(2)} and reclaimed — trapped shorts`,
      signals: { priorLow: +priorLow.toFixed(2), reclaimPct: +(reclaim * 100).toFixed(1) },
    };
  }
  return null;
}

// ===== Composite score from setups =====
// Many places in the app want a single number to represent "how good are this
// ticker's technicals right now". This collapses the setup list into 0-100.
export function scoreSetups(setups: TechnicalSetup[]): {
  score: number;
  direction: 'long' | 'short' | 'neutral';
  tags: string[];
} {
  if (setups.length === 0) return { score: 50, direction: 'neutral', tags: [] };

  let longPts = 0;
  let shortPts = 0;
  let neutralPts = 0;
  const tags: string[] = [];

  for (const s of setups) {
    const pts = s.strength * 15;
    if (s.direction === 'long') longPts += pts;
    else if (s.direction === 'short') shortPts += pts;
    else neutralPts += pts * 0.5;
    tags.push(s.label);
  }

  // Neutral setups (compression) are directionless on their own — they
  // amplify whichever side the directional setups already favor. Wave 4C
  // (review m8): the old code added 0.5×pts to BOTH sides, which cancelled
  // exactly in the net — compression had zero effect despite this comment.
  // With no directional setups there is nothing to amplify, so a pure
  // compression deck stays at the 50/neutral baseline.
  const directionalNet = longPts - shortPts;
  if (directionalNet > 0) longPts += neutralPts;
  else if (directionalNet < 0) shortPts += neutralPts;

  const net = longPts - shortPts;
  const dir: 'long' | 'short' | 'neutral' = net > 5 ? 'long' : net < -5 ? 'short' : 'neutral';
  const score = Math.round(Math.max(0, Math.min(100, 50 + net)));
  return { score, direction: dir, tags };
}

// ===== Primitives =====

function ema(xs: number[], period: number): number {
  if (xs.length < period) return xs.at(-1) ?? 0;
  const k = 2 / (period + 1);
  let e = avg(xs.slice(0, period));
  for (let i = period; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}

function bollinger(xs: number[], p: number, m: number) {
  if (xs.length < p) return null;
  const w = xs.slice(-p);
  const mid = avg(w);
  const sd = Math.sqrt(avg(w.map((x) => (x - mid) ** 2)));
  return { mid, upper: mid + sd * m, lower: mid - sd * m };
}

function rsi(xs: number[], period: number): number | null {
  if (xs.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = xs.length - period; i < xs.length; i++) {
    const diff = xs[i] - xs[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeObv(bars: Bar[]): number[] {
  const out: number[] = [];
  let obv = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) { out.push(0); continue; }
    if (bars[i].c > bars[i - 1].c) obv += bars[i].v;
    else if (bars[i].c < bars[i - 1].c) obv -= bars[i].v;
    out.push(obv);
  }
  return out;
}

function linearSlope(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = avg(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (xs[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
