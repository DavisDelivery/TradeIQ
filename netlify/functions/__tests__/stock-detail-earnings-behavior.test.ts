// PROFILE-1 W1.2 — earnings behaviour, and the AMC off-by-one it fixes.

import { describe, it, expect } from 'vitest';
import { priceReactionAround, buildEarningsBehavior } from '../stock-detail';
import type { Bar } from '../shared/data-provider';

const day = (ymd: string, c: number): Bar =>
  ({ t: Date.parse(`${ymd}T00:00:00Z`), o: c, h: c, l: c, c, v: 1_000_000 }) as Bar;

// D-1 = 100, D = 110, D+1 = 132.
//   BMO reporter: announces before D's open, market reacts on D  -> +10%
//   AMC reporter: announces after D's close, market reacts on D+1 -> +20%
// A straddle spanning D-1 -> D+1 captures either: +32%.
const bars: Bar[] = [
  day('2026-05-04', 96),
  day('2026-05-05', 100), // D-1
  day('2026-05-06', 110), // D  (announcement date)
  day('2026-05-07', 132), // D+1
  day('2026-05-08', 130),
];

describe('priceReactionAround — session-agnostic straddle', () => {
  it('spans D-1 to D+1, so it contains the move under either session', () => {
    // The old implementation returned close[D-1]->close[D] = +10%, which is
    // the BMO answer. For an AMC reporter the real reaction is the +20% on
    // D+1 and the old number described the day BEFORE it.
    expect(priceReactionAround('2026-05-06', bars)).toBeCloseTo(32, 1);
  });

  it('is NOT the old BMO-only figure', () => {
    // Guards the regression directly: 10.0 was the previous output.
    expect(priceReactionAround('2026-05-06', bars)).not.toBeCloseTo(10, 1);
  });

  it('anchors on the first bar at or after the announcement date', () => {
    // Announced on a Saturday; the market opens Monday. The straddle should
    // still resolve around the first trading bar on/after that date.
    const weekend = [day('2026-05-01', 50), day('2026-05-04', 55), day('2026-05-05', 66)];
    expect(priceReactionAround('2026-05-02', weekend)).toBeCloseTo(32, 1);
  });

  it('returns null when there is no bar after the print', () => {
    // The most recent quarter, before the reaction has happened. Null, not 0.
    expect(priceReactionAround('2026-05-08', bars)).toBeNull();
  });

  it('returns null when there is no bar before the print', () => {
    expect(priceReactionAround('2026-05-04', bars)).toBeNull();
  });

  it('returns null rather than dividing by a non-positive close', () => {
    const bad = [day('2026-05-05', 0), day('2026-05-06', 10), day('2026-05-07', 12)];
    expect(priceReactionAround('2026-05-06', bad)).toBeNull();
  });
});

describe('buildEarningsBehavior', () => {
  const q = (period: string, announceDate: string | null, epsActual: number, epsEstimate: number) =>
    ({ period, announceDate, epsActual, epsEstimate });

  it('returns every quarter, newest first', () => {
    const out = buildEarningsBehavior(
      [q('2026-03-31', '2026-05-06', 1.2, 1.0), q('2025-12-31', '2026-02-04', 0.9, 1.0)],
      bars,
    )!;
    expect(out.quarters.map((x) => x.period)).toEqual(['2026-03-31', '2025-12-31']);
    expect(out.total).toBe(2);
  });

  it('computes the surprise when the vendor omits it', () => {
    const out = buildEarningsBehavior([q('2026-03-31', '2026-05-06', 1.2, 1.0)], bars)!;
    expect(out.quarters[0].surprisePct).toBeCloseTo(20, 1);
  });

  it('prefers the vendor surprise when present', () => {
    const out = buildEarningsBehavior(
      [{ ...q('2026-03-31', '2026-05-06', 1.2, 1.0), surprisePct: 17.5 }],
      bars,
    )!;
    expect(out.quarters[0].surprisePct).toBeCloseTo(17.5, 1);
  });

  it('keeps EPS but nulls the reaction for an unanchored quarter', () => {
    // A period-end window measures a random two-day move about a month from
    // the print, so it degrades rather than guessing.
    const out = buildEarningsBehavior([q('2026-03-31', null, 1.2, 1.0)], bars)!;
    expect(out.quarters[0].epsActual).toBe(1.2);
    expect(out.quarters[0].reactionPct).toBeNull();
    expect(out.measured).toBe(0);
  });

  it('reports measured vs total so blank quarters are visible', () => {
    const out = buildEarningsBehavior(
      [q('2026-03-31', '2026-05-06', 1.2, 1.0), q('2025-12-31', null, 0.9, 1.0)],
      bars,
    )!;
    expect(out.measured).toBe(1);
    expect(out.total).toBe(2);
  });

  it('averages the ABSOLUTE move, so a crash and a rally do not cancel', () => {
    const b = [
      day('2026-01-05', 100), day('2026-01-06', 100), day('2026-01-07', 120), // +20
      day('2026-02-04', 100), day('2026-02-05', 100), day('2026-02-06', 80),  // -20
    ];
    const out = buildEarningsBehavior(
      [q('2026-01-06', '2026-01-06', 1, 1), q('2026-02-05', '2026-02-05', 1, 1)],
      b,
    )!;
    expect(out.avgAbsMovePct).toBeCloseTo(20, 1);
  });

  it('reports the worst move SIGNED, not as a magnitude', () => {
    const b = [
      day('2026-01-05', 100), day('2026-01-06', 100), day('2026-01-07', 105), // +5
      day('2026-02-04', 100), day('2026-02-05', 100), day('2026-02-06', 70),  // -30
    ];
    const out = buildEarningsBehavior(
      [q('2026-01-06', '2026-01-06', 1, 1), q('2026-02-05', '2026-02-05', 1, 1)],
      b,
    )!;
    // -30 is the worst; reporting +30 would invert the direction of the risk.
    expect(out.worstMovePct).toBeCloseTo(-30, 1);
  });

  it('nulls the aggregates rather than emitting 0 when nothing is measurable', () => {
    const out = buildEarningsBehavior([q('2026-03-31', null, 1.2, 1.0)], bars)!;
    expect(out.avgAbsMovePct).toBeNull();
    expect(out.worstMovePct).toBeNull();
  });

  it('returns null for no earnings at all', () => {
    expect(buildEarningsBehavior([], bars)).toBeNull();
  });

  it('never emits a non-finite number', () => {
    const out = buildEarningsBehavior(
      [q('2026-03-31', '2026-05-06', Number.NaN, 0)],
      bars,
    )!;
    expect(out.quarters[0].epsActual).toBeNull();
    expect(out.quarters[0].surprisePct).toBeNull();
    for (const v of [out.avgAbsMovePct, out.worstMovePct]) {
      if (v !== null) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
