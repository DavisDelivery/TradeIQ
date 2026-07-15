// Firestore-backed LIVE provider cache (TTL'd) — the live-mode sibling of
// pit-cache.
//
// Why this exists (2026-07-15 stale-board incident):
//   PR #105 aligned `getEarningsHistory` with the shared Finnhub token
//   bucket (correct — the unpaced raw fetch burst-hammered Finnhub and
//   silently returned [] under 429). But the pacing repriced every
//   large-universe LIVE scan that calls it per ticker: prophet's sieve
//   stage 2 went from scoring 487 survivors in ~11s (unpaced, mostly-
//   wrong-under-load) to 232-in-244s (bucket rate, 55/min) — chronic
//   status:'partial', never promoted, `_latest` frozen at Jul 10. The
//   lynch sp500 scan (503 tickers × the same call ≈ +9 min) blew through
//   its 15-min container and died without even a runs/ doc; target/ndx
//   died to the account-level contention of prophet's now-continuous
//   token burn. Full diagnosis: reports/incidents/2026-07-15-stale-scans.md.
//
//   The disease is REFETCHING QUARTERLY-STABLE DATA 18×/day per ticker at
//   55/min. The cure is a shared, cross-container cache so each ticker's
//   earnings history costs ONE paced Finnhub call per TTL window — after
//   which every scan (prophet stages, lynch, target's analyst runner,
//   catalyst intel) reads Firestore at ~unbounded rpm.
//
// Semantics:
//   - LIVE data only. Never used when a caller passes asOfDate — PIT
//     reads keep their immutable pit-cache path untouched.
//   - TTL'd, caller-supplied per value: non-empty payloads default-cache
//     for ~26h (quarterly data; a day of staleness is immaterial to the
//     quality/trend layers that consume it), legitimately-empty payloads
//     for a short window (an ETF has no earnings today and tomorrow, but
//     we re-verify often since empty is also what a plan gap looks like).
//   - M8 discipline: failure-shaped results (HTTP !ok, parse fallback,
//     thrown transport) are NEVER cached — the caller must simply not
//     call `liveCacheSet` on those paths.
//   - Read/write failures degrade to a miss / no-op: the cache must never
//     make a fetch path less reliable than it was without it.
//   - In-process L1 map in front of Firestore: reused warm containers
//     skip the network read entirely; the L1 honors the same TTL rule.

import { createHash } from 'node:crypto';
import { getAdminDb } from './firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'providerLiveCache';

export interface LiveCacheKey {
  /** Provider slug, e.g. 'finnhub'. */
  provider: string;
  /** Endpoint slug, e.g. 'stock/earnings'. */
  endpoint: string;
  ticker: string;
  /** Discriminates request variants, e.g. 'limit=8:join=1'. */
  extra?: string;
}

interface LiveCacheDoc {
  key: LiveCacheKey;
  value: unknown;
  createdAt: string; // ISO
}

// ---------------------------------------------------------------------------
// Test seams (mirrors pit-cache's __setDbForTesting pattern)
// ---------------------------------------------------------------------------

let dbOverride: Firestore | null = null;
export function __setLiveCacheDbForTesting(db: Firestore | null): void {
  dbOverride = db;
}
const db = (): Firestore => dbOverride ?? getAdminDb();

const l1 = new Map<string, { at: number; value: unknown }>();
export function __clearLiveCacheL1ForTesting(): void {
  l1.clear();
}

export function liveCacheId(key: LiveCacheKey): string {
  const canonical = `${key.provider}|${key.endpoint}|${key.ticker}|${key.extra ?? ''}`;
  return createHash('sha1').update(canonical).digest('hex');
}

/**
 * Read a live cache entry. `maxAgeMsFor` receives the cached value and
 * returns the TTL that applies to it (this is how empty payloads get a
 * shorter shelf life than non-empty ones). Returns null on miss, expiry,
 * or any Firestore error.
 */
export async function liveCacheGet<T>(
  key: LiveCacheKey,
  maxAgeMsFor: (value: T) => number,
): Promise<T | null> {
  const id = liveCacheId(key);
  const now = Date.now();

  const memo = l1.get(id);
  if (memo && now - memo.at <= maxAgeMsFor(memo.value as T)) {
    return memo.value as T;
  }

  try {
    const snap = await db().collection(COLLECTION).doc(id).get();
    if (!snap.exists) return null;
    const data = snap.data() as LiveCacheDoc | undefined;
    if (!data || data.value === undefined) return null;
    const at = Date.parse(data.createdAt);
    if (!Number.isFinite(at)) return null;
    if (now - at > maxAgeMsFor(data.value as T)) return null;
    l1.set(id, { at, value: data.value });
    return data.value as T;
  } catch {
    // A broken cache read must never break the fetch path.
    return null;
  }
}

/**
 * Write a live cache entry. Only call this with success-shaped values —
 * the M8 rule (never cache a failure-shaped empty) is enforced at the
 * call site, where failure shapes are distinguishable. Write failures
 * are swallowed: caching is best-effort.
 *
 * Values are JSON-sanitized before the Firestore write: the admin SDK
 * rejects documents containing `undefined` (it isn't a Firestore type),
 * and provider result objects are full of optional fields (`latestBuy?`,
 * `surprisePct?`). Round-tripping through JSON strips undefined keys —
 * without this, any value with one optional-absent field silently never
 * cached (the set() threw into the swallow below).
 */
export async function liveCacheSet<T>(key: LiveCacheKey, value: T): Promise<void> {
  const id = liveCacheId(key);
  const createdAt = new Date().toISOString();
  const sanitized = JSON.parse(JSON.stringify(value)) as T;
  l1.set(id, { at: Date.parse(createdAt), value: sanitized });
  try {
    const doc: LiveCacheDoc = { key, value: sanitized, createdAt };
    await db().collection(COLLECTION).doc(id).set(doc);
  } catch {
    // Best-effort: the fresh value is already being returned to the caller.
  }
}

/**
 * Wrap a live-mode provider fetch with the cache. The M8 convention all
 * catalyst-layer providers share — `null` = transport failure, typed
 * empty object = verified-empty — maps directly: null results are NEVER
 * cached (a Finnhub outage must not become sticky "no insider activity"),
 * success shapes (including verified-empties) are cached at the caller's
 * TTL. Callers must route PIT reads (asOfDate) around this entirely.
 */
export async function liveCacheWrap<T>(
  key: LiveCacheKey,
  ttlMsFor: (value: T) => number,
  fetcher: () => Promise<T | null>,
): Promise<T | null> {
  const hit = await liveCacheGet<T>(key, ttlMsFor);
  if (hit !== null) return hit;
  const fresh = await fetcher();
  if (fresh !== null && fresh !== undefined) await liveCacheSet(key, fresh);
  return fresh;
}
