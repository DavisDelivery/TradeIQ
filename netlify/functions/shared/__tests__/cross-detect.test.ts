import { describe, it, expect } from 'vitest';
import { detectCrosses, toCrossRows, type CrossBar } from '../cross-detect';

const DAY = 86_400_000;
const T0 = Date.parse('2025-01-01T00:00:00Z');

/** Build bars from a close series, one bar per day starting at T0. */
const bars = (closes: number[]): CrossBar[] =>
  closes.map((c, i) => ({ t: T0 + i * DAY, c }));

/**
 * A series engineered to produce exactly one golden cross:
 * 250 flat bars at 100 (SMA50 == SMA200), then a strong ramp — SMA50
 * reacts first and crosses above SMA200.
 */
function goldenSeries() {
  const closes = Array(250).fill(100);
  for (let i = 0; i < 60; i++) closes.push(100 + (i + 1) * 2);
  return closes;
}

describe('detectCrosses', () => {
  it('finds a single golden cross when SMA50 crosses above SMA200', () => {
    const events = detectCrosses(bars(goldenSeries()));
    const golden = events.filter((e) => e.type === 'golden');
    expect(golden).toHaveLength(1);
    expect(golden[0].sma50).toBeGreaterThan(golden[0].sma200);
    // The cross must fire during the ramp, not the flat stretch.
    expect(Date.parse(golden[0].date)).toBeGreaterThan(T0 + 249 * DAY);
  });

  it('finds a death cross on the mirrored (declining) series', () => {
    const closes = Array(250).fill(100);
    for (let i = 0; i < 60; i++) closes.push(100 - (i + 1) * 1.5);
    const events = detectCrosses(bars(closes));
    const death = events.filter((e) => e.type === 'death');
    expect(death).toHaveLength(1);
    expect(death[0].sma50).toBeLessThan(death[0].sma200);
  });

  it('emits nothing for a monotonic series with no cross', () => {
    const closes = Array.from({ length: 320 }, (_, i) => 100 + i); // always rising: SMA50 > SMA200 throughout warmup exit
    const events = detectCrosses(bars(closes));
    expect(events).toHaveLength(0);
  });

  it('returns [] when history is too short for an SMA200 (recent IPO)', () => {
    expect(detectCrosses(bars(Array(150).fill(100)))).toHaveLength(0);
    expect(detectCrosses(bars(Array(200).fill(100)))).toHaveLength(0); // needs 201 (T-1 valid too)
  });

  it('sinceMs bounds the events but old bars still feed the SMAs', () => {
    const series = goldenSeries();
    const all = detectCrosses(bars(series));
    expect(all).toHaveLength(1);
    // Window starting AFTER the cross date excludes it…
    const afterCross = Date.parse(all[0].date) + DAY;
    expect(detectCrosses(bars(series), afterCross)).toHaveLength(0);
    // …window starting before it keeps it.
    expect(detectCrosses(bars(series), afterCross - 2 * DAY)).toHaveLength(1);
  });

  it('barsAgo counts completed bars since the cross (0 = tonight)', () => {
    const series = goldenSeries();
    const all = detectCrosses(bars(series));
    const crossIdx = series.length - 1 - all[0].barsAgo;
    // Truncate the series so the cross is the LAST bar: barsAgo becomes 0.
    const truncated = detectCrosses(bars(series.slice(0, crossIdx + 1)));
    expect(truncated).toHaveLength(1);
    expect(truncated[0].barsAgo).toBe(0);
    expect(truncated[0].date).toBe(all[0].date);
  });
});

describe('toCrossRows', () => {
  it('computes % move from the cross close to the latest close', () => {
    const series = goldenSeries();
    const b = bars(series);
    const events = detectCrosses(b);
    const rows = toCrossRows('AAPL', 'Apple Inc', 'Technology', b, events);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.ticker).toBe('AAPL');
    expect(r.lastClose).toBe(series[series.length - 1]);
    const expectedPct = ((r.lastClose - r.closeAtCross) / r.closeAtCross) * 100;
    expect(r.pctSinceCross).toBeCloseTo(expectedPct, 1);
  });
});
