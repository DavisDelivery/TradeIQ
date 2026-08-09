// QS-1 (2026-08-09) — residual momentum, the "Quiet Strength" signal.
//
// Blitz, Huij & Martens (2011): rank stocks on the part of their momentum
// that their FACTOR EXPOSURES do not explain. Regress 36 trailing monthly
// excess returns on Fama-French 3, then score the residuals over the
// standard 12-1 window.
//
// WHY RESIDUALS RATHER THAN RAW MOMENTUM — the measured case:
//   Sharpe 0.95 vs 0.47 for plain 12-1, and max drawdown −25.5% vs −67.1%
//   (Hanauer & Windmüller, US + 48 countries). Confirmed out of sample over
//   2009-2015 (BHM 2011; Huij & Lansdorp 2017).
//
//   The mechanism is not a better return forecast, it is a smaller hole.
//   Plain momentum's catastrophic drawdowns are factor events: after a
//   crash, the "winners" are whatever had the defensive factor loading, so
//   a momentum book becomes an enormous unintended factor bet that reverses
//   violently on the rebound. Netting the factor exposure out of the SIGNAL
//   is what removes the bet. This module therefore exists to make the
//   drawdown smaller, and any framing of it as a return enhancer is wrong.
//
// WHAT THIS MODULE REFUSES:
//   * 12-7 formation. Goyal & Wahal find it does not survive ex-US; the
//     window here is fixed at 12-2 and is not a parameter.
//   * A score when the regression explained essentially everything. See
//     DEGENERATE_RESIDUAL_RATIO — the ratio of two near-zeros is noise, and
//     returning it as a number is how a rounding artefact becomes a rank.
//   * Non-finite output of any kind. `JSON.stringify(Infinity)` is `null`,
//     so an infinite score reaches the client as "no data" — the loudest
//     thing the model could say, silently turned into silence. Every exit
//     from this module is a finite number or an explicit null with a reason.

/** Months of history the regression is estimated over. */
export const ESTIMATION_MONTHS = 36;

/**
 * The scoring window, as offsets from t: t-12 through t-2 inclusive.
 *
 * SKIP MONTH IS MANDATORY. t-1 is excluded because the most recent month
 * carries short-term reversal, which is a different (and opposing) effect.
 * Held as constants rather than parameters so it cannot be tuned.
 */
export const WINDOW_START_LAG = 12;
export const WINDOW_END_LAG = 2;
/** 11 months: t-12 … t-2. */
export const WINDOW_MONTHS = WINDOW_START_LAG - WINDOW_END_LAG + 1;

/**
 * Residual dispersion below this fraction of the stock's own return
 * dispersion means the factors explained the stock almost exactly.
 *
 * MEASURED, not guessed. On a synthetic stock built as exactly 1.2× the
 * market, residuals come back at ~1e-15 and `sum / stdev` — a ratio of two
 * near-zeros — evaluated to −1.31 and, on a second such input, 8.4e16. A
 * bare `stdev > 0` test passes both. The guard has to be relative to the
 * scale of the data, which is what this constant is.
 */
export const DEGENERATE_RESIDUAL_RATIO = 1e-6;

export type ResidualMomentumReason =
  | 'insufficient-history'
  | 'factor-gap'
  | 'non-finite-input'
  | 'singular-design'
  | 'degenerate-residuals';

export interface FactorMonth {
  /** Calendar month as YYYYMM, e.g. 202606. */
  ym: number;
  /** Excess market return, percent. */
  mktRf: number;
  /** Small-minus-big, percent. */
  smb: number;
  /** High-minus-low, percent. */
  hml: number;
  /** Risk-free rate, percent. */
  rf: number;
}

export interface ResidualMomentumResult {
  /** Sum of window residuals ÷ their stdev. Null when not computable. */
  score: number | null;
  /** Why `score` is null, else null. */
  reason: ResidualMomentumReason | null;
  /** Factor loadings from the 36-month regression. */
  betaMkt: number | null;
  betaSmb: number | null;
  betaHml: number | null;
  /** Monthly alpha in percent — the regression intercept. */
  alphaPct: number | null;
  /** Plain 12-1 momentum over the SAME window, compounded, percent. */
  plain12_1Pct: number | null;
  /** Months of history actually used. */
  monthsUsed: number;
}

const nullResult = (
  reason: ResidualMomentumReason,
  monthsUsed = 0,
  plain12_1Pct: number | null = null,
): ResidualMomentumResult => ({
  score: null,
  reason,
  betaMkt: null,
  betaSmb: null,
  betaHml: null,
  alphaPct: null,
  plain12_1Pct,
  monthsUsed,
});

/**
 * Solve a small symmetric linear system by Gauss-Jordan with partial
 * pivoting. Returns null when the matrix is singular to working precision.
 *
 * Deliberately dependency-free and explicit: the regression is 4 parameters
 * over 36 observations, so the normal equations are a 4×4 solve and pulling
 * a linear-algebra package in for it would be the larger risk.
 */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (!Number.isFinite(m[pivot][col]) || Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  const out = m.map((row) => row[n]);
  return out.every((v) => Number.isFinite(v)) ? out : null;
}

/** Sample standard deviation (n−1). Null for fewer than 2 points. */
export function sampleStdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const ss = xs.reduce((s, x) => s + (x - mean) ** 2, 0);
  const v = ss / (xs.length - 1);
  return Number.isFinite(v) && v >= 0 ? Math.sqrt(v) : null;
}

/** Compound a series of percent returns into one percent figure. */
export function compoundPct(retPct: number[]): number | null {
  let acc = 1;
  for (const r of retPct) {
    if (!Number.isFinite(r)) return null;
    acc *= 1 + r / 100;
  }
  const out = (acc - 1) * 100;
  return Number.isFinite(out) ? out : null;
}

export interface ResidualMomentumInput {
  /**
   * Trailing monthly total returns in PERCENT, OLDEST FIRST, length 36:
   * element 0 is t-36, element 35 is t-1.
   */
  monthlyReturnsPct: number[];
  /** Factor months aligned 1:1 with `monthlyReturnsPct`, same ordering. */
  factors: FactorMonth[];
}

/**
 * Score one stock.
 *
 * ON WHAT THE SKIP MONTH ACTUALLY BUYS — narrower than it sounds, and
 * measured here rather than assumed. t-1 is excluded from the SCORING
 * window but remains inside the 36-month ESTIMATION window, so a violent
 * t-1 still moves the betas and therefore every residual. On a synthetic
 * stock, appending a −60% t-1 moved betaMkt from 0.8114 to 0.8897 and cut
 * the score from 18.72 to 7.11 — the month is skipped as a RETURN, not as
 * an influence. That is the published method, not a defect, but the
 * guarantee is "last month's return is not scored", never "last month
 * cannot affect the score". `t1-crash-still-moves-betas` in the tests pins
 * this so the weaker claim cannot quietly become the stronger one.
 */
export function residualMomentum(input: ResidualMomentumInput): ResidualMomentumResult {
  const { monthlyReturnsPct: r, factors: f } = input;

  if (!Array.isArray(r) || !Array.isArray(f)) return nullResult('insufficient-history');
  if (r.length < ESTIMATION_MONTHS) return nullResult('insufficient-history', r.length);
  if (f.length !== r.length) return nullResult('factor-gap', r.length);

  // Use the most recent ESTIMATION_MONTHS if a longer series was supplied.
  const rr = r.slice(r.length - ESTIMATION_MONTHS);
  const ff = f.slice(f.length - ESTIMATION_MONTHS);

  if (!rr.every(Number.isFinite)) return nullResult('non-finite-input', rr.length);
  for (const m of ff) {
    if (!Number.isFinite(m?.mktRf) || !Number.isFinite(m?.smb) ||
        !Number.isFinite(m?.hml) || !Number.isFinite(m?.rf)) {
      return nullResult('factor-gap', rr.length);
    }
  }

  // Window indices. t-k -> index ESTIMATION_MONTHS - k.
  const lo = ESTIMATION_MONTHS - WINDOW_START_LAG;      // t-12 -> 24
  const hi = ESTIMATION_MONTHS - WINDOW_END_LAG + 1;    // t-2  -> 34, exclusive 35
  const plain = compoundPct(rr.slice(lo, hi));

  // Excess returns and the design matrix [1, mktRf, smb, hml].
  const y = rr.map((v, i) => v - ff[i].rf);
  const X = ff.map((m) => [1, m.mktRf, m.smb, m.hml]);

  // Normal equations: (XᵀX) b = Xᵀy.
  const k = 4;
  const xtx: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      xty[a] += X[i][a] * y[i];
      for (let b = a; b < k; b++) xtx[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) xtx[a][b] = xtx[b][a];

  const coef = solve(xtx, xty);
  if (!coef) return nullResult('singular-design', rr.length, plain);

  const [alpha, bMkt, bSmb, bHml] = coef;
  const resid = y.map((v, i) => v - (alpha + bMkt * X[i][1] + bSmb * X[i][2] + bHml * X[i][3]));
  const window = resid.slice(lo, hi);

  const sd = sampleStdev(window);
  const scale = sampleStdev(rr) ?? 0;
  const floor = Math.max(scale, 1) * DEGENERATE_RESIDUAL_RATIO;

  const base = {
    betaMkt: bMkt,
    betaSmb: bSmb,
    betaHml: bHml,
    alphaPct: alpha,
    plain12_1Pct: plain,
    monthsUsed: rr.length,
  };

  if (sd === null || !Number.isFinite(sd) || sd <= floor) {
    return { ...base, score: null, reason: 'degenerate-residuals' };
  }

  const sum = window.reduce((s, x) => s + x, 0);
  const score = sum / sd;
  if (!Number.isFinite(score)) {
    return { ...base, score: null, reason: 'degenerate-residuals' };
  }

  return { ...base, score, reason: null };
}
