// QV-1 — integrated quality-value scoring.
//
// The evidence this implements is specific about details that look like
// pedantry and are not: the quality denominator, the refusal to rank on
// cheapness alone, and computing percentiles AFTER the universe filter.
// Each test below pins one of those.

import { describe, it, expect } from 'vitest';
import {
  grossProfitsToAssets,
  qualityFromMargin,
  percentileRank,
  scoreQualityValue,
  MIN_VALUE_INPUTS,
  type QVInput,
} from '../quality-value';

/** A scorable, policy-passing name. */
function name(t: string, over: Partial<QVInput> = {}): QVInput {
  return {
    ticker: t,
    marketCapM: 5_000,
    medianDollarVol: 20_000_000,
    price: 50,
    grossProfit: 300,
    totalAssets: 1_000,
    pe: 15,
    ps: 2,
    pb: 3,
    ...over,
  };
}

describe('gross profitability — the denominator is the point', () => {
  it('is gross profit over TOTAL ASSETS (Novy-Marx 2013)', () => {
    expect(grossProfitsToAssets(300, 1_000)).toBeCloseTo(0.30, 10);
  });

  it('is null unless BOTH inputs are real — not a weaker number, a different one', () => {
    expect(grossProfitsToAssets(300, null)).toBeNull();
    expect(grossProfitsToAssets(null, 1_000)).toBeNull();
    expect(grossProfitsToAssets(300, 0)).toBeNull();
    expect(grossProfitsToAssets(300, -50)).toBeNull();
  });

  it('refuses gross MARGIN as a substitute', () => {
    // Margin is GP/revenue; profitability is GP/assets. They differ by asset
    // turnover, which is exactly what the result rests on. HXZ found the
    // book-equity-denominated version FAILS replication while the
    // asset-denominated one survives even their q-factor model.
    expect(qualityFromMargin()).toBeNull();
  });
});

describe('percentileRank', () => {
  it('scores best = 1, worst = 0', () => {
    const p = percentileRank([10, 20, 30], true);
    expect(p[2]).toBe(1);
    expect(p[0]).toBe(0);
  });

  it('inverts for lower-is-better ratios', () => {
    const p = percentileRank([10, 20, 30], false);
    expect(p[0]).toBe(1);
    expect(p[2]).toBe(0);
  });

  it('gives tied inputs equal scores', () => {
    const p = percentileRank([5, 5, 1], true);
    expect(p[0]).toBe(p[1]);
    expect(p[2]).toBe(0);
  });

  it('passes nulls through as null rather than treating them as zero', () => {
    const p = percentileRank([10, null, 30], true);
    expect(p[1]).toBeNull();
    expect(p[0]).toBe(0);
    expect(p[2]).toBe(1);
  });

  it('handles a single scorable value without dividing by zero', () => {
    expect(percentileRank([42, null], true)).toEqual([1, null]);
  });
});

describe('scoreQualityValue', () => {
  it('ranks cheap AND profitable above cheap-only or profitable-only', () => {
    const res = scoreQualityValue([
      name('BOTH', { grossProfit: 500, totalAssets: 1000, pe: 8, ps: 1, pb: 1 }),
      name('CHEAPONLY', { grossProfit: 50, totalAssets: 1000, pe: 8, ps: 1, pb: 1 }),
      name('QUALONLY', { grossProfit: 500, totalAssets: 1000, pe: 40, ps: 9, pb: 9 }),
    ]);
    expect(res.scored[0].ticker).toBe('BOTH');
    const both = res.scored.find((s) => s.ticker === 'BOTH')!;
    const cheap = res.scored.find((s) => s.ticker === 'CHEAPONLY')!;
    const qual = res.scored.find((s) => s.ticker === 'QUALONLY')!;
    expect(both.composite!).toBeGreaterThan(cheap.composite!);
    expect(both.composite!).toBeGreaterThan(qual.composite!);
  });

  it('applies the universe policy BEFORE percentiling', () => {
    // If the microcap were percentiled in, it would occupy a rank slot and
    // shift every survivor's score against a name we cannot trade.
    const res = scoreQualityValue([
      name('BIG'),
      name('MICRO', { marketCapM: 90 }),
      name('OTHER', { pe: 30 }),
    ]);
    expect(res.excluded.MICRO).toBe('microcap');
    expect(res.scored.map((s) => s.ticker).sort()).toEqual(['BIG', 'OTHER']);
  });

  it('gives NO composite to a name scorable on only one axis', () => {
    // Ranking on cheapness alone is the Dreman failure mode — his fund held
    // Fannie, Freddie, Wachovia and WaMu into 2008 and lost 46%.
    const res = scoreQualityValue([
      name('OK'),
      name('NOQUAL', { grossProfit: null, totalAssets: null, roicPct: null }),
    ]);
    const noqual = res.scored.find((s) => s.ticker === 'NOQUAL')!;
    expect(noqual.composite).toBeNull();
    expect(res.unscorable.NOQUAL).toBe('no-quality');
  });

  it('needs at least two value ratios before trusting a value percentile', () => {
    expect(MIN_VALUE_INPUTS).toBe(2);
    const res = scoreQualityValue([
      name('OK'),
      name('THIN', { pe: 12, ps: null, pb: null, fcfYieldPct: null }),
    ]);
    const thin = res.scored.find((s) => s.ticker === 'THIN')!;
    expect(thin.valuePct).toBeNull();
    expect(thin.composite).toBeNull();
    expect(res.unscorable.THIN).toBe('no-value');
  });

  it('falls back to an ROIC proxy and REPORTS that it did', () => {
    const res = scoreQualityValue([
      name('REAL'),
      name('PROXY', { grossProfit: null, totalAssets: null, roicPct: 22 }),
    ]);
    const proxy = res.scored.find((s) => s.ticker === 'PROXY')!;
    expect(proxy.qualityBasis).toBe('roic-proxy');
    expect(proxy.gpToAssets).toBeNull();
    expect(res.qualityBasisCounts['gross-profits-to-assets']).toBe(1);
    expect(res.qualityBasisCounts['roic-proxy']).toBe(1);
  });

  it('never ranks a GP/A value against an ROIC value', () => {
    // Different units. Each basis is percentiled within its own cohort, so a
    // lone proxy name tops its cohort rather than being scored against
    // statement-derived profitability it cannot be compared to.
    const res = scoreQualityValue([
      name('A', { grossProfit: 100, totalAssets: 1000 }),
      name('B', { grossProfit: 900, totalAssets: 1000 }),
      name('P', { grossProfit: null, totalAssets: null, roicPct: 5 }),
    ]);
    const p = res.scored.find((s) => s.ticker === 'P')!;
    expect(p.qualityPct).toBe(1); // only member of the proxy cohort
    const a = res.scored.find((s) => s.ticker === 'A')!;
    const b = res.scored.find((s) => s.ticker === 'B')!;
    expect(b.qualityPct!).toBeGreaterThan(a.qualityPct!);
  });

  it('ignores non-positive ratios rather than scoring them as ultra-cheap', () => {
    // A negative P/E is not "cheaper than everything" — it is a loss-maker,
    // and sorting ascending would put it at the very top.
    const res = scoreQualityValue([
      name('LOSS', { pe: -5, ps: 1, pb: 1 }),
      name('CHEAP', { pe: 6, ps: 1, pb: 1 }),
      name('RICH', { pe: 60, ps: 8, pb: 8 }),
    ]);
    const loss = res.scored.find((s) => s.ticker === 'LOSS')!;
    const cheap = res.scored.find((s) => s.ticker === 'CHEAP')!;
    expect(cheap.valuePct!).toBeGreaterThanOrEqual(loss.valuePct!);
  });

  it('returns an empty result set rather than throwing on no input', () => {
    const res = scoreQualityValue([]);
    expect(res.scored).toEqual([]);
  });
});
