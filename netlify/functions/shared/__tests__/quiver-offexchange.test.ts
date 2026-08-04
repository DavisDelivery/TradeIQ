import { describe, expect, it } from 'vitest';
import {
  BASELINE_DAYS,
  MIN_DAYS,
  RECENT_DAYS,
  Z_CLIP,
  computeOffExchange,
  normaliseRows,
  type OffExchangeRow,
} from '../quiver-offexchange';

/** Build a flat series of `n` days ending 2026-08-03, with a fixed volume. */
function flat(n: number, otcTotal = 100_000, dpi = 0.5): any[] {
  const out: any[] = [];
  const start = Date.UTC(2026, 7, 3) - (n - 1) * 86_400_000;
  for (let i = 0; i < n; i++) {
    out.push({
      Ticker: 'TEST',
      Date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      OTC_Total: otcTotal,
      OTC_Short: Math.round(otcTotal * dpi),
      DPI: dpi,
    });
  }
  return out;
}

describe('normaliseRows', () => {
  it('parses the live Quiver row shape', () => {
    const rows = normaliseRows([
      { Ticker: 'CROX', Date: '2026-08-03', OTC_Short: 334005, OTC_Total: 470914, DPI: 0.7092697418267175 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: '2026-08-03', otcShort: 334005, otcTotal: 470914 });
    expect(rows[0].dpi).toBeCloseTo(0.70927, 5);
  });

  it('accepts stringified numerics — Quiver has shipped both', () => {
    const rows = normaliseRows([{ Date: '2026-08-03', OTC_Short: '100', OTC_Total: '400' }]);
    expect(rows[0].otcTotal).toBe(400);
    expect(rows[0].dpi).toBeCloseTo(0.25, 6);
  });

  it('DROPS rows with no volume rather than zero-filling them', () => {
    // A zero-volume day that never happened would deflate the baseline mean
    // and inflate every subsequent z-score.
    const rows = normaliseRows([
      { Date: '2026-08-01', OTC_Total: 0, OTC_Short: 0 },
      { Date: '2026-08-02', OTC_Total: null, OTC_Short: 5 },
      { Date: '2026-08-03', OTC_Total: 100, OTC_Short: 50 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-08-03');
  });

  it('sorts ascending regardless of the order Quiver returns', () => {
    const rows = normaliseRows([
      { Date: '2026-08-03', OTC_Total: 3, OTC_Short: 1 },
      { Date: '2026-08-01', OTC_Total: 1, OTC_Short: 1 },
      { Date: '2026-08-02', OTC_Total: 2, OTC_Short: 1 },
    ]);
    expect(rows.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('returns [] for a non-array body instead of throwing', () => {
    expect(normaliseRows({ detail: 'Upgrade your subscription plan' })).toEqual([]);
    expect(normaliseRows(null)).toEqual([]);
  });

  it('leaves dpi null when the short leg is missing — never invents one', () => {
    const rows = normaliseRows([{ Date: '2026-08-03', OTC_Total: 100, OTC_Short: null, DPI: null }]);
    expect(rows[0].dpi).toBeNull();
  });
});

describe('computeOffExchange', () => {
  it('reports volumeZ as NULL, not 0, when history is too short', () => {
    const rows = normaliseRows(flat(MIN_DAYS - 1));
    const sig = computeOffExchange('TEST', rows);
    expect(sig.volumeZ).toBeNull();
    expect(sig.days).toBe(MIN_DAYS - 1);
    expect(sig.reason).toMatch(/need \d+ for a baseline/);
  });

  it('reports available=false with days=0 for an empty series', () => {
    const sig = computeOffExchange('TEST', []);
    expect(sig.available).toBe(false);
    expect(sig.days).toBe(0);
    expect(sig.volumeZ).toBeNull();
    expect(sig.asOf).toBeNull();
  });

  it('gives volumeZ null (not 0) when the baseline has zero variance', () => {
    // A perfectly flat baseline has sd 0; dividing by it would be Infinity
    // or NaN. Null is the honest answer.
    const sig = computeOffExchange('TEST', normaliseRows(flat(200)));
    expect(sig.volumeZ).toBeNull();
    expect(sig.available).toBe(true);
  });

  it('detects a genuine volume surge in the recent window', () => {
    const raw = flat(200);
    // Give the baseline some spread so sd > 0...
    for (let i = 0; i < raw.length; i++) raw[i].OTC_Total = 100_000 * (1 + (i % 7) * 0.03);
    // ...then 4x the last RECENT_DAYS.
    for (let i = raw.length - RECENT_DAYS; i < raw.length; i++) raw[i].OTC_Total *= 4;
    const sig = computeOffExchange('TEST', normaliseRows(raw));
    expect(sig.volumeZ).toBeGreaterThan(2);
    expect(sig.recentDailyVolume).toBeGreaterThan(300_000);
  });

  it('clips the z-score at ±Z_CLIP', () => {
    const raw = flat(200);
    for (let i = 0; i < raw.length; i++) raw[i].OTC_Total = 100_000 * (1 + (i % 7) * 0.001);
    for (let i = raw.length - RECENT_DAYS; i < raw.length; i++) raw[i].OTC_Total *= 500;
    const sig = computeOffExchange('TEST', normaliseRows(raw));
    expect(sig.volumeZ).toBe(Z_CLIP);
  });

  it('measures the baseline over exactly BASELINE_DAYS ending before the recent window', () => {
    // Ancient history is deliberately extreme; if it leaked into the
    // baseline the z-score would be wrong.
    const raw = flat(400);
    for (let i = 0; i < 300; i++) raw[i].OTC_Total = 1;
    for (let i = 300; i < raw.length; i++) raw[i].OTC_Total = 100_000 * (1 + (i % 7) * 0.03);
    const sig = computeOffExchange('TEST', normaliseRows(raw));
    // Recent == baseline regime, so z should sit near zero despite the
    // 100,000x older regime present in the series.
    expect(Math.abs(sig.volumeZ!)).toBeLessThan(1);
    expect(sig.days).toBe(400);
  });

  it('reports recent and baseline DPI separately — never a single cross-sectional level', () => {
    const raw = flat(200, 100_000, 0.45);
    for (let i = raw.length - RECENT_DAYS; i < raw.length; i++) raw[i].DPI = 0.65;
    const sig = computeOffExchange('TEST', normaliseRows(raw));
    expect(sig.dpiRecent).toBeCloseTo(0.65, 3);
    expect(sig.dpiBase).toBeCloseTo(0.45, 3);
  });

  it('nulls DPI when no row carries one, rather than reporting 0', () => {
    const raw = flat(200).map((r) => ({ ...r, DPI: null, OTC_Short: null }));
    const sig = computeOffExchange('TEST', normaliseRows(raw));
    expect(sig.dpiRecent).toBeNull();
    expect(sig.dpiBase).toBeNull();
  });

  it('always carries the caveat so a UI refactor cannot drop it', () => {
    for (const rows of [[] as OffExchangeRow[], normaliseRows(flat(200))]) {
      expect(computeOffExchange('TEST', rows).caveat).toMatch(/no weight in any score/i);
    }
  });

  it('uses a 5-day recent window against a 60-day baseline', () => {
    expect(RECENT_DAYS).toBe(5);
    expect(BASELINE_DAYS).toBe(60);
  });
});
