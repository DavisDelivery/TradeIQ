// P1-S3 — the consensus archive.

import { describe, it, expect } from 'vitest';
import {
  buildConsensusSnapshot,
  revisionsBetween,
  archiveReadiness,
  ARCHIVE_SCHEMA_VERSION,
  type ConsensusSnapshot,
} from '../consensus-archive';
import type { FinvizRow } from '../finviz';

const row = (over: Partial<FinvizRow> & { ticker: string }): FinvizRow =>
  ({
    sector: null, marketCapM: null, pe: null, forwardPe: null, peg: null,
    targetPrice: null, analystRecom: null, price: null,
    epsGrowthThisYearPct: null, epsGrowthNextYearPct: null, epsGrowthNext5YPct: null,
    ...over,
  }) as FinvizRow;

describe('buildConsensusSnapshot', () => {
  it('projects the consensus fields and stamps the observation date', () => {
    const s = buildConsensusSnapshot(
      [row({ ticker: 'aapl', targetPrice: 250, analystRecom: 1.8, price: 200, epsGrowthNextYearPct: 12 })],
      '2026-08-09',
      '2026-08-09T22:45:00.000Z',
    );
    expect(s.date).toBe('2026-08-09');
    expect(s.schemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
    expect(s.count).toBe(1);
    expect(s.points[0]).toEqual({
      ticker: 'AAPL', tp: 250, rec: 1.8, egY: null, egN: 12, eg5: null, px: 200,
    });
  });

  it('drops rows with nothing to say about consensus', () => {
    // Five nulls is indistinguishable from "never covered", and storing it
    // would inflate the denominator of any future coverage statistic.
    const s = buildConsensusSnapshot(
      [row({ ticker: 'COVERED', analystRecom: 2 }), row({ ticker: 'BARE', price: 10 })],
      '2026-08-09', 'x',
    );
    expect(s.points.map((p) => p.ticker)).toEqual(['COVERED']);
  });

  it('keeps a row that has only a price target', () => {
    const s = buildConsensusSnapshot([row({ ticker: 'TP', targetPrice: 5 })], 'd', 'x');
    expect(s.count).toBe(1);
  });

  it('dedupes and sorts, so two days are diffable without re-sorting', () => {
    const s = buildConsensusSnapshot(
      [row({ ticker: 'ZZZ', analystRecom: 2 }), row({ ticker: 'AAA', analystRecom: 2 }),
       row({ ticker: 'ZZZ', analystRecom: 3 })],
      'd', 'x',
    );
    expect(s.points.map((p) => p.ticker)).toEqual(['AAA', 'ZZZ']);
    expect(s.points.find((p) => p.ticker === 'ZZZ')!.rec).toBe(2); // first wins
  });

  it('coerces non-finite vendor values to null rather than storing NaN', () => {
    const s = buildConsensusSnapshot(
      [row({ ticker: 'X', targetPrice: NaN as unknown as number, analystRecom: 2 })],
      'd', 'x',
    );
    expect(s.points[0].tp).toBeNull();
  });
});

describe('revisionsBetween', () => {
  const snap = (date: string, pts: any[]): ConsensusSnapshot => ({
    date, schemaVersion: 1, observedAt: `${date}T00:00:00Z`, count: pts.length, points: pts,
  });

  it('computes growth, target and implied-upside changes', () => {
    const a = snap('2026-07-09', [{ ticker: 'A', tp: 100, rec: 3, egY: null, egN: 10, eg5: null, px: 90 }]);
    const b = snap('2026-08-09', [{ ticker: 'A', tp: 110, rec: 2, egY: null, egN: 14, eg5: null, px: 100 }]);
    const [r] = revisionsBetween(a, b);
    expect(r.dEgN).toBeCloseTo(4, 10);
    expect(r.dTpPct).toBeCloseTo(10, 10);
    expect(r.impliedUpsidePct).toBeCloseTo(10, 10);
  });

  it('makes the recommendation sign convention explicit: an UPGRADE is NEGATIVE', () => {
    // Finviz runs 1 = strong buy … 5 = strong sell. Anything ranking on dRec
    // must flip it; this test is here so that cannot be got wrong silently.
    const a = snap('d1', [{ ticker: 'A', tp: null, rec: 3.0, egY: null, egN: null, eg5: null, px: null }]);
    const b = snap('d2', [{ ticker: 'A', tp: null, rec: 1.5, egY: null, egN: null, eg5: null, px: null }]);
    const [r] = revisionsBetween(a, b);
    expect(r.dRec).toBeCloseTo(-1.5, 10);
    expect(r.dRec! < 0).toBe(true); // negative == upgraded == good news
  });

  it('skips a ticker with no prior observation rather than treating it as zero', () => {
    // A new listing has not been "revised to" its first estimate.
    const a = snap('d1', []);
    const b = snap('d2', [{ ticker: 'NEW', tp: 10, rec: 2, egY: null, egN: 5, eg5: null, px: 8 }]);
    expect(revisionsBetween(a, b)).toEqual([]);
  });

  it('returns null per-field rather than fabricating a change from a missing side', () => {
    const a = snap('d1', [{ ticker: 'A', tp: null, rec: null, egY: null, egN: null, eg5: null, px: null }]);
    const b = snap('d2', [{ ticker: 'A', tp: 120, rec: 2, egY: null, egN: 9, eg5: null, px: 100 }]);
    const [r] = revisionsBetween(a, b);
    expect(r.dEgN).toBeNull();
    expect(r.dRec).toBeNull();
    expect(r.dTpPct).toBeNull();
    expect(r.impliedUpsidePct).toBeCloseTo(20, 10); // computable from `later` alone
  });

  it('refuses a percentage change off a zero or negative base', () => {
    const a = snap('d1', [{ ticker: 'A', tp: 0, rec: null, egY: null, egN: null, eg5: null, px: null }]);
    const b = snap('d2', [{ ticker: 'A', tp: 10, rec: null, egY: null, egN: null, eg5: null, px: null }]);
    expect(revisionsBetween(a, b)[0].dTpPct).toBeNull();
  });
});

describe('archiveReadiness — the clock', () => {
  it('is not ready on day one', () => {
    const r = archiveReadiness(['2026-08-09']);
    expect(r.spanDays).toBe(0);
    expect(r.ready).toBe(false);
  });

  it('reports the span regardless of input ordering', () => {
    const r = archiveReadiness(['2026-08-09', '2025-08-09', '2026-01-01']);
    expect(r.first).toBe('2025-08-09');
    expect(r.last).toBe('2026-08-09');
    expect(r.spanDays).toBe(365);
    expect(r.ready).toBe(true);
  });

  it('is still not ready one day short of a year', () => {
    expect(archiveReadiness(['2025-08-10', '2026-08-09']).ready).toBe(false);
  });

  it('handles an empty archive', () => {
    expect(archiveReadiness([])).toEqual({ first: null, last: null, spanDays: 0, ready: false });
  });
});
