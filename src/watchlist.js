// DESK-1 W2 — Firestore-synced single-user watchlist.
// Mirrors the tradeLog.js hybrid pattern exactly: Firestore is the source
// of truth when online, localStorage mirrors everything so the Desk works
// offline and reads are instant. Synchronous API (readWatchlist,
// addToWatchlist, removeFromWatchlist) — cloud sync happens in the
// background and fires 'watchlist:change' when remote data arrives.
//
// Firestore layout: collection `watchlist`, one doc per ticker
// ({ ticker, addedAt }). NOTE: requires a `watchlist` rules block in
// FIRESTORE_RULES.md (mirroring tradeLog's) — without it cloud writes
// fail permission-denied and entries stay local-only (_pendingSync).

import { fbOps } from './firebase.js';

const LOCAL_KEY = 'tradeiq.watchlist.v1';
const FB_COLLECTION = 'watchlist';

// ─── Local storage helpers ────────────────────────────────────────────────────

function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocal(list) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('watchlist:change'));
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Cloud sync ───────────────────────────────────────────────────────────────

let _subscribed = false;
let _cloudReady = false;

async function ensureCloudSubscription() {
  if (_subscribed) return;
  _subscribed = true;
  const ops = await fbOps();
  if (!ops) return; // offline / unavailable — localStorage only
  try {
    ops.subscribe(FB_COLLECTION, (remoteEntries) => {
      _cloudReady = true;
      mergeRemote(remoteEntries);
    }, { orderByField: 'addedAt', direction: 'asc' });
  } catch (err) {
    console.warn('[watchlist] cloud subscribe failed:', err.message);
  }
}

function mergeRemote(remoteEntries) {
  // Remote is authoritative; local-only pending entries are preserved.
  const local = readLocal();
  const remoteTickers = new Set(remoteEntries.map((e) => e.ticker));
  const localOnly = local.filter((e) => !remoteTickers.has(e.ticker) && e._pendingSync);
  writeLocal([...remoteEntries, ...localOnly]);
  drainPendingSyncs();
}

async function drainPendingSyncs() {
  const ops = await fbOps();
  if (!ops) return;
  const list = readLocal();
  const pending = list.filter((e) => e._pendingSync);
  if (pending.length === 0) return;
  for (const entry of pending) {
    try {
      const { _pendingSync, ...clean } = entry;
      await ops.write(`${FB_COLLECTION}/${entry.ticker}`, clean);
      const idx = list.findIndex((e) => e.ticker === entry.ticker);
      if (idx >= 0) list[idx] = clean;
    } catch (err) {
      console.warn('[watchlist] sync failed for', entry.ticker, err.message);
    }
  }
  writeLocal(list);
}

// ─── Public API (synchronous, mirrors tradeLog) ───────────────────────────────

export function readWatchlist() {
  ensureCloudSubscription();
  return readLocal();
}

/**
 * Add a ticker. Caller validates the symbol first (Desk uses the
 * /api/ticker-info lookup); this layer only normalizes + dedupes.
 * Returns the entry, or null when it was already present / invalid.
 */
export function addToWatchlist(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(t)) return null;

  const list = readLocal();
  if (list.some((e) => e.ticker === t)) return null;

  const entry = { ticker: t, addedAt: new Date().toISOString() };
  list.push({ ...entry, _pendingSync: true });
  writeLocal(list);

  // Fire-and-forget cloud write
  (async () => {
    const ops = await fbOps();
    if (!ops) return; // offline, drains later
    try {
      await ops.write(`${FB_COLLECTION}/${t}`, entry);
      const current = readLocal();
      const idx = current.findIndex((e) => e.ticker === t);
      if (idx >= 0) {
        delete current[idx]._pendingSync;
        writeLocal(current);
      }
    } catch (err) {
      console.warn('[watchlist] cloud write failed, will retry:', err.message);
    }
  })();

  return entry;
}

export function removeFromWatchlist(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  const list = readLocal().filter((e) => e.ticker !== t);
  writeLocal(list);

  (async () => {
    const ops = await fbOps();
    if (!ops) return;
    try { await ops.remove(`${FB_COLLECTION}/${t}`); }
    catch (err) { console.warn('[watchlist] cloud remove failed:', err.message); }
  })();

  return list;
}

export function isWatched(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  return readLocal().some((e) => e.ticker === t);
}

// ─── Connection state for UI ──────────────────────────────────────────────────

export function watchlistSyncState() {
  return { ready: _cloudReady, subscribed: _subscribed };
}

// Exposed for tests.
export const _internals = { LOCAL_KEY, FB_COLLECTION };
