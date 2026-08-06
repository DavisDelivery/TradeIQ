// STOP-1 — the stop watcher's honesty rules.
//
// The value of a SERVER-SIDE watcher over a row highlight is that it samples
// while the app is closed and records when a breach was FIRST seen. That is
// only worth anything if it never invents one, so the load-bearing tests here
// are the negative cases: a missing quote is not a breach, an armed protective
// stop is not a breached position, and a moved stop re-arms rather than
// inheriting a stale alert.

import { describe, it, expect } from 'vitest';
import {
  selectWatchedTrades,
  foldBreaches,
  describeBreach,
  isStopWatchWindow,
  type WatchedTrade,
} from '../stop-watch';

const T = (over: Partial<WatchedTrade> = {}): WatchedTrade => ({
  id: 't1', ticker: 'NVDA', loggedPrice: 200, shares: 5, stop: 190, ...over,
});
const NOW = '2026-08-06T18:30:00.000Z';

describe('who is watched', () => {
  it('watches an open position that has a stop', () => {
    expect(selectWatchedTrades([T()])).toHaveLength(1);
  });

  it('ignores a position with no stop — nothing to enforce', () => {
    expect(selectWatchedTrades([T({ stop: null })])).toHaveLength(0);
  });

  it('ignores a CLOSED position', () => {
    expect(selectWatchedTrades([T({ exitPrice: 205, exitAt: NOW })])).toHaveLength(0);
  });

  it('ignores a sell event — an exit is not a holding', () => {
    expect(selectWatchedTrades([T({ side: 'sell' })])).toHaveLength(0);
    expect(selectWatchedTrades([T({ isSellEvent: true })])).toHaveLength(0);
  });

  it('ignores a PENDING order — an armed stop is not a breached position', () => {
    // Broker docs are written at order placement, so a protective sell-stop
    // exists as a pending doc. Watching it would mean alerting that your stop
    // is at your stop, every single poll, forever.
    expect(selectWatchedTrades([T({ pending: true })])).toHaveLength(0);
  });
});

describe('a missing quote is never a breach', () => {
  it('skips a ticker absent from the quote map', () => {
    const r = foldBreaches([T()], {}, [], NOW);
    expect(r.events).toHaveLength(0);
    expect(r.opened).toHaveLength(0);
  });

  it('skips null and zero prices rather than treating them as 0 <= stop', () => {
    expect(foldBreaches([T()], { NVDA: null }, [], NOW).opened).toHaveLength(0);
    expect(foldBreaches([T()], { NVDA: 0 }, [], NOW).opened).toHaveLength(0);
  });

  it('CARRIES an existing event unchanged when the quote goes missing', () => {
    // A provider outage must not extend, clear, or re-confirm an event on
    // data we never received.
    const first = foldBreaches([T()], { NVDA: 188 }, [], NOW);
    const outage = foldBreaches([T()], {}, first.events, '2026-08-06T18:35:00.000Z');
    expect(outage.events).toEqual(first.events);
    expect(outage.cleared).toEqual([]);
  });
});

describe('detection and accumulation', () => {
  it('opens an event when the last quote is at or below the stop', () => {
    const r = foldBreaches([T()], { NVDA: 189.5 }, [], NOW);
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0].stop).toBe(190);
    expect(r.opened[0].observedPrice).toBe(189.5);
    expect(r.opened[0].observations).toBe(1);
  });

  it('treats exactly-at-the-stop as a breach', () => {
    expect(foldBreaches([T()], { NVDA: 190 }, [], NOW).opened).toHaveLength(1);
  });

  it('does NOT open above the stop', () => {
    expect(foldBreaches([T()], { NVDA: 190.01 }, [], NOW).opened).toHaveLength(0);
  });

  it('preserves firstObservedAt and tracks the low across samples', () => {
    const a = foldBreaches([T()], { NVDA: 189 }, [], NOW);
    const b = foldBreaches([T()], { NVDA: 185 }, a.events, '2026-08-06T18:35:00.000Z');
    const c = foldBreaches([T()], { NVDA: 187 }, b.events, '2026-08-06T18:40:00.000Z');
    expect(c.events[0].firstObservedAt).toBe(NOW);            // never moves
    expect(c.events[0].lastObservedAt).toBe('2026-08-06T18:40:00.000Z');
    expect(c.events[0].lowestObserved).toBe(185);             // the wick is kept
    expect(c.events[0].observations).toBe(3);
    expect(c.opened).toHaveLength(0);                          // not re-opened
  });

  it('a recovery above the stop stops extending, but history is not lost', () => {
    const a = foldBreaches([T()], { NVDA: 189 }, [], NOW);
    const b = foldBreaches([T()], { NVDA: 195 }, a.events, '2026-08-06T18:35:00.000Z');
    // No longer breaching, so it clears — the UI should not show a red banner
    // on a position that recovered.
    expect(b.events).toHaveLength(0);
    expect(b.cleared).toEqual([a.events[0].key]);
  });
});

describe('re-arming', () => {
  it('MOVING the stop starts a fresh watch instead of inheriting the old alert', () => {
    const a = foldBreaches([T({ stop: 190 })], { NVDA: 189 }, [], NOW);
    // Owner lowers the stop to 180; price is still 189 — above the new stop.
    const b = foldBreaches([T({ stop: 180 })], { NVDA: 189 }, a.events, NOW);
    expect(b.events).toHaveLength(0);
    expect(b.cleared).toEqual([a.events[0].key]); // old key retired
  });

  it('clears when the position is closed', () => {
    const a = foldBreaches([T()], { NVDA: 189 }, [], NOW);
    const b = foldBreaches([], { NVDA: 189 }, a.events, NOW);
    expect(b.events).toHaveLength(0);
    expect(b.cleared).toHaveLength(1);
  });
});

describe('wording', () => {
  it('says OBSERVED with a sample time — never "stopped out"', () => {
    const e = foldBreaches([T()], { NVDA: 188 }, [], NOW).opened[0];
    const s = describeBreach(e);
    expect(s).toMatch(/observed at or below/i);
    expect(s).toMatch(/first seen/i);
    expect(s.toLowerCase()).not.toContain('stopped out');
    expect(s).toContain('-6.0%'); // 188 vs 200 entry
  });
});

describe('isStopWatchWindow', () => {
  // The read endpoint only claims staleness inside this window. Getting it
  // wrong in either direction is bad: too wide cries wolf every evening, too
  // narrow hides a dead cron during the session.
  it('is open through the US session and closed outside it', () => {
    expect(isStopWatchWindow(new Date('2026-08-06T13:00:00Z'))).toBe(true);  // 09:00 ET
    expect(isStopWatchWindow(new Date('2026-08-06T18:32:00Z'))).toBe(true);  // 14:32 ET
    expect(isStopWatchWindow(new Date('2026-08-06T20:59:00Z'))).toBe(true);  // 16:59 ET
    expect(isStopWatchWindow(new Date('2026-08-06T21:00:00Z'))).toBe(false); // after the last cron
    expect(isStopWatchWindow(new Date('2026-08-06T12:59:00Z'))).toBe(false); // before the first
    expect(isStopWatchWindow(new Date('2026-08-07T03:00:00Z'))).toBe(false); // overnight
  });
});
