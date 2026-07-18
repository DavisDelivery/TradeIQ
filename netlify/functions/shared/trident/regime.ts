// TRIDENT regime module — index-level context for NQ (QQQ proxy), SPX
// (SPY proxy), and R2K (IWM proxy), computed from daily bars.
//
// Design contract: reports/trident/design.md §3. The evidence ranking is
// baked into the OUTPUT SHAPE — `modulation` carries the only fields that
// may change scan behavior (trend gate, size scalar, entry-mix state),
// while `stretch` and `levels` are DISPLAY-ONLY context (overbought does
// not predict weak forward returns and must never gate — StockCharts/CXO
// reviews; Cooper–Gutierrez–Hameed and Faber justify the trend bit;
// Barroso–Santa-Clara / Moreira–Muir justify continuous vol scaling;
// Daniel–Moskowitz justifies the crash-regime breakout suppression).
//
// Pure module: bars in, regime out. No fetches, no clocks (caller passes
// bars; "today" is the last bar).

export interface RegimeBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type TrendState = 'UP' | 'DOWN' | 'FLAT';
export type EntryMixState = 'NORMAL' | 'CHOP' | 'CRASH_REBOUND';

export interface SupportResistanceLevel {
  kind: 'swingHigh' | 'swingLow' | 'donchian20High' | 'donchian20Low' | 'donchian55High' | 'donchian55Low' | 'sma50' | 'sma200' | 'roundNumber';
  price: number;
  /** Signed % distance from last close (+ = level above price). */
  distancePct: number;
}

export interface IndexRegime {
  symbol: string;
  asOf: string; // last bar date
  lastClose: number;
  trend: {
    state: TrendState;
    sma200: number | null;
    sma200SlopePct21d: number | null; // % change of the 200dma over 21 bars
    aboveSma200: boolean | null;
  };
  stretch: {
    rsi14: number | null;
    rsi2: number | null;
    /** Position inside the Donchian-20 channel, 0 (at low) .. 100 (at high). */
    donchian20Pos: number | null;
    /** Annualized 21d realized vol, % */
    realizedVol21Ann: number | null;
    /** Percentile of that vol vs the trailing 2y of 21d windows, 0-100. */
    volPctile2y: number | null;
    /** Plain-language read shown in the UI; NEVER used for gating. */
    label: 'deeply oversold' | 'oversold' | 'neutral' | 'strong' | 'overbought';
  };
  levels: SupportResistanceLevel[]; // sorted by |distancePct|, nearest first
  drawdown: {
    fromHigh252Pct: number | null; // negative number, % below 252d high
  };
  modulation: {
    /** HARD gate: false → no NEW tracked-book entries for this universe. */
    entriesAllowed: boolean;
    /** min(1, 12% / realizedVolAnn) — position-size multiplier, (0,1]. */
    sizeScalar: number;
    entryMix: EntryMixState;
    /** Composite-point demotion applied to BREAKOUT-classified setups. */
    breakoutDemotion: number; // 0 | 15 | 999 (suppressed)
    reasons: string[];
  };
}

const TARGET_VOL_ANN = 12; // %

// ---------------------------------------------------------------------------
// Small math helpers (self-contained; bars ascending by date)
// ---------------------------------------------------------------------------

function smaAt(closes: number[], n: number, end: number): number | null {
  if (end + 1 < n) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += closes[i];
  return s / n;
}

/** Wilder RSI over the full series, value at the last bar. */
export function rsiAt(closes: number[], period: number, end: number): number | null {
  if (end < period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i <= end; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function realizedVolAnnPct(closes: number[], end: number, window: number): number | null {
  if (end + 1 < window + 1) return null;
  const rets: number[] = [];
  for (let i = end - window + 1; i <= end; i++) {
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varc) * Math.sqrt(252) * 100;
}

/** Swing pivots: bar i is a swing high if its high is the max of highs
 *  in [i-k, i+k] (strictly greater than neighbors' max). Returns the most
 *  recent CONFIRMED pivot at each side (needs k bars after it). */
function lastSwing(bars: RegimeBar[], k: number): { high: number | null; low: number | null } {
  let high: number | null = null;
  let low: number | null = null;
  for (let i = bars.length - 1 - k; i >= k; i--) {
    if (high === null) {
      let isHigh = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j !== i && bars[j].high >= bars[i].high) { isHigh = false; break; }
      }
      if (isHigh) high = bars[i].high;
    }
    if (low === null) {
      let isLow = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j !== i && bars[j].low <= bars[i].low) { isLow = false; break; }
      }
      if (isLow) low = bars[i].low;
    }
    if (high !== null && low !== null) break;
  }
  return { high, low };
}

/** Nearest "century-style" round number: powers-of-ten-scaled 100s
 *  (e.g. SPY 600, QQQ 500, IWM 250 → nearest 50 for <500, nearest 100 above). */
function nearestRound(price: number): number {
  const step = price >= 500 ? 100 : price >= 100 ? 50 : price >= 20 ? 10 : 5;
  return Math.round(price / step) * step;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function computeIndexRegime(symbol: string, bars: RegimeBar[]): IndexRegime | null {
  if (!bars || bars.length < 60) return null;
  const closes = bars.map((b) => b.close);
  const end = bars.length - 1;
  const lastClose = closes[end];
  const asOf = bars[end].date;

  // Trend
  const sma200 = smaAt(closes, 200, end);
  const sma200Prev = smaAt(closes, 200, end - 21);
  const sma200SlopePct21d =
    sma200 !== null && sma200Prev !== null ? ((sma200 - sma200Prev) / sma200Prev) * 100 : null;
  const aboveSma200 = sma200 !== null ? lastClose > sma200 : null;
  let trendState: TrendState = 'FLAT';
  if (aboveSma200 !== null && sma200SlopePct21d !== null) {
    if (aboveSma200 && sma200SlopePct21d >= 0) trendState = 'UP';
    else if (!aboveSma200 && sma200SlopePct21d < 0) trendState = 'DOWN';
    else trendState = 'FLAT';
  } else if (aboveSma200 !== null) {
    trendState = aboveSma200 ? 'UP' : 'DOWN';
  }

  // Stretch
  const rsi14 = rsiAt(closes, 14, end);
  const rsi2 = rsiAt(closes, 2, end);
  const don20High = Math.max(...bars.slice(Math.max(0, end - 19), end + 1).map((b) => b.high));
  const don20Low = Math.min(...bars.slice(Math.max(0, end - 19), end + 1).map((b) => b.low));
  const donchian20Pos =
    don20High > don20Low ? ((lastClose - don20Low) / (don20High - don20Low)) * 100 : null;
  const realizedVol21Ann = realizedVolAnnPct(closes, end, 21);
  // Vol percentile: 21d realized vol today vs each day's 21d vol over ~2y.
  let volPctile2y: number | null = null;
  if (realizedVol21Ann !== null && end >= 120) {
    const from = Math.max(22, end - 504);
    const history: number[] = [];
    for (let i = from; i <= end; i++) {
      const v = realizedVolAnnPct(closes, i, 21);
      if (v !== null) history.push(v);
    }
    if (history.length >= 60) {
      const below = history.filter((v) => v <= realizedVol21Ann).length;
      volPctile2y = (below / history.length) * 100;
    }
  }
  const label: IndexRegime['stretch']['label'] =
    rsi14 === null ? 'neutral'
    : rsi2 !== null && rsi2 < 10 && trendState === 'UP' ? 'deeply oversold'
    : rsi14 < 30 ? 'oversold'
    : rsi14 > 70 ? 'overbought'
    : rsi14 > 55 ? 'strong'
    : 'neutral';

  // Levels
  const don55High = end >= 54 ? Math.max(...bars.slice(end - 54, end + 1).map((b) => b.high)) : null;
  const don55Low = end >= 54 ? Math.min(...bars.slice(end - 54, end + 1).map((b) => b.low)) : null;
  const sma50 = smaAt(closes, 50, end);
  const swing = lastSwing(bars, 10);
  const round = nearestRound(lastClose);
  const rawLevels: Array<[SupportResistanceLevel['kind'], number | null]> = [
    ['swingHigh', swing.high],
    ['swingLow', swing.low],
    ['donchian20High', don20High],
    ['donchian20Low', don20Low],
    ['donchian55High', don55High],
    ['donchian55Low', don55Low],
    ['sma50', sma50],
    ['sma200', sma200],
    ['roundNumber', round],
  ];
  const levels: SupportResistanceLevel[] = rawLevels
    .filter((x): x is [SupportResistanceLevel['kind'], number] => x[1] !== null && Number.isFinite(x[1]))
    .map(([kind, price]) => ({
      kind,
      price: +price.toFixed(2),
      distancePct: +(((price - lastClose) / lastClose) * 100).toFixed(2),
    }))
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));

  // Drawdown + crash regime (Daniel–Moskowitz style detector)
  const high252 = Math.max(...bars.slice(Math.max(0, end - 251), end + 1).map((b) => b.high));
  const fromHigh252Pct = high252 > 0 ? +(((lastClose - high252) / high252) * 100).toFixed(2) : null;
  // "Was >=15% below the 252d high at any point in the last 63 bars"
  let recentDeepDrawdown = false;
  for (let i = Math.max(0, end - 62); i <= end; i++) {
    const h = Math.max(...bars.slice(Math.max(0, i - 251), i + 1).map((b) => b.high));
    if (h > 0 && (bars[i].close - h) / h <= -0.15) { recentDeepDrawdown = true; break; }
  }
  const crashRebound = recentDeepDrawdown && (volPctile2y ?? 0) > 80;

  // Modulation (the ONLY behavior-changing outputs)
  const reasons: string[] = [];
  const entriesAllowed = trendState !== 'DOWN';
  if (!entriesAllowed) reasons.push('index below falling 200dma — new entries gated (Faber/CGH04)');
  const sizeScalar =
    realizedVol21Ann !== null && realizedVol21Ann > 0
      ? +Math.min(1, TARGET_VOL_ANN / realizedVol21Ann).toFixed(2)
      : 1;
  if (sizeScalar < 1) reasons.push(`vol scaling ${sizeScalar}x (realized ${realizedVol21Ann?.toFixed(0)}% vs ${TARGET_VOL_ANN}% target)`);
  let entryMix: EntryMixState = 'NORMAL';
  let breakoutDemotion = 0;
  if (crashRebound) {
    entryMix = 'CRASH_REBOUND';
    breakoutDemotion = 999;
    reasons.push('post-drawdown high-vol rebound — breakout entries suppressed (Daniel–Moskowitz)');
  } else if (trendState === 'FLAT' && (volPctile2y ?? 0) > 60) {
    entryMix = 'CHOP';
    breakoutDemotion = 15;
    reasons.push('choppy tape — breakout setups demoted, pullbacks favored (failure rates ~double in chop)');
  }

  return {
    symbol,
    asOf,
    lastClose: +lastClose.toFixed(2),
    trend: {
      state: trendState,
      sma200: sma200 !== null ? +sma200.toFixed(2) : null,
      sma200SlopePct21d: sma200SlopePct21d !== null ? +sma200SlopePct21d.toFixed(2) : null,
      aboveSma200,
    },
    stretch: {
      rsi14: rsi14 !== null ? +rsi14.toFixed(1) : null,
      rsi2: rsi2 !== null ? +rsi2.toFixed(1) : null,
      donchian20Pos: donchian20Pos !== null ? +donchian20Pos.toFixed(1) : null,
      realizedVol21Ann: realizedVol21Ann !== null ? +realizedVol21Ann.toFixed(1) : null,
      volPctile2y: volPctile2y !== null ? +volPctile2y.toFixed(0) : null,
      label,
    },
    levels,
    drawdown: { fromHigh252Pct },
    modulation: { entriesAllowed, sizeScalar, entryMix, breakoutDemotion, reasons },
  };
}
