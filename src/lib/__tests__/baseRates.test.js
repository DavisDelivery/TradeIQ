// DESK-1 W4 — base-rate math tests: expectancy, the insufficient-sample
// gate, grouping, ticker record, and R-multiples.

import { describe, it, expect } from 'vitest';
import {
  isClosed, tradeReturnPct, computeBaseRate, baseRatesBySetup,
  baseRatesByBoard, tickerRecord, rMultiple, MIN_SAMPLE,
} from '../baseRates.js';

const closed = (ticker, entry, exit, over = {}) => ({
  id: `${ticker}-${Math.random()}`,
  ticker,
  loggedPrice: entry,
  loggedAt: '2026-01-01T00:00:00.000Z',
  exitPrice: exit,
  exitAt: over.exitAt ?? '2026-02-01T00:00:00.000Z',
  ...over,
});

describe('isClosed / tradeReturnPct', () => {
  it('closed requires BOTH exitPrice and exitAt', () => {
    expect(isClosed(closed('A', 100, 110))).toBe(true);
    expect(isClosed({ loggedPrice: 100, exitPrice: 110 })).toBe(false);
    expect(isClosed({ loggedPrice: 100, exitAt: '2026-01-01' })).toBe(false);
    expect(isClosed({ loggedPrice: 100 })).toBe(false);
  });

  it('return % is signed and entry-relative', () => {
    expect(tradeReturnPct(closed('A', 100, 110))).toBeCloseTo(10, 10);
    expect(tradeReturnPct(closed('A', 100, 85))).toBeCloseTo(-15, 10);
    expect(tradeReturnPct({ ...closed('A', 0, 110) })).toBeNull(); // unusable entry
  });
});

describe('computeBaseRate', () => {
  it('computes n, win%, avgWin, avgLoss, expectancy on a known fixture', () => {
    // 3 wins (+10, +20, +30 → avg +20), 2 losses (−10, −20 → avg −15)
    const trades = [
      closed('A', 100, 110), closed('B', 100, 120), closed('C', 100, 130),
      closed('D', 100, 90), closed('E', 100, 80),
    ];
    const r = computeBaseRate(trades);
    expect(r.n).toBe(5);
    expect(r.winRate).toBeCloseTo(0.6, 10);
    expect(r.avgWinPct).toBeCloseTo(20, 10);
    expect(r.avgLossPct).toBeCloseTo(-15, 10);
    // expectancy = 0.6*20 − 0.4*15 = 12 − 6 = 6
    expect(r.expectancy).toBeCloseTo(6, 10);
    expect(r.insufficientSample).toBe(false);
  });

  it('gates n < MIN_SAMPLE as insufficient — a 2-trade rate is noise', () => {
    const r = computeBaseRate([closed('A', 100, 150), closed('B', 100, 140)]);
    expect(r.n).toBe(2);
    expect(r.winRate).toBe(1);
    expect(r.insufficientSample).toBe(true);
    expect(MIN_SAMPLE).toBe(5);
  });

  it('all-win group: avgLoss null, expectancy still defined', () => {
    const r = computeBaseRate(Array.from({ length: 6 }, (_, i) => closed(`T${i}`, 100, 110)));
    expect(r.avgLossPct).toBeNull();
    expect(r.expectancy).toBeCloseTo(10, 10);
    expect(r.insufficientSample).toBe(false);
  });

  it('lastTen is a W/L strip, most recent exit first, capped at 10', () => {
    const trades = Array.from({ length: 12 }, (_, i) =>
      closed(`T${i}`, 100, i % 2 === 0 ? 110 : 90, {
        exitAt: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      }));
    const r = computeBaseRate(trades);
    expect(r.lastTen).toHaveLength(10);
    // i=11 (loss) is the most recent exit
    expect(r.lastTen[0]).toBe('L');
    expect(r.lastTen[1]).toBe('W');
  });

  it('returns null with zero usable closed trades', () => {
    expect(computeBaseRate([])).toBeNull();
    expect(computeBaseRate([{ ticker: 'A', loggedPrice: 100 }])).toBeNull(); // open
  });
});

describe('grouping', () => {
  const trades = [
    closed('A', 100, 120, { setup: 'breakout', source: 'board' }),
    closed('B', 100, 90, { setup: 'breakout', source: 'board' }),
    closed('C', 100, 105, { setup: 'pead', source: 'earnings' }),
    closed('D', 100, 111, { source: 'earnings' }),          // untagged setup
    { id: 'open-1', ticker: 'E', loggedPrice: 100, setup: 'breakout' }, // OPEN — excluded
  ];

  it('groups by setup tag; open trades never contaminate; untagged bucketed', () => {
    const rows = baseRatesBySetup(trades);
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(['(untagged)', 'breakout', 'pead']);
    const breakout = rows.find((r) => r.key === 'breakout');
    expect(breakout.n).toBe(2); // the open E trade is NOT counted
    expect(breakout.insufficientSample).toBe(true);
  });

  it('groups by board/source', () => {
    const rows = baseRatesByBoard(trades);
    const earnings = rows.find((r) => r.key === 'earnings');
    expect(earnings.n).toBe(2);
  });
});

describe('tickerRecord', () => {
  it('summarizes closed trades on one ticker (n, win%, net pp)', () => {
    const trades = [
      closed('NVDA', 100, 110),
      closed('NVDA', 100, 95),
      closed('AMD', 100, 130),
      { id: 'open', ticker: 'NVDA', loggedPrice: 100 },
    ];
    const r = tickerRecord(trades, 'NVDA');
    expect(r.n).toBe(2);
    expect(r.winRate).toBeCloseTo(0.5, 10);
    expect(r.netPct).toBeCloseTo(5, 10); // +10 − 5
  });

  it('null when the ticker has no closed trades', () => {
    expect(tickerRecord([{ ticker: 'NVDA', loggedPrice: 100 }], 'NVDA')).toBeNull();
    expect(tickerRecord([], 'NVDA')).toBeNull();
  });
});

describe('rMultiple', () => {
  it('(mark − entry) / (entry − stop)', () => {
    expect(rMultiple(100, 95, 110)).toBeCloseTo(2, 10);
    expect(rMultiple(100, 95, 92.5)).toBeCloseTo(-1.5, 10);
  });

  it('null without a valid stop below entry', () => {
    expect(rMultiple(100, null, 110)).toBeNull();
    expect(rMultiple(100, 100, 110)).toBeNull(); // zero risk
    expect(rMultiple(100, 105, 110)).toBeNull(); // stop above entry (not long-risk)
  });
});
