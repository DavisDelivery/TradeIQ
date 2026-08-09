// QS-1 — residual momentum.
//
// The numeric expectations in residual-momentum.vectors.json were produced by
// an INDEPENDENT reference implementation (numpy `lstsq`, QR-based) rather
// than by capturing this module's own output. The module solves the 4×4
// normal equations by Gauss-Jordan instead, so agreement to 8 decimals is a
// genuine cross-check of the linear algebra, not a snapshot of itself.

import { describe, it, expect } from 'vitest';
import {
  residualMomentum,
  sampleStdev,
  compoundPct,
  ESTIMATION_MONTHS,
  WINDOW_MONTHS,
  type FactorMonth,
} from '../residual-momentum';
import vectors from './residual-momentum.vectors.json';

type Vector = {
  input: {
    stockRetPct: number[];
    mktRf: number[];
    smb: number[];
    hml: number[];
    rf: number[];
  };
  expected: {
    betaMkt: number;
    betaSmb: number;
    betaHml: number;
    windowSum: number;
    windowStdev: number;
    degenerate: boolean;
    score: number | null;
    plain12_1Pct: number;
  };
};

const V = vectors as unknown as Record<string, Vector>;

const factorsOf = (v: Vector): FactorMonth[] =>
  v.input.mktRf.map((_, i) => ({
    ym: 202000 + i,
    mktRf: v.input.mktRf[i],
    smb: v.input.smb[i],
    hml: v.input.hml[i],
    rf: v.input.rf[i],
  }));

const run = (v: Vector) =>
  residualMomentum({ monthlyReturnsPct: v.input.stockRetPct, factors: factorsOf(v) });

describe('residualMomentum — against an independent reference', () => {
  it('recovers known factor loadings and the reference score', () => {
    const v = V['recovers-known-betas'];
    const r = run(v);
    // Built with true betas 0.85 / 0.40 / −0.25 plus idiosyncratic noise.
    expect(r.betaMkt).toBeCloseTo(v.expected.betaMkt, 8);
    expect(r.betaSmb).toBeCloseTo(v.expected.betaSmb, 8);
    expect(r.betaHml).toBeCloseTo(v.expected.betaHml, 8);
    expect(r.score).toBeCloseTo(v.expected.score as number, 8);
    expect(r.plain12_1Pct).toBeCloseTo(v.expected.plain12_1Pct, 8);
    expect(r.reason).toBeNull();
    // Sanity that the fixture really is near the generating betas.
    expect(r.betaMkt!).toBeGreaterThan(0.75);
    expect(r.betaMkt!).toBeLessThan(0.95);
  });

  it('scores an idiosyncratic winner strongly positive', () => {
    const v = V['idiosyncratic-winner-scores-positive'];
    const r = run(v);
    expect(r.score).toBeCloseTo(v.expected.score as number, 8);
    expect(r.score!).toBeGreaterThan(10);
    expect(r.plain12_1Pct).toBeCloseTo(v.expected.plain12_1Pct, 8);
  });

  it('returns null — not a number — when the factors explain everything', () => {
    // A stock built as exactly 1.2× the market. Residuals land at ~1e-15, so
    // sum/stdev is a ratio of two near-zeros. A bare `stdev > 0` guard lets
    // this through and it evaluated to −1.31 on this very input; the score
    // must be refused, and the market beta must still be reported.
    const v = V['exact-factor-replication-is-degenerate'];
    const r = run(v);
    expect(r.score).toBeNull();
    expect(r.reason).toBe('degenerate-residuals');
    expect(r.betaMkt).toBeCloseTo(1.2, 6);
    expect(r.plain12_1Pct).toBeCloseTo(v.expected.plain12_1Pct, 8);
  });
});

describe('the skip month — what it does and does not buy', () => {
  const clean = V['idiosyncratic-winner-scores-positive'];
  const crashed = V['t1-crash-still-moves-betas'];

  it('excludes t-1 from plain 12-1 entirely', () => {
    // The two fixtures are identical except for a −60% return in t-1.
    // Compounding touches only t-12…t-2, so the figures must be IDENTICAL.
    const a = run(clean);
    const b = run(crashed);
    expect(b.plain12_1Pct).toBeCloseTo(a.plain12_1Pct as number, 10);
    expect(crashed.input.stockRetPct[ESTIMATION_MONTHS - 1]).toBe(-60);
  });

  it('does NOT insulate the score from t-1 — betas still move', () => {
    // The honest, narrower guarantee. t-1 is skipped as a RETURN but stays
    // inside the estimation window, so it reshapes the regression. If a
    // refactor ever drops t-1 from estimation too, this fails and the
    // documented claim has to be rewritten rather than silently widened.
    const a = run(clean);
    const b = run(crashed);
    expect(b.betaMkt).toBeCloseTo(crashed.expected.betaMkt, 8);
    expect(Math.abs((b.betaMkt as number) - (a.betaMkt as number))).toBeGreaterThan(0.05);
    expect(b.score).toBeCloseTo(crashed.expected.score as number, 8);
    // The score more than halved on a month that is supposedly skipped.
    expect((b.score as number)).toBeLessThan((a.score as number) / 2);
  });
});

describe('window geometry is fixed, not tunable', () => {
  it('scores exactly 11 months, t-12 through t-2', () => {
    expect(WINDOW_MONTHS).toBe(11);
    expect(ESTIMATION_MONTHS).toBe(36);
  });

  it('a spike inside the window moves the score; the same spike at t-1 is not scored', () => {
    const base = V['recovers-known-betas'];
    const f = factorsOf(base);
    const inWindow = [...base.input.stockRetPct];
    inWindow[24] += 25; // t-12, first scored month
    const atT1 = [...base.input.stockRetPct];
    atT1[35] += 25; // t-1, skipped

    const a = residualMomentum({ monthlyReturnsPct: inWindow, factors: f });
    const b = residualMomentum({ monthlyReturnsPct: atT1, factors: f });
    const plain0 = run(base).plain12_1Pct as number;

    expect(a.plain12_1Pct).not.toBeCloseTo(plain0, 6);
    expect(b.plain12_1Pct).toBeCloseTo(plain0, 10);
  });
});

describe('refusals are explicit, never NaN or Infinity', () => {
  const base = V['recovers-known-betas'];
  const f = factorsOf(base);

  it('refuses short history', () => {
    const r = residualMomentum({
      monthlyReturnsPct: base.input.stockRetPct.slice(0, 24),
      factors: f.slice(0, 24),
    });
    expect(r.score).toBeNull();
    expect(r.reason).toBe('insufficient-history');
    expect(r.monthsUsed).toBe(24);
  });

  it('refuses a factor series that does not align with the returns', () => {
    const r = residualMomentum({
      monthlyReturnsPct: base.input.stockRetPct,
      factors: f.slice(0, 30),
    });
    expect(r.score).toBeNull();
    expect(r.reason).toBe('factor-gap');
  });

  it('refuses a non-finite return', () => {
    const bad = [...base.input.stockRetPct];
    bad[10] = Number.NaN;
    const r = residualMomentum({ monthlyReturnsPct: bad, factors: f });
    expect(r.score).toBeNull();
    expect(r.reason).toBe('non-finite-input');
  });

  it('refuses a non-finite factor', () => {
    const badF = f.map((m, i) => (i === 5 ? { ...m, hml: Number.POSITIVE_INFINITY } : m));
    const r = residualMomentum({ monthlyReturnsPct: base.input.stockRetPct, factors: badF });
    expect(r.score).toBeNull();
    expect(r.reason).toBe('factor-gap');
  });

  it('refuses a singular design instead of returning a fabricated beta', () => {
    // All factor columns constant → collinear with the intercept. Earlier
    // hand-built fixtures had exactly this shape and numpy's minimum-norm
    // solution silently returned unidentified betas that swung 0.47 → −0.21
    // between otherwise-similar inputs. An explicit refusal is the honest
    // answer; a number here would be arbitrary.
    const flat: FactorMonth[] = Array.from({ length: 36 }, (_, i) => ({
      ym: 202000 + i, mktRf: 0.5, smb: 0, hml: 0, rf: 0.2,
    }));
    const r = residualMomentum({ monthlyReturnsPct: base.input.stockRetPct, factors: flat });
    expect(r.score).toBeNull();
    expect(r.reason).toBe('singular-design');
  });

  it('never emits a non-finite score across every fixture', () => {
    for (const [name, v] of Object.entries(V)) {
      const r = run(v);
      if (r.score !== null) {
        expect(Number.isFinite(r.score), `${name} score`).toBe(true);
        // JSON.stringify(Infinity) is 'null' — an infinite score would reach
        // the client as "no data", the loudest signal turned into silence.
        expect(JSON.parse(JSON.stringify({ s: r.score })).s, `${name} json`).not.toBeNull();
      }
    }
  });
});

describe('numeric helpers', () => {
  it('sampleStdev uses n−1 and refuses fewer than two points', () => {
    expect(sampleStdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13808993, 7);
    expect(sampleStdev([5])).toBeNull();
    expect(sampleStdev([])).toBeNull();
  });

  it('compoundPct compounds rather than sums', () => {
    // +10% then +10% is +21%, not +20%.
    expect(compoundPct([10, 10])).toBeCloseTo(21, 10);
    expect(compoundPct([50, -50])).toBeCloseTo(-25, 10);
    expect(compoundPct([1, Number.NaN])).toBeNull();
  });
});
