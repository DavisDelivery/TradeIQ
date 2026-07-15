// VECTOR — state feature computation at arbitrary (ticker, t) from bars.
//
// Pure: callers supply the bar series (ascending, clipped to <= t by the
// PIT-aware fetcher) plus the SPY series for the same window. Every
// feature that cannot be computed returns null — never a fabricated 0.

export interface FBar {
  t: number; // epoch ms
  c: number;
  h: number;
  l: number;
  v: number;
}

export interface VectorFeatures {
  trendState: 'above200_50above' | 'above200' | 'below200' | null;
  extension: number | null; // close/SMA50 - 1
  contraction: number | null; // ATR14/ATR63
  dist52w: number | null; // close / max(high, 252d)
  drawdown: number | null; // 1 - dist52w
  ivol63: number | null; // sigma of daily residuals vs SPY, 63d
  amihud63: number | null; // mean |ret| / $vol, 63d (x 1e9 for readability)
  volumeShock: number | null; // vol(t) / median63 vol
  sma50: number | null;
  sma200: number | null;
  ema20: number | null;
  higherFiveDayLow: boolean | null;
  close: number;
}

const sma = (xs: number[], n: number): number | null =>
  xs.length >= n ? xs.slice(-n).reduce((a, b) => a + b, 0) / n : null;

function ema(xs: number[], n: number): number | null {
  if (xs.length < n) return null;
  const k = 2 / (n + 1);
  let e = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}

function atr(bars: FBar[], n: number): number | null {
  if (bars.length < n + 1) return null;
  const trs: number[] = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const prevC = bars[i - 1].c;
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prevC), Math.abs(bars[i].l - prevC)));
  }
  return trs.reduce((a, b) => a + b, 0) / n;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Compute all state features from the ticker's bars (ascending, last bar
 * = day t) and SPY bars covering at least the same trailing 64 sessions.
 */
export function computeFeatures(bars: FBar[], spyBars: FBar[]): VectorFeatures {
  const closes = bars.map((b) => b.c);
  const close = closes[closes.length - 1];
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const ema20 = ema(closes, 20);

  let trendState: VectorFeatures['trendState'] = null;
  if (sma200 != null) {
    trendState =
      close > sma200 && sma50 != null && sma50 > sma200
        ? 'above200_50above'
        : close > sma200
          ? 'above200'
          : 'below200';
  }

  const extension = sma50 != null ? close / sma50 - 1 : null;
  const atr14 = atr(bars, 14);
  const atr63 = atr(bars, 63);
  const contraction = atr14 != null && atr63 != null && atr63 > 0 ? atr14 / atr63 : null;

  const hi252 = bars.length >= 252 ? Math.max(...bars.slice(-252).map((b) => b.h)) : null;
  const dist52w = hi252 != null && hi252 > 0 ? close / hi252 : null;
  const drawdown = dist52w != null ? 1 - dist52w : null;

  // Returns for IVOL/amihud (need 64 closes for 63 returns).
  let ivol63: number | null = null;
  let amihud63: number | null = null;
  if (bars.length >= 64) {
    const rets: number[] = [];
    const dollarVols: number[] = [];
    for (let i = bars.length - 63; i < bars.length; i++) {
      rets.push(bars[i].c / bars[i - 1].c - 1);
      dollarVols.push(bars[i].c * bars[i].v);
    }
    // Amihud: mean |ret| / $vol, scaled 1e9 so values are human-readable.
    const ai = rets.map((r, i) => (dollarVols[i] > 0 ? Math.abs(r) / dollarVols[i] : null))
      .filter((x): x is number => x != null);
    amihud63 = ai.length >= 40 ? (ai.reduce((a, b) => a + b, 0) / ai.length) * 1e9 : null;

    // IVOL: residual sigma vs SPY over the same 63 sessions (beta via OLS).
    if (spyBars.length >= 64) {
      const spyRets: number[] = [];
      for (let i = spyBars.length - 63; i < spyBars.length; i++) {
        spyRets.push(spyBars[i].c / spyBars[i - 1].c - 1);
      }
      if (spyRets.length === rets.length) {
        const mx = spyRets.reduce((a, b) => a + b, 0) / spyRets.length;
        const my = rets.reduce((a, b) => a + b, 0) / rets.length;
        let cov = 0;
        let varx = 0;
        for (let i = 0; i < rets.length; i++) {
          cov += (spyRets[i] - mx) * (rets[i] - my);
          varx += (spyRets[i] - mx) ** 2;
        }
        const beta = varx > 1e-12 ? cov / varx : 0;
        const resid = rets.map((r, i) => r - (my + beta * (spyRets[i] - mx)));
        const rv = resid.reduce((a, b) => a + b * b, 0) / resid.length;
        ivol63 = Math.sqrt(rv);
      }
    }
  }

  // Volume shock: today's volume vs 63d median (excluding today).
  let volumeShock: number | null = null;
  if (bars.length >= 64) {
    const med = median(bars.slice(-64, -1).map((b) => b.v));
    if (med != null && med > 0) volumeShock = bars[bars.length - 1].v / med;
  }

  // Higher 5-day low: min(low, last 5) > min(low, prior 5).
  let higherFiveDayLow: boolean | null = null;
  if (bars.length >= 10) {
    const last5 = Math.min(...bars.slice(-5).map((b) => b.l));
    const prior5 = Math.min(...bars.slice(-10, -5).map((b) => b.l));
    higherFiveDayLow = last5 > prior5;
  }

  return {
    trendState, extension, contraction, dist52w, drawdown,
    ivol63, amihud63, volumeShock, sma50, sma200, ema20,
    higherFiveDayLow, close,
  };
}
