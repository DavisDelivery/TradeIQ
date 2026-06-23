import { describe, it, expect } from 'vitest';
import { overlayQuotes } from '../hooks/useLiveQuotes.js';

describe('overlayQuotes', () => {
  const rows = [
    { ticker: 'AAPL', price: 100, priceChangePct: 1, composite: 90 },
    { ticker: 'MSFT', price: 200, priceChangePct: -2, composite: 80 },
  ];

  it('overlays live price + %-change, keeping other fields', () => {
    const out = overlayQuotes(rows, { AAPL: { price: 105.5, changePct: 3.2 } });
    expect(out[0]).toEqual({ ticker: 'AAPL', price: 105.5, priceChangePct: 3.2, composite: 90 });
    // MSFT had no quote → untouched (same reference).
    expect(out[1]).toBe(rows[1]);
  });

  it('falls back to scored values when a quote is missing', () => {
    const out = overlayQuotes(rows, {});
    expect(out).toEqual(rows);
  });

  it('matches case-insensitively on ticker', () => {
    const out = overlayQuotes([{ ticker: 'aapl', price: 1, priceChangePct: 0 }], {
      AAPL: { price: 9, changePct: 4 },
    });
    expect(out[0].price).toBe(9);
    expect(out[0].priceChangePct).toBe(4);
  });

  it('honors custom price/pct/ticker keys (e.g. options flow)', () => {
    const out = overlayQuotes(
      [{ symbol: 'TSLA', underlyingPrice: 10, intradayChangePct: 0 }],
      { TSLA: { price: 250, changePct: 1.5 } },
      { priceKey: 'underlyingPrice', pctKey: 'intradayChangePct', tickerKey: 'symbol' },
    );
    expect(out[0].underlyingPrice).toBe(250);
    expect(out[0].intradayChangePct).toBe(1.5);
  });

  it('pctKey:null overlays price only (insider/lynch)', () => {
    const out = overlayQuotes([{ ticker: 'X', price: 1, priceChangePct: 9 }], {
      X: { price: 50, changePct: 7 },
    }, { pctKey: null });
    expect(out[0].price).toBe(50);
    expect(out[0].priceChangePct).toBe(9); // unchanged
  });

  it('handles empty/nullish rows safely', () => {
    expect(overlayQuotes([], { A: { price: 1, changePct: 1 } })).toEqual([]);
    expect(overlayQuotes(null, {})).toEqual([]);
  });
});
