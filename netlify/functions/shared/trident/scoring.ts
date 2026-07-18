// TRIDENT scorer — pure. Contract: reports/trident/design.md §2.
//
// Three pillars, each 0–100 raw (universe percentiles are assigned at
// scan level, not here): F (fundamental thrust), T (technical setup),
// I (institutional accumulation). The I pillar's EDGAR-fed inputs are
// OPTIONAL — until the 13D/13F pipes are populated the scorer reweights
// F/T pro-rata and marks `institutionalState: 'warming'` (design §2:
// "no fake zeros").
//
// v1 deviations from the design doc, on record:
//   - f2 SurpriseQuality omits the CAR3 sign-agreement term (needs
//     announcement-window bars; lands with the estimates snapshotter).
//     v1 = latest surprise % + beat streak.
//   - f3 RevisionMomentum uses monthly analyst-recommendation deltas
//     (PIT-friendly history at our Finnhub tier) as the revision proxy;
//     upgrades to true estimate-revision deltas when our own snapshots
//     accrue ≥60d (design §4 P3).

export interface TridentBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TridentEarningsRow {
  period: string; // fiscal quarter end YYYY-MM-DD, newest first NOT required — we sort
  epsActual: number;
  epsEstimate: number;
  surprisePct?: number;
}

export interface TridentRecRow {
  period: string; // YYYY-MM-DD month start
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export interface TridentFundamentals {
  epsGrowthTTM?: number;
  grossMargin?: number;
  priorGrossMarginYoY?: number;
  operatingMargin?: number;
  priorOperatingMarginYoY?: number;
  roe?: number | null; // decimal (0.18 = 18%)
  operatingCashflowTTM?: number | null;
  grossProfitTTM?: number | null;
}

export interface ActivistEvent {
  filer: string;
  type: '13D' | '13D/A';
  acceptedAt: string; // ISO date
  stakePct?: number;
}

export interface ConvictionAdd {
  fund: string;
  action: 'new' | 'increase';
  portfolioWeightPct: number;
  acceptedAt: string; // ISO date
}

export interface InstitutionalInputs {
  activist: ActivistEvent | null;
  convictionAdds: ConvictionAdd[];
  /** W3 flips this — false means the 13F pipeline isn't ingested yet, so
   *  i2/i3 are NULL (renormalized), never zero (missing data ≠ nobody
   *  buying). */
  convictionDataAvailable?: boolean;
  clusterCount: number;
  shortInterestPctFloat: number | null;
  /** Crowding proxy when %float is unavailable: FINRA days-to-cover. */
  daysToCover?: number | null;
  instShareOfFloatPct: number | null;
  breadthDecline: boolean | null;
  /** Open-market insider net buys, last 90d, dollars. */
  insiderNetBuyDollars: number | null;
}

export type EntryKind = 'BREAKOUT' | 'PULLBACK' | 'NONE';

export interface TridentEntry {
  kind: EntryKind;
  pivot: number | null;
  stop: number | null;
  note: string;
}

export interface TridentPillars {
  F: number; // 0-100
  T: number;
  I: number | null; // null while institutional feeds warm up
  sub: {
    f1Acceleration: number | null;
    f2Surprise: number | null;
    f3Revisions: number | null;
    f4Quality: number | null;
    t1HighGround: number;
    t2TrendQuality: number;
    t3Coil: number;
    t4Volume: number;
    i1Activist: number | null;
    i2Conviction: number | null;
    i3Cluster: number | null;
    i4Crowding: number | null;
    i5Insider: number | null;
  };
}

export interface TridentScore {
  eligible: boolean;
  gateReasons: string[];
  pillars: TridentPillars | null;
  entry: TridentEntry | null;
  /** Raw weighted composite 0-100 (percentile-ranked at scan level). */
  composite: number | null;
  institutionalState: 'live' | 'warming';
  diagnostics: Record<string, number | string | boolean | null>;
}

export const TRIDENT_CONSTANTS = {
  MIN_PRICE: 3,
  MIN_DOLLAR_VOL_SP500: 10_000_000,
  MIN_DOLLAR_VOL_R2K: 2_000_000,
  WEIGHT_F: 0.4,
  WEIGHT_T: 0.35,
  WEIGHT_I: 0.25,
  // F sub-weights
  F_W: { f1: 0.35, f2: 0.2, f3: 0.25, f4: 0.2 },
  T_W: { t1: 0.3, t2: 0.25, t3: 0.25, t4: 0.2 },
  I_W: { i1: 0.4, i2: 0.3, i3: 0.15, i5: 0.15 }, // i4 is a subtraction, cap -15
  ACTIVIST_FULL_DAYS: 30,
  ACTIVIST_ZERO_DAYS: 180,
  CONVICTION_ZERO_DAYS: 135,
} as const;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

/** Squash a raw value through a soft scale: score 50 at 0, ~90 at +hi, ~10 at -hi. */
function squash(v: number, hi: number): number {
  return clamp(50 + 40 * Math.tanh(v / hi));
}

function smaAt(vals: number[], n: number, end: number): number | null {
  if (end + 1 < n) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += vals[i];
  return s / n;
}

function rsi2At(closes: number[], end: number): number | null {
  if (end < 2) return null;
  let g = 0;
  let l = 0;
  for (let i = end - 1; i <= end; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  if (l === 0) return 100;
  if (g === 0) return 0;
  return 100 - 100 / (1 + g / l);
}

function daysBetween(aIso: string, bIso: string): number {
  return Math.abs(Date.parse(bIso) - Date.parse(aIso)) / 86400000;
}

// ---------------------------------------------------------------------------
// F pillar
// ---------------------------------------------------------------------------

export function scoreAcceleration(earnings: TridentEarningsRow[]): number | null {
  const rows = [...earnings].sort((a, b) => b.period.localeCompare(a.period));
  if (rows.length < 8) return null;
  const yoy = (t: number): number | null => {
    const cur = rows[t]?.epsActual;
    const prior = rows[t + 4]?.epsActual;
    if (cur === undefined || prior === undefined || !Number.isFinite(cur) || !Number.isFinite(prior)) return null;
    if (Math.abs(prior) < 0.01) return null; // base too small — acceleration meaningless
    return (cur - prior) / Math.abs(prior);
  };
  const g0 = yoy(0);
  const g1 = yoy(1);
  const g2 = yoy(2);
  if (g0 === null || g1 === null) return null;
  const a1 = g0 - g1; // acceleration, latest
  const a2 = g1 !== null && g2 !== null ? g1 - g2 : null;
  let score = squash(a1, 0.4); // ±40pp of YoY-growth change ≈ full range
  if (a2 !== null && a1 > 0 && a2 > 0) score = clamp(score + 8); // sustained
  if (a2 !== null && a1 < 0 && a2 < 0) score = clamp(score - 8); // sustained decel
  return score;
}

export function scoreSurprise(earnings: TridentEarningsRow[]): number | null {
  const rows = [...earnings].sort((a, b) => b.period.localeCompare(a.period));
  if (rows.length === 0) return null;
  const latest = rows[0];
  const sp = latest.surprisePct ?? (latest.epsEstimate !== 0 ? ((latest.epsActual - latest.epsEstimate) / Math.abs(latest.epsEstimate)) * 100 : null);
  if (sp === null || !Number.isFinite(sp)) return null;
  let streak = 0;
  for (const r of rows.slice(0, 4)) {
    if (r.epsActual > r.epsEstimate) streak += 1;
    else break;
  }
  return clamp(squash(sp, 15) * 0.7 + (streak / 4) * 100 * 0.3);
}

export function scoreRevisions(recs: TridentRecRow[]): number | null {
  const rows = [...recs].sort((a, b) => b.period.localeCompare(a.period));
  if (rows.length < 3) return null;
  const ratio = (r: TridentRecRow): number | null => {
    const total = r.strongBuy + r.buy + r.hold + r.sell + r.strongSell;
    if (total < 3) return null; // too few analysts to mean anything
    return (r.strongBuy + r.buy) / total;
  };
  const now = ratio(rows[0]);
  const prev2 = ratio(rows[2]);
  if (now === null || prev2 === null) return null;
  const delta = now - prev2; // 2-month change in bullish breadth
  return clamp(squash(delta, 0.15) * 0.75 + now * 100 * 0.25);
}

export function scoreQuality(f: TridentFundamentals | null): number | null {
  if (!f) return null;
  const parts: number[] = [];
  if (f.roe != null && Number.isFinite(f.roe)) parts.push(squash(f.roe - 0.1, 0.15)); // 10% ROE = neutral
  if (f.grossMargin != null && f.priorGrossMarginYoY != null)
    parts.push(squash(f.grossMargin - f.priorGrossMarginYoY, 0.05));
  if (f.operatingMargin != null && f.priorOperatingMarginYoY != null)
    parts.push(squash(f.operatingMargin - f.priorOperatingMarginYoY, 0.05));
  if (f.epsGrowthTTM != null && Number.isFinite(f.epsGrowthTTM)) parts.push(squash(f.epsGrowthTTM, 0.5));
  if (parts.length === 0) return null;
  return clamp(parts.reduce((a, b) => a + b, 0) / parts.length);
}

// ---------------------------------------------------------------------------
// T pillar
// ---------------------------------------------------------------------------

export interface TechContext {
  t1: number;
  t2: number;
  t3: number;
  t4: number;
  entry: TridentEntry;
  diagnostics: Record<string, number | string | null>;
}

export function scoreTechnicals(bars: TridentBar[], benchBars: TridentBar[]): TechContext | null {
  if (bars.length < 220 || benchBars.length < 80) return null;
  const closes = bars.map((b) => b.close);
  const end = bars.length - 1;
  const last = closes[end];

  // t1 — 52w-high proximity (George–Hwang)
  const high252 = Math.max(...bars.slice(Math.max(0, end - 251), end + 1).map((b) => b.high));
  const proximity = last / high252; // 0..1
  const t1 = clamp(((proximity - 0.7) / 0.3) * 100); // 70% of high → 0, at high → 100

  // t2 — trend quality: MAD + RS vs benchmark
  const sma21 = smaAt(closes, 21, end);
  const sma50 = smaAt(closes, 50, end);
  const sma200 = smaAt(closes, 200, end);
  const mad = sma21 !== null && sma200 !== null ? (sma21 - sma200) / sma200 : null;
  const bc = benchBars.map((b) => b.close);
  const bEnd = benchBars.length - 1;
  const ret63 = end >= 63 ? closes[end] / closes[end - 63] - 1 : null;
  const bRet63 = bEnd >= 63 ? bc[bEnd] / bc[bEnd - 63] - 1 : null;
  const rs63 = ret63 !== null && bRet63 !== null ? ret63 - bRet63 : null;
  const t2 = clamp(
    (mad !== null ? squash(mad, 0.15) : 50) * 0.5 + (rs63 !== null ? squash(rs63, 0.15) : 50) * 0.5,
  );

  // t3 — coil + entry classification
  const win20 = bars.slice(end - 19, end + 1);
  const hi20 = Math.max(...win20.map((b) => b.high));
  const lo20 = Math.min(...win20.map((b) => b.low));
  const range20Pct = (hi20 - lo20) / last;
  // tightness percentile vs own trailing 6 months of 20d ranges
  const ranges: number[] = [];
  for (let i = Math.max(19, end - 126); i <= end; i++) {
    const w = bars.slice(i - 19, i + 1);
    ranges.push((Math.max(...w.map((b) => b.high)) - Math.min(...w.map((b) => b.low))) / bars[i].close);
  }
  const tighter = ranges.filter((r) => r >= range20Pct).length;
  const tightPctile = (tighter / ranges.length) * 100; // high = tighter than usual
  const vol10 = smaAt(bars.map((b) => b.volume), 10, end);
  const vol63 = smaAt(bars.map((b) => b.volume), 63, end);
  const dryUp = vol10 !== null && vol63 !== null && vol63 > 0 ? vol10 / vol63 : null;
  let t3 = clamp(tightPctile * 0.7 + (dryUp !== null ? clamp((1.2 - dryUp) * 100, 0, 100) * 0.3 : 35));

  // entry classification
  const rsi2 = rsi2At(closes, end);
  const distFromHi20 = (hi20 - last) / last;
  const sma50Rising = sma50 !== null && end >= 60 ? sma50 > (smaAt(closes, 50, end - 10) ?? sma50) : false;
  let entry: TridentEntry = { kind: 'NONE', pivot: null, stop: null, note: 'no defined setup — extended or basing incomplete' };
  if (tightPctile >= 60 && distFromHi20 <= 0.05) {
    const pivot = +(hi20 * 1.002).toFixed(2);
    const stop = +(Math.max(pivot * 0.9, lo20 * 0.985)).toFixed(2);
    entry = { kind: 'BREAKOUT', pivot, stop, note: 'tight range near highs — buy the push through the pivot' };
  } else if (sma50Rising && sma50 !== null && last > sma50 && distFromHi20 >= 0.03 && distFromHi20 <= 0.12 && (rsi2 ?? 100) < 30) {
    const pivot = +(last * 1.001).toFixed(2);
    const stop = +(Math.min(sma50 * 0.97, last * 0.92)).toFixed(2);
    entry = { kind: 'PULLBACK', pivot, stop, note: 'orderly pullback in an uptrend with short-term washout — buy the turn' };
  } else if (distFromHi20 > 0.12) {
    t3 = clamp(t3 - 15); // broken, not basing
  }

  // t4 — direction-conditioned volume shocks (Gervais)
  let upShocks = 0;
  let downShocks = 0;
  if (vol63 !== null && vol63 > 0) {
    for (let i = Math.max(1, end - 20); i <= end; i++) {
      if (bars[i].volume > 1.5 * vol63) {
        if (bars[i].close > bars[i - 1].close) upShocks += 1;
        else downShocks += 1;
      }
    }
  }
  const t4 = clamp(50 + (upShocks - downShocks) * 12);

  return {
    t1, t2, t3, t4, entry,
    diagnostics: {
      proximity52w: +proximity.toFixed(3),
      mad: mad !== null ? +mad.toFixed(3) : null,
      rs63: rs63 !== null ? +rs63.toFixed(3) : null,
      tightPctile: +tightPctile.toFixed(0),
      volumeDryUp: dryUp !== null ? +dryUp.toFixed(2) : null,
      rsi2: rsi2 !== null ? +rsi2.toFixed(0) : null,
      upShocks, downShocks,
      entryKind: entry.kind,
    },
  };
}

// ---------------------------------------------------------------------------
// I pillar
// ---------------------------------------------------------------------------

export function scoreInstitutional(inst: InstitutionalInputs | null, asOfIso: string): {
  I: number | null;
  i1: number | null; i2: number | null; i3: number | null; i4: number | null; i5: number | null;
  state: 'live' | 'warming';
} {
  const C = TRIDENT_CONSTANTS;
  // Feed-connected detection: the W2 wiring always passes an object with
  // the availability flag present; a null/legacy-shape input means the
  // Smart Money pipes aren't wired at all → warming (renormalize F/T).
  const feedConnected =
    inst != null &&
    (inst.convictionDataAvailable !== undefined ||
      inst.activist !== null ||
      inst.convictionAdds.length > 0 ||
      inst.shortInterestPctFloat !== null ||
      inst.daysToCover != null);
  if (!inst || !feedConnected) {
    const i5 = inst?.insiderNetBuyDollars != null ? squash(inst.insiderNetBuyDollars, 2_000_000) : null;
    return { I: null, i1: null, i2: null, i3: null, i4: null, i5, state: 'warming' };
  }
  // i1 activist recency decay
  let i1 = 0;
  if (inst.activist) {
    const age = daysBetween(inst.activist.acceptedAt, asOfIso);
    i1 =
      age <= C.ACTIVIST_FULL_DAYS ? 100
      : age >= C.ACTIVIST_ZERO_DAYS ? 0
      : (1 - (age - C.ACTIVIST_FULL_DAYS) / (C.ACTIVIST_ZERO_DAYS - C.ACTIVIST_FULL_DAYS)) * 100;
  }
  // i2/i3 conviction + cluster — NULL (not zero) until the 13F pipeline
  // is ingested; renormalized below.
  const convictionAvailable = inst.convictionDataAvailable !== false;
  let i2: number | null = null;
  let i3: number | null = null;
  if (convictionAvailable) {
    let acc = 0;
    for (const add of inst.convictionAdds) {
      const age = daysBetween(add.acceptedAt, asOfIso);
      const fresh = age >= C.CONVICTION_ZERO_DAYS ? 0 : 1 - age / C.CONVICTION_ZERO_DAYS;
      const convScale = Math.min(add.portfolioWeightPct / 7.5, 1.5);
      acc += fresh * convScale * (add.action === 'new' ? 40 : 25);
    }
    i2 = clamp(acc);
    i3 = clamp(inst.clusterCount >= 3 ? 100 : inst.clusterCount === 2 ? 70 : 0);
  }
  // i4 crowding penalty 0..100 (subtracted, capped). %float when known;
  // FINRA days-to-cover as the proxy otherwise.
  const si = inst.shortInterestPctFloat;
  const io = inst.instShareOfFloatPct ?? 0;
  const dtc = inst.daysToCover ?? null;
  const i4 =
    si !== null
      ? clamp(si > 10 && io > 60 ? 100 : si > 6 && io > 40 ? 55 : si > 10 ? 40 : 0)
      : dtc !== null
        ? clamp(dtc > 8 ? 70 : dtc > 5 ? 40 : 0)
        : 0;
  const i5 = inst.insiderNetBuyDollars != null ? squash(inst.insiderNetBuyDollars, 2_000_000) : null;

  // Weighted average over AVAILABLE positive sub-signals, renormalized.
  const parts: Array<[number | null, number]> = [
    [i1, C.I_W.i1], [i2, C.I_W.i2], [i3, C.I_W.i3], [i5, C.I_W.i5],
  ];
  const avail = parts.filter(([v]) => v !== null) as Array<[number, number]>;
  let I = avail.length > 0
    ? avail.reduce((a, [v, w]) => a + v * w, 0) / avail.reduce((a, [, w]) => a + w, 0)
    : 0;
  I -= (i4 / 100) * 15; // crowding cap −15
  if (inst.breadthDecline === true) I = Math.min(I, 45); // suppress "accumulating"
  return { I: clamp(I), i1, i2, i3, i4, i5, state: 'live' };
}

// ---------------------------------------------------------------------------
// Gate + composite
// ---------------------------------------------------------------------------

export interface TridentInputs {
  ticker: string;
  universe: 'sp500' | 'russell2k';
  bars: TridentBar[];
  benchBars: TridentBar[];
  earnings: TridentEarningsRow[];
  recommendations: TridentRecRow[];
  fundamentals: TridentFundamentals | null;
  institutional: InstitutionalInputs | null;
}

export function scoreTrident(inp: TridentInputs): TridentScore {
  const C = TRIDENT_CONSTANTS;
  const gateReasons: string[] = [];
  const bars = inp.bars;
  if (bars.length < 220) {
    return { eligible: false, gateReasons: ['insufficient price history (<220 bars)'], pillars: null, entry: null, composite: null, institutionalState: 'warming', diagnostics: {} };
  }
  const end = bars.length - 1;
  const last = bars[end].close;
  const asOfIso = bars[end].date;

  if (last < C.MIN_PRICE) gateReasons.push(`price $${last.toFixed(2)} < $${C.MIN_PRICE}`);
  const dv: number[] = bars.slice(end - 19, end + 1).map((b) => b.close * b.volume).sort((a, b) => a - b);
  const medDollarVol = dv[Math.floor(dv.length / 2)];
  const minDv = inp.universe === 'sp500' ? C.MIN_DOLLAR_VOL_SP500 : C.MIN_DOLLAR_VOL_R2K;
  if (medDollarVol < minDv) gateReasons.push(`median $vol ${(medDollarVol / 1e6).toFixed(1)}M < ${(minDv / 1e6).toFixed(0)}M`);
  const closes = bars.map((b) => b.close);
  const sma200 = smaAt(closes, 200, end);
  const sma200Prev = smaAt(closes, 200, end - 21);
  const uptrend = sma200 !== null && sma200Prev !== null && last > sma200 && sma200 >= sma200Prev;
  if (!uptrend) gateReasons.push('not in an uptrend (close ≤ 200dma or 200dma falling)');
  if (inp.universe === 'russell2k' && inp.fundamentals) {
    const gp = inp.fundamentals.grossProfitTTM;
    const ocf = inp.fundamentals.operatingCashflowTTM;
    if ((gp != null && gp <= 0) || (ocf != null && ocf <= 0)) {
      gateReasons.push('small-cap quality floor: non-positive gross profit or operating cash flow');
    }
  }
  if (gateReasons.length > 0) {
    return { eligible: false, gateReasons, pillars: null, entry: null, composite: null, institutionalState: 'warming', diagnostics: { medDollarVol } };
  }

  // Pillars
  const f1 = scoreAcceleration(inp.earnings);
  const f2 = scoreSurprise(inp.earnings);
  const f3 = scoreRevisions(inp.recommendations);
  const f4 = scoreQuality(inp.fundamentals);
  const fParts: Array<[number | null, number]> = [
    [f1, C.F_W.f1], [f2, C.F_W.f2], [f3, C.F_W.f3], [f4, C.F_W.f4],
  ];
  const fAvail = fParts.filter(([v]) => v !== null);
  const F = fAvail.length >= 2
    ? clamp(fAvail.reduce((a, [v, w]) => a + (v as number) * w, 0) / fAvail.reduce((a, [, w]) => a + w, 0))
    : 40; // thin fundamental data → below-neutral, not fake-strong

  const tech = scoreTechnicals(inp.bars, inp.benchBars);
  if (!tech) {
    return { eligible: false, gateReasons: ['technical context unavailable'], pillars: null, entry: null, composite: null, institutionalState: 'warming', diagnostics: {} };
  }
  const T = clamp(tech.t1 * C.T_W.t1 + tech.t2 * C.T_W.t2 + tech.t3 * C.T_W.t3 + tech.t4 * C.T_W.t4);

  const instScore = scoreInstitutional(inp.institutional, asOfIso);

  // Composite — reweight F/T pro-rata while institutional feeds warm.
  let composite: number;
  if (instScore.I === null) {
    const wf = C.WEIGHT_F / (C.WEIGHT_F + C.WEIGHT_T);
    composite = clamp(F * wf + T * (1 - wf));
  } else {
    composite = clamp(F * C.WEIGHT_F + T * C.WEIGHT_T + instScore.I * C.WEIGHT_I);
  }

  return {
    eligible: true,
    gateReasons: [],
    pillars: {
      F, T, I: instScore.I,
      sub: {
        f1Acceleration: f1, f2Surprise: f2, f3Revisions: f3, f4Quality: f4,
        t1HighGround: tech.t1, t2TrendQuality: tech.t2, t3Coil: tech.t3, t4Volume: tech.t4,
        i1Activist: instScore.i1, i2Conviction: instScore.i2, i3Cluster: instScore.i3,
        i4Crowding: instScore.i4, i5Insider: instScore.i5,
      },
    },
    entry: tech.entry,
    composite: +composite.toFixed(1),
    institutionalState: instScore.state,
    diagnostics: { ...tech.diagnostics, medDollarVol: Math.round(medDollarVol) },
  };
}

/** Percentile ranks for a scanned universe (scan-level; mirrors FABLE). */
export function percentileRanks(composites: number[]): number[] {
  const sorted = [...composites].sort((a, b) => a - b);
  return composites.map((c) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= c) lo = mid + 1;
      else hi = mid;
    }
    return +(100 * (lo / sorted.length)).toFixed(1);
  });
}
