// PROFILE-1 W1.1 / W1.3 — shaping the Finviz row for the profile.

import { describe, it, expect } from 'vitest';
import { shapeFinvizRow, ratio } from '../finviz-row';
import type { FinvizRow } from '../finviz';

const row = (over: Partial<FinvizRow> = {}): FinvizRow =>
  ({
    ticker: 'AAPL', sector: 'Technology',
    price: 200, avgVolume: 50_000_000, relVolume: 1.3, atr: 4.5, floatM: 15_000,
    instOwnPct: 61.2, insiderOwnPct: 0.07, insiderTransPct: -1.4,
    shortFloatPct: 0.9, shortRatio: 1.8,
    epsGrowthPast5YPct: 15.1, epsGrowthThisYearPct: 9.2, epsGrowthNextYearPct: 11.4,
    epsGrowthNext5YPct: 8.8, epsGrowthQoQPct: 12.0, salesGrowthQoQPct: 4.9,
    analystRecom: 1.9, targetPrice: 250,
    earningsDate: '2026-05-06', earningsSession: 'amc',
    ...over,
  }) as FinvizRow;

describe('tradability derivations', () => {
  it('computes ADV$ as average volume x price', () => {
    const b = shapeFinvizRow(row()).tradability;
    expect(b.advDollar).toBeCloseTo(50_000_000 * 200, 0);
  });

  it('computes ATR as a PERCENT of price', () => {
    // A $4.50 ATR means nothing without knowing the stock is $200, not $20.
    const b = shapeFinvizRow(row()).tradability;
    expect(b.atrPct).toBeCloseTo(2.25, 6);
  });

  it('passes float and relative volume straight through', () => {
    const b = shapeFinvizRow(row()).tradability;
    expect(b.floatM).toBe(15_000);
    expect(b.relativeVolume).toBe(1.3);
  });

  it('nulls the derivations rather than dividing by a missing price', () => {
    const b = shapeFinvizRow(row({ price: null })).tradability;
    expect(b.advDollar).toBeNull();
    expect(b.atrPct).toBeNull();
    expect(b.atr).toBe(4.5); // the raw column survives
  });

  it('nulls ATR% on a zero price rather than emitting Infinity', () => {
    // JSON.stringify(Infinity) is null, so an infinite value would reach the
    // client as "no data" — the loudest reading turned into silence.
    const b = shapeFinvizRow(row({ price: 0 })).tradability;
    expect(b.atrPct).toBeNull();
  });
});

describe('ownership and short structure', () => {
  it('carries days-to-cover alongside short float', () => {
    // Short interest ALONE lost significance after 2000; the liquidity-scaled
    // form is what survived, so the pair must travel together.
    const b = shapeFinvizRow(row()).ownership;
    expect(b.shortFloatPct).toBe(0.9);
    expect(b.shortRatio).toBe(1.8);
  });

  it('preserves a NEGATIVE insider-transaction percentage', () => {
    // Net selling is the signal-bearing case; clamping or absolute-valuing
    // it would erase the direction.
    expect(shapeFinvizRow(row({ insiderTransPct: -12.5 })).ownership.insiderTransPct).toBe(-12.5);
  });

  it('keeps a genuine zero distinct from a missing value', () => {
    expect(shapeFinvizRow(row({ shortFloatPct: 0 })).ownership.shortFloatPct).toBe(0);
    expect(shapeFinvizRow(row({ shortFloatPct: null })).ownership.shortFloatPct).toBeNull();
  });
});

describe('analyst block', () => {
  it('computes implied upside from target and price', () => {
    expect(shapeFinvizRow(row()).analyst.impliedUpsidePct).toBeCloseTo(25, 6);
  });

  it('computes a NEGATIVE implied upside when the target is below price', () => {
    const a = shapeFinvizRow(row({ targetPrice: 150 })).analyst;
    expect(a.impliedUpsidePct).toBeCloseTo(-25, 6);
  });

  it('nulls implied upside when either side is missing', () => {
    expect(shapeFinvizRow(row({ targetPrice: null })).analyst.impliedUpsidePct).toBeNull();
    expect(shapeFinvizRow(row({ price: null })).analyst.impliedUpsidePct).toBeNull();
  });

  it('carries the recommendation on Finviz\'s own 1-5 scale', () => {
    // 1.0 strong buy … 5.0 strong sell. Not rescaled or inverted here —
    // any flip belongs at the render site, once, with a label.
    expect(shapeFinvizRow(row()).analyst.recom).toBe(1.9);
  });
});

describe('growth and events', () => {
  it('carries the whole EPS ladder plus sales QoQ', () => {
    const g = shapeFinvizRow(row()).growth;
    expect(g).toEqual({
      epsPast5YPct: 15.1, epsThisYearPct: 9.2, epsNextYearPct: 11.4,
      epsNext5YPct: 8.8, epsQoQPct: 12.0, salesQoQPct: 4.9,
    });
  });

  it('carries the vendor earnings date and session', () => {
    const b = shapeFinvizRow(row());
    expect(b.earningsDate).toBe('2026-05-06');
    expect(b.earningsSession).toBe('amc');
  });

  it('nulls the session when the vendor omits it', () => {
    expect(shapeFinvizRow(row({ earningsSession: null })).earningsSession).toBeNull();
  });
});

describe('an all-null row produces all nulls, never zeros', () => {
  it('shapes cleanly', () => {
    const empty = shapeFinvizRow({ ticker: 'X' } as FinvizRow);
    for (const v of Object.values(empty.tradability)) expect(v).toBeNull();
    for (const v of Object.values(empty.ownership)) expect(v).toBeNull();
    for (const v of Object.values(empty.growth)) expect(v).toBeNull();
    expect(empty.analyst.impliedUpsidePct).toBeNull();
  });

  it('never emits NaN or Infinity anywhere', () => {
    const shaped = shapeFinvizRow(row({ price: 0, avgVolume: Number.NaN, atr: Infinity }));
    const walk = (o: unknown) => {
      if (typeof o === 'number') expect(Number.isFinite(o)).toBe(true);
      else if (o && typeof o === 'object') Object.values(o).forEach(walk);
    };
    walk(shaped);
    expect(JSON.stringify(shaped)).not.toMatch(/NaN|Infinity/);
  });
});

describe('ratio', () => {
  it('refuses a zero or negative base', () => {
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(1, -2)).toBeNull();
  });

  it('refuses a missing side', () => {
    expect(ratio(null, 2)).toBeNull();
    expect(ratio(1, null)).toBeNull();
  });

  it('divides when both sides are real', () => {
    expect(ratio(4.5, 200)).toBeCloseTo(0.0225, 8);
  });
});
