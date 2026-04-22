// Trade log — hybrid Firestore + localStorage.
// Firestore is the source of truth when online. localStorage mirrors everything
// so the app works offline and reads are instant. All callers use the same
// synchronous API (readLog, logTrade, removeTrade) — cloud sync happens in the
// background and fires 'tradelog:change' when remote data arrives.

import { fbOps } from './firebase.js';

const LOCAL_KEY = 'tradeiq.tradeLog.v1';
// Collection path in Firestore. Single shared namespace since this is a personal
// tool — add auth.userId later if the app goes multi-user.
const FB_COLLECTION = 'tradeLog';

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

function writeLocal(log) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(log));
    // Dispatch change event so React views can refresh
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tradelog:change'));
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Cloud sync ───────────────────────────────────────────────────────────────

let _subscribed = false;
let _cloudReady = false;

// Subscribe to Firestore once, merge remote entries into local cache.
// Called automatically on first readLog() invocation.
async function ensureCloudSubscription() {
  if (_subscribed) return;
  _subscribed = true;
  const ops = await fbOps();
  if (!ops) return; // offline / unavailable — localStorage only
  try {
    ops.subscribe(FB_COLLECTION, (remoteEntries) => {
      _cloudReady = true;
      mergeRemote(remoteEntries);
    }, { orderByField: 'loggedAt', direction: 'desc' });
  } catch (err) {
    console.warn('[tradeLog] cloud subscribe failed:', err.message);
  }
}

function mergeRemote(remoteEntries) {
  // Remote is authoritative. Remote entries replace local, plus any local-only
  // entries (never synced, maybe offline-queued) are preserved.
  const local = readLocal();
  const remoteIds = new Set(remoteEntries.map((e) => e.id));
  const localOnly = local.filter((e) => !remoteIds.has(e.id) && e._pendingSync);
  const merged = [...remoteEntries, ...localOnly];
  writeLocal(merged);
  // Re-drain pending syncs in case we came back online
  drainPendingSyncs();
}

async function drainPendingSyncs() {
  const ops = await fbOps();
  if (!ops) return;
  const log = readLocal();
  const pending = log.filter((e) => e._pendingSync);
  if (pending.length === 0) return;
  for (const entry of pending) {
    try {
      const { _pendingSync, ...clean } = entry;
      await ops.write(`${FB_COLLECTION}/${entry.id}`, clean);
      // Clear the flag locally
      const idx = log.findIndex((e) => e.id === entry.id);
      if (idx >= 0) {
        log[idx] = clean;
      }
    } catch (err) {
      console.warn('[tradeLog] sync failed for', entry.id, err.message);
    }
  }
  writeLocal(log);
}

// ─── Public API (synchronous, same signatures as before) ──────────────────────

export function readLog() {
  ensureCloudSubscription();
  return readLocal();
}

export function logTrade(entry) {
  const enriched = {
    id: `${entry.ticker}-${entry.source}-${Date.now()}`,
    loggedAt: new Date().toISOString(),
    ...entry,
  };

  // Write local immediately (optimistic)
  const log = readLocal();
  log.push({ ...enriched, _pendingSync: true });
  writeLocal(log);

  // Fire-and-forget cloud write
  (async () => {
    const ops = await fbOps();
    if (!ops) return; // offline, will drain later
    try {
      await ops.write(`${FB_COLLECTION}/${enriched.id}`, enriched);
      // Strip pending flag on success
      const current = readLocal();
      const idx = current.findIndex((e) => e.id === enriched.id);
      if (idx >= 0) {
        delete current[idx]._pendingSync;
        writeLocal(current);
      }
    } catch (err) {
      console.warn('[tradeLog] cloud write failed, will retry:', err.message);
    }
  })();

  return enriched;
}

export function removeTrade(id) {
  // Remove from local immediately
  const log = readLocal().filter((t) => t.id !== id);
  writeLocal(log);

  // Remove from cloud in background
  (async () => {
    const ops = await fbOps();
    if (!ops) return;
    try { await ops.remove(`${FB_COLLECTION}/${id}`); }
    catch (err) { console.warn('[tradeLog] cloud remove failed:', err.message); }
  })();

  return log;
}

export function isLogged(ticker, source) {
  return readLocal().some((t) => t.ticker === ticker && t.source === source);
}

// ─── Shared utilities (unchanged) ─────────────────────────────────────────────

export function daysBetween(aIso, bIso) {
  return Math.round((new Date(bIso).getTime() - new Date(aIso).getTime()) / 86400000);
}

export function computeForwardReturns(bars, loggedAt, loggedPrice) {
  if (!bars?.length || loggedPrice <= 0) return {};
  const windows = { since: null, fwd5: 5, fwd20: 20, fwd30: 30, fwd60: 60, fwd90: 90 };
  const out = {};
  const loggedTs = new Date(loggedAt).getTime();
  const baseIdx = bars.findIndex((b) => new Date(b.date).getTime() >= loggedTs);
  const basePrice = baseIdx >= 0 ? bars[baseIdx].c : loggedPrice;
  const latestBar = bars[bars.length - 1];
  const daysSinceLog = daysBetween(loggedAt, latestBar.date);

  for (const [key, days] of Object.entries(windows)) {
    if (key === 'since') {
      out[key] = {
        days: daysSinceLog,
        price: latestBar.c,
        returnPct: +(((latestBar.c - basePrice) / basePrice) * 100).toFixed(2),
      };
      continue;
    }
    const targetIdx = baseIdx >= 0 ? baseIdx + days : -1;
    if (targetIdx < 0 || targetIdx >= bars.length) {
      out[key] = null;
      continue;
    }
    const targetBar = bars[targetIdx];
    out[key] = {
      days,
      price: targetBar.c,
      returnPct: +(((targetBar.c - basePrice) / basePrice) * 100).toFixed(2),
      date: targetBar.date,
    };
  }
  return out;
}

// ─── Connection state for UI ──────────────────────────────────────────────────

export function cloudSyncState() {
  return {
    ready: _cloudReady,
    subscribed: _subscribed,
  };
}
