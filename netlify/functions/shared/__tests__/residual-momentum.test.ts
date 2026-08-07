// RMOM-1 — residual momentum, P1-S1 of the V2 rebuild.
//
// The tests that matter here are the REFUSALS. A momentum board is easy to
// build and easy to build wrong in ways that look fine: include the skip
// month and short-term reversal eats the signal; let the regression fail
// silently and it degrades into plain momentum; uncap the vol scaler and it
// becomes a leveraged bet nobody can hold.

import { describe, it, expect } from 'vitest';
import {
  regressResiduals,
  residualMomentumScore,
  plainMomentum12_1,
  refuse12_7,
  refuse200dmaGate,
  volScaledExposure,
  realizedVol,
  bearDimmer,
  trancheFor,
  selectWithBuffer,
  buildResidualMomentumBoard,
  RMOM_EXPECTATION,
  REGRESSION_MONTHS,
  VOL_TARGET,
  type MonthlyObservation,
  type RMomScore,
} from '../residual-momentum';

/** 36 months where the stock is exactly 1.5x the market — zero residual. */
function pureBeta(n = REGRESSION_MONTHS, beta = 1.5): MonthlyObservation[] {
  return Array.from({ length: n }, (_, i) => {
    const mkt = 0.01 * Math.sin(i / 3);
    return { r: beta * mkt, mkt, smb: 0.002 * Math.cos(i / 4), hml: 0.001 * Math.sin(i / 5) };
  });
}

describe('regressResiduals', () => {
  it('leaves ~zero residual for a stock that is pure factor exposure', () => {
    const res = regressResiduals(pureBeta())!;
    expect(res).not.toBeNull();
    expect(Math.max(...res.residuals.map(Math.abs))).toBeLessThan(1e-9);
    expect(res.basis).toBe('ff3');
  });

  it('isolates a stock-specific move as residual', () => {
    const obs = pureBeta();
    obs[obs.length - 5].r += 0.20; // +20% unexplained in one month
    const res = regressResiduals(obs)!;
    expect(res.residuals[res.residuals.length - 5]).toBeGreaterThan(0.1);
  });

  it('falls back to market-only when SMB/HML are missing, and SAYS SO', () => {
    // A silent fallback measures something different from FF3; the payload
    // has to be able to report which one produced the number.
    const obs = pureBeta().map((o) => ({ r: o.r, mkt: o.mkt }));
    const res = regressResiduals(obs)!;
    expect(res.basis).toBe('market-only');
  });

  it('needs a full 36 months — no partial regression', () => {
    expect(regressResiduals(pureBeta(35))).toBeNull();
  });

  it('returns null on a singular system rather than fitting zeros', () => {
    // A constant market series makes the design matrix singular. Returning
    // zero betas would make every residual equal the raw return, silently
    // turning this board back into plain momentum.
    const obs = Array.from({ length: REGRESSION_MONTHS }, () => ({
      r: 0.01, mkt: 0.005, smb: 0.005, hml: 0.005,
    }));
    expect(regressResiduals(obs)).toBeNull();
  });
});

describe('the skip month is structural', () => {
  it('EXCLUDES t-1 from the score window', () => {
    // Two identical residual histories except for the final month. If the
    // score changes, t-1 leaked in — the exact defect that gave the retired
    // FABLE board a negative IC on top of a sound gate.
    const base = Array.from({ length: REGRESSION_MONTHS }, (_, i) => 0.01 * Math.sin(i));
    const spiked = [...base];
    spiked[spiked.length - 1] = 5; // enormous last-month residual
    expect(residualMomentumScore(spiked)).toBeCloseTo(residualMomentumScore(base)!, 10);
  });

  it('DOES include t-2', () => {
    const base = Array.from({ length: REGRESSION_MONTHS }, (_, i) => 0.01 * Math.sin(i));
    const spiked = [...base];
    spiked[spiked.length - 2] = 5;
    expect(residualMomentumScore(spiked)).not.toBeCloseTo(residualMomentumScore(base)!, 4);
  });

  it('plain 12-1 skips the last month too', () => {
    const base = Array.from({ length: 14 }, () => 0.01);
    const spiked = [...base];
    spiked[spiked.length - 1] = 0.9;
    expect(plainMomentum12_1(spiked)).toBeCloseTo(plainMomentum12_1(base)!, 10);
  });
});

describe('documented refusals', () => {
  it('refuses the 12-7 window (Goyal & Wahal: fails ex-US)', () => {
    expect(refuse12_7()).toBeNull();
  });
  it('refuses a hard 200dma gate (~85% of crossings are noise)', () => {
    expect(refuse200dmaGate()).toBeNull();
  });
});

describe('crash control', () => {
  it('scales down when vol is high', () => {
    expect(volScaledExposure(0.24)).toBeCloseTo(0.5, 10); // 12% / 24%
  });

  it('CAPS at 1 — never levers up in calm markets', () => {
    // Uncapped this would be 4x at 3% vol. A long-only retail account
    // cannot take that, and the capped form keeps ~95% of the benefit.
    expect(volScaledExposure(0.03)).toBe(1);
  });

  it('is null on missing or nonsensical vol, never a default of 1', () => {
    expect(volScaledExposure(null)).toBeNull();
    expect(volScaledExposure(0)).toBeNull();
    expect(volScaledExposure(-0.1)).toBeNull();
  });

  it('annualises realized vol from daily returns', () => {
    const daily = Array.from({ length: 126 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    const v = realizedVol(daily)!;
    expect(v).toBeGreaterThan(0.1);
    expect(realizedVol(daily.slice(0, 125))).toBeNull(); // short window → null
  });

  it('halves the tilt in a 24-month bear, leaves it alone otherwise', () => {
    expect(bearDimmer(-0.1)).toBe(0.5);
    expect(bearDimmer(0.3)).toBe(1);
    expect(bearDimmer(null)).toBe(1); // unknown is not bearish
  });

  it('targets 12% annualised', () => {
    expect(VOL_TARGET).toBe(0.12);
  });
});

describe('tranches', () => {
  it('are deterministic per ticker', () => {
    expect(trancheFor('AAPL')).toBe(trancheFor('AAPL'));
    expect(trancheFor('AAPL')).toBeGreaterThanOrEqual(0);
    expect(trancheFor('AAPL')).toBeLessThan(3);
  });

  it('spread a realistic universe across all three', () => {
    const names = ['AAPL','MSFT','NVDA','AMD','INTC','ORCL','CRM','ADBE','NOW','TXN','QCOM','AVGO'];
    const used = new Set(names.map((t) => trancheFor(t)));
    expect(used.size).toBe(3);
  });
});

describe('rank buffer', () => {
  const ranked: RMomScore[] = Array.from({ length: 100 }, (_, i) => ({
    ticker: `T${i}`, score: 100 - i, plain12_1: 0, basis: 'ff3', tranche: 0,
  }));

  it('enters only inside the top 10%', () => {
    const { enter } = selectWithBuffer(ranked, new Set());
    expect(enter.length).toBeLessThanOrEqual(10);
    expect(enter).toContain('T0');
    expect(enter).not.toContain('T50');
  });

  it('HOLDS a name that slipped past the entry cut but is inside the top 25%', () => {
    // The buffer is where a momentum strategy's avoidable turnover lives: a
    // single threshold churns every name sitting on the boundary.
    const { hold, exit } = selectWithBuffer(ranked, new Set(['T15']));
    expect(hold).toContain('T15');
    expect(exit).not.toContain('T15');
  });

  it('exits a name that fell outside the top 25%', () => {
    const { hold, exit } = selectWithBuffer(ranked, new Set(['T40']));
    expect(exit).toContain('T40');
    expect(hold).not.toContain('T40');
  });

  it('exits a name that dropped out of the scorable set entirely', () => {
    const { exit } = selectWithBuffer(ranked, new Set(['DELISTED']));
    expect(exit).toContain('DELISTED');
  });

  it('does not overfill past the target', () => {
    const held = new Set(ranked.slice(0, 40).map((r) => r.ticker));
    const { enter } = selectWithBuffer(ranked, held, 40);
    expect(enter).toHaveLength(0);
  });
});

describe('board assembly', () => {
  it('applies the universe policy and carries the expectation banner', () => {
    const board = buildResidualMomentumBoard([
      { ticker: 'GOOD', marketCapM: 5_000, medianDollarVol: 2e7, price: 50, observations: pureBeta(), monthlyReturns: Array(14).fill(0.01) },
      { ticker: 'MICRO', marketCapM: 80, medianDollarVol: 2e7, price: 50, observations: pureBeta() },
    ]);
    expect(board.excluded.MICRO).toBe('microcap');
    expect(board.scored.map((s) => s.ticker)).toEqual(['GOOD']);
    // The banner is data, so a UI refactor cannot silently drop it.
    expect(board.expectation).toBe(RMOM_EXPECTATION);
    expect(board.expectation).toMatch(/droughts/);
    expect(board.expectation).toMatch(/0\.5–1\.5pp/);
  });

  it('reports the FF3 vs market-only split', () => {
    const board = buildResidualMomentumBoard([
      { ticker: 'A', marketCapM: 5_000, medianDollarVol: 2e7, price: 50, observations: pureBeta() },
      { ticker: 'B', marketCapM: 5_000, medianDollarVol: 2e7, price: 50,
        observations: pureBeta().map((o) => ({ r: o.r, mkt: o.mkt })) },
    ]);
    expect(board.basisCounts.ff3).toBe(1);
    expect(board.basisCounts['market-only']).toBe(1);
  });

  it('shows plain 12-1 alongside, so the two can be compared on the board', () => {
    const board = buildResidualMomentumBoard([{
      ticker: 'A', marketCapM: 5_000, medianDollarVol: 2e7, price: 50,
      observations: pureBeta(), monthlyReturns: Array(14).fill(0.02),
    }]);
    expect(board.scored[0].plain12_1).not.toBeNull();
  });
});
