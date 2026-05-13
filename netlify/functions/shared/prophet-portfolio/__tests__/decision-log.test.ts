// Phase 4e-1 — decisionLog builder + forward-return tests.

import { describe, expect, it } from 'vitest';
import {
  buildDecisionLogRows,
  computeForwardReturns,
} from '../decision-log';
import type {
  PortfolioState,
  RankingResult,
  RebalanceDecision,
} from '../types';

function cand(ticker: string, composite: number): RankingResult {
  return {
    ticker,
    name: ticker,
    sector: 'Technology',
    composite,
    layers: { fundamental: { score: composite, pass: true } },
    fundamentalPass: true,
    regime: 'risk_on',
    signalId: 'composite-v1',
  };
}

const STATE: PortfolioState = {
  universe: 'largecap',
  asOfDate: '2024-01-08',
  cash: 0,
  equity: 100_000,
  positions: [
    {
      ticker: 'AAPL',
      shares: 100,
      entryDate: '2024-01-01',
      entryPrice: 100,
      currentPrice: 100,
      marketValue: 10_000,
      weight: 0.1,
      sector: 'Technology',
    },
  ],
  lastRebalanceAt: '2024-01-01T21:00:00Z',
  updatedAt: '2024-01-08T21:00:00Z',
};

describe('buildDecisionLogRows', () => {
  it('emits one ADD row per addition + EXIT per out', () => {
    const decision: RebalanceDecision = {
      in: [
        { ticker: 'NEW1', targetWeight: 0.1, rank: 1, composite: 85, sector: 'Tech' },
        { ticker: 'NEW2', targetWeight: 0.1, rank: 2, composite: 82, sector: 'Tech' },
      ],
      out: [{ ticker: 'AAPL', shares: 100, reason: 'fell_out_of_top_N' }],
      holds: [],
      notes: [],
    };
    const rows = buildDecisionLogRows({
      asOfDate: '2024-02-15',
      state: STATE,
      candidates: [cand('NEW1', 85), cand('NEW2', 82)],
      decision,
      signalId: 'composite-v1',
    });
    expect(rows.find((r) => r.ticker === 'NEW1')?.action).toBe('ADD');
    expect(rows.find((r) => r.ticker === 'NEW2')?.action).toBe('ADD');
    expect(rows.find((r) => r.ticker === 'AAPL')?.action).toBe('EXIT');
  });

  it('emits HOLD_IN for current holdings that stayed', () => {
    const decision: RebalanceDecision = {
      in: [],
      out: [],
      holds: [{ ticker: 'AAPL', reason: 'still_top_N' }],
      notes: [],
    };
    const rows = buildDecisionLogRows({
      asOfDate: '2024-02-15',
      state: STATE,
      candidates: [cand('AAPL', 85)],
      decision,
      signalId: 'composite-v1',
    });
    expect(rows.find((r) => r.ticker === 'AAPL')?.action).toBe('HOLD_IN');
  });

  it('emits HOLD_OUT shadow rows for candidates the rule passed over', () => {
    const decision: RebalanceDecision = {
      in: [],
      out: [],
      holds: [],
      notes: [],
    };
    const rows = buildDecisionLogRows({
      asOfDate: '2024-02-15',
      state: STATE,
      candidates: [cand('SHADOW', 90)],
      decision,
      signalId: 'composite-v1',
    });
    expect(rows.find((r) => r.ticker === 'SHADOW')?.action).toBe('HOLD_OUT');
  });

  it('stamps every row with the provided signalId + regime', () => {
    const rows = buildDecisionLogRows({
      asOfDate: '2024-02-15',
      state: STATE,
      candidates: [cand('A', 80)],
      decision: {
        in: [{ ticker: 'A', targetWeight: 0.1, rank: 1, composite: 80, sector: 'Tech' }],
        out: [],
        holds: [],
        notes: [],
      },
      signalId: 'composite-v1',
      regime: 'risk_on',
    });
    expect(rows[0].signalId).toBe('composite-v1');
    expect(rows[0].regime).toBe('risk_on');
  });

  it('does not duplicate a ticker that appears in both holds and candidates', () => {
    const decision: RebalanceDecision = {
      in: [],
      out: [],
      holds: [{ ticker: 'AAPL', reason: 'still_top_N' }],
      notes: [],
    };
    const rows = buildDecisionLogRows({
      asOfDate: '2024-02-15',
      state: STATE,
      candidates: [cand('AAPL', 85)],
      decision,
      signalId: 'composite-v1',
    });
    expect(rows.filter((r) => r.ticker === 'AAPL')).toHaveLength(1);
  });
});

describe('computeForwardReturns', () => {
  function barsLinear(start: string, n: number, step: number): { date: string; close: number }[] {
    const startMs = Date.parse(`${start}T00:00:00Z`);
    return Array.from({ length: n }, (_, i) => ({
      date: new Date(startMs + i * 86_400_000).toISOString().slice(0, 10),
      close: 100 + i * step,
    }));
  }

  it('computes 30d/60d/90d returns from entry to target dates', () => {
    // 100, 101, 102, ..., 200 — daily +1 over 100 days
    const bars = barsLinear('2024-01-08', 120, 1);
    const r = computeForwardReturns('2024-01-08', bars);
    // entry close = 100 (idx 0); 30d later → +30, +60, +90
    expect(r.forwardReturn30d).toBeCloseTo(0.3, 4);
    expect(r.forwardReturn60d).toBeCloseTo(0.6, 4);
    expect(r.forwardReturn90d).toBeCloseTo(0.9, 4);
  });

  it('returns nulls when decisionDate precedes all bars', () => {
    const bars = barsLinear('2024-06-01', 10, 1);
    const r = computeForwardReturns('2024-01-01', bars);
    expect(r.forwardReturn30d).toBeNull();
    expect(r.forwardReturn60d).toBeNull();
    expect(r.forwardReturn90d).toBeNull();
  });

  it('returns null for windows that exceed bar coverage', () => {
    // Only 40 days of bars — 60d and 90d should be null.
    const bars = barsLinear('2024-01-08', 40, 1);
    const r = computeForwardReturns('2024-01-08', bars);
    expect(r.forwardReturn30d).toBeCloseTo(0.3, 4);
    expect(r.forwardReturn60d).toBeNull();
    expect(r.forwardReturn90d).toBeNull();
  });

  it('handles flat price series → 0 return', () => {
    const bars = Array.from({ length: 100 }, (_, i) => ({
      date: new Date(Date.parse('2024-01-08T00:00:00Z') + i * 86_400_000)
        .toISOString()
        .slice(0, 10),
      close: 100,
    }));
    const r = computeForwardReturns('2024-01-08', bars);
    expect(r.forwardReturn30d).toBe(0);
  });
});
