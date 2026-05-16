import { describe, it, expect } from 'vitest';
import { computeMetrics, spearman } from '../metrics';
import type {
  AttributionRecord,
  DailyEquityPoint,
  MLTrainingRow,
  TradeRecord,
} from '../types';

function flatEquity(days: number, start = 100): DailyEquityPoint[] {
  const out: DailyEquityPoint[] = [];
  for (let i = 0; i < days; i++) {
    out.push({ date: `2024-01-${String(i + 1).padStart(2, '0')}`, value: start });
  }
  return out;
}

function risingEquity(days: number, start = 100, dailyRet = 0.001): DailyEquityPoint[] {
  const out: DailyEquityPoint[] = [];
  let v = start;
  for (let i = 0; i < days; i++) {
    out.push({ date: `2024-01-${String(i + 1).padStart(2, '0')}`, value: v });
    v *= 1 + dailyRet;
  }
  return out;
}

const emptyInputs = {
  trades: [] as TradeRecord[],
  attribution: [] as AttributionRecord[],
  mlRows: [] as MLTrainingRow[],
  benchmarkBars: [] as never[],
  initialCapital: 100,
  startDate: '2024-01-01',
  endDate: '2024-01-31',
};

describe('spearman', () => {
  it('perfectly correlated → 1', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 8);
  });

  it('perfectly anti-correlated → -1', () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 8);
  });

  it('uncorrelated random-looking → near 0', () => {
    // {1, 2, 3, 4} vs {3, 1, 4, 2} — non-monotonic
    const r = spearman([1, 2, 3, 4], [3, 1, 4, 2]);
    expect(Math.abs(r)).toBeLessThan(0.5);
  });

  it('handles ties via average rank', () => {
    expect(spearman([1, 1, 2, 2], [1, 1, 2, 2])).toBeCloseTo(1, 8);
  });

  it('returns 0 for degenerate input', () => {
    expect(spearman([], [])).toBe(0);
    expect(spearman([1, 1, 1], [2, 2, 2])).toBe(0);
  });
});

describe('computeMetrics — synthetic equity curves', () => {
  it('flat equity → zero returns, zero Sharpe, zero DD', () => {
    const m = computeMetrics({ ...emptyInputs, dailyEquity: flatEquity(30) });
    expect(m.totalReturnPct).toBe(0);
    expect(m.sharpe).toBe(0);
    expect(m.maxDrawdownPct).toBe(0);
  });

  it('rising equity → positive total return and CAGR', () => {
    const eq = risingEquity(252); // one trading year
    const m = computeMetrics({ ...emptyInputs, dailyEquity: eq });
    expect(m.totalReturnPct).toBeGreaterThan(0);
    expect(m.cagrPct).toBeGreaterThan(0);
  });

  it('rising equity with constant returns → very high Sharpe (no volatility = pure signal)', () => {
    // Constant +0.1% per day → near-zero std, mean=positive → Sharpe → ∞
    const eq = risingEquity(30, 100, 0.001);
    const m = computeMetrics({ ...emptyInputs, dailyEquity: eq });
    expect(m.sharpe).toBeGreaterThan(100);
  });

  it('detects a 20% drawdown from V-shaped equity', () => {
    // Start 100, climb to 120, drop to 96 (-20% from peak), recover to 130
    const eq: DailyEquityPoint[] = [
      { date: '2024-01-01', value: 100 },
      { date: '2024-01-02', value: 110 },
      { date: '2024-01-03', value: 120 },
      { date: '2024-01-04', value: 110 },
      { date: '2024-01-05', value: 96 }, // -20% from 120
      { date: '2024-01-06', value: 110 },
      { date: '2024-01-07', value: 130 },
    ];
    const m = computeMetrics({ ...emptyInputs, dailyEquity: eq });
    expect(m.maxDrawdownPct).toBeCloseTo(20, 4);
    expect(m.recoveryDays).toBeGreaterThan(0);
  });

  it('records recoveryDays=null when DD never recovers', () => {
    const eq: DailyEquityPoint[] = [
      { date: '2024-01-01', value: 100 },
      { date: '2024-01-02', value: 120 },
      { date: '2024-01-03', value: 110 },
      { date: '2024-01-04', value: 90 }, // -25% from peak
    ];
    const m = computeMetrics({ ...emptyInputs, dailyEquity: eq });
    expect(m.recoveryDays).toBeNull();
    expect(m.maxDrawdownPct).toBeCloseTo(25, 4);
  });

  it('win/profit-factor: 3 wins + 1 loss summed correctly', () => {
    const att: AttributionRecord[] = [
      { rebalanceDate: '2024-01-01', ticker: 'A', weight: 0.25, segmentReturn: 0.10, contribution: 0.025, layers: {}, composite: 60, regime: null },
      { rebalanceDate: '2024-01-01', ticker: 'B', weight: 0.25, segmentReturn: 0.05, contribution: 0.0125, layers: {}, composite: 60, regime: null },
      { rebalanceDate: '2024-01-01', ticker: 'C', weight: 0.25, segmentReturn: 0.02, contribution: 0.005, layers: {}, composite: 60, regime: null },
      { rebalanceDate: '2024-01-01', ticker: 'D', weight: 0.25, segmentReturn: -0.04, contribution: -0.01, layers: {}, composite: 60, regime: null },
    ];
    const m = computeMetrics({
      ...emptyInputs,
      dailyEquity: flatEquity(30),
      attribution: att,
    });
    expect(m.winRatePct).toBe(75);
    expect(m.avgWinPct).toBeCloseTo(((10 + 5 + 2) / 3), 4);
    expect(m.avgLossPct).toBeCloseTo(-4, 4);
    // gross win = 0.17, gross loss = 0.04 → 4.25
    expect(m.profitFactor).toBeCloseTo(0.17 / 0.04, 4);
  });

  it('IC: composite ranks perfectly predict forward returns → IC=1', () => {
    const ml: MLTrainingRow[] = [
      { runId: 'x', ticker: 'A', asOfDate: '2024-01-01', composite: 90, layers: {}, regime: null, sector: null, marketCapBucket: null, inPortfolio: true, entryPrice: null, exitPrice: null, holdDays: null, forward5dReturn: null, forward20dReturn: 0.10, forward60dReturn: null, forward252dReturn: null, realizedPnl: null },
      { runId: 'x', ticker: 'B', asOfDate: '2024-01-01', composite: 70, layers: {}, regime: null, sector: null, marketCapBucket: null, inPortfolio: true, entryPrice: null, exitPrice: null, holdDays: null, forward5dReturn: null, forward20dReturn: 0.05, forward60dReturn: null, forward252dReturn: null, realizedPnl: null },
      { runId: 'x', ticker: 'C', asOfDate: '2024-01-01', composite: 50, layers: {}, regime: null, sector: null, marketCapBucket: null, inPortfolio: false, entryPrice: null, exitPrice: null, holdDays: null, forward5dReturn: null, forward20dReturn: 0.01, forward60dReturn: null, forward252dReturn: null, realizedPnl: null },
      { runId: 'x', ticker: 'D', asOfDate: '2024-01-01', composite: 30, layers: {}, regime: null, sector: null, marketCapBucket: null, inPortfolio: false, entryPrice: null, exitPrice: null, holdDays: null, forward5dReturn: null, forward20dReturn: -0.03, forward60dReturn: null, forward252dReturn: null, realizedPnl: null },
    ];
    const m = computeMetrics({
      ...emptyInputs,
      dailyEquity: flatEquity(30),
      mlRows: ml,
    });
    expect(m.informationCoefficient).toBeCloseTo(1, 4);
  });
});
