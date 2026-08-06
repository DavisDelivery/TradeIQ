// Broker -> journal contract (2026-08-06).
//
// THE DEFECT: broker-execute.ts and trade-queue.ts wrote
// {price, entry, qty, stopPrice, notes}. PositionsPanel reads loggedPrice,
// baseRates reads loggedPrice, JournalView reads loggedPrice/shares/note.
// ZERO overlap — so every trade actually executed through Robinhood showed a
// blank entry, produced null Unrl%/R, and was silently excluded from Base
// Rates. The honesty apparatus was blind to the real trades.
//
// Normalisation is on the READ side on purpose: a writer-only fix leaves
// every doc already in Firestore broken.

import { describe, it, expect } from 'vitest';
import { normalizeTrade } from '../../tradeLog.js';
import { buildPositionRows } from '../../components/desk/PositionsPanel.jsx';
import { isClosed } from '../baseRates.js';

/** Exactly what broker-execute.ts used to write, legacy keys only. */
const legacyBrokerBuy = {
  id: 'NVDA-prophet-1',
  ticker: 'NVDA',
  source: 'prophet',
  side: 'buy',
  loggedAt: '2026-08-05T14:00:00Z',
  price: 124.5,
  entry: 124.5,
  qty: 3,
  stopPrice: 118,
  notes: 'robinhood market buy 3 NVDA',
};

describe('normalizeTrade repairs the legacy broker schema', () => {
  it('maps price/qty/stopPrice/notes onto the keys readers use', () => {
    const t = normalizeTrade(legacyBrokerBuy);
    expect(t.loggedPrice).toBe(124.5);
    expect(t.shares).toBe(3);
    expect(t.stop).toBe(118);
    expect(t.note).toBe('robinhood market buy 3 NVDA');
  });

  it('a canonical doc is passed through untouched (normaliser is a no-op)', () => {
    const t = normalizeTrade({ id: 'x', ticker: 'AAPL', loggedPrice: 200, shares: 5, stop: 190 });
    expect(t.loggedPrice).toBe(200);
    expect(t.shares).toBe(5);
    expect(t.stop).toBe(190);
  });

  it('prefers the canonical key when both are present and disagree', () => {
    const t = normalizeTrade({ loggedPrice: 100, price: 999 });
    expect(t.loggedPrice).toBe(100);
  });
});

describe('Positions no longer invents holdings', () => {
  it('a legacy broker buy now renders a real entry price', () => {
    const rows = buildPositionRows([normalizeTrade(legacyBrokerBuy)], { NVDA: { price: 130 } });
    expect(rows).toHaveLength(1);
    expect(rows[0].entry).toBe(124.5);        // was null — the whole defect
    expect(rows[0].unrealizedPerShare).toBeCloseTo(5.5);
  });

  it('a SELL event is not an open position', () => {
    // Previously rendered as a row whose "entry" was actually an exit price.
    const sell = normalizeTrade({ id: 's1', ticker: 'NVDA', side: 'sell', price: 130, qty: -3 });
    expect(sell.isSellEvent).toBe(true);
    expect(buildPositionRows([sell], {})).toHaveLength(0);
  });

  it('an UNFILLED order is not a position — the armed-stop trap', () => {
    // broker docs are written at ORDER PLACEMENT. A protective sell-stop at
    // $92 on a winning $100 lot must never appear as a holding, and must
    // never be matched against the buy as an exit.
    const armedStop = normalizeTrade({
      id: 'p1', ticker: 'NVDA', side: 'sell', loggedPrice: 92, shares: -3, pending: true,
    });
    expect(armedStop.pending).toBe(true);
    expect(buildPositionRows([armedStop], {})).toHaveLength(0);
  });

  it('an unfilled BUY limit is not a position either', () => {
    const restingLimit = normalizeTrade({
      id: 'p2', ticker: 'AMD', side: 'buy', loggedPrice: 90, shares: 5, pending: true,
    });
    expect(buildPositionRows([restingLimit], {})).toHaveLength(0);
  });
});

describe('Base Rates cannot be poisoned by unfilled orders', () => {
  it('a pending order is not a closed trade', () => {
    expect(isClosed(normalizeTrade({ pending: true, loggedPrice: 92, shares: -3 }))).toBe(false);
  });

  it('a real closed round trip still counts', () => {
    const done = normalizeTrade({
      ticker: 'NVDA', price: 100, qty: 3, exitPrice: 110, exitAt: '2026-08-06T20:00:00Z',
    });
    expect(isClosed(done)).toBe(true);
    expect(done.loggedPrice).toBe(100); // repaired from the legacy key
  });
});
