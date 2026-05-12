import { describe, it, expect } from 'vitest';
import { __test_aggregate } from '../components/AttributionChart.jsx';

// Phase 4b — pin the per-analyst aggregation contract.
//
// For each attribution row, we find the layer with the highest score
// at entry, then sum the row's `contribution` into that analyst's
// bucket. Rows without a finite top-layer score or contribution are
// skipped. Output is sorted descending by contributionPct (which is
// sum * 100). This is the methodology Chad will eyeball before Phase 5
// recalibrates weights, so it has to be right.

describe('AttributionChart aggregation', () => {
  it('attributes each row to the layer with the highest score at entry', () => {
    const rows = [
      // momentum highest
      { layers: { momentum: 90, fundamental: 40 }, contribution: 0.01 },
      // fundamental highest
      { layers: { momentum: 30, fundamental: 80 }, contribution: -0.005 },
      // momentum again
      { layers: { momentum: 70, fundamental: 60 }, contribution: 0.02 },
    ];
    const out = __test_aggregate(rows);
    // momentum: 0.01 + 0.02 = 0.03 → 3.000%
    // fundamental: -0.005 → -0.500%
    expect(out.find((r) => r.analyst === 'momentum')?.contributionPct).toBeCloseTo(3.0, 3);
    expect(out.find((r) => r.analyst === 'fundamental')?.contributionPct).toBeCloseTo(-0.5, 3);
  });

  it('sorts output by contributionPct descending', () => {
    const rows = [
      { layers: { a: 90 }, contribution: -0.05 },
      { layers: { b: 90 }, contribution: 0.10 },
      { layers: { c: 90 }, contribution: 0.02 },
    ];
    const out = __test_aggregate(rows);
    expect(out.map((r) => r.analyst)).toEqual(['b', 'c', 'a']);
  });

  it('skips rows with no layers', () => {
    const rows = [
      { layers: {}, contribution: 0.01 },
      { layers: { momentum: 70 }, contribution: 0.02 },
    ];
    const out = __test_aggregate(rows);
    expect(out).toHaveLength(1);
    expect(out[0].analyst).toBe('momentum');
  });

  it('skips rows with non-finite contribution', () => {
    const rows = [
      { layers: { momentum: 70 }, contribution: NaN },
      { layers: { momentum: 70 }, contribution: null },
      { layers: { momentum: 70 }, contribution: 0.01 },
    ];
    const out = __test_aggregate(rows);
    expect(out).toHaveLength(1);
    expect(out[0].contributionPct).toBeCloseTo(1.0, 3);
  });

  it('returns empty array on empty or missing input', () => {
    expect(__test_aggregate([])).toEqual([]);
    expect(__test_aggregate(null)).toEqual([]);
    expect(__test_aggregate(undefined)).toEqual([]);
  });

  it('handles the real Phase 4a layer set from the smoke-test fixture', () => {
    // Layer names from bt_20260511155722_eg0gv5 attribution[0].
    const rows = [
      {
        layers: {
          structure: 90, momentum: 40, volume: 75, volatility: 95,
          relativeStrength: 78, fundamental: 0, catalyst: 38.54,
        },
        contribution: -0.0034,
      },
      {
        layers: {
          structure: 60, momentum: 85, volume: 50, volatility: 30,
          relativeStrength: 70, fundamental: 20, catalyst: 10,
        },
        contribution: 0.005,
      },
    ];
    const out = __test_aggregate(rows);
    // First row's top layer is volatility (95); second row's top is momentum (85).
    expect(out.find((r) => r.analyst === 'volatility')?.contributionPct).toBeCloseTo(-0.34, 2);
    expect(out.find((r) => r.analyst === 'momentum')?.contributionPct).toBeCloseTo(0.5, 2);
  });
});
