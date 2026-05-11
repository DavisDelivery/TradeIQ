import { describe, it, expect } from 'vitest';
import { walkForwardArray, walkForwardDates } from '../walk-forward';
import type { BacktestConfig } from '../types';

const baseConfig: BacktestConfig = {
  universe: 'dow',
  startDate: '2024-01-01',
  endDate: '2024-03-31',
  rebalanceFrequency: 'monthly',
  board: 'prophet',
  portfolio: {
    topN: 20,
    weighting: 'equal',
    maxPositionPct: 0.05,
    maxSectorPct: 0.3,
    cashSleeve: 0.05,
    minComposite: 0,
  },
  costs: { slippageBps: {}, commission: 0 },
  initialCapital: 100_000,
};

describe('walkForwardDates', () => {
  it('snaps startDate forward to first trading day', () => {
    // 2024-01-01 is a holiday; first trading day is 2024-01-02
    const dates = walkForwardArray({ ...baseConfig, endDate: '2024-01-10' });
    expect(dates[0]).toBe('2024-01-02');
  });

  it('yields weekly cadence stepping ~7 days, snapped to trading days', () => {
    const dates = walkForwardArray({
      ...baseConfig,
      startDate: '2024-01-08',
      endDate: '2024-02-09',
      rebalanceFrequency: 'weekly',
    });
    // First rebalance 2024-01-08 (Mon), step +7d → 2024-01-15 (MLK Day) →
    // snapped to 2024-01-16 (Tue). Then +7d → 2024-01-23 (Tue) ...
    expect(dates[0]).toBe('2024-01-08');
    expect(dates[1]).toBe('2024-01-16');
    expect(dates[2]).toBe('2024-01-23');
  });

  it('yields monthly cadence (~30d step) for 3-month window', () => {
    const dates = walkForwardArray({
      ...baseConfig,
      startDate: '2024-01-02',
      endDate: '2024-03-31',
      rebalanceFrequency: 'monthly',
    });
    // 2024-01-02, +30d=2024-02-01, +30d=2024-03-02 (Sat) → 2024-03-04
    expect(dates).toEqual(['2024-01-02', '2024-02-01', '2024-03-04']);
  });

  it('yields quarterly cadence (~91d step)', () => {
    const dates = walkForwardArray({
      ...baseConfig,
      startDate: '2024-01-02',
      endDate: '2024-12-31',
      rebalanceFrequency: 'quarterly',
    });
    // 2024-01-02, +91d=2024-04-02, +91d=2024-07-02, +91d=2024-10-01,
    // +91d=2024-12-31 (Tue, last trading day Dec)
    expect(dates.length).toBe(5);
    expect(dates[0]).toBe('2024-01-02');
    expect(dates[1]).toBe('2024-04-02');
    expect(dates[2]).toBe('2024-07-02');
  });

  it('stops at or before endDate', () => {
    const dates = walkForwardArray({
      ...baseConfig,
      startDate: '2024-01-02',
      endDate: '2024-01-15', // MLK day — last trading day before is Jan 12 Fri
      rebalanceFrequency: 'weekly',
    });
    // 2024-01-02, +7d=2024-01-09, +7d=2024-01-16 > endDate (2024-01-15) → stop
    expect(dates[dates.length - 1] <= '2024-01-15').toBe(true);
    expect(dates).toEqual(['2024-01-02', '2024-01-09']);
  });

  it('empty when startDate > endDate', () => {
    expect(
      walkForwardArray({
        ...baseConfig,
        startDate: '2024-06-01',
        endDate: '2024-01-01',
      }),
    ).toEqual([]);
  });

  it('generator can be consumed lazily', () => {
    const gen = walkForwardDates({
      ...baseConfig,
      startDate: '2024-01-02',
      endDate: '2024-12-31',
      rebalanceFrequency: 'monthly',
    });
    let count = 0;
    for (const _ of gen) {
      count++;
      if (count > 3) break;
    }
    expect(count).toBe(4);
  });
});
