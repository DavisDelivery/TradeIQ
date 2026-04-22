// Netlify Blobs wrapper — typed get/set/list for persistence.
// Store names used across the app:
//   'targetboard'      - latest and historical target boards
//   'pm-decisions'     - Claude-as-PM daily output
//   'backtests'        - backtest run results
//   'regime-narrative' - daily Claude-written macro narrative
//   'analyst-cache'    - cached analyst outputs (TTL-based via key suffix)

import { getStore, type Store } from '@netlify/blobs';

type StoreName =
  | 'targetboard'
  | 'pm-decisions'
  | 'backtests'
  | 'regime-narrative'
  | 'analyst-cache';

function store(name: StoreName): Store {
  return getStore({ name, consistency: 'strong' });
}

export async function blobGet<T>(storeName: StoreName, key: string): Promise<T | null> {
  try {
    const raw = await store(storeName).get(key, { type: 'json' });
    return (raw ?? null) as T | null;
  } catch (err) {
    console.error(`blobGet ${storeName}/${key} failed`, err);
    return null;
  }
}

export async function blobSet<T>(
  storeName: StoreName,
  key: string,
  value: T,
): Promise<void> {
  await store(storeName).setJSON(key, value);
}

export async function blobList(storeName: StoreName, prefix?: string): Promise<string[]> {
  const { blobs } = await store(storeName).list({ prefix });
  return blobs.map((b) => b.key);
}

export async function blobDelete(storeName: StoreName, key: string): Promise<void> {
  await store(storeName).delete(key);
}

/** Convenience: today's date key in YYYY-MM-DD (ET). */
export function todayKey(): string {
  const now = new Date();
  // Convert to US/Eastern
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y = ny.getFullYear();
  const m = String(ny.getMonth() + 1).padStart(2, '0');
  const d = String(ny.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
