// Larry Williams style analyst.
//
// Signals favored by Williams:
//   1. Williams %R (14-period) — his own momentum/overbought-oversold indicator.
//      Overbought >-20, oversold <-80. Williams used it differently than most:
//      he BOUGHT when %R fell from -20 to -80 (momentum capitulation) and sold
//      when it climbed back to -20 (trend reclaim).
//
//   2. Volatility breakout — Williams' classic "yesterday's close + a fraction
//      of yesterday's range". If today's price breaks that level, enter long.
//      Formula: entry = prevClose + k * prevRange, where k = 0.4-0.6.
//
//   3. Opening range breakout — less directly measurable on daily bars, but
//      first-hour strength is proxied by (close - open) / (high - low).
//
//   4. Seasonality tilt — Williams famously used historical date-based patterns
//      (day-of-week, day-of-month, holiday effects). We apply a modest tilt for
//      first/last trading days of month.
//
//   5. Trend confirmation — Williams was NOT a counter-trend trader in his wins.
//      He used 20/50 EMA alignment to confirm the larger trend before entries.
//
// Output: AnalystScore -100 to +100.

import type { AnalystScore } from '../shared/style-types';
import type { Bar } from '../shared/data-provider';

export interface WilliamsInput {
  ticker: string;
  bars: Bar[]; // at least 60 daily bars
}

export function runWilliams(input: WilliamsInput): AnalystScore {
  const { bars } = input;
  if (bars.length < 30) {
    return nullScore('Insufficient price history');
  }

  const signals: Record<string, any> = {};
  let score = 0;

  // --- 1. Williams %R (14) ---
  const wr = williamsR(bars, 14);
  signals.williamsR = +wr.toFixed(1);

  // Williams' own interpretation: momentum capitulation = buy, trend reclaim = sell
  // Here we generate a "setup quality" score based on %R trajectory + location
  const wrPrev = bars.length >= 15 ? williamsRAt(bars, bars.length - 2, 14) : wr;
  const wrTurning = wr > -50 && wrPrev < -70; // bottoming from oversold
  const wrTopping = wr < -50 && wrPrev > -30; // rolling from overbought

  if (wrTurning) score += 25;
  else if (wr < -80) score += 15; // deep oversold, but no turn yet
  else if (wrTopping) score -= 25;
  else if (wr > -20) score -= 10; // extended

  signals.wrTurning = wrTurning;
  signals.wrTopping = wrTopping;

  // --- 2. Volatility breakout (Williams classic) ---
  const vbSignal = volatilityBreakout(bars, 0.5);
  signals.volBreakoutLong = vbSignal.longTriggered;
  signals.volBreakoutShort = vbSignal.shortTriggered;
  signals.vbStrength = +vbSignal.strength.toFixed(2);

  if (vbSignal.longTriggered) score += 25 * vbSignal.strength;
  else if (vbSignal.shortTriggered) score -= 25 * vbSignal.strength;

  // --- 3. Intraday strength proxy ---
  const closeStrength10 = avg(
    bars.slice(-10).map((b) => {
      const range = b.h - b.l;
      return range > 0 ? (b.c - b.l) / range : 0.5;
    }),
  );
  signals.closeStrength10d = +(closeStrength10 * 100).toFixed(1);
  score += (closeStrength10 - 0.5) * 30;

  // --- 4. Seasonality tilt ---
  const latestBar = bars.at(-1)!;
  const d = new Date(latestBar.t);
  const day = d.getUTCDate();
  const weekday = d.getUTCDay();

  let seasonalTilt = 0;
  // Williams' "TDM effect" — first 3 trading days of month bullish
  if (day <= 3) seasonalTilt += 8;
  // Friday bullish, Monday slightly bearish historically
  if (weekday === 5) seasonalTilt += 3;
  if (weekday === 1) seasonalTilt -= 2;
  score += seasonalTilt;
  signals.seasonalTilt = seasonalTilt;

  // --- 5. Trend confirmation gate ---
  // Williams wasn't a blind contrarian. He confirmed with larger trend.
  const ema20 = ema(
    bars.map((b) => b.c),
    20,
  );
  const ema50 = ema(
    bars.map((b) => b.c),
    50,
  );
  const latest = latestBar.c;
  const uptrend = latest > ema20 && ema20 > ema50;
  const downtrend = latest < ema20 && ema20 < ema50;

  signals.uptrend = uptrend;
  signals.downtrend = downtrend;

  // If score direction disagrees with trend, halve it (Williams-style discipline)
  if (score > 0 && downtrend) score *= 0.4;
  if (score < 0 && uptrend) score *= 0.4;

  // Additional tilt for clean trend alignment
  if (uptrend && score > 0) score += 10;
  if (downtrend && score < 0) score -= 10;

  score = clamp(score, -100, 100);
  const confidence = Math.min(1, Math.abs(score) / 60);

  return {
    analyst: 'williams-style',
    score,
    confidence,
    rationale: buildRationale({ wr, vbSignal, uptrend, closeStrength10, wrTurning, wrTopping }),
    signals,
  };
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

function williamsR(bars: Bar[], period: number): number {
  return williamsRAt(bars, bars.length - 1, period);
}

function williamsRAt(bars: Bar[], idx: number, period: number): number {
  if (idx < period - 1) return -50;
  const slice = bars.slice(idx - period + 1, idx + 1);
  const hh = Math.max(...slice.map((b) => b.h));
  const ll = Math.min(...slice.map((b) => b.l));
  const close = bars[idx].c;
  if (hh === ll) return -50;
  return ((hh - close) / (hh - ll)) * -100;
}

function volatilityBreakout(bars: Bar[], k: number) {
  if (bars.length < 3) return { longTriggered: false, shortTriggered: false, strength: 0 };
  const prev = bars.at(-2)!;
  const today = bars.at(-1)!;
  const prevRange = prev.h - prev.l;
  const longTrigger = prev.c + k * prevRange;
  const shortTrigger = prev.c - k * prevRange;

  const longTriggered = today.h >= longTrigger;
  const shortTriggered = today.l <= shortTrigger;

  // Strength: how decisively the break happened (closing price vs trigger)
  let strength = 0;
  if (longTriggered) {
    strength = (today.c - longTrigger) / (prevRange || 1);
    strength = clamp(strength * 2, 0, 1);
  } else if (shortTriggered) {
    strength = (shortTrigger - today.c) / (prevRange || 1);
    strength = clamp(strength * 2, 0, 1);
  }

  return { longTriggered, shortTriggered, strength };
}

function ema(xs: number[], period: number): number {
  if (xs.length < period) return xs.at(-1) ?? 0;
  const k = 2 / (period + 1);
  let e = avg(xs.slice(0, period));
  for (let i = period; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function buildRationale(s: any): string {
  const parts: string[] = [];
  if (s.wrTurning) parts.push('Williams %R turning up from oversold');
  else if (s.wrTopping) parts.push('Williams %R rolling over from overbought');
  else if (s.wr < -80) parts.push(`%R deep oversold at ${s.wr.toFixed(0)}`);
  else if (s.wr > -20) parts.push(`%R extended at ${s.wr.toFixed(0)}`);

  if (s.vbSignal.longTriggered)
    parts.push(`volatility breakout long (strength ${s.vbSignal.strength.toFixed(2)})`);
  else if (s.vbSignal.shortTriggered)
    parts.push(`volatility breakout short (strength ${s.vbSignal.strength.toFixed(2)})`);

  if (s.closeStrength10 > 0.7) parts.push('closing near highs');
  else if (s.closeStrength10 < 0.3) parts.push('closing near lows');

  if (s.uptrend) parts.push('trend up (20>50 EMA)');
  else if (s.downtrend) parts.push('trend down (20<50 EMA)');

  return parts.join('; ') || 'no Williams setup';
}

function nullScore(reason: string): AnalystScore {
  return {
    analyst: 'williams-style',
    score: 0,
    confidence: 0,
    rationale: reason,
    signals: {},
  };
}
