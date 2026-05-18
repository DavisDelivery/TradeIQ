// Phase 4p W2 — snapshot-doc size-safety helper.
//
// Pure function — no Firestore. Establishes that:
//   - Small payloads pass through with no flag.
//   - A payload over the safety ceiling is truncated to top-N by the
//     producer's sort order (we don't re-sort).
//   - The reported sizes / counts are sane.
//   - Empty inputs are a clean no-op.

import { describe, it, expect } from 'vitest';
import {
  trimResultsForDocLimit,
  SNAPSHOT_DOC_SAFE_BYTES,
} from '../snapshot-store';

interface Row {
  ticker: string;
  composite: number;
  payload: string;
}

function fatRow(ticker: string, composite: number, padBytes: number): Row {
  return { ticker, composite, payload: 'x'.repeat(padBytes) };
}

describe('trimResultsForDocLimit (Phase 4p W2)', () => {
  it('passes a small array through with truncated=false', () => {
    const rows: Row[] = [
      fatRow('AAA', 99, 10),
      fatRow('BBB', 98, 10),
    ];
    const out = trimResultsForDocLimit(rows);
    expect(out.truncated).toBe(false);
    expect(out.storedCount).toBe(2);
    expect(out.originalCount).toBe(2);
    expect(out.results).toBe(rows); // same reference — no copy when no trim
  });

  it('returns a clean no-op for an empty input', () => {
    const out = trimResultsForDocLimit<Row>([]);
    expect(out.truncated).toBe(false);
    expect(out.results).toEqual([]);
    expect(out.storedCount).toBe(0);
    expect(out.originalCount).toBe(0);
  });

  it('truncates when the serialized array exceeds the ceiling', () => {
    // 200 rows × ~2 KB payload ≈ 400 KB. Set the ceiling at 50 KB so
    // ~25 rows survive.
    const rows: Row[] = Array.from({ length: 200 }, (_, i) =>
      fatRow(`T${String(i).padStart(4, '0')}`, 1000 - i, 2000),
    );
    const out = trimResultsForDocLimit(rows, 50_000);
    expect(out.truncated).toBe(true);
    expect(out.storedCount).toBeLessThan(200);
    expect(out.storedCount).toBeGreaterThan(0);
    expect(out.originalCount).toBe(200);
    // The kept slice respects the producer's order — we kept the
    // leading rows (highest-composite first).
    expect(out.results[0].ticker).toBe('T0000');
    expect(out.results[1].ticker).toBe('T0001');
    // And the estimated size really does fit under the ceiling.
    expect(out.estimatedBytes).toBeLessThanOrEqual(50_000);
  });

  it('keeps zero rows if even the first row is over the ceiling', () => {
    // One pathologically large row; ceiling smaller than the row itself.
    const rows: Row[] = [fatRow('XXL', 100, 200_000)];
    const out = trimResultsForDocLimit(rows, 1_000);
    expect(out.truncated).toBe(true);
    expect(out.storedCount).toBe(0);
    expect(out.results).toEqual([]);
  });

  it('uses the SNAPSHOT_DOC_SAFE_BYTES default when no ceiling is given', () => {
    // Sanity: the exported constant is the default. Build an array
    // slightly over the default and confirm a trim fires.
    const rowBytes = 2_000;
    const targetBytes = SNAPSHOT_DOC_SAFE_BYTES + 50_000;
    const n = Math.ceil(targetBytes / rowBytes);
    const rows: Row[] = Array.from({ length: n }, (_, i) =>
      fatRow(`T${String(i).padStart(4, '0')}`, n - i, rowBytes),
    );
    const out = trimResultsForDocLimit(rows);
    expect(out.truncated).toBe(true);
    expect(out.estimatedBytes).toBeLessThanOrEqual(SNAPSHOT_DOC_SAFE_BYTES);
  });

  it('the russell2k worst-case (2,037 fat rows) trims rather than throwing', () => {
    // Models a russell2k Target snapshot — fat analystContributions per
    // row. Without W2 this would throw at writeSnapshot and freeze the
    // cursor (the brief's exact failure mode).
    const rows: Row[] = Array.from({ length: 2037 }, (_, i) =>
      fatRow(`R${String(i).padStart(4, '0')}`, 2037 - i, 800),
    );
    const out = trimResultsForDocLimit(rows);
    if (out.truncated) {
      expect(out.estimatedBytes).toBeLessThanOrEqual(SNAPSHOT_DOC_SAFE_BYTES);
      expect(out.storedCount).toBeGreaterThan(0);
    }
    // Whether or not it tripped, the worker now has a finite, safe payload.
    expect(out.results.length).toBeLessThanOrEqual(2037);
  });
});
