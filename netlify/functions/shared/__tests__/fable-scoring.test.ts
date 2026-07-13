// FABLE — pure engine tests. Pin the gate, pillar squashes, insider edge,
// composite, and regime classifier on synthetic fixtures with hand-checkable
// answers. These constants are the pre-committed ones under validation.

import { describe, it, expect } from 'vitest';
import {
  evaluateFoundationGate,
  computePillars,
  computeInsiderEdge,
  computeFableComposite,
  scoreFable,
  percentileAmong,
  suggestEntry,
  classifyFableRegime,
  smaAt,
  FABLE_CONSTANTS,
  type FableBar,
  type FableInsiderTx,
} from '../fable-scoring';

const DAY = 86_400_000;
const T0 = Date.parse('2024-01-01T12:00:00Z');

/** Build bars from a close-path fn; skips weekends for realism-lite. */
function mkBars(n: number, closeAt: (i: number) => number, volAt?: (i: number) => number): FableBar[] {
  const bars: FableBar[] = [];
  let t = T0;
  for (let i = 0; i < n; i++) {
    // advance skipping weekends
    do {
      t += DAY;
    } while (new Date(t).getUTCDay() === 0 || new Date(t).getUTCDay() === 6);
    const c = closeAt(i);
    bars.push({ t, o: c * 0.995, h: c * 1.01, l: c * 0.99, c, v: volAt ? volAt(i) : 1_000_000 });
  }
  return bars;
}

/** Smooth +55%/yr uptrend with realistic wiggle, tightening at the end. */
function idealBars(n = 320): FableBar[] {
  return mkBars(
    n,
    (i) => 100 * Math.pow(1.0018, i) * (1 + 0.006 * Math.sin(i / 3) + 0.004 * Math.sin(i / 7)),
    (i) => (i > n - 12 ? 600_000 : 1_000_000), // volume dry-up in the last 10 days
  );
}

/** Downtrend. */
function bearBars(n = 320): FableBar[] {
  return mkBars(n, (i) => 100 * Math.pow(0.9985, i));
}

describe('foundation gate', () => {
  it('passes the ideal smooth uptrend', () => {
    const g = evaluateFoundationGate(idealBars());
    expect(g.failed).toEqual([]);
    expect(g.pass).toBe(true);
  });

  it('fails a downtrend on multiple conditions', () => {
    const g = evaluateFoundationGate(bearBars());
    expect(g.pass).toBe(false);
    expect(g.failed.length).toBeGreaterThan(0);
    expect(g.failed).toContain('ma-stack');
  });

  it('fails on insufficient history', () => {
    const g = evaluateFoundationGate(idealBars(100));
    expect(g.pass).toBe(false);
    expect(g.failed).toContain('insufficient-history');
  });

  it('smaAt returns null when window exceeds history', () => {
    expect(smaAt(idealBars(60), 200, 59)).toBeNull();
  });
});

describe('pillars', () => {
  const spy = mkBars(320, (i) => 400 * Math.pow(1.0004, i) * (1 + 0.004 * Math.sin(i / 5)));

  it('ideal name: high ascent/smooth/high-ground, non-zero coil', () => {
    const p = computePillars(idealBars(), spy)!;
    expect(p).not.toBeNull();
    expect(p.ascent).toBeGreaterThan(40); // ~55%/yr weighted RS
    expect(p.smoothPath).toBeGreaterThan(50); // smooth by construction
    expect(p.highGround).toBeGreaterThan(80); // at its highs
    expect(p.coiledSpring).toBeGreaterThan(0);
    expect(p.fip).toBeLessThan(0); // winner, more up-days than down
    expect(p.proximity52w).toBeGreaterThan(0.9);
  });

  it('extension damper zeroes coil when >35% above SMA50', () => {
    // Parabolic finish: +2.2%/day for the last 40 days
    const b = mkBars(320, (i) => (i < 280 ? 100 * Math.pow(1.0005, i) : 100 * Math.pow(1.0005, 280) * Math.pow(1.022, i - 280)));
    const p = computePillars(b, spy)!;
    expect(p.extensionPct).toBeGreaterThan(FABLE_CONSTANTS.EXT_DAMPER_END);
    expect(p.coiledSpring).toBe(0);
  });

  it('null on insufficient history', () => {
    expect(computePillars(idealBars(150), spy)).toBeNull();
  });
});

describe('insider edge', () => {
  const asOf = '2025-03-01';
  const buy = (name: string, filingDate: string, usd = 50_000): FableInsiderTx => ({
    name,
    change: Math.round(usd / 50),
    transactionPrice: 50,
    transactionCode: 'P',
    filingDate,
    transactionDate: filingDate,
  });

  it('single fresh qualifying buy ≈ 40·w', () => {
    const e = computeInsiderEdge([buy('A', '2025-02-25')], asOf);
    expect(e.score).toBeGreaterThan(35);
    expect(e.buyers90d).toBe(1);
  });

  it('3-buyer cluster + $250k net scores ~90 fresh', () => {
    const e = computeInsiderEdge(
      [buy('A', '2025-02-20', 120_000), buy('B', '2025-02-22', 100_000), buy('C', '2025-02-25', 60_000)],
      asOf,
    );
    expect(e.score).toBeGreaterThan(80);
    expect(e.buyers90d).toBe(3);
    expect(e.netBuyUsd90d).toBeGreaterThanOrEqual(250_000);
  });

  it('decays to 0 past 180 days', () => {
    const e = computeInsiderEdge([buy('A', '2024-08-01')], asOf);
    expect(e.score).toBe(0);
  });

  it('sub-$25k buys ignored; derivative ignored; future filings invisible (PIT)', () => {
    const e = computeInsiderEdge(
      [
        buy('A', '2025-02-25', 10_000),
        { ...buy('B', '2025-02-25'), isDerivative: true },
        buy('C', '2025-03-15'), // filed after asOf
      ],
      asOf,
    );
    expect(e.score).toBe(0);
  });

  it('2 big sellers apply the −25 veto', () => {
    const sell = (name: string): FableInsiderTx => ({
      name,
      change: -20_000,
      transactionPrice: 50,
      transactionCode: 'S',
      filingDate: '2025-02-20',
      transactionDate: '2025-02-20',
    });
    const withVeto = computeInsiderEdge([buy('A', '2025-02-25'), sell('X'), sell('Y')], asOf);
    const without = computeInsiderEdge([buy('A', '2025-02-25')], asOf);
    expect(without.score - withVeto.score).toBeCloseTo(25, 5);
    expect(withVeto.sellVeto).toBe(true);
  });

  it('exec role bonus applies only when roles provided', () => {
    const roles = new Map([['A', 'Chief Financial Officer']]);
    const withRole = computeInsiderEdge([buy('A', '2025-02-25')], asOf, roles);
    const noRole = computeInsiderEdge([buy('A', '2025-02-25')], asOf);
    expect(withRole.score).toBeGreaterThan(noRole.score);
  });
});

describe('composite + score + display', () => {
  const spy = mkBars(320, (i) => 400 * Math.pow(1.0004, i) * (1 + 0.004 * Math.sin(i / 5)));

  it('composite = 0.2·(P1+P2+P3+P4) + 0.2·insider', () => {
    const pillars = computePillars(idealBars(), spy)!;
    const insider = { score: 50, buyers90d: 1, netBuyUsd90d: 50_000, latestFiling: '2025-01-01', sellVeto: false };
    const c = computeFableComposite(pillars, insider);
    expect(c).toBeCloseTo(
      0.2 * (pillars.ascent + pillars.smoothPath + pillars.highGround + pillars.coiledSpring) + 10,
      8,
    );
  });

  it('scoreFable: null for gate-fail, populated for ideal', () => {
    expect(scoreFable(bearBars(), spy, [], '2025-03-01')).toBeNull();
    const s = scoreFable(idealBars(), spy, [], '2025-03-01');
    expect(s).not.toBeNull();
    expect(s!.composite).toBeGreaterThan(0);
    expect(s!.insider.score).toBe(0);
  });

  it('percentileAmong ranks 0-100 with ties averaged', () => {
    expect(percentileAmong([10, 20, 30])).toEqual([0, 50, 100]);
    const p = percentileAmong([10, 20, 20, 30]);
    expect(p[1]).toBeCloseTo(p[2], 10);
  });

  it('suggestEntry: pivot = 10d high, stop ≥ 8% below pivot', () => {
    const b = idealBars();
    const { pivot, stop } = suggestEntry(b);
    expect(pivot).toBeGreaterThan(b[b.length - 1].c * 0.99);
    expect(stop).toBeGreaterThanOrEqual(+(pivot * (1 - FABLE_CONSTANTS.STOP_PCT)).toFixed(2));
  });
});

describe('regime classifier', () => {
  it('offense in a steady bull', () => {
    expect(classifyFableRegime(mkBars(600, (i) => 300 * Math.pow(1.0006, i)))).toBe('offense');
  });
  it('defense when below the 200d', () => {
    const b = mkBars(600, (i) => (i < 500 ? 300 * Math.pow(1.0006, i) : 300 * Math.pow(1.0006, 500) * Math.pow(0.997, i - 500)));
    expect(classifyFableRegime(b)).toBe('defense');
  });
  it('panic when 24mo return negative and vol spikes', () => {
    // long decline then a violent final month
    const b = mkBars(
      700,
      (i) => (i < 600 ? 300 * Math.pow(0.9993, i) : 300 * Math.pow(0.9993, 600) * (1 + 0.04 * Math.sin(i))),
    );
    expect(classifyFableRegime(b)).toBe('panic');
  });
});
