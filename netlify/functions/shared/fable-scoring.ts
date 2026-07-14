// FABLE — my board. Pure scoring engine.
//
// Designed by Claude (claude-fable-5) from a blank slate for a 30–170
// trading-day horizon. Synthesis of four research sweeps (academic factors,
// verifiable practitioner systems, insider evidence, institutional quant
// practice) — full rationale + citations in reports/fable/design.md. The
// constants below are PRE-COMMITTED: they are the constants under test in
// the binding validation rule, frozen at the commit that introduces them.
//
// Architecture invariant: the composite is CROSS-SECTION-FREE — every
// pillar maps raw measurements through fixed squashes to 0-100, so the
// live scan and the PIT backtest compute IDENTICAL scores per ticker.
// (Cross-sectional percentiles are display-layer only.) This is what makes
// the backtest an honest test of the shipped board rather than a cousin.
//
// Pure module: no I/O, no wall clock — everything derives from the bars,
// transactions, and asOf date passed in.

export interface FableBar {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Finnhub Form-4 shape (subset used here). */
export interface FableInsiderTx {
  name: string;
  change: number; // signed share delta
  transactionPrice: number;
  transactionCode: string; // 'P' open-market purchase, 'S' sale
  filingDate: string; // YYYY-MM-DD — the PIT timestamp
  transactionDate: string;
  isDerivative?: boolean;
}

// ---------------------------------------------------------------------------
// Pre-committed constants (the validation rule tests EXACTLY these).
// ---------------------------------------------------------------------------

export const FABLE_CONSTANTS = {
  MIN_BARS: 287, // 252 + slack — also auto-excludes recent IPOs
  MIN_PRICE: 5,
  MIN_MEDIAN_DOLLAR_VOL: 10_000_000, // 63d median $ volume

  // Foundation gate
  GATE_LOW_MULT: 1.3, // ≥30% above 52wk low
  GATE_HIGH_MULT: 0.75, // within 25% of 52wk high
  SMA200_RISING_LOOKBACK: 21,

  // Pillar squash bounds (raw → 0-100)
  RS_FULL_SCALE: 0.6, // weighted RS of +60% → 100
  FIP_BEST: -0.25, // very smooth winner
  FIP_WORST: 0.05,
  IMOM_FULL_SCALE: 3.5, // information ratio → 100
  ATR_RATIO_BEST: 0.5,
  ATR_RATIO_WORST: 1.1,
  RANGE10_BEST: 0.02,
  RANGE10_WORST: 0.12,
  DRYUP_BEST: 0.5,
  DRYUP_WORST: 1.2,
  EXT_DAMPER_START: 0.15, // ≤15% above SMA50: no damping
  EXT_DAMPER_END: 0.35, // ≥35% above: pillar 4 zeroed

  // Insider edge
  INSIDER_MIN_BUY_USD: 25_000,
  INSIDER_MAX_FILING_LAG_DAYS: 30,
  INSIDER_DECAY_DAYS: 180,
  INSIDER_CLUSTER_WINDOW_DAYS: 90,
  INSIDER_NET_USD_STRONG: 250_000,
  INSIDER_SELL_VETO_USD: 1_000_000,

  // Position discipline (display)
  BAND_ENTER_PCTL: 90,
  BAND_EXIT_PCTL: 60,
  MAX_HOLD_TRADING_DAYS: 126,
  STOP_PCT: 0.08,
} as const;

const C = FABLE_CONSTANTS;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function clip01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Simple moving average of closes ending at index `end` (inclusive). */
export function smaAt(bars: FableBar[], n: number, end: number): number | null {
  if (end + 1 < n) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += bars[i].c;
  return s / n;
}

function windowReturn(bars: FableBar[], from: number, to: number): number | null {
  if (from < 0 || to >= bars.length || bars[from].c <= 0) return null;
  return bars[to].c / bars[from].c - 1;
}

function trueRange(prevClose: number, b: FableBar): number {
  return Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose));
}

function atrAt(bars: FableBar[], n: number, end: number): number | null {
  if (end < n) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += trueRange(bars[i - 1].c, bars[i]);
  return s / n;
}

// ---------------------------------------------------------------------------
// Gate — FOUNDATION (the one hard gate)
// ---------------------------------------------------------------------------

export interface FableGate {
  pass: boolean;
  /** Which conditions failed (empty when pass). */
  failed: string[];
}

export function evaluateFoundationGate(bars: FableBar[]): FableGate {
  const failed: string[] = [];
  const end = bars.length - 1;
  if (bars.length < C.MIN_BARS) return { pass: false, failed: ['insufficient-history'] };

  const close = bars[end].c;
  const sma50 = smaAt(bars, 50, end);
  const sma150 = smaAt(bars, 150, end);
  const sma200 = smaAt(bars, 200, end);
  const sma200Prev = smaAt(bars, 200, end - C.SMA200_RISING_LOOKBACK);
  let lo52 = Infinity;
  let hi52 = -Infinity;
  for (let i = end - 251; i <= end; i++) {
    if (bars[i].l < lo52) lo52 = bars[i].l;
    if (bars[i].h > hi52) hi52 = bars[i].h;
  }
  const mom121 = windowReturn(bars, end - 252, end - 21);

  if (close < C.MIN_PRICE) failed.push('price-floor');
  if (sma50 === null || sma150 === null || sma200 === null || sma200Prev === null) {
    failed.push('insufficient-history');
  } else {
    if (!(close > sma50 && sma50 > sma150 && sma150 > sma200)) failed.push('ma-stack');
    if (!(sma200 > sma200Prev)) failed.push('sma200-not-rising');
  }
  if (!(close >= C.GATE_LOW_MULT * lo52)) failed.push('too-close-to-52wk-low');
  if (!(close >= C.GATE_HIGH_MULT * hi52)) failed.push('too-far-from-52wk-high');
  if (mom121 === null || mom121 <= 0) failed.push('negative-12-1-momentum');

  return { pass: failed.length === 0, failed };
}

// ---------------------------------------------------------------------------
// Pillars 1-4 from bars (+ SPY bars for the residual)
// ---------------------------------------------------------------------------

export interface FablePillars {
  ascent: number; // P1 0-100
  smoothPath: number; // P2 0-100
  highGround: number; // P3 0-100
  coiledSpring: number; // P4 0-100
  // raw diagnostics for the UI
  rsRaw: number;
  fip: number;
  imomIr: number;
  proximity52w: number;
  atrRatio: number;
  range10Pct: number;
  volDryup: number;
  extensionPct: number;
}

/**
 * Compute pillars 1-4. `spyBars` must be date-aligned "closely enough":
 * we align by timestamp map and use the intersection (robust to holiday
 * mismatches). Returns null when history is insufficient.
 */
export function computePillars(bars: FableBar[], spyBars: FableBar[]): FablePillars | null {
  const end = bars.length - 1;
  if (bars.length < C.MIN_BARS) return null;
  const close = bars[end].c;

  // P1 — ASCENT: 0.4·r63 + 0.2·r126 + 0.2·r189 + 0.2·r252
  const r63 = windowReturn(bars, end - 63, end);
  const r126 = windowReturn(bars, end - 126, end);
  const r189 = windowReturn(bars, end - 189, end);
  const r252 = windowReturn(bars, end - 252, end);
  if (r63 === null || r126 === null || r189 === null || r252 === null) return null;
  const rsRaw = 0.4 * r63 + 0.2 * r126 + 0.2 * r189 + 0.2 * r252;
  const ascent = clip01(rsRaw / C.RS_FULL_SCALE) * 100;

  // Formation window t-252 → t-21 daily returns (for FIP + iMOM)
  const spyByT = new Map<number, number>();
  for (const b of spyBars) spyByT.set(b.t, b.c);
  const stockRets: number[] = [];
  const mktRets: number[] = [];
  let pos = 0;
  let neg = 0;
  let nonZero = 0;
  let prevSpy: number | null = null;
  for (let i = end - 252; i <= end - 21; i++) {
    if (i <= 0) continue;
    const r = bars[i].c / bars[i - 1].c - 1;
    if (r > 0) pos++;
    else if (r < 0) neg++;
    if (r !== 0) nonZero++;
    const spyC = spyByT.get(bars[i].t);
    if (spyC !== undefined && prevSpy !== null && prevSpy > 0) {
      stockRets.push(r);
      mktRets.push(spyC / prevSpy - 1);
    }
    if (spyC !== undefined) prevSpy = spyC;
  }
  const mom121 = windowReturn(bars, end - 252, end - 21) ?? 0;
  const fip = nonZero > 0 ? Math.sign(mom121) * ((neg - pos) / nonZero) : 0;
  const fipScore = clip01((-fip - -C.FIP_WORST) / (-C.FIP_BEST - -C.FIP_WORST)) * 100;

  // iMOM information ratio: residual vs SPY over the formation window
  let imomIr = 0;
  if (stockRets.length >= 100) {
    const n = stockRets.length;
    const mMean = mktRets.reduce((a, b) => a + b, 0) / n;
    const sMean = stockRets.reduce((a, b) => a + b, 0) / n;
    let cov = 0;
    let varM = 0;
    for (let i = 0; i < n; i++) {
      cov += (stockRets[i] - sMean) * (mktRets[i] - mMean);
      varM += (mktRets[i] - mMean) ** 2;
    }
    const beta = varM > 0 ? cov / varM : 1;
    const resid = stockRets.map((r, i) => r - beta * mktRets[i]);
    const rMean = resid.reduce((a, b) => a + b, 0) / n;
    const rStd = Math.sqrt(resid.reduce((a, b) => a + (b - rMean) ** 2, 0) / (n - 1));
    imomIr = rStd > 0 ? (rMean * n) / (rStd * Math.sqrt(n)) : 0;
  }
  const imomScore = clip01(imomIr / C.IMOM_FULL_SCALE) * 100;
  const smoothPath = (fipScore + imomScore) / 2;

  // P3 — HIGH GROUND
  let hi52 = -Infinity;
  for (let i = end - 251; i <= end; i++) if (bars[i].h > hi52) hi52 = bars[i].h;
  const proximity52w = hi52 > 0 ? close / hi52 : 0;
  const highGround = clip01((proximity52w - C.GATE_HIGH_MULT) / (1 - C.GATE_HIGH_MULT)) * 100;

  // P4 — COILED SPRING
  const atr14 = atrAt(bars, 14, end);
  const atr63 = atrAt(bars, 63, end);
  const atrRatio = atr14 !== null && atr63 !== null && atr63 > 0 ? atr14 / atr63 : 1;
  const aScore = clip01((C.ATR_RATIO_WORST - atrRatio) / (C.ATR_RATIO_WORST - C.ATR_RATIO_BEST)) * 100;
  let hi10 = -Infinity;
  let lo10 = Infinity;
  for (let i = end - 9; i <= end; i++) {
    if (bars[i].h > hi10) hi10 = bars[i].h;
    if (bars[i].l < lo10) lo10 = bars[i].l;
  }
  const range10Pct = close > 0 ? (hi10 - lo10) / close : 1;
  const rScore = clip01((C.RANGE10_WORST - range10Pct) / (C.RANGE10_WORST - C.RANGE10_BEST)) * 100;
  const vol10 = bars.slice(end - 9, end + 1).reduce((a, b) => a + (b.v || 0), 0) / 10;
  const vol63 = bars.slice(end - 62, end + 1).reduce((a, b) => a + (b.v || 0), 0) / 63;
  const volDryup = vol63 > 0 ? vol10 / vol63 : 1;
  const dScore = clip01((C.DRYUP_WORST - volDryup) / (C.DRYUP_WORST - C.DRYUP_BEST)) * 100;
  const sma50 = smaAt(bars, 50, end) ?? close;
  const extensionPct = sma50 > 0 ? close / sma50 - 1 : 0;
  const damper =
    extensionPct <= C.EXT_DAMPER_START
      ? 1
      : extensionPct >= C.EXT_DAMPER_END
        ? 0
        : (C.EXT_DAMPER_END - extensionPct) / (C.EXT_DAMPER_END - C.EXT_DAMPER_START);
  const coiledSpring = ((aScore + rScore + dScore) / 3) * damper;

  return {
    ascent,
    smoothPath,
    highGround,
    coiledSpring,
    rsRaw,
    fip,
    imomIr,
    proximity52w,
    atrRatio,
    range10Pct,
    volDryup,
    extensionPct,
  };
}

// ---------------------------------------------------------------------------
// Pillar 5 — INSIDER EDGE (0-100 calibrated event score)
// ---------------------------------------------------------------------------

export interface InsiderEdge {
  score: number; // 0-100
  buyers90d: number;
  netBuyUsd90d: number;
  latestFiling: string | null;
  sellVeto: boolean;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / 86_400_000,
  );
}

/**
 * `roleByName` is optional: the live scan enriches roles via EDGAR; the
 * PIT path omits it (role feed is not PIT-reconstructable), which makes
 * the backtest slightly CONSERVATIVE on this pillar — acceptable and
 * documented in the design.
 */
export function computeInsiderEdge(
  txs: FableInsiderTx[],
  asOfIso: string,
  roleByName?: Map<string, string>,
): InsiderEdge {
  interface Buy { name: string; usd: number; filingDate: string }
  const buys: Buy[] = [];
  const sellers = new Map<string, number>();
  for (const tx of txs) {
    if (tx.isDerivative) continue;
    if (!tx.filingDate || tx.filingDate > asOfIso) continue; // PIT: visible once FILED
    const age = daysBetween(tx.filingDate, asOfIso);
    if (age < 0 || age > C.INSIDER_CLUSTER_WINDOW_DAYS * 2) continue;
    const usd = Math.abs(tx.change) * (tx.transactionPrice || 0);
    if (tx.transactionCode === 'P' && tx.change > 0) {
      if (usd < C.INSIDER_MIN_BUY_USD) continue;
      if (
        tx.transactionDate &&
        daysBetween(tx.transactionDate, tx.filingDate) > C.INSIDER_MAX_FILING_LAG_DAYS
      )
        continue; // stale/corrective filing
      buys.push({ name: tx.name, usd, filingDate: tx.filingDate });
    } else if (tx.transactionCode === 'S' && tx.change < 0 && age <= C.INSIDER_CLUSTER_WINDOW_DAYS) {
      sellers.set(tx.name, (sellers.get(tx.name) ?? 0) + usd);
    }
  }

  const buys90 = buys.filter((b) => daysBetween(b.filingDate, asOfIso) <= C.INSIDER_CLUSTER_WINDOW_DAYS);
  const distinct90 = new Set(buys90.map((b) => b.name));
  const netBuyUsd90d = buys90.reduce((a, b) => a + b.usd, 0);
  const latest = buys.reduce<string | null>(
    (acc, b) => (acc === null || b.filingDate > acc ? b.filingDate : acc),
    null,
  );
  const w =
    latest !== null ? Math.max(0, 1 - daysBetween(latest, asOfIso) / C.INSIDER_DECAY_DAYS) : 0;

  let score = 0;
  if (latest !== null) score += 40 * w;
  if (distinct90.size >= 2) score += 25 * w;
  if (distinct90.size >= 3) score += 15 * w;
  if (roleByName) {
    const exec = buys90.some((b) => /chief|ceo|cfo|chair|president/i.test(roleByName.get(b.name) ?? ''));
    if (exec) score += 10 * w;
  }
  if (netBuyUsd90d >= C.INSIDER_NET_USD_STRONG) score += 10 * w;

  const bigSellers = Array.from(sellers.values()).filter((v) => v > 0);
  const sellVeto =
    bigSellers.length >= 2 && bigSellers.reduce((a, b) => a + b, 0) >= C.INSIDER_SELL_VETO_USD;
  if (sellVeto) score -= 25;

  return {
    score: Math.max(0, Math.min(100, score)),
    buyers90d: distinct90.size,
    netBuyUsd90d,
    latestFiling: latest,
    sellVeto,
  };
}

// ---------------------------------------------------------------------------
// Composite + display helpers
// ---------------------------------------------------------------------------

export interface FableScore {
  composite: number; // 0-100, cross-section-free
  pillars: FablePillars;
  insider: InsiderEdge;
  gate: FableGate;
}

/** The FABLE composite. Identical in live scan and PIT backtest. */
export function computeFableComposite(pillars: FablePillars, insider: InsiderEdge): number {
  return (
    0.2 * (pillars.ascent + pillars.smoothPath + pillars.highGround + pillars.coiledSpring) +
    0.2 * insider.score
  );
}

/** Full single-name evaluation (gate → pillars → composite). Null = no setup. */
export function scoreFable(
  bars: FableBar[],
  spyBars: FableBar[],
  insiderTxs: FableInsiderTx[],
  asOfIso: string,
  roleByName?: Map<string, string>,
): FableScore | null {
  const gate = evaluateFoundationGate(bars);
  if (!gate.pass) return null;
  const pillars = computePillars(bars, spyBars);
  if (!pillars) return null;
  const insider = computeInsiderEdge(insiderTxs, asOfIso, roleByName);
  return { composite: computeFableComposite(pillars, insider), pillars, insider, gate };
}

/** Display-layer percentile of each value among the passers (0-100, ties averaged). */
export function percentileAmong(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const pct = values.length > 1 ? ((i + j) / 2 / (values.length - 1)) * 100 : 50;
    for (let k = i; k <= j; k++) out[idx[k].i] = pct;
    i = j + 1;
  }
  return out;
}

/** Suggested entry/stop for the UI (bars-derived, informational). */
export function suggestEntry(bars: FableBar[]): { pivot: number; stop: number } {
  const end = bars.length - 1;
  let hi10 = -Infinity;
  let lo10 = Infinity;
  for (let i = Math.max(0, end - 9); i <= end; i++) {
    if (bars[i].h > hi10) hi10 = bars[i].h;
    if (bars[i].l < lo10) lo10 = bars[i].l;
  }
  const pivot = hi10;
  const stop = Math.max(pivot * (1 - C.STOP_PCT), lo10);
  return { pivot: +pivot.toFixed(2), stop: +stop.toFixed(2) };
}

// Regime classification (market-level; SPY bars)
export type FableRegime = 'offense' | 'defense' | 'panic';

export function classifyFableRegime(spyBars: FableBar[]): FableRegime {
  const end = spyBars.length - 1;
  if (spyBars.length < 200) return 'offense';
  const sma200 = smaAt(spyBars, 200, end);
  const close = spyBars[end].c;
  const defense = sma200 !== null && close < sma200;
  // panic: trailing ~24mo return < 0 AND 21d realized vol in top decile of trailing 5y
  let panic = false;
  if (spyBars.length >= 400) {
    const idx24 = Math.max(0, end - 504);
    const ret24 = close / spyBars[idx24].c - 1;
    const dailyVol = (from: number, to: number) => {
      const rets: number[] = [];
      for (let i = from + 1; i <= to; i++) rets.push(spyBars[i].c / spyBars[i - 1].c - 1);
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      return Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
    };
    const vol21 = dailyVol(end - 21, end);
    const hist: number[] = [];
    for (let e = end; e > Math.max(21, end - 1260); e -= 21) hist.push(dailyVol(e - 21, e));
    hist.sort((a, b) => a - b);
    const p90 = hist[Math.floor(hist.length * 0.9)] ?? Infinity;
    panic = ret24 < 0 && vol21 >= p90;
  }
  return panic ? 'panic' : defense ? 'defense' : 'offense';
}
