// Phase 4f W4b — unusual options activity compute tests.

import { describe, expect, it } from 'vitest';
import {
  computeOptionsFlowSignal,
  countBlocks,
  countOiSpikes,
  countSweeps,
  premiumOf,
} from '../options-unusual';
import type {
  OptionStrikeOI,
  OptionsTickWindow,
  PolygonOptionsTrade,
} from '../types';

function optTrade(
  side: 'C' | 'P',
  premium: number,
  contracts: number,
  opts: Partial<PolygonOptionsTrade> = {},
): PolygonOptionsTrade {
  return {
    t: 0,
    p: premium,
    s: contracts,
    side,
    strike: 100,
    expiry: '2024-07-19',
    ...opts,
  };
}

function oi(
  strike: number,
  side: 'C' | 'P',
  today: number,
  prev: number,
): OptionStrikeOI {
  return {
    strike,
    side,
    expiry: '2024-07-19',
    openInterestToday: today,
    openInterestPrev: prev,
  };
}

describe('helpers', () => {
  it('premiumOf multiplies by 100 (CBOE contract)', () => {
    expect(premiumOf(optTrade('C', 1.5, 10))).toBe(1500);
  });
  it('countSweeps requires exchanges >= 3', () => {
    expect(
      countSweeps([
        optTrade('C', 1, 1, { exchanges: 1 }),
        optTrade('C', 1, 1, { exchanges: 3 }),
        optTrade('C', 1, 1, { exchanges: 5 }),
      ]),
    ).toBe(2);
  });
  it('countBlocks requires premium ≥ $500K', () => {
    expect(
      countBlocks([
        optTrade('C', 5, 1000), // $500K — exactly threshold
        optTrade('C', 4.99, 1000), // just under
        optTrade('P', 100, 100), // $1M
      ]),
    ).toBe(2);
  });
  it('countOiSpikes flags strikes with OI growth > 50%', () => {
    expect(
      countOiSpikes([
        oi(100, 'C', 200, 100), // +100% → spike
        oi(110, 'C', 140, 100), // +40% → not a spike
        oi(120, 'C', 151, 100), // +51% → spike
      ]),
    ).toBe(2);
  });
});

describe('computeOptionsFlowSignal', () => {
  function w(trades: PolygonOptionsTrade[], openInterest: OptionStrikeOI[] = []): OptionsTickWindow {
    return { trades, openInterest };
  }

  it('zero activity → neutral score and zero buckets', () => {
    const out = computeOptionsFlowSignal({
      ticker: 'AAPL',
      asOfDate: '2024-06-30',
      window: w([]),
    });
    expect(out.bullishPremium).toBe(0);
    expect(out.bearishPremium).toBe(0);
    expect(out.sweepCount).toBe(0);
    expect(out.blockCount).toBe(0);
    expect(out.oiSpikeStrikes).toBe(0);
    // Neutral direction sub-score = 50, flow_intensity = 0, oi_intensity = 0
    // → (50 + 0 + 0) / 3 = 16.67
    expect(out.unusualScore).toBeCloseTo((50 + 0 + 0) / 3, 1);
  });

  it('calls-bought at-or-above-ask → bullish', () => {
    const out = computeOptionsFlowSignal({
      ticker: 'AAPL',
      asOfDate: '2024-06-30',
      window: w([
        optTrade('C', 2, 100, { bid: 1.95, ask: 2.0 }),
        optTrade('C', 2.1, 200, { bid: 1.95, ask: 2.0 }),
      ]),
    });
    expect(out.bullishPremium).toBeGreaterThan(0);
    expect(out.bearishPremium).toBe(0);
    expect(out.netDirectionalPremium).toBe(out.bullishPremium);
  });

  it('puts-bought at-or-above-ask → bearish', () => {
    const out = computeOptionsFlowSignal({
      ticker: 'AAPL',
      asOfDate: '2024-06-30',
      window: w([optTrade('P', 3, 100, { bid: 2.9, ask: 3.0 })]),
    });
    expect(out.bearishPremium).toBe(3 * 100 * 100);
    expect(out.bullishPremium).toBe(0);
  });

  it('mid-spread fills split bull/bear evenly', () => {
    const out = computeOptionsFlowSignal({
      ticker: 'AAPL',
      asOfDate: '2024-06-30',
      window: w([optTrade('C', 1.975, 100, { bid: 1.95, ask: 2.0 })]),
    });
    expect(out.bullishPremium).toBeCloseTo(1.975 * 100 * 100 / 2, 2);
    expect(out.bearishPremium).toBeCloseTo(out.bullishPremium, 2);
  });

  it('high-premium bullish sweeps + OI spikes push unusualScore > 70', () => {
    const trades: PolygonOptionsTrade[] = [];
    for (let i = 0; i < 10; i++) {
      trades.push(optTrade('C', 10, 1000, { bid: 9.95, ask: 10, exchanges: 4 }));
    }
    // Add OI spikes to lift the third score component above zero.
    const oiSpikes = [
      oi(100, 'C', 300, 100),
      oi(110, 'C', 200, 50),
      oi(120, 'C', 400, 100),
    ];
    const out = computeOptionsFlowSignal({
      ticker: 'AAPL',
      asOfDate: '2024-06-30',
      window: w(trades, oiSpikes),
    });
    expect(out.unusualScore).toBeGreaterThan(70);
    expect(out.sweepCount).toBe(10);
    expect(out.blockCount).toBe(10);
  });

  it('oi-spike strikes contribute to score', () => {
    const out = computeOptionsFlowSignal({
      ticker: 'AAPL',
      asOfDate: '2024-06-30',
      window: w(
        [],
        [oi(100, 'C', 200, 100), oi(110, 'P', 300, 50), oi(120, 'C', 500, 100)],
      ),
    });
    expect(out.oiSpikeStrikes).toBe(3);
    // oi_intensity = 30 → component of average.
    expect(out.unusualScore).toBeGreaterThan(16.7); // > neutral baseline
  });
});
