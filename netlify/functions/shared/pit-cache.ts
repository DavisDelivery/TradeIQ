// Firestore-backed hot cache for point-in-time data fetches.
//
// Why this exists:
//   Phase 4 backtests pull thousands of (provider, ticker, asOfDate) tuples
//   per run. Without a cache, a single 4-year × 1900-ticker Russell backtest
//   would burn vendor API budget for hours and hit free-tier rate limits.
//   With this cache, the first run primes Firestore; subsequent runs hit
//   the cache and complete in minutes.
//
// Why it's safe:
//   Point-in-time data is immutable by definition — the answer to
//   "what did fundamentals look like for AAPL as of 2023-06-30?" never
//   changes. So cache entries have no TTL: a hit is always correct.
//
// Bypass:
//   Set env `PIT_CACHE_BYPASS=1` to force re-fetch and overwrite. Use when
//   verifying provider PIT semantics, never in normal backtest runs.

import { createHash } from 'node:crypto';
import { getAdminDb } from './firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';

export type PitDataClass =
  | 'fundamentals'
  | 'news'
  | 'recommendations'
  | 'insider'
  | 'political'
  | 'patents'
  | 'contracts'
  | 'macro'
  | 'bars'
  | 'earnings_intel';

export type PitProvider = 'polygon' | 'finnhub' | 'quiver' | 'fred' | 'derived';

export interface PitCacheKey {
  provider: PitProvider;
  dataClass: PitDataClass;
  ticker?: string;
  seriesId?: string;
  asOfDate: string; // YYYY-MM-DD
  extra?: string; // window suffixes, limits — must be deterministic
}

const COLLECTION = 'pitCache';

/** Stable hash over the key — sorted-key JSON → sha1 → hex. */
export function hashKey(key: PitCacheKey): string {
  const source = key as unknown as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const k of Object.keys(source).sort()) {
    const v = source[k];
    if (v !== undefined) canonical[k] = v;
  }
  return createHash('sha1').update(JSON.stringify(canonical)).digest('hex');
}

function bypass(): boolean {
  return process.env.PIT_CACHE_BYPASS === '1';
}

/**
 * Optional Firestore injection seam — used by tests to inject an in-memory
 * fake. Production callers leave this null and resolve via getAdminDb().
 */
let _dbOverride: Firestore | null = null;

export function __setDbForTesting(db: Firestore | null): void {
  _dbOverride = db;
}

function db(): Firestore {
  return _dbOverride ?? getAdminDb();
}

/**
 * Sentinel for "cache miss" — distinct from a legitimately cached `null`,
 * which is a perfectly valid PIT answer (e.g. "no insider activity in
 * window"). Callers use `pitCacheHas` or destructure the wrap return value.
 */
const CACHE_MISS = Symbol('pit-cache:miss');

async function pitCacheGetRaw<T = unknown>(
  key: PitCacheKey,
): Promise<T | typeof CACHE_MISS> {
  if (bypass()) return CACHE_MISS;
  const id = hashKey(key);
  const snap = await db().collection(COLLECTION).doc(id).get();
  if (!snap.exists) return CACHE_MISS;
  const data = snap.data();
  if (!data) return CACHE_MISS;
  // `value` may legitimately be null and we must preserve that distinction.
  return (data.value as T) ?? (null as T);
}

export async function pitCacheGet<T = unknown>(key: PitCacheKey): Promise<T | null> {
  const v = await pitCacheGetRaw<T>(key);
  if (v === CACHE_MISS) return null;
  return v;
}

/** Returns true iff a value (possibly null) is cached for this key. */
export async function pitCacheHas(key: PitCacheKey): Promise<boolean> {
  const v = await pitCacheGetRaw(key);
  return v !== CACHE_MISS;
}

export async function pitCacheSet<T = unknown>(key: PitCacheKey, value: T): Promise<void> {
  const id = hashKey(key);
  await db()
    .collection(COLLECTION)
    .doc(id)
    .set({
      key,
      value,
      createdAt: new Date().toISOString(),
    });
}

/**
 * Wrap a fetcher with the cache. Single most common usage pattern.
 *
 *   const data = await pitCacheWrap(key, () => providerFetch(...));
 *
 * On cache miss: calls fetcher, writes result (even null), returns it.
 * On cache hit: returns cached value, fetcher is never called.
 *
 * Bypass mode (PIT_CACHE_BYPASS=1): always calls fetcher and overwrites
 * the cache entry. Use for provider-behavior verification.
 */
export async function pitCacheWrap<T>(
  key: PitCacheKey,
  fetcher: () => Promise<T>,
): Promise<T> {
  if (!bypass()) {
    const hit = await pitCacheGetRaw<T>(key);
    if (hit !== CACHE_MISS) return hit;
  }
  const fresh = await fetcher();
  // Cache nulls too — "no insider activity in window" is itself PIT-stable.
  await pitCacheSet(key, fresh);
  return fresh;
}

/**
 * Batched prefetch. Backtest engines often know every (ticker, asOfDate)
 * pair up front; this lets them warm the cache in a single Firestore RPC
 * round-trip per chunk of <=500 docs.
 *
 * Returns a map of hashKey → { hit, value }:
 *   - hit=false: no cache entry (miss)
 *   - hit=true, value=anything (including null): cached value
 */
export interface PitCacheManyEntry<T> {
  hit: boolean;
  value: T | null;
}

export async function pitCacheGetMany<T = unknown>(
  keys: PitCacheKey[],
): Promise<Map<string, PitCacheManyEntry<T>>> {
  const out = new Map<string, PitCacheManyEntry<T>>();
  if (bypass() || keys.length === 0) {
    for (const k of keys) out.set(hashKey(k), { hit: false, value: null });
    return out;
  }
  const refs = keys.map((k) => db().collection(COLLECTION).doc(hashKey(k)));
  const CHUNK = 500;
  for (let i = 0; i < refs.length; i += CHUNK) {
    const slice = refs.slice(i, i + CHUNK);
    const snaps = await db().getAll(...slice);
    for (let j = 0; j < snaps.length; j++) {
      const id = slice[j].id;
      const exists = snaps[j].exists;
      const data = exists ? snaps[j].data() : null;
      out.set(id, {
        hit: exists,
        value: data ? ((data.value as T) ?? null) : null,
      });
    }
  }
  return out;
}
