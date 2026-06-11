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

// ---------------------------------------------------------------------------
// Wave-3D regression (code-review-2026-06 M5) — replay columns must read the
// fields the producing scans ACTUALLY write, not invented ones. Each fixture
// below mirrors the producer's row shape (file referenced per board). The
// pre-fix accessors (r.score/r.side on target rows, r.buyCount/
// r.mostRecentFiling on insider rows, r.reason on williams, top-level
// peg/pe/growth on lynch) rendered '—' on every row.
// ---------------------------------------------------------------------------

function fmtByKey(board, row) {
  const out = {};
  for (const c of pickColumnsForBoard(board, [row])) out[c.key] = c.format(row);
  return out;
}

describe('pickColumnsForBoard — producer-realistic row shapes (M5)', () => {
  it('target-board reads composite/direction/price/rationale (shared/types.ts Target)', () => {
    const row = {
      ticker: 'NVDA', composite: 78, tier: 'A', direction: 'long',
      price: 131.27, priceChangePct: 1.4,
      rationale: 'Momentum + earnings revision cluster',
      analystContributions: [], topSignals: [], conflictLevel: 'none',
      scoredAt: '2026-06-10T20:00:00Z',
    };
    const cells = fmtByKey('target-board', row);
    expect(cells.composite).toBe(78);
    expect(cells.direction).toBe('long');
    expect(cells.price).toBe('$131.27');
    // Rationale renders inside a span — assert via its props.
    expect(cells.rationale.props.children).toContain('Momentum');
  });

  it('catalyst reads composite (shared/catalyst-scorer.ts CatalystScore)', () => {
    const row = {
      ticker: 'LMT', composite: 71, conviction: 'high', direction: 'long',
      rationale: 'contract win + cluster buy', tags: ['cluster_buy', 'contract_win'],
    };
    const cells = fmtByKey('catalyst', row);
    expect(cells.composite).toBe(71);
    expect(cells.conviction).toBe('high');
    expect(cells.tags).toBe('cluster_buy · contract_win');
  });

  it('insider reads buyerCount/latestFilingDate (shared/scan-insider.ts row shape)', () => {
    const row = {
      ticker: 'CRM', buyDollars: 2_400_000, awardDollars: 0, sellDollars: 0,
      netDollars: 2_400_000, buyerCount: 3, totalBuys: 4, totalAwards: 0,
      totalSells: 0, topBuyer: { name: 'Jane Roe', role: 'CFO', dollars: 1_500_000 },
      latestFilingDate: '2026-06-01', daysSinceLatest: 10, price: null, filings: [],
    };
    const cells = fmtByKey('insider', row);
    expect(cells.buyerCount).toBe(3);
    expect(cells.buyDollars).toBe('$2400k');
    expect(cells.topBuyer).toBe('Jane Roe (CFO)');
    expect(cells.latestFilingDate).not.toBe('—');
    expect(String(cells.latestFilingDate)).toMatch(/2026/);
  });

  it('williams reads rationale (shared/scan-williams.ts WilliamsCandidate)', () => {
    const row = {
      ticker: 'DE', name: 'Deere', sector: 'Industrials', score: 62,
      confidence: 0.7, rationale: 'oversold %R reversal + closing strength',
      signals: { williamsR: -91 }, side: 'long',
      signal: { verdict: 'BUY', entry: 400, stop: 388, target: 436, atr: 6 },
      price: 401.5,
    };
    const cells = fmtByKey('williams', row);
    expect(cells.score).toBe(62);
    expect(cells.side).toBe('long');
    expect(cells.rationale.props.children).toContain('oversold');
  });

  it('lynch reads signals.peg / signals.peRatio / signals.epsGrowthYoYPct (styles/lynch.ts)', () => {
    const row = {
      ticker: 'ULTA', name: 'Ulta Beauty', sector: 'Consumer', score: 55,
      confidence: 0.75, rationale: 'PEG 0.85 — reasonable',
      signals: { peg: 0.85, peRatio: 17.4, epsGrowthYoYPct: 20.5, debtToEquity: 0.4 },
      side: 'long', signal: { verdict: 'BUY' }, price: 410,
    };
    const cells = fmtByKey('lynch', row);
    expect(cells.peg).toBe('0.85');
    expect(cells.pe).toBe('17.4');
    expect(cells.growth).toBe('20.5%');
  });

  it('prophet reads composite (shared/prophet-layers.ts ProphetScore)', () => {
    const row = { ticker: 'NVDA', composite: 81, conviction: 'HIGH', layers: {}, price: 131.27 };
    const cells = fmtByKey('prophet', row);
    expect(cells.composite).toBe(81);
  });

  it('missing fields still degrade to em-dash, never throw', () => {
    for (const board of ['target-board', 'catalyst', 'insider', 'williams', 'lynch']) {
      const cells = fmtByKey(board, { ticker: 'X' });
      for (const [key, v] of Object.entries(cells)) {
        if (key === 'ticker' || key === 'rationale') continue;
        const rendered = typeof v === 'object' && v !== null && v.props ? v.props.children : v;
        expect(['—', '$—', '']).toContain(String(rendered));
      }
    }
  });
});
