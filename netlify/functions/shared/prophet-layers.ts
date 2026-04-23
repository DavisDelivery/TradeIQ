// PROPHET — Probability-Ranked Opportunity Picker using Heuristic Ensemble Trading
// 7-layer ensemble scorer. Each layer returns {score 0-100, pass boolean, details}.
// A stock must pass >=5/7 layers to qualify, with weighted composite for ranking.

import type { Bar } from './data-provider';

export type Direction = 'long' | 'short' | 'neutral';

export interface LayerResult {
  score: number;
  pass: boolean;
  details: Record<string, number | string | boolean | null>;
  flags: string[];
}

export interface ProphetScore {
  layers: {
    structure: LayerResult;
    momentum: LayerResult;
    volume: LayerResult;
    volatility: LayerResult;
    relativeStrength: LayerResult;
    fundamental: LayerResult;
    catalyst: LayerResult;
  };
  layersPassed: number;
  composite: number;
  conviction: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  signal: 'BUY' | 'HOLD' | null;
  direction: Direction;
  flags: string[];
  entry: number | null;
  stop: number | null;
  targets: number[];
  invalidation: number | null;
}

// Base weights — will be regime-adjusted in the endpoint layer
const BASE_WEIGHTS = {
  structure: 0.13,
  momentum: 0.11,
  volume: 0.12,
  volatility: 0.07,
  relativeStrength: 0.11,
  fundamental: 0.20,  // raised: earnings growth + acceleration + beats history
  catalyst: 0.26,
};

// ═══════════════════════════════════════════════════════════════════════════
// MATH PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════════

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(NaN); continue; }
    if (prev === null) {
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out.push(prev);
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function slope(values: number[]): number {
  // Least-squares slope over index vs value
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg >= 0) gain += chg; else loss -= chg;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    const g = chg >= 0 ? chg : 0;
    const l = chg < 0 ? -chg : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].h - bars[i].l;
    const hc = Math.abs(bars[i].h - bars[i - 1].c);
    const lc = Math.abs(bars[i].l - bars[i - 1].c);
    trs.push(Math.max(hl, hc, lc));
  }
  return sma(trs.slice(-period), period);
}

function adx(bars: Bar[], period = 14): number | null {
  if (bars.length < period * 2 + 1) return null;
  const plusDM: number[] = [], minusDM: number[] = [], trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const hl = bars[i].h - bars[i].l;
    const hc = Math.abs(bars[i].h - bars[i - 1].c);
    const lc = Math.abs(bars[i].l - bars[i - 1].c);
    trs.push(Math.max(hl, hc, lc));
  }
  const tr14 = sma(trs.slice(-period), period) ?? 0;
  const plus14 = sma(plusDM.slice(-period), period) ?? 0;
  const minus14 = sma(minusDM.slice(-period), period) ?? 0;
  if (tr14 === 0) return null;
  const plusDI = 100 * plus14 / tr14;
  const minusDI = 100 * minus14 / tr14;
  const sum = plusDI + minusDI;
  if (sum === 0) return 0;
  const dx = 100 * Math.abs(plusDI - minusDI) / sum;
  // Simplified: return DX as ADX proxy (true ADX is smoothed DX, good enough for gating)
  return dx;
}

function obv(bars: Bar[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = out[i - 1];
    const delta = bars[i].c > bars[i - 1].c ? bars[i].v
      : bars[i].c < bars[i - 1].c ? -bars[i].v : 0;
    out.push(prev + delta);
  }
  return out;
}

function macd(closes: number[]): { line: number; signal: number; hist: number } | null {
  if (closes.length < 35) return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(ema12[i] - ema26[i]);
  }
  const valid = macdLine.filter((v) => !isNaN(v));
  const signalLine = ema(valid, 9);
  const lastLine = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  return { line: lastLine, signal: lastSignal, hist: lastLine - lastSignal };
}

function macdHistSeries(closes: number[]): number[] {
  if (closes.length < 35) return [];
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) macdLine.push(ema12[i] - ema26[i]);
  const valid = macdLine.map((v, i) => isNaN(v) ? 0 : v);
  const signalLine = ema(valid.slice(25), 9);
  const out: number[] = [];
  for (let i = 0; i < valid.length; i++) {
    const sigIdx = i - 25;
    if (sigIdx < 0) out.push(0);
    else out.push(valid[i] - (signalLine[sigIdx] ?? 0));
  }
  return out;
}

function bollingerWidth(closes: number[], period = 20): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const sd = stddev(slice);
  return (4 * sd) / mean;  // (upper-lower)/mean, 2 stdev each side
}

function bollingerWidthSeries(closes: number[], period = 20): number[] {
  const out: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { out.push(NaN); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const sd = stddev(slice);
    out.push((4 * sd) / mean);
  }
  return out;
}

function stochastic(bars: Bar[], period = 14): { k: number; d: number } | null {
  if (bars.length < period + 3) return null;
  const ks: number[] = [];
  for (let i = period - 1; i < bars.length; i++) {
    const slice = bars.slice(i - period + 1, i + 1);
    const high = Math.max(...slice.map((b) => b.h));
    const low = Math.min(...slice.map((b) => b.l));
    if (high === low) { ks.push(50); continue; }
    ks.push(100 * (bars[i].c - low) / (high - low));
  }
  const k = ks[ks.length - 1];
  const d = sma(ks.slice(-3), 3) ?? k;
  return { k, d };
}

function mfi(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  let posFlow = 0, negFlow = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    const prevTp = (bars[i - 1].h + bars[i - 1].l + bars[i - 1].c) / 3;
    const rawFlow = tp * bars[i].v;
    if (tp > prevTp) posFlow += rawFlow;
    else if (tp < prevTp) negFlow += rawFlow;
  }
  if (negFlow === 0) return 100;
  const ratio = posFlow / negFlow;
  return 100 - 100 / (1 + ratio);
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1 — PRICE STRUCTURE
// ═══════════════════════════════════════════════════════════════════════════

export function layerStructure(bars: Bar[]): LayerResult {
  const details: LayerResult['details'] = {};
  const flags: string[] = [];
  if (bars.length < 200) {
    return { score: 0, pass: false, details: { error: 'insufficient bars' }, flags: [] };
  }

  const closes = bars.map((b) => b.c);
  const latest = closes[closes.length - 1];
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const sma20Slope = slope(closes.slice(-20));
  const sma50Slope = slope(closes.slice(-50));
  const sma200Slope = slope(closes.slice(-100));

  details.sma20 = sma20;
  details.sma50 = sma50;
  details.sma200 = sma200;

  const above20 = sma20 !== null && latest > sma20;
  const above50 = sma50 !== null && latest > sma50;
  const above200 = sma200 !== null && latest > sma200;
  const aligned = sma20 && sma50 && sma200 && sma20 > sma50 && sma50 > sma200;

  // 52-week high distance
  const high52w = Math.max(...closes.slice(-252));
  const distFromHigh = ((high52w - latest) / high52w) * 100;
  details.pct_below_52w_high = +distFromHigh.toFixed(1);

  // Golden cross within last 40 days
  let goldenCross = false;
  for (let i = Math.max(50, closes.length - 40); i < closes.length; i++) {
    const s50 = sma(closes.slice(0, i + 1), 50);
    const s200 = sma(closes.slice(0, i + 1), 200);
    const s50Prev = sma(closes.slice(0, i), 50);
    const s200Prev = sma(closes.slice(0, i), 200);
    if (s50 && s200 && s50Prev && s200Prev && s50 > s200 && s50Prev <= s200Prev) {
      goldenCross = true;
      break;
    }
  }
  details.goldenCross = goldenCross;

  // Higher-highs / higher-lows on last 4 weekly windows (20 trading days)
  const weekly: Bar[] = [];
  for (let i = bars.length - 20; i < bars.length; i += 5) {
    const chunk = bars.slice(i, i + 5);
    if (chunk.length < 5) continue;
    weekly.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map((b) => b.h)),
      l: Math.min(...chunk.map((b) => b.l)),
      c: chunk[chunk.length - 1].c,
      v: chunk.reduce((s, b) => s + b.v, 0),
    });
  }
  const hhhl = weekly.length >= 3 &&
    weekly.every((w, i) => i === 0 || (w.h >= weekly[i - 1].h && w.l >= weekly[i - 1].l));
  details.weekly_hhhl = hhhl;

  const adxVal = adx(bars);
  details.adx = adxVal ? +adxVal.toFixed(1) : null;

  // Scoring
  let score = 0;
  if (above20) { score += 10; flags.push('above_20d'); }
  if (above50) { score += 10; flags.push('above_50d'); }
  if (above200) { score += 15; flags.push('above_200d'); }
  if (aligned) { score += 15; flags.push('sma_aligned'); }
  if (sma20Slope > 0) score += 8;
  if (sma50Slope > 0) score += 8;
  if (sma200Slope > 0) score += 5;
  if (goldenCross) { score += 10; flags.push('golden_cross'); }
  if (hhhl) { score += 10; flags.push('higher_highs'); }
  if (distFromHigh < 15) score += 5;
  else if (distFromHigh > 50) score -= 10;
  if (adxVal && adxVal > 25) { score += 4; flags.push('strong_trend'); }

  score = Math.max(0, Math.min(100, score));

  // Hard pass gates
  const pass = above200 && (adxVal ?? 0) >= 15 && hhhl;

  return { score, pass, details, flags };
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2 — MOMENTUM
// ═══════════════════════════════════════════════════════════════════════════

export function layerMomentum(bars: Bar[]): LayerResult {
  const details: LayerResult['details'] = {};
  const flags: string[] = [];
  if (bars.length < 35) return { score: 0, pass: false, details: {}, flags: [] };

  const closes = bars.map((b) => b.c);
  const rsiVal = rsi(closes);
  const macdRes = macd(closes);
  const histSeries = macdHistSeries(closes);
  const last3Hist = histSeries.slice(-3);
  const histExpanding = last3Hist.length === 3 && last3Hist[2] > last3Hist[1] && last3Hist[1] > last3Hist[0];

  // Bearish RSI divergence: price HH, RSI LH within 20d window
  let bearishDiv = false;
  if (closes.length >= 40 && rsiVal !== null) {
    const recentHighIdx = closes.slice(-20).reduce((maxI, c, i, arr) => c > arr[maxI] ? i : maxI, 0) + closes.length - 20;
    const priorHighIdx = closes.slice(-40, -20).reduce((maxI, c, i, arr) => c > arr[maxI] ? i : maxI, 0) + closes.length - 40;
    if (closes[recentHighIdx] > closes[priorHighIdx]) {
      const rsiRecent = rsi(closes.slice(0, recentHighIdx + 1));
      const rsiPrior = rsi(closes.slice(0, priorHighIdx + 1));
      if (rsiRecent !== null && rsiPrior !== null && rsiRecent < rsiPrior) bearishDiv = true;
    }
  }

  const roc20 = closes.length >= 21 ? ((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100 : 0;
  const roc60 = closes.length >= 61 ? ((closes[closes.length - 1] - closes[closes.length - 61]) / closes[closes.length - 61]) * 100 : 0;
  const stoch = stochastic(bars);

  details.rsi = rsiVal !== null ? +rsiVal.toFixed(1) : null;
  details.macd_line = macdRes ? +macdRes.line.toFixed(3) : null;
  details.macd_signal = macdRes ? +macdRes.signal.toFixed(3) : null;
  details.macd_hist = macdRes ? +macdRes.hist.toFixed(3) : null;
  details.macd_hist_expanding = histExpanding;
  details.roc_20d = +roc20.toFixed(1);
  details.roc_60d = +roc60.toFixed(1);
  details.bearish_rsi_divergence = bearishDiv;
  details.stoch_k = stoch ? +stoch.k.toFixed(1) : null;
  details.stoch_d = stoch ? +stoch.d.toFixed(1) : null;

  let score = 0;
  if (rsiVal !== null) {
    if (rsiVal >= 50 && rsiVal <= 70) { score += 25; flags.push('rsi_sweet_spot'); }
    else if (rsiVal >= 40 && rsiVal < 50) score += 15;
    else if (rsiVal > 70 && rsiVal <= 80) score += 10;
    else if (rsiVal > 80) score -= 10;
  }
  if (macdRes) {
    if (macdRes.line > macdRes.signal) { score += 12; flags.push('macd_bull'); }
    if (macdRes.line > 0 && macdRes.signal > 0) score += 8;
    if (histExpanding) { score += 10; flags.push('macd_accelerating'); }
  }
  if (roc20 > 0) score += 5;
  if (roc20 > roc60 / 3) score += 10;  // Short-term outpacing long-term
  if (roc20 > 5) score += 5;
  if (stoch && stoch.k > stoch.d) score += 5;
  if (bearishDiv) score -= 20;

  score = Math.max(0, Math.min(100, score));
  const pass = rsiVal !== null && rsiVal < 80 && !bearishDiv && macdRes !== null && macdRes.line > macdRes.signal;
  return { score, pass, details, flags };
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 3 — VOLUME & FLOW
// ═══════════════════════════════════════════════════════════════════════════

export function layerVolume(bars: Bar[]): LayerResult {
  const details: LayerResult['details'] = {};
  const flags: string[] = [];
  if (bars.length < 20) return { score: 0, pass: false, details: {}, flags: [] };

  const obvSeries = obv(bars);
  const obvSlope20 = slope(obvSeries.slice(-20));
  const closes = bars.map((b) => b.c);

  // OBV confirming price: both making 20d highs
  const priceMax20Idx = closes.slice(-20).reduce((mi, c, i, arr) => c > arr[mi] ? i : mi, 0);
  const obvMax20Idx = obvSeries.slice(-20).reduce((mi, v, i, arr) => v > arr[mi] ? i : mi, 0);
  const obvConfirming = Math.abs(priceMax20Idx - obvMax20Idx) <= 3;
  const obvDivergence = priceMax20Idx === 19 && obvMax20Idx < 15;  // Price new high, OBV lagging

  // Up-day vs down-day volume (20d)
  let upVol = 0, downVol = 0;
  for (let i = bars.length - 20; i < bars.length; i++) {
    if (i === 0) continue;
    if (bars[i].c > bars[i - 1].c) upVol += bars[i].v;
    else if (bars[i].c < bars[i - 1].c) downVol += bars[i].v;
  }
  const upDownRatio = downVol === 0 ? 99 : upVol / downVol;

  // Volume surge detection on recent large-up-move days
  const avgVol20 = bars.slice(-20).reduce((s, b) => s + b.v, 0) / 20;
  const recentSurge = bars.slice(-10).some((b, i) => {
    const idx = bars.length - 10 + i;
    if (idx === 0) return false;
    return b.v > avgVol20 * 1.5 && b.c > bars[idx - 1].c * 1.015;  // 1.5x vol + 1.5% up
  });

  // Institutional accumulation: tight range + high volume days
  let accumDays = 0;
  for (let i = bars.length - 20; i < bars.length; i++) {
    const range = (bars[i].h - bars[i].l) / bars[i].c;
    if (range < 0.015 && bars[i].v > avgVol20 * 1.2) accumDays++;
  }

  // VWAP (50d rough: avg(h+l+c)/3 vol-weighted)
  let tpv = 0, volSum = 0;
  for (let i = Math.max(0, bars.length - 50); i < bars.length; i++) {
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    tpv += tp * bars[i].v;
    volSum += bars[i].v;
  }
  const vwap50 = volSum > 0 ? tpv / volSum : null;
  const aboveVwap = vwap50 !== null && closes[closes.length - 1] > vwap50;

  const mfiVal = mfi(bars);

  details.obv_slope_20d = +obvSlope20.toFixed(0);
  details.obv_confirming = obvConfirming;
  details.obv_divergence = obvDivergence;
  details.up_down_vol_ratio = +upDownRatio.toFixed(2);
  details.recent_volume_surge = recentSurge;
  details.accumulation_days = accumDays;
  details.vwap_50d = vwap50 ? +vwap50.toFixed(2) : null;
  details.above_vwap = aboveVwap;
  details.mfi = mfiVal ? +mfiVal.toFixed(1) : null;

  let score = 0;
  if (obvSlope20 > 0) { score += 15; flags.push('obv_rising'); }
  if (obvConfirming) { score += 15; flags.push('obv_confirming'); }
  if (obvDivergence) score -= 25;
  if (upDownRatio > 1.5) { score += 15; flags.push('buyers_dominant'); }
  else if (upDownRatio > 1.2) score += 8;
  else if (upDownRatio < 0.8) score -= 10;
  if (recentSurge) { score += 10; flags.push('volume_surge'); }
  if (accumDays >= 3) { score += 10; flags.push('institutional_accum'); }
  if (aboveVwap) score += 10;
  if (mfiVal !== null) {
    if (mfiVal > 50 && mfiVal < 80) score += 10;
    else if (mfiVal >= 80) score -= 5;
  }

  score = Math.max(0, Math.min(100, score));
  const pass = !obvDivergence && upDownRatio > 1.0 && obvSlope20 > 0;
  return { score, pass, details, flags };
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 4 — VOLATILITY REGIME
// ═══════════════════════════════════════════════════════════════════════════

export function layerVolatility(bars: Bar[]): LayerResult {
  const details: LayerResult['details'] = {};
  const flags: string[] = [];
  if (bars.length < 60) return { score: 0, pass: false, details: {}, flags: [] };

  const closes = bars.map((b) => b.c);
  const latest = closes[closes.length - 1];
  const atr14 = atr(bars) ?? 0;
  const atrPct = (atr14 / latest) * 100;

  const bbSeries = bollingerWidthSeries(closes);
  const bbLatest = bbSeries[bbSeries.length - 1];
  const bb30 = bbSeries.slice(-30).filter((v) => !isNaN(v));
  const bb6mo = bbSeries.slice(-130).filter((v) => !isNaN(v));
  const bb30Min = bb30.length ? Math.min(...bb30) : null;
  const bb6moMin = bb6mo.length ? Math.min(...bb6mo) : null;
  const recentSqueeze = bb6moMin !== null && bb30Min !== null && Math.abs(bb30Min - bb6moMin) / bb6moMin < 0.1;
  const expanding = bbSeries.length >= 10 && bbLatest > sma(bbSeries.slice(-10).filter((v) => !isNaN(v)), 10)! * 1.1;

  // Realized vol 20d vs 60d
  const returns = [];
  for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
  const rv20 = stddev(returns.slice(-20)) * Math.sqrt(252);
  const rv60 = stddev(returns.slice(-60)) * Math.sqrt(252);
  const volRatio = rv60 > 0 ? rv20 / rv60 : 1;

  details.atr_14 = +atr14.toFixed(2);
  details.atr_pct = +atrPct.toFixed(2);
  details.bb_width_now = +bbLatest.toFixed(4);
  details.bb_width_30d_min = bb30Min ? +bb30Min.toFixed(4) : null;
  details.recent_squeeze = recentSqueeze;
  details.bb_expanding = expanding;
  details.rv_20d = +(rv20 * 100).toFixed(1);
  details.rv_60d = +(rv60 * 100).toFixed(1);
  details.vol_ratio_20_60 = +volRatio.toFixed(2);

  let score = 50;  // Neutral base
  if (atrPct >= 1.5 && atrPct <= 4) { score += 15; flags.push('tradeable_vol'); }
  else if (atrPct < 1.5) score -= 10;
  else if (atrPct > 6) score -= 25;
  if (recentSqueeze) { score += 15; flags.push('bb_squeeze'); }
  if (recentSqueeze && expanding) { score += 15; flags.push('squeeze_releasing'); }
  if (volRatio < 0.8) { score += 10; flags.push('vol_compressing'); }
  else if (volRatio > 1.5) score -= 15;

  score = Math.max(0, Math.min(100, score));
  const pass = atrPct <= 6 && volRatio < 1.5;
  return { score, pass, details, flags };
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 5 — RELATIVE STRENGTH
// ═══════════════════════════════════════════════════════════════════════════

export function layerRelativeStrength(
  tickerBars: Bar[],
  spyBars: Bar[],
  sectorBars: Bar[] | null,
): LayerResult {
  const details: LayerResult['details'] = {};
  const flags: string[] = [];

  if (tickerBars.length < 120 || spyBars.length < 120) {
    return { score: 0, pass: false, details: { error: 'insufficient bars' }, flags: [] };
  }

  const rel = (bars: Bar[], days: number) => {
    if (bars.length < days + 1) return null;
    return (bars[bars.length - 1].c - bars[bars.length - 1 - days].c) / bars[bars.length - 1 - days].c;
  };

  const ret20 = rel(tickerBars, 20);
  const ret60 = rel(tickerBars, 60);
  const ret120 = rel(tickerBars, 120);
  const spy20 = rel(spyBars, 20);
  const spy60 = rel(spyBars, 60);
  const spy120 = rel(spyBars, 120);

  const alpha20 = ret20 !== null && spy20 !== null ? (ret20 - spy20) * 100 : null;
  const alpha60 = ret60 !== null && spy60 !== null ? (ret60 - spy60) * 100 : null;
  const alpha120 = ret120 !== null && spy120 !== null ? (ret120 - spy120) * 100 : null;

  let sectorAlpha20 = null;
  if (sectorBars && sectorBars.length >= 21) {
    const sec20 = rel(sectorBars, 20);
    if (ret20 !== null && sec20 !== null) sectorAlpha20 = (ret20 - sec20) * 100;
  }

  details.alpha_vs_spy_20d = alpha20 !== null ? +alpha20.toFixed(2) : null;
  details.alpha_vs_spy_60d = alpha60 !== null ? +alpha60.toFixed(2) : null;
  details.alpha_vs_spy_120d = alpha120 !== null ? +alpha120.toFixed(2) : null;
  details.alpha_vs_sector_20d = sectorAlpha20 !== null ? +sectorAlpha20.toFixed(2) : null;
  details.ret_20d_pct = ret20 !== null ? +(ret20 * 100).toFixed(2) : null;
  details.ret_60d_pct = ret60 !== null ? +(ret60 * 100).toFixed(2) : null;

  let score = 50;
  if (alpha20 !== null && alpha20 > 0) score += 10;
  if (alpha20 !== null && alpha20 > 5) { score += 8; flags.push('rs_strong_20d'); }
  if (alpha60 !== null && alpha60 > 0) score += 10;
  if (alpha60 !== null && alpha60 > 10) { score += 8; flags.push('rs_strong_60d'); }
  if (alpha120 !== null && alpha120 > 0) score += 7;
  if (alpha120 !== null && alpha120 > 15) { score += 5; flags.push('rs_strong_120d'); }
  if (sectorAlpha20 !== null && sectorAlpha20 > 0) { score += 8; flags.push('beating_sector'); }
  if (sectorAlpha20 !== null && sectorAlpha20 < -5) score -= 10;
  // Accelerating RS: 20d alpha > 60d alpha annualized
  if (alpha20 !== null && alpha60 !== null && alpha20 > alpha60 / 3) {
    score += 6; flags.push('rs_accelerating');
  }

  score = Math.max(0, Math.min(100, score));
  const pass = (alpha60 ?? 0) > -3 && (sectorAlpha20 === null || sectorAlpha20 > -5);
  return { score, pass, details, flags };
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 6 — FUNDAMENTAL TAILWIND
// ═══════════════════════════════════════════════════════════════════════════

export interface FundInput {
  revenueGrowthYoY?: number;
  epsGrowthYoY?: number;
  operatingMargin?: number;
  grossMargin?: number;
  priorOperatingMargin?: number;
  pe?: number;
  peg?: number;
  debtToEquity?: number;
  epsSurpriseBeats?: number;  // 0-4 out of last 4
  // Earnings-intel additions:
  epsAcceleration?: number;     // latest YoY growth minus prior YoY growth (in fraction, 0.10 = 10pp accel)
  avgSurpriseMagnitude?: number; // average beat % in last 4 reports
  postEarningsDrift?: boolean;   // currently in PEAD window after a beat
  streak?: 'beats' | 'misses' | 'mixed';
}

export function layerFundamental(fund: FundInput | null): LayerResult {
  const details: LayerResult['details'] = {};
  const flags: string[] = [];

  if (!fund) {
    return { score: 30, pass: false, details: { error: 'no fundamentals' }, flags: [] };
  }

  details.revenue_growth_yoy_pct = fund.revenueGrowthYoY !== undefined ? +(fund.revenueGrowthYoY * 100).toFixed(1) : null;
  details.eps_growth_yoy_pct = fund.epsGrowthYoY !== undefined ? +(fund.epsGrowthYoY * 100).toFixed(1) : null;
  details.eps_accel_pp = fund.epsAcceleration !== undefined ? +(fund.epsAcceleration * 100).toFixed(1) : null;
  details.avg_surprise_pct = fund.avgSurpriseMagnitude !== undefined ? +fund.avgSurpriseMagnitude.toFixed(1) : null;
  details.operating_margin_pct = fund.operatingMargin !== undefined ? +(fund.operatingMargin * 100).toFixed(1) : null;
  details.gross_margin_pct = fund.grossMargin !== undefined ? +(fund.grossMargin * 100).toFixed(1) : null;
  details.pe = fund.pe ?? null;
  details.peg = fund.peg ?? null;
  details.debt_equity = fund.debtToEquity ?? null;
  details.beats_4q = fund.epsSurpriseBeats ?? null;
  details.streak = fund.streak ?? null;
  details.post_earnings_drift = fund.postEarningsDrift ?? null;

  let score = 0;
  const rev = fund.revenueGrowthYoY ?? 0;
  const eps = fund.epsGrowthYoY ?? 0;
  const om = fund.operatingMargin ?? 0;
  const gm = fund.grossMargin ?? 0;

  // Revenue growth (max +25)
  if (rev > 0.20) { score += 25; flags.push('rev_growth_>20pct'); }
  else if (rev > 0.10) { score += 18; flags.push('rev_growth_>10pct'); }
  else if (rev > 0.05) score += 10;
  else if (rev > 0) score += 5;
  else if (rev < -0.05) score -= 15;

  // EPS growth (max +25 — up from +20)
  if (eps > 0.50) { score += 25; flags.push('eps_growth_>50pct'); }
  else if (eps > 0.25) { score += 20; flags.push('eps_growth_>25pct'); }
  else if (eps > 0.10) score += 12;
  else if (eps > 0) score += 5;
  else if (eps < -0.10) { score -= 15; flags.push('eps_contracting'); }
  else if (eps < 0) score -= 8;

  // NEW: EPS acceleration (max +15) — single strongest CANSLIM signal
  if (fund.epsAcceleration !== undefined) {
    if (fund.epsAcceleration > 0.15) { score += 15; flags.push('eps_accelerating'); }
    else if (fund.epsAcceleration > 0.05) { score += 10; flags.push('eps_accel_modest'); }
    else if (fund.epsAcceleration > 0) score += 5;
    else if (fund.epsAcceleration < -0.15) { score -= 12; flags.push('eps_decelerating'); }
  }

  // Margins
  if (om > 0.20) { score += 10; flags.push('margins_rich'); }
  else if (om > 0.10) score += 6;
  else if (om > 0.05) score += 2;

  if (fund.priorOperatingMargin !== undefined && om > fund.priorOperatingMargin) {
    score += 6; flags.push('margins_expanding');
  }
  if (gm > 0.40) score += 5;

  // Valuation — PEG favor
  if (fund.peg !== undefined && fund.peg > 0 && fund.peg < 1.5) { score += 10; flags.push('peg_favorable'); }
  else if (fund.peg !== undefined && fund.peg > 4) score -= 8;

  if (fund.debtToEquity !== undefined && fund.debtToEquity < 1.0) score += 3;
  else if (fund.debtToEquity !== undefined && fund.debtToEquity > 2.5) score -= 6;

  // Beats count (max +12, up from +12 — same but with streak bonus)
  if (fund.epsSurpriseBeats !== undefined) {
    score += fund.epsSurpriseBeats * 3;
    if (fund.epsSurpriseBeats >= 3) flags.push('beats_3plus_of_4');
  }

  // NEW: Clean 4/4 streak bonus
  if (fund.streak === 'beats' && fund.epsSurpriseBeats === 4) {
    score += 8; flags.push('perfect_beat_streak');
  } else if (fund.streak === 'misses') {
    score -= 10; flags.push('miss_streak');
  }

  // NEW: Avg surprise magnitude
  if (fund.avgSurpriseMagnitude !== undefined) {
    if (fund.avgSurpriseMagnitude > 10) { score += 8; flags.push('blowout_avg'); }
    else if (fund.avgSurpriseMagnitude > 3) score += 4;
    else if (fund.avgSurpriseMagnitude < -3) score -= 6;
  }

  score = Math.max(0, Math.min(100, score));
  const pass = rev >= -0.05 && eps >= -0.10 && (fund.peg === undefined || fund.peg < 4);
  return { score, pass, details, flags };
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 7 — CATALYST & META
// ═══════════════════════════════════════════════════════════════════════════

export interface CatalystInput {
  insiderScore?: number;        // 0-100
  insiderCluster?: boolean;
  cSuiteBuy?: boolean;
  firstBuyInYear?: boolean;
  politicalScore?: number;
  bipartisanPolitical?: boolean;
  lobbyingVelocity?: number;    // positive = accelerating
  govContractScore?: number;
  patentScore?: number;
  patentVelocity?: number;      // positive = accelerating
  newsSentiment7d?: number;     // -1 to 1
  newsVolumeSpike?: boolean;
  daysUntilEarnings?: number | null;
  postEarningsDrift?: boolean;  // in 3-14d post-beat drift window
  macroBias?: number;           // -1 (risk_off) to +1 (risk_on)
  sectorRank?: number;          // 1 = leader, 11 = laggard
}

export function layerCatalyst(cat: CatalystInput): LayerResult {
  const details: LayerResult['details'] = {};
  const flags: string[] = [];

  let score = 30;  // Base for any stock

  if (cat.insiderScore !== undefined) {
    score += Math.min(20, Math.max(-10, (cat.insiderScore - 50) / 2.5));
    if (cat.insiderCluster) { score += 8; flags.push('insider_cluster'); }
    if (cat.cSuiteBuy) { score += 6; flags.push('c_suite_buy'); }
    if (cat.firstBuyInYear) { score += 5; flags.push('first_buy_12mo'); }
  }

  if (cat.politicalScore !== undefined) {
    score += Math.min(15, Math.max(-5, (cat.politicalScore - 50) / 3.3));
    if (cat.bipartisanPolitical) { score += 6; flags.push('bipartisan_flow'); }
    if ((cat.lobbyingVelocity ?? 0) > 0.2) { score += 5; flags.push('lobbying_up'); }
  }

  if (cat.govContractScore !== undefined && cat.govContractScore > 60) {
    score += 10; flags.push('gov_contracts_flowing');
  }

  if (cat.patentScore !== undefined && cat.patentScore > 55) {
    score += 5;
    if ((cat.patentVelocity ?? 0) > 0.3) { score += 6; flags.push('patent_burst'); }
  }

  if (cat.newsSentiment7d !== undefined) {
    if (cat.newsSentiment7d > 0.3) { score += 8; flags.push('news_bullish'); }
    else if (cat.newsSentiment7d < -0.3) score -= 10;
  }
  if (cat.newsVolumeSpike) score += 3;

  // Earnings timing (penalize too-close earnings)
  if (cat.daysUntilEarnings !== null && cat.daysUntilEarnings !== undefined) {
    if (cat.daysUntilEarnings < 3 && cat.daysUntilEarnings >= 0) {
      score -= 15; flags.push('earnings_within_3d');
    } else if (cat.daysUntilEarnings <= 10 && cat.daysUntilEarnings >= 4) {
      score += 3;  // "Run into earnings" has some edge
    }
  }

  // NEW: Post-earnings drift bonus — well-documented positive drift in 3-14 days after a beat
  if (cat.postEarningsDrift) {
    score += 12; flags.push('post_earnings_drift');
  }

  if (cat.macroBias !== undefined) score += cat.macroBias * 5;
  if (cat.sectorRank !== undefined) {
    if (cat.sectorRank <= 3) { score += 8; flags.push('sector_leader'); }
    else if (cat.sectorRank >= 9) score -= 8;
  }

  details.insider_score = cat.insiderScore ?? null;
  details.political_score = cat.politicalScore ?? null;
  details.gov_contract_score = cat.govContractScore ?? null;
  details.patent_score = cat.patentScore ?? null;
  details.news_sentiment_7d = cat.newsSentiment7d ?? null;
  details.days_until_earnings = cat.daysUntilEarnings ?? null;
  details.macro_bias = cat.macroBias ?? null;
  details.sector_rank = cat.sectorRank ?? null;

  score = Math.max(0, Math.min(100, score));
  // Pass if any catalyst is materially positive; don't gate strictly here
  const pass = score >= 40 &&
    !(cat.daysUntilEarnings !== null && cat.daysUntilEarnings !== undefined && cat.daysUntilEarnings >= 0 && cat.daysUntilEarnings < 3);
  return { score, pass, details, flags };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSITE & SIGNAL
// ═══════════════════════════════════════════════════════════════════════════

export function composeProphet(
  bars: Bar[],
  layers: ProphetScore['layers'],
  macroBias = 0,
): Omit<ProphetScore, 'layers'> {
  // Regime-adjusted weights
  const w = { ...BASE_WEIGHTS };
  if (macroBias > 0.4) {
    // Risk-on: momentum and catalyst matter more
    w.momentum = 0.15;
    w.fundamental = 0.12;
  } else if (macroBias < -0.4) {
    // Risk-off: fundamental matters more, catalyst less
    w.fundamental = 0.20;
    w.catalyst = 0.18;
  }

  const entries = Object.entries(layers) as [keyof typeof layers, LayerResult][];
  const layersPassed = entries.filter(([, r]) => r.pass).length;
  const weightedSum = entries.reduce((s, [k, r]) => s + r.score * (w as any)[k], 0);
  const composite = Math.round(weightedSum);

  let conviction: ProphetScore['conviction'] = null;
  if (composite >= 80 && layersPassed === 7) conviction = 'HIGH';
  else if (composite >= 65 && layersPassed >= 6) conviction = 'MEDIUM';
  else if (composite >= 50 && layersPassed >= 5) conviction = 'LOW';

  const signal: ProphetScore['signal'] = conviction ? 'BUY' : null;
  const direction: Direction = conviction ? 'long' : 'neutral';

  const allFlags = entries.flatMap(([, r]) => r.flags);

  // Entry/stop/target math from bars
  const closes = bars.map((b) => b.c);
  const latest = closes[closes.length - 1];
  const atr14 = atr(bars) ?? latest * 0.02;
  const sma20 = sma(closes, 20) ?? latest * 0.97;
  const sma50 = sma(closes, 50) ?? latest * 0.94;

  const entry = conviction ? +latest.toFixed(2) : null;
  // Stop: max of 20d SMA and (latest - 2*ATR), whichever is tighter-but-reasonable
  const stopCandidate1 = sma20 * 0.97;  // 3% below 20d SMA
  const stopCandidate2 = latest - 2 * atr14;
  const stop = conviction ? +Math.max(stopCandidate1, stopCandidate2).toFixed(2) : null;
  const targets = conviction
    ? [+(latest + 2 * atr14).toFixed(2), +(latest + 4 * atr14).toFixed(2)]
    : [];
  const invalidation = conviction ? +Math.min(sma50 * 0.98, latest - 3 * atr14).toFixed(2) : null;

  return {
    layersPassed,
    composite,
    conviction,
    signal,
    direction,
    flags: Array.from(new Set(allFlags)),
    entry, stop, targets, invalidation,
  };
}
