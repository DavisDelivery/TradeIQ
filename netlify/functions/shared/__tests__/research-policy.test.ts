// RESEARCH-POLICY-1 — the standing rules, pinned.
//
// These encode owner decisions with measured justifications behind them. A
// test failure here means someone loosened a rule that exists because the
// literature says loosening it produces numbers that do not survive contact
// with real money.

import { describe, it, expect } from 'vitest';
import {
  MIN_MARKET_CAP_M,
  MIN_MEDIAN_DOLLAR_VOL,
  MIN_PRICE,
  exclusionReason,
  applyUniversePolicy,
  HAIRCUT_SURVIVAL,
  haircutExcess,
  haircutLabel,
  MIN_DISCOVERY_T,
  clearsDiscoveryBar,
  discoveryVerdict,
  costTier,
  ROUND_TRIP_BPS,
} from '../research-policy';

const ok = { ticker: 'OK', marketCapM: 2_000, medianDollarVol: 25_000_000, price: 40 };

describe('universe policy — no microcaps, all of the Russell', () => {
  it('keeps a liquid small cap: the Russell body is IN', () => {
    // ~$600M, $8M/day — a typical Russell 2000 constituent, not a microcap.
    expect(exclusionReason({ ticker: 'SML', marketCapM: 600, medianDollarVol: 8_000_000, price: 22 })).toBeNull();
  });

  it('excludes microcaps — where the anomaly literature\'s apparent edges live', () => {
    expect(exclusionReason({ ticker: 'MIC', marketCapM: 120, medianDollarVol: 9_000_000, price: 12 })).toBe('microcap');
  });

  it('excludes an illiquid name even when its market cap passes', () => {
    // $400M cap but $200k/day — cannot absorb an order without moving.
    expect(exclusionReason({ ticker: 'THIN', marketCapM: 400, medianDollarVol: 200_000, price: 18 })).toBe('illiquid');
  });

  it('excludes sub-$5 names', () => {
    expect(exclusionReason({ ticker: 'PNY', marketCapM: 900, medianDollarVol: 20_000_000, price: 3.2 })).toBe('price-floor');
  });

  it('MISSING DATA EXCLUDES — an unknown cap is not assumed large', () => {
    // This is the rule that keeps the universe label true: assuming absent
    // means acceptable is exactly how a microcap enters a "no microcap" set.
    expect(exclusionReason({ ticker: 'NA1', marketCapM: null, medianDollarVol: 9e6, price: 20 })).toBe('no-data');
    expect(exclusionReason({ ticker: 'NA2', marketCapM: 900, medianDollarVol: null, price: 20 })).toBe('no-data');
    expect(exclusionReason({ ticker: 'NA3', marketCapM: 900, medianDollarVol: 9e6, price: null })).toBe('no-data');
  });

  it('reports every exclusion by reason, so a screen can say what it dropped', () => {
    const res = applyUniversePolicy([
      ok,
      { ticker: 'MIC', marketCapM: 100, medianDollarVol: 9e6, price: 10 },
      { ticker: 'THIN', marketCapM: 900, medianDollarVol: 100_000, price: 10 },
      { ticker: 'PNY', marketCapM: 900, medianDollarVol: 9e6, price: 2 },
      { ticker: 'NA', marketCapM: null, medianDollarVol: null, price: null },
    ]);
    expect(res.kept.map((k) => k.ticker)).toEqual(['OK']);
    expect(res.excluded).toEqual({ MIC: 'microcap', THIN: 'illiquid', PNY: 'price-floor', NA: 'no-data' });
    expect(res.counts).toEqual({ microcap: 1, illiquid: 1, 'price-floor': 1, 'no-data': 1 });
  });

  it('the floors are the ratified values', () => {
    expect(MIN_MARKET_CAP_M).toBe(300);
    expect(MIN_MEDIAN_DOLLAR_VOL).toBe(3_000_000);
    expect(MIN_PRICE).toBe(5);
  });
});

describe('backtest haircut', () => {
  it('halves a positive edge', () => {
    expect(HAIRCUT_SURVIVAL).toBe(0.5);
    expect(haircutExcess(20)).toBe(10);
  });

  it('does NOT halve a loss — pessimism is not flattered', () => {
    // Halving −74pp to −37pp would understate a measured failure. The
    // asymmetry is deliberate: discount optimism only.
    expect(haircutExcess(-74.2)).toBe(-74.2);
  });

  it('names the haircut in the label so a reader cannot mistake it for raw', () => {
    expect(haircutLabel(20)).toBe('+10.0pp (50% haircut)');
    expect(haircutLabel(-74.2)).toBe('−74.2pp');
    expect(haircutLabel(null)).toBe('not measured');
  });
});

describe('discovery bar', () => {
  it('requires |t| >= 3', () => {
    expect(MIN_DISCOVERY_T).toBe(3);
    expect(clearsDiscoveryBar(3.1)).toBe(true);
    expect(clearsDiscoveryBar(-3.4)).toBe(true);
    expect(clearsDiscoveryBar(2.5)).toBe(false);
  });

  it('an unmeasured effect does NOT pass by default', () => {
    // The lynch row shipped a bare IC of 0.0011 for months because nothing
    // forced the question "compared to what error?".
    expect(clearsDiscoveryBar(null)).toBe(false);
    expect(clearsDiscoveryBar(undefined)).toBe(false);
    expect(clearsDiscoveryBar(NaN)).toBe(false);
    expect(discoveryVerdict(null)).toMatch(/NOT MEASURED/);
  });

  it('calls out the t>2 danger zone by name rather than just failing it', () => {
    expect(discoveryVerdict(2.4)).toMatch(/BELOW BAR/);
    expect(discoveryVerdict(2.4)).toMatch(/mining/);
    expect(discoveryVerdict(0.8)).toMatch(/NO EVIDENCE/);
    expect(discoveryVerdict(4.1)).toMatch(/CLEARS BAR/);
  });
});

describe('costs', () => {
  it('charges small caps more, because that is where the spread is', () => {
    expect(ROUND_TRIP_BPS.smallCap).toBeGreaterThan(ROUND_TRIP_BPS.largeCap);
    expect(costTier(50_000)).toBe('largeCap');
    expect(costTier(800)).toBe('smallCap');
  });

  it('treats an unknown cap as small — the conservative direction', () => {
    expect(costTier(null)).toBe('smallCap');
  });
});
