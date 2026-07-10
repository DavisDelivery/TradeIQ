// DESK-1 W3 — pure indicator math for the upgraded PriceChart.
// No library, no React, no I/O — unit-testable in isolation.
//
// Alignment convention: every function returns an array the SAME length
// as its input, padded with `null` where the indicator is not yet
// defined (recharts renders null gaps correctly and rows stay aligned
// with the bar array by index).

/**
 * Simple moving average of `values` over `period`.
 * Entry i is the mean of values[i-period+1 .. i]; null until enough data.
 * Non-finite inputs poison their window to null (never fabricate).
 */
export function sma(values, period) {
  const n = Array.isArray(values) ? values.length : 0;
  const out = new Array(n).fill(null);
  if (!Number.isInteger(period) || period <= 0 || n < period) return out;
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (typeof v !== 'number' || !Number.isFinite(v)) { ok = false; break; }
      sum += v;
    }
    out[i] = ok ? sum / period : null;
  }
  return out;
}

/**
 * Wilder RSI over closes. First defined value at index `period` (needs
 * `period` deltas), seeded with the simple average gain/loss, then
 * Wilder-smoothed: avg = (prevAvg * (period-1) + current) / period.
 * All-gain windows return 100; all-loss return 0.
 */
export function rsi(closes, period = 14) {
  const n = Array.isArray(closes) ? closes.length : 0;
  const out = new Array(n).fill(null);
  if (!Number.isInteger(period) || period <= 0 || n < period + 1) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (!Number.isFinite(d)) return out;
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    if (!Number.isFinite(d)) { out[i] = null; continue; }
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Wilder ATR over OHLC bars ({high, low, close}). True range uses the
 * prior close, so the first defined ATR lands at index `period` (after
 * `period` true ranges). Seed = simple mean of the first `period` TRs;
 * then Wilder smoothing.
 */
export function atr(bars, period = 14) {
  const n = Array.isArray(bars) ? bars.length : 0;
  const out = new Array(n).fill(null);
  if (!Number.isInteger(period) || period <= 0 || n < period + 1) return out;

  const trs = [];
  for (let i = 1; i < n; i++) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - prevClose),
      Math.abs(b.low - prevClose),
    );
    if (!Number.isFinite(tr)) return out;
    trs.push(tr);
  }

  let a = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  out[period] = a;
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
    out[i + 1] = a;
  }
  return out;
}
