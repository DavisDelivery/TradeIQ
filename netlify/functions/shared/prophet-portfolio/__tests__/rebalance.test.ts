// Phase 4e-1 — Rebalance decision tests.
//
// Pure function — no mocks. Covers the cases enumerated in
// briefs/phase-4e-1-brief.md § W3.

import { describe, expect, it } from 'vitest';
import { decideRebalance } from '../rebalance';
import type {
  PortfolioConfig,
  PortfolioPosition,
  PortfolioState,
  RankingResult,
} from '../types';

const CONFIG: PortfolioConfig = {
  universe: 'largecap',
  startDate: '2024-01-01',
  startCapital: 100_000,
  positionCount: 10,
  minHoldDays: 30,
  maxSwapsPerRebalance: 3,
  sectorCap: 4,
  slippageBps: 10,
  minComposite: 50,
  candidatePool: 15,
  version: 'v1',
};

const EMPTY_STATE: PortfolioState = {
  universe: 'largecap',
  asOfDate: '2024-01-01',
  cash: 100_000,
  equity: 100_000,
  positions: [],
  lastRebalanceAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

function candidate(
  ticker: string,
  composite: number,
  sector = 'Technology',
  fundamentalPass = true,
): RankingResult {
  return {
    ticker,
    name: ticker,
    sector,
    composite,
    layers: {
      fundamental: { score: composite, pass: fundamentalPass },
    },
    fundamentalPass,
    regime: 'risk_on',
    signalId: 'composite-v1',
  };
}

function position(
  ticker: string,
  entryDate: string,
  sector = 'Technology',
): PortfolioPosition {
  return {
    ticker,
    shares: 50,
    entryDate,
    entryPrice: 100,
    currentPrice: 105,
    marketValue: 5_250,
    weight: 0.1,
    sector,
  };
}

describe('decideRebalance — empty state', () => {
  it('initial fill: 10 buys, 0 sells, equal weight, no holds', () => {
    const sectors = ['Tech', 'HC', 'Fin', 'Energy', 'Cons'];
    const candidates = Array.from({ length: 15 }, (_, i) =>
      candidate(
        `T${i.toString().padStart(2, '0')}`,
        90 - i,
        sectors[i % sectors.length],
      ),
    );
    const d = decideRebalance(EMPTY_STATE, candidates, CONFIG, '2024-01-08');
    expect(d.in).toHaveLength(10);
    expect(d.out).toHaveLength(0);
    expect(d.holds).toHaveLength(0);
    expect(d.in.every((x) => x.targetWeight === 0.1)).toBe(true);
    expect(d.in[0].rank).toBe(1);
    expect(d.in[9].rank).toBe(10);
  });

  it('initial fill respects sector cap (max 4 per sector)', () => {
    // 6 Tech + 4 Healthcare in top-10 composite order — Tech is capped
    // at 4 so candidates 5 and 6 (Tech) get skipped in favor of further-
    // down Healthcare picks.
    const candidates: RankingResult[] = [];
    for (let i = 0; i < 6; i++) {
      candidates.push(candidate(`TECH${i}`, 95 - i, 'Technology'));
    }
    for (let i = 0; i < 4; i++) {
      candidates.push(candidate(`HC${i}`, 85 - i, 'Healthcare'));
    }
    for (let i = 0; i < 5; i++) {
      candidates.push(candidate(`FIN${i}`, 75 - i, 'Financials'));
    }
    const d = decideRebalance(EMPTY_STATE, candidates, CONFIG, '2024-01-08');
    expect(d.in).toHaveLength(10);
    const sectorCounts = d.in.reduce<Record<string, number>>((acc, x) => {
      acc[x.sector] = (acc[x.sector] ?? 0) + 1;
      return acc;
    }, {});
    expect(sectorCounts.Technology).toBeLessThanOrEqual(4);
    expect(sectorCounts.Healthcare).toBeLessThanOrEqual(4);
    expect(d.notes.some((n) => n.includes('sector cap'))).toBe(true);
  });
});

describe('decideRebalance — min-hold protection', () => {
  it('keeps a holding that fell out of top-15 but is held < 30 days', () => {
    const state: PortfolioState = {
      ...EMPTY_STATE,
      asOfDate: '2024-01-15',
      positions: [position('AAPL', '2024-01-01')], // 14 days held
    };
    const candidates = [candidate('NEW', 80)]; // AAPL not in candidates
    const d = decideRebalance(state, candidates, CONFIG, '2024-01-15');
    expect(d.out.find((o) => o.ticker === 'AAPL')).toBeUndefined();
    expect(d.holds.find((h) => h.ticker === 'AAPL')?.reason).toBe(
      'min_hold_active',
    );
  });

  it('exits a holding that fell out of top-15 once held >= 30 days', () => {
    const state: PortfolioState = {
      ...EMPTY_STATE,
      asOfDate: '2024-02-15',
      positions: [position('AAPL', '2024-01-01')], // 45 days held
    };
    const candidates = [candidate('NEW', 80)]; // AAPL not in candidates
    const d = decideRebalance(state, candidates, CONFIG, '2024-02-15');
    expect(d.out.find((o) => o.ticker === 'AAPL')?.reason).toBe(
      'fell_out_of_top_N',
    );
  });
});

describe('decideRebalance — forced exit on earnings-gate fail', () => {
  it('exits a holding with fundamentalPass=false bypassing the min-hold', () => {
    const state: PortfolioState = {
      ...EMPTY_STATE,
      asOfDate: '2024-02-15',
      positions: [position('BAD', '2024-01-01')], // 45 days
    };
    // BAD is in candidates but fundamentalPass=false
    const candidates = [candidate('BAD', 75, 'Technology', false)];
    const d = decideRebalance(state, candidates, CONFIG, '2024-02-15');
    expect(d.out.find((o) => o.ticker === 'BAD')?.reason).toBe(
      'fundamental_fail',
    );
  });

  it('forced exits use swap budget; deferred forced exits stay as holds', () => {
    const state: PortfolioState = {
      ...EMPTY_STATE,
      asOfDate: '2024-03-15',
      positions: [
        position('F1', '2024-01-01', 'Sector1'),
        position('F2', '2024-01-01', 'Sector2'),
        position('F3', '2024-01-01', 'Sector3'),
        position('F4', '2024-01-01', 'Sector4'),
        position('F5', '2024-01-01', 'Sector5'),
      ],
    };
    const candidates = [
      candidate('F1', 60, 'Sector1', false),
      candidate('F2', 61, 'Sector2', false),
      candidate('F3', 62, 'Sector3', false),
      candidate('F4', 63, 'Sector4', false),
      candidate('F5', 64, 'Sector5', false),
      candidate('REPL', 80, 'Sector9', true),
    ];
    const d = decideRebalance(state, candidates, CONFIG, '2024-03-15');
    expect(d.out).toHaveLength(3); // budget=3
    expect(d.out.every((o) => o.reason === 'fundamental_fail')).toBe(true);
    // Lowest composite exits first
    const tickersOut = d.out.map((o) => o.ticker);
    expect(tickersOut).toContain('F1');
    expect(tickersOut).toContain('F2');
    expect(tickersOut).toContain('F3');
    // Deferred exits noted + held as 'still_in_universe'
    expect(d.notes.some((n) => n.includes('deferred'))).toBe(true);
    expect(
      d.holds.filter((h) => h.reason === 'still_in_universe').length,
    ).toBe(2);
  });
});

describe('decideRebalance — additions + sector cap on a non-empty portfolio', () => {
  it('skips an addition that would breach the sector cap', () => {
    // 4 Tech holdings already (cap = 4). The first candidate is also
    // Tech and must be skipped in favor of the second candidate.
    const state: PortfolioState = {
      ...EMPTY_STATE,
      asOfDate: '2024-02-15',
      positions: [
        position('T1', '2024-01-01', 'Technology'),
        position('T2', '2024-01-01', 'Technology'),
        position('T3', '2024-01-01', 'Technology'),
        position('T4', '2024-01-01', 'Technology'),
        position('OLD', '2023-12-01', 'Healthcare'), // held > 30d, fell out
      ],
    };
    const candidates = [
      candidate('T1', 95, 'Technology'),
      candidate('T2', 94, 'Technology'),
      candidate('T3', 93, 'Technology'),
      candidate('T4', 92, 'Technology'),
      candidate('TECH_NEW', 91, 'Technology'),
      candidate('HC_NEW', 90, 'Healthcare'),
    ];
    const d = decideRebalance(state, candidates, CONFIG, '2024-02-15');
    // OLD exits (Healthcare slot becomes available); TECH_NEW skipped
    // (sector cap), HC_NEW takes the slot.
    expect(d.out.find((o) => o.ticker === 'OLD')?.reason).toBe(
      'fell_out_of_top_N',
    );
    expect(d.in.map((x) => x.ticker)).toContain('HC_NEW');
    expect(d.in.map((x) => x.ticker)).not.toContain('TECH_NEW');
    expect(d.notes.some((n) => n.includes('TECH_NEW'))).toBe(true);
  });

  it('fewer than positionCount valid candidates → cash sleeve held', () => {
    const candidates = [
      candidate('A', 80),
      candidate('B', 75),
      candidate('C', 70),
    ];
    const d = decideRebalance(EMPTY_STATE, candidates, CONFIG, '2024-01-08');
    expect(d.in).toHaveLength(3);
    expect(d.out).toHaveLength(0);
    expect(d.notes.some((n) => n.includes('Cash sleeve'))).toBe(true);
  });
});

describe('decideRebalance — held position still in top-15 stays', () => {
  it('does not exit a holding at rank 12 (still in candidates)', () => {
    const state: PortfolioState = {
      ...EMPTY_STATE,
      asOfDate: '2024-02-15',
      positions: [position('AAPL', '2024-01-01')],
    };
    // AAPL at rank 12 — still in top-15
    const candidates = Array.from({ length: 15 }, (_, i) =>
      candidate(`T${i}`, 90 - i),
    );
    candidates[11] = candidate('AAPL', 79); // rank 12
    const d = decideRebalance(state, candidates, CONFIG, '2024-02-15');
    expect(d.out.find((o) => o.ticker === 'AAPL')).toBeUndefined();
    expect(d.holds.find((h) => h.ticker === 'AAPL')?.reason).toBe(
      'still_top_N',
    );
  });
});

describe('decideRebalance — equal weight + targetWeight invariants', () => {
  it('targetWeight is 1 / positionCount regardless of how many are added', () => {
    const config3: PortfolioConfig = { ...CONFIG, positionCount: 5 };
    const candidates = [candidate('A', 80), candidate('B', 75)];
    const d = decideRebalance(EMPTY_STATE, candidates, config3, '2024-01-08');
    expect(d.in.every((x) => x.targetWeight === 0.2)).toBe(true);
  });
});
