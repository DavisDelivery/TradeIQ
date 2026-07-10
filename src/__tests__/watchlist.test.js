// DESK-1 W2 — watchlist store tests (tradeLog sync pattern).
//
// fbOps is mocked at module level; localStorage is jsdom's. Covers:
// add (validation + dedupe + pendingSync lifecycle), remove, cloud
// merge semantics (remote authoritative, local pending preserved), and
// offline behavior (null ops → local-only with pending flag).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const writeMock = vi.fn();
const removeMock = vi.fn();
let subscribeCb = null;
let opsAvailable = true;

vi.mock('../firebase.js', () => ({
  fbOps: async () => (opsAvailable ? {
    write: writeMock,
    remove: removeMock,
    subscribe: (col, cb) => { subscribeCb = cb; },
  } : null),
}));

import {
  readWatchlist, addToWatchlist, removeFromWatchlist, isWatched, _internals,
} from '../watchlist.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  writeMock.mockReset().mockResolvedValue(true);
  removeMock.mockReset().mockResolvedValue(true);
  opsAvailable = true;
});

describe('addToWatchlist', () => {
  it('normalizes, stores locally, and syncs to the cloud doc keyed by ticker', async () => {
    const entry = addToWatchlist(' nvda ');
    expect(entry.ticker).toBe('NVDA');
    expect(entry.addedAt).toBeTruthy();
    expect(isWatched('NVDA')).toBe(true);
    await flush();
    expect(writeMock).toHaveBeenCalledWith(
      `${_internals.FB_COLLECTION}/NVDA`,
      expect.objectContaining({ ticker: 'NVDA' }),
    );
    // pendingSync cleared after successful cloud write
    const list = JSON.parse(localStorage.getItem(_internals.LOCAL_KEY));
    expect(list[0]._pendingSync).toBeUndefined();
  });

  it('rejects garbage symbols and duplicates', () => {
    expect(addToWatchlist('')).toBeNull();
    expect(addToWatchlist('nope!!')).toBeNull();
    expect(addToWatchlist('123')).toBeNull();
    addToWatchlist('AAPL');
    expect(addToWatchlist('AAPL')).toBeNull();
    expect(readWatchlist()).toHaveLength(1);
  });

  it('accepts dotted share classes (BRK.B)', () => {
    expect(addToWatchlist('BRK.B')?.ticker).toBe('BRK.B');
  });

  it('offline: entry stays local with the pendingSync flag', async () => {
    opsAvailable = false;
    addToWatchlist('MSFT');
    await flush();
    const list = JSON.parse(localStorage.getItem(_internals.LOCAL_KEY));
    expect(list[0]._pendingSync).toBe(true);
    expect(writeMock).not.toHaveBeenCalled();
  });
});

describe('removeFromWatchlist', () => {
  it('removes locally and from the cloud', async () => {
    addToWatchlist('AAPL');
    await flush();
    removeFromWatchlist('AAPL');
    expect(isWatched('AAPL')).toBe(false);
    await flush();
    expect(removeMock).toHaveBeenCalledWith(`${_internals.FB_COLLECTION}/AAPL`);
  });
});

describe('cloud merge', () => {
  it('remote is authoritative; local-only PENDING entries are preserved', async () => {
    readWatchlist(); // establish subscription
    await flush();
    expect(typeof subscribeCb).toBe('function');

    // Local pending entry (offline write) + a stale synced one.
    localStorage.setItem(_internals.LOCAL_KEY, JSON.stringify([
      { ticker: 'PENDING', addedAt: '2026-07-01', _pendingSync: true },
      { ticker: 'STALE', addedAt: '2026-06-01' },
    ]));

    subscribeCb([{ id: 'NVDA', ticker: 'NVDA', addedAt: '2026-07-05' }]);
    await flush();

    const tickers = readWatchlist().map((e) => e.ticker);
    expect(tickers).toContain('NVDA');     // remote arrived
    expect(tickers).toContain('PENDING');  // pending preserved
    expect(tickers).not.toContain('STALE'); // non-pending local-only dropped (remote wins)
  });

  it('fires watchlist:change on local writes', () => {
    const handler = vi.fn();
    window.addEventListener('watchlist:change', handler);
    addToWatchlist('AMD');
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('watchlist:change', handler);
  });
});
