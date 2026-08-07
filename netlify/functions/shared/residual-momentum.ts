// RMOM-1 (2026-08-07) — residual ("quiet strength") momentum.
//
// V2 REBUILD, P1-S1. The first board built after all seven predictive boards
// were retired, and the first one whose construction was chosen from what
// SURVIVED hostile replication rather than from an idea that sounded good.
//
// WHY RESIDUAL RATHER THAN PLAIN MOMENTUM. Conventional 12-1 momentum works
// but crashes: −67.1% max drawdown, Sharpe 0.47. Ranking on the part of a
// stock's return its factor exposures do NOT explain — the residual — gives
// Sharpe 0.95 and −25.5% max drawdown over the same period
// (Hanauer & Windmüller, US + 48 countries), with the effect confirmed out
// of sample 2009-2015 (Blitz/Huij/Martens 2011; Huij & Lansdorp 2017). The
// intuition: a stock up 40% because its whole sector is up tells you about
// the sector; a stock up 40% when its factor exposures predicted 10% is
// telling you something specific to that company.
//
// THREE THINGS THIS MODULE REFUSES TO DO, each for a measured reason:
//
//   1. THE SKIP MONTH IS STRUCTURAL, NOT OPTIONAL. The score window is
//      t-12..t-2 and there is no parameter to include t-1. Short-term
//      reversal runs opposite to momentum over the most recent month, and a
//      momentum rank contaminated by it is how the retired FABLE board
//      gated on good 12-1 momentum and then RANKED on unskipped windows
//      weighted toward the last month — producing a sensible universe with
//      a negative IC.
//
//   2. NO 12-7 WINDOW. `refuse12_7` exists as a documented refusal:
//      Goyal & Wahal find the "intermediate horizon" variant does not
//      survive outside the US, and it is exactly the kind of window a
//      backtest picks because it fit.
//
//   3. NO HARD 200-DAY GATE. Roughly 85% of daily 200dma crossings are
//      noise. Crash control is done with continuous volatility scaling
//      (Barroso & Santa-Clara), which keeps ~95% of the benefit while being
//      lev-capped, plus a coarse bear dimmer evaluated monthly.
//
// HONEST EXPECTATION, carried in the payload so no UI refactor can drop it:
// after the policy module's 50% haircut and costs, ~0.5-1.5pp/yr over SPY,
// with multi-year droughts of the 2000-2015 variety. That banner is part of
// the board's contract, not decoration.

import { applyUniversePolicy, type UniverseCandidate } from './research-policy';

/** The score window. Structural — see refusal (1) above. */
export const SCORE_FROM_MONTH = 12;
export const SCORE_TO_MONTH = 2; // t-2 ⇒ month t-1 is skipped
/** Monthly observations required for the regression. */
export const REGRESSION_MONTHS = 36;
/** Annualised volatility target for the crash-control scaler. */
export const VOL_TARGET = 0.12;
/** Trading days in the realized-vol lookback. */
export const VOL_LOOKBACK_D = 126;
/** Portfolio size band; 40 is the default. */
export const TARGET_NAMES = 40;
/** Rank buffer: enter inside the top 10%, hold until outside the top 25%. */
export const ENTER_PCTL = 0.10;
export const EXIT_PCTL = 0.25;
/** Staggered monthly tranches — rebalance-timing luck exceeds 100bps/yr. */
export const TRANCHES = 3;

/**
 * The honest expectation banner. Exported as data so it travels with the
 * board payload and cannot be lost in a UI refactor.
 */
export const RMOM_EXPECTATION =
  'Expected net edge after haircut ~0.5–1.5pp/yr over SPY. Expect multi-year ' +
  'droughts — this factor went nowhere from 2000 to 2015. Not a validated ' +
  'edge in this app until the forward test says so.';

export interface MonthlyObservation {
  /** Stock excess return for the month, decimal (0.03 = +3%). */
  r: number;
  /** Market excess return (Mkt-RF). */
  mkt: number;
  /** Size factor (SMB). Absent ⇒ market-only fallback. */
  smb?: number | null;
  /** Value factor (HML). Absent ⇒ market-only fallback. */
  hml?: number | null;
}

export type RegressionBasis = 'ff3' | 'market-only';

export interface RegressionResult {
  /** Residual per input month, same order. */
  residuals: number[];
  basis: RegressionBasis;
  betas: number[];
}

/**
 * OLS via normal equations on a small design matrix.
 *
 * Returns null rather than a degenerate fit when the system is singular —
 * a regression that silently returned zeros would make every residual equal
 * the raw return, quietly turning this board back into plain momentum.
 */
function ols(y: number[], X: number[][]): number[] | null {
  const n = y.length;
  const k = X[0].length;
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  // Gauss-Jordan with partial pivoting.
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null; // singular
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let j = c; j <= k; j++) M[c][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row[k]);
}

/**
 * Regress a stock's monthly excess returns on FF3, or on the market alone
 * when the size/value factors are unavailable (Chaves 2016 shows the
 * market-only variant retains most of the effect).
 *
 * The fallback is REPORTED in `basis`, never silent — a run that quietly
 * degraded to market-only is measuring something different from one that
 * did not, and the payload has to be able to say which it was.
 */
export function regressResiduals(obs: MonthlyObservation[]): RegressionResult | null {
  if (!Array.isArray(obs) || obs.length < REGRESSION_MONTHS) return null;
  const rows = obs.slice(-REGRESSION_MONTHS);
  if (rows.some((o) => !Number.isFinite(o.r) || !Number.isFinite(o.mkt))) return null;

  const hasFF3 = rows.every(
    (o) => Number.isFinite(o.smb as number) && Number.isFinite(o.hml as number),
  );
  const basis: RegressionBasis = hasFF3 ? 'ff3' : 'market-only';
  const X = rows.map((o) => (hasFF3 ? [1, o.mkt, o.smb as number, o.hml as number] : [1, o.mkt]));
  const y = rows.map((o) => o.r);
  const betas = ols(y, X);
  if (!betas) return null;

  const residuals = rows.map((o, i) => {
    const fitted = X[i].reduce((acc, xv, j) => acc + xv * betas[j], 0);
    return y[i] - fitted;
  });
  return { residuals, basis, betas };
}

/**
 * Residual momentum score: the t-12..t-2 residuals summed and standardised
 * by their own dispersion.
 *
 * Standardising is what separates this from a raw residual sum — it is a
 * risk-adjusted measure, and it is why the published Sharpe roughly doubles
 * rather than the raw return doing so.
 */
export function residualMomentumScore(residuals: number[]): number | null {
  if (!Array.isArray(residuals) || residuals.length < REGRESSION_MONTHS) return null;
  // residuals are chronological; index -1 is t-1 (skipped), -2 is t-2, etc.
  const window = residuals.slice(-SCORE_FROM_MONTH, -(SCORE_TO_MONTH - 1) || undefined);
  const slice = residuals.slice(residuals.length - SCORE_FROM_MONTH, residuals.length - (SCORE_TO_MONTH - 1));
  const use = slice.length ? slice : window;
  if (use.length < 2) return null;
  const sum = use.reduce((a, b) => a + b, 0);
  const mean = sum / use.length;
  const sd = Math.sqrt(use.reduce((a, b) => a + (b - mean) ** 2, 0) / (use.length - 1));
  if (!Number.isFinite(sd) || sd === 0) return null;
  return sum / sd;
}

/**
 * Plain 12-1 total-return momentum, shown ALONGSIDE the residual score so
 * the two can be compared on the board rather than the user having to trust
 * that the fancier one is better.
 */
export function plainMomentum12_1(monthlyReturns: number[]): number | null {
  if (!Array.isArray(monthlyReturns) || monthlyReturns.length < SCORE_FROM_MONTH) return null;
  const slice = monthlyReturns.slice(
    monthlyReturns.length - SCORE_FROM_MONTH,
    monthlyReturns.length - (SCORE_TO_MONTH - 1),
  );
  if (slice.length === 0) return null;
  return slice.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

/**
 * The 12-7 "intermediate horizon" variant, refused.
 *
 * Goyal & Wahal find it does not survive outside the US. It is kept as an
 * exported refusal because it is precisely the window a backtest selects
 * when it is fitting rather than measuring.
 */
export function refuse12_7(): null {
  return null;
}

/**
 * Crash control: scale exposure so the sleeve targets `VOL_TARGET`
 * annualised, capped at 1 (no leverage).
 *
 * Barroso & Santa-Clara's constant-volatility momentum; the lev-capped form
 * retains ~95% of the benefit, which matters because a long-only retail
 * account cannot take the uncapped version anyway.
 */
export function volScaledExposure(
  realizedAnnualVol: number | null | undefined,
  target = VOL_TARGET,
): number | null {
  if (!Number.isFinite(realizedAnnualVol as number)) return null;
  const v = realizedAnnualVol as number;
  if (v <= 0) return null;
  return Math.min(1, target / v);
}

/** Annualised realized vol from daily returns over the lookback. */
export function realizedVol(dailyReturns: number[], lookback = VOL_LOOKBACK_D): number | null {
  if (!Array.isArray(dailyReturns) || dailyReturns.length < lookback) return null;
  const w = dailyReturns.slice(-lookback);
  const mean = w.reduce((a, b) => a + b, 0) / w.length;
  const varr = w.reduce((a, b) => a + (b - mean) ** 2, 0) / (w.length - 1);
  return Math.sqrt(varr) * Math.sqrt(252);
}

/**
 * Bear dimmer — halve the tilt when the trailing 24-month market return is
 * negative. Coarse and monthly ON PURPOSE: this is the slow, low-turnover
 * complement to the volatility scaler, not a timing signal.
 */
export function bearDimmer(spy24MonthReturn: number | null | undefined): number {
  if (!Number.isFinite(spy24MonthReturn as number)) return 1;
  return (spy24MonthReturn as number) < 0 ? 0.5 : 1;
}

/**
 * A hard 200-day moving-average gate, refused.
 *
 * ~85% of daily crossings are noise; a gate on one converts a slow factor
 * into a high-turnover timing bet with worse net results.
 */
export function refuse200dmaGate(): null {
  return null;
}

/**
 * Deterministic tranche assignment, so a name always rebalances in the same
 * one. Rebalance-timing luck is worth >100bps/yr, which is larger than the
 * expected edge — running three staggered tranches averages it away instead
 * of letting the calendar decide the result.
 */
export function trancheFor(ticker: string, tranches = TRANCHES): number {
  let h = 0;
  for (let i = 0; i < ticker.length; i++) h = (h * 31 + ticker.charCodeAt(i)) >>> 0;
  return h % tranches;
}

export interface RMomCandidate extends UniverseCandidate {
  ticker: string;
  observations?: MonthlyObservation[];
  monthlyReturns?: number[];
}

export interface RMomScore {
  ticker: string;
  score: number | null;
  plain12_1: number | null;
  basis: RegressionBasis | null;
  tranche: number;
}

export interface RMomBoard {
  scored: RMomScore[];
  excluded: Record<string, string>;
  /** How many names used FF3 vs the market-only fallback. */
  basisCounts: Record<RegressionBasis, number>;
  /** Carried in the payload; the UI must render it. */
  expectation: string;
}

/** Score a candidate set. Universe policy first, as always. */
export function buildResidualMomentumBoard(candidates: RMomCandidate[]): RMomBoard {
  const { kept, excluded } = applyUniversePolicy(candidates ?? []);
  const basisCounts: Record<RegressionBasis, number> = { ff3: 0, 'market-only': 0 };

  const scored: RMomScore[] = kept.map((c) => {
    const reg = c.observations ? regressResiduals(c.observations) : null;
    if (reg) basisCounts[reg.basis] += 1;
    return {
      ticker: c.ticker,
      score: reg ? residualMomentumScore(reg.residuals) : null,
      plain12_1: plainMomentum12_1(c.monthlyReturns ?? []),
      basis: reg?.basis ?? null,
      tranche: trancheFor(c.ticker),
    };
  });

  scored.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  return { scored, excluded, basisCounts, expectation: RMOM_EXPECTATION };
}

/**
 * Rank buffer: enter inside the top `ENTER_PCTL`, hold until outside
 * `EXIT_PCTL`. A single threshold churns names sitting on the boundary; the
 * buffer is where most of a momentum strategy's avoidable turnover goes.
 */
export function selectWithBuffer(
  ranked: RMomScore[],
  held: Set<string>,
  target = TARGET_NAMES,
): { hold: string[]; enter: string[]; exit: string[] } {
  const scorable = ranked.filter((r) => r.score !== null);
  const n = scorable.length;
  if (n === 0) return { hold: [], enter: [], exit: [...held] };

  const enterCut = Math.max(1, Math.floor(n * ENTER_PCTL));
  const exitCut = Math.max(enterCut, Math.floor(n * EXIT_PCTL));
  const rankOf = new Map(scorable.map((r, i) => [r.ticker, i]));

  const hold = [...held].filter((t) => (rankOf.get(t) ?? Infinity) < exitCut);
  const exit = [...held].filter((t) => (rankOf.get(t) ?? Infinity) >= exitCut);
  const room = Math.max(0, target - hold.length);
  const enter = scorable
    .slice(0, enterCut)
    .filter((r) => !held.has(r.ticker))
    .slice(0, room)
    .map((r) => r.ticker);

  return { hold, enter, exit };
}
