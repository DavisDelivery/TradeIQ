// Wave-1 regression — History replay prophet "Layers" column.
//
// Prophet snapshot rows store `layers` as an OBJECT keyed by layer name
// (prophet-layers.ts ProphetScore), but the column formatter called
// `.filter` on it, so selecting any prophet snapshot crashed the History
// view with a TypeError (code-review-2026-06, frontend C3). The formatter
// must accept both the object form and the legacy `layerResults` array.

import { describe, it, expect } from 'vitest';
import { pickColumnsForBoard } from '../HistoryView.jsx';

function layersColumn() {
  const columns = pickColumnsForBoard('prophet', [{ ticker: 'A' }]);
  const col = columns.find((c) => c.key === 'layers');
  expect(col).toBeDefined();
  return col;
}

describe('pickColumnsForBoard("prophet") Layers formatter', () => {
  it('handles object-shaped layers (real prophet snapshot rows)', () => {
    const col = layersColumn();
    const row = {
      ticker: 'NVDA',
      layers: {
        structure: { score: 70, pass: true },
        momentum: { score: 65, pass: true },
        volume: { score: 50, pass: false },
        volatility: { score: 60, pass: true },
        relativeStrength: { score: 75, pass: true },
        fundamental: { score: 80, pass: true },
        catalyst: { score: 30, pass: false },
      },
    };
    expect(col.format(row)).toBe('5/7');
  });

  it('still handles legacy layerResults arrays', () => {
    const col = layersColumn();
    const row = {
      ticker: 'AAPL',
      layerResults: [{ pass: true }, { pass: false }, { pass: true }],
    };
    expect(col.format(row)).toBe('2/3');
  });

  it('renders em-dash when layers are absent', () => {
    const col = layersColumn();
    expect(col.format({ ticker: 'MSFT' })).toBe('—');
    expect(col.format(undefined)).toBe('—');
  });
});
