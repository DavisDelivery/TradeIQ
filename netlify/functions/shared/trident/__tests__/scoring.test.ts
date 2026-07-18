// TRIDENT scorer — pins the design contract (design.md §2): gate rules,
// acceleration math, warming-state reweight, entry classification, and
// the crowding/breadth suppressors.

import { describe, it, expect } from 'vitest';
import {
  scoreTrident,
  scoreAcceleration,
  scoreRevisions,
  scoreInstitutional,
  percentileRanks,
  type TridentBar,
  type TridentEarningsRow,
  type TridentInputs,
} from '../scoring';

function mkBars(closes: number[], volume = 2_000_000): TridentBar[] {
  const start = Date.UTC(2024, 0, 1);
  return closes.map((c, i) => ({
    date: new Date(start + i * 86400000).toISOString().slice(0, 10),
    open: c * 0.999,
    high: c * 1.005,
    low: c * 0.995,
    close: c,
    volume,
  }));
}

function trendCloses(n: number, start: number, dailyPct: number): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) { out.push(+p.toFixed(4)); p *= 1 + dailyPct; }
  return out;
}

/** 8 quarters of EPS, oldest→newest values. */
function mkEarnings(eps: number[]): TridentEarningsRow[] {
  return eps.map((e, i) => ({
    period: `202${Math.floor(i / 4) + 3}-${String(((i % 4) + 1) * 3).padStart(2, '0')}-30`,
    epsActual: e,
    epsEstimate: e * 0.95,
    surprisePct: 5,
  }));
}

const UPTREND = trendCloses(300, 50, 0.002);

function baseInputs(over: Partial<TridentInputs> = {}): TridentInputs {
  return {
    ticker: 'TEST',
    universe: 'sp500',
    bars: mkBars(UPTREND, 800_000), // ~$80M+ daily dollar vol at these prices... volume*price
    benchBars: mkBars(trendCloses(300, 400, 0.0005)),
    earnings: mkEarnings([1.0, 1.05, 1.1, 1.15, 1.3, 1.45, 1.65, 1.9]), // accelerating
    recommendations: [
      { period: '2026-05-01', strongBuy: 5, buy: 8, hold: 10, sell: 1, strongSell: 0 },
      { period: '2026-06-01', strongBuy: 7, buy: 9, hold: 8, sell: 1, strongSell: 0 },
      { period: '2026-07-01', strongBuy: 9, buy: 10, hold: 6, sell: 0, strongSell: 0 },
    ].reverse(),
    fundamentals: {
      roe: 0.22,
      grossMargin: 0.55,
      priorGrossMarginYoY: 0.5,
      operatingMargin: 0.25,
      priorOperatingMarginYoY: 0.22,
      epsGrowthTTM: 0.4,
      grossProfitTTM: 5e8,
      operatingCashflowTTM: 3e8,
    },
    institutional: null,
    ...over,
  };
}

describe('gate', () => {
  it('rejects downtrends even with great fundamentals', () => {
    const s = scoreTrident(baseInputs({ bars: mkBars(trendCloses(300, 100, -0.002), 800_000) }));
    expect(s.eligible).toBe(false);
    expect(s.gateReasons.join(' ')).toMatch(/uptrend/);
  });

  it('rejects illiquid names', () => {
    const s = scoreTrident(baseInputs({ bars: mkBars(UPTREND, 1_000) }));
    expect(s.eligible).toBe(false);
    expect(s.gateReasons.join(' ')).toMatch(/vol/);
  });

  it('small-cap quality floor: negative cash flow fails the r2k gate', () => {
    const s = scoreTrident(baseInputs({
      universe: 'russell2k',
      fundamentals: { ...baseInputs().fundamentals!, operatingCashflowTTM: -1e6 },
    }));
    expect(s.eligible).toBe(false);
    expect(s.gateReasons.join(' ')).toMatch(/quality floor/);
  });

  it('accepts a liquid uptrending name', () => {
    const s = scoreTrident(baseInputs());
    expect(s.eligible).toBe(true);
    expect(s.composite).not.toBeNull();
  });
});

describe('F pillar', () => {
  it('acceleration: rising YoY growth scores high, decelerating scores low', () => {
    // growth of growth positive: yoy g goes 30% -> 43% -> 50% -> 65%
    const accel = scoreAcceleration(mkEarnings([1.0, 1.05, 1.1, 1.15, 1.3, 1.5, 1.65, 1.9]))!;
    // decelerating: strong growth but slowing
    const decel = scoreAcceleration(mkEarnings([1.0, 1.2, 1.4, 1.6, 1.9, 2.1, 2.2, 2.25]))!;
    expect(accel).toBeGreaterThan(60);
    expect(decel).toBeLessThan(45);
    expect(accel).toBeGreaterThan(decel);
  });

  it('acceleration needs 8 quarters and a sane base', () => {
    expect(scoreAcceleration(mkEarnings([1, 1.1, 1.2, 1.3]))).toBeNull();
    // Tiny year-ago base (the rows[4] slot after newest-first sort) → null.
    expect(scoreAcceleration(mkEarnings([1, 1.1, 1.2, 0.001, 1.3, 1.5, 1.6, 1.7]))).toBeNull();
  });

  it('revisions: improving bullish breadth scores above deteriorating', () => {
    const up = scoreRevisions([
      { period: '2026-07-01', strongBuy: 10, buy: 10, hold: 4, sell: 0, strongSell: 0 },
      { period: '2026-06-01', strongBuy: 7, buy: 9, hold: 8, sell: 1, strongSell: 0 },
      { period: '2026-05-01', strongBuy: 5, buy: 8, hold: 10, sell: 2, strongSell: 0 },
    ])!;
    const down = scoreRevisions([
      { period: '2026-07-01', strongBuy: 3, buy: 6, hold: 12, sell: 3, strongSell: 1 },
      { period: '2026-06-01', strongBuy: 6, buy: 8, hold: 9, sell: 1, strongSell: 0 },
      { period: '2026-05-01', strongBuy: 8, buy: 9, hold: 7, sell: 1, strongSell: 0 },
    ])!;
    expect(up).toBeGreaterThan(down);
    expect(up).toBeGreaterThan(55);
  });
});

describe('I pillar + warming state', () => {
  it('null institutional inputs → warming, composite reweights to F/T only', () => {
    const s = scoreTrident(baseInputs());
    expect(s.institutionalState).toBe('warming');
    expect(s.pillars!.I).toBeNull();
    const wf = 0.4 / 0.75;
    const expected = s.pillars!.F * wf + s.pillars!.T * (1 - wf);
    expect(Math.abs(s.composite! - expected)).toBeLessThan(0.11);
  });

  it('fresh 13D scores i1=100; stale 13D decays; crowding subtracts; breadth decline caps', () => {
    const asOf = '2026-07-18';
    const fresh = scoreInstitutional({
      activist: { filer: 'Fund X', type: '13D', acceptedAt: '2026-07-01' },
      convictionAdds: [], clusterCount: 0,
      shortInterestPctFloat: 2, instShareOfFloatPct: 30,
      breadthDecline: false, insiderNetBuyDollars: null,
    }, asOf);
    expect(fresh.state).toBe('live');
    expect(fresh.i1).toBe(100);

    const stale = scoreInstitutional({
      activist: { filer: 'Fund X', type: '13D', acceptedAt: '2026-02-15' }, // ~153d old → deep decay, not zero
      convictionAdds: [], clusterCount: 0,
      shortInterestPctFloat: 2, instShareOfFloatPct: 30,
      breadthDecline: false, insiderNetBuyDollars: null,
    }, asOf);
    expect(stale.i1!).toBeGreaterThan(0);
    expect(stale.i1!).toBeLessThan(30);

    const crowded = scoreInstitutional({
      activist: { filer: 'Fund X', type: '13D', acceptedAt: '2026-07-01' },
      convictionAdds: [], clusterCount: 0,
      shortInterestPctFloat: 15, instShareOfFloatPct: 70,
      breadthDecline: false, insiderNetBuyDollars: null,
    }, asOf);
    expect(crowded.I!).toBeLessThan(fresh.I!);

    const breadthCapped = scoreInstitutional({
      activist: { filer: 'Fund X', type: '13D', acceptedAt: '2026-07-01' },
      convictionAdds: [{ fund: 'Y', action: 'new', portfolioWeightPct: 8, acceptedAt: '2026-06-01' }],
      clusterCount: 2,
      shortInterestPctFloat: 2, instShareOfFloatPct: 30,
      breadthDecline: true, insiderNetBuyDollars: 1_000_000,
    }, asOf);
    expect(breadthCapped.I!).toBeLessThanOrEqual(45);
  });
});

describe('entry classification', () => {
  it('tight range near highs classifies BREAKOUT with pivot above the range', () => {
    // long uptrend then 25 flat bars (tight base at the highs)
    const closes = [...trendCloses(275, 50, 0.003), ...Array(25).fill(0).map(() => 112 + Math.sin(Math.random()) * 0.2)];
    // deterministic flat: replace random with fixed tiny oscillation
    for (let i = 275; i < 300; i++) closes[i] = 112 + ((i % 3) - 1) * 0.15;
    const s = scoreTrident(baseInputs({ bars: mkBars(closes, 800_000) }));
    expect(s.eligible).toBe(true);
    expect(s.entry!.kind).toBe('BREAKOUT');
    expect(s.entry!.pivot!).toBeGreaterThan(112);
    expect(s.entry!.stop!).toBeLessThan(s.entry!.pivot!);
  });
});

describe('percentileRanks', () => {
  it('ranks a spread of composites 0..100 monotonically', () => {
    const ranks = percentileRanks([10, 50, 90, 50]);
    expect(ranks[2]).toBeGreaterThan(ranks[1]);
    expect(ranks[1]).toBeGreaterThan(ranks[0]);
    expect(ranks[1]).toBe(ranks[3]);
  });
});
