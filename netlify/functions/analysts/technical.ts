import type { Bar } from '../shared/data-provider';
import type { AnalystOutput, Direction } from '../shared/types';

export function runTechnical(bars: Bar[]): AnalystOutput {
  if (bars.length < 50) {
    return { score: 50, direction: 'neutral', confidence: 0, rationale: 'insufficient bars', signals: {} };
  }
  const closes = bars.map((b) => b.c);
  const vols = bars.map((b) => b.v);
  const latest = closes.at(-1)!;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  const roc20 = pct(closes, 20);
  const roc60 = pct(closes, 60);
  const bb = bollinger(closes, 20, 2);
  // Flat tape (σ=0) makes (upper − mid) zero — treat as neutral (at the
  // mid) instead of letting 0/0 = NaN leak into the score/signals.
  const bbPos = bb && bb.upper > bb.mid ? (latest - bb.mid) / (bb.upper - bb.mid) : 0;

  const avgVol20 = avg(vols.slice(-20));
  const recentVol5 = avg(vols.slice(-5));
  const volRatio = avgVol20 > 0 ? recentVol5 / avgVol20 : 1;

  // Each EMA comparison only scores when both sides exist. The standard
  // 220-calendar-day fetch yields ~150 trading bars, so ema200 is null on
  // every live scan — the old `xs.at(-1)` fallback degraded ema200 to the
  // latest close and sign-inverted the trend term (CR-4): `ema50 > ema200`
  // became `ema50 > price`, +10 when price was BELOW its 50-EMA.
  let raw = 0;
  if (ema20 !== null) {
    if (latest > ema20) raw += 15;
    else raw -= 15;
  }
  if (ema20 !== null && ema50 !== null) {
    if (ema20 > ema50) raw += 10;
    else raw -= 10;
  }
  if (ema50 !== null && ema200 !== null) {
    if (ema50 > ema200) raw += 10;
    else raw -= 10;
  }
  raw += clamp(roc20 * 150, -20, 20);
  raw += clamp(roc60 * 50, -10, 10);
  if (Math.abs(bbPos) > 0.9) raw -= Math.sign(bbPos) * 8;
  if (volRatio > 1.3 && roc20 > 0) raw += 8;
  else if (volRatio > 1.3 && roc20 < 0) raw -= 8;

  raw = clamp(raw, -100, 100);
  const direction: Direction = raw > 10 ? 'long' : raw < -10 ? 'short' : 'neutral';
  const score = Math.round(50 + raw / 2);

  const parts: string[] = [];
  // Trend rationale requires every EMA in the chain — no claim either way
  // when ema200 (or any shorter EMA) is unavailable.
  if (ema20 !== null && ema50 !== null && ema200 !== null && latest > ema20 && ema20 > ema50 && ema50 > ema200) parts.push('uptrend intact');
  else if (ema20 !== null && ema50 !== null && latest < ema20 && ema20 < ema50) parts.push('downtrend');
  if (Math.abs(roc20) > 0.05) parts.push(`${roc20 > 0 ? '+' : ''}${(roc20 * 100).toFixed(1)}% 20d`);
  if (bbPos > 0.9) parts.push('stretched upper band');
  else if (bbPos < -0.9) parts.push('oversold lower band');
  if (volRatio > 1.3) parts.push(`vol ${volRatio.toFixed(1)}x avg`);

  return {
    score,
    direction,
    confidence: Math.min(1, Math.abs(raw) / 60),
    rationale: parts.join(', ') || 'mixed',
    signals: {
      ema20: round(ema20),
      ema50: round(ema50),
      ema200: round(ema200),
      roc20Pct: +(roc20 * 100).toFixed(2),
      roc60Pct: +(roc60 * 100).toFixed(2),
      bbPosition: +bbPos.toFixed(2),
      volRatio: +volRatio.toFixed(2),
    },
  };
}

// Returns null when there aren't enough bars for the period — callers skip
// the term. (The old fallback to `xs.at(-1)` silently substituted the latest
// close for ema200 on every live scan — see CR-4 in the trend-term block.)
function ema(xs: number[], period: number): number | null {
  if (xs.length < period) return null;
  const k = 2 / (period + 1);
  let e = avg(xs.slice(0, period));
  for (let i = period; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}
function pct(xs: number[], lookback: number): number {
  if (xs.length <= lookback) return 0;
  return xs.at(-1)! / xs[xs.length - 1 - lookback] - 1;
}
function bollinger(xs: number[], p: number, m: number) {
  if (xs.length < p) return null;
  const w = xs.slice(-p);
  const mid = avg(w);
  const sd = Math.sqrt(avg(w.map((x) => (x - mid) ** 2)));
  return { mid, upper: mid + sd * m, lower: mid - sd * m };
}
function avg(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }
function round(x: number | null): number | null { return x === null ? null : +x.toFixed(2); }
