// Phase 4h W3 — persistent ticker → company-name cache.
//
// Company name is enriched onto every snapshot pick so the UI can render
// "AAPL — Apple Inc." instead of a bare ticker. Polygon's
// /v3/reference/tickers/{ticker} is the canonical source; reference data
// effectively never changes, so cache aggressively in Firestore at
// `tickerReference/{ticker}` and only call Polygon on a miss.
//
// First scan of a fresh universe → ~N Polygon lookups. All subsequent
// scans → near-zero (cache hits). On Polygon failure, fall back to the
// in-repo `findEntry(ticker)?.name` so a transient network blip can't
// blank the company-name column.

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from './firebase-admin';
import { findEntry } from './universe';

const POLYGON = 'https://api.polygon.io';
const COLLECTION = 'tickerReference';
const POLYGON_TIMEOUT_MS = 5_000;
const POLYGON_CONCURRENCY = 6;

interface TickerReferenceDoc {
  name: string;
  fetchedAt: string;
}

/**
 * Local fallback used when Firestore + Polygon are unavailable. The
 * in-repo universe table carries authoritative names for the ~2,500
 * tickers TradeIQ scans today; we still go to Polygon first so the
 * cache stays canonical for any future ticker the table doesn't cover.
 */
export function localFallbackName(ticker: string): string {
  return findEntry(ticker)?.name ?? ticker;
}

function polygonKey(): string | null {
  return process.env.POLYGON_API_KEY ?? null;
}

/**
 * Single-ticker lookup. Cache-first; on miss → Polygon → write-through →
 * return. Falls back to the in-repo name if both Firestore and Polygon
 * are unreachable so callers always get a non-empty string.
 */
export async function getTickerName(
  ticker: string,
  dbOverride?: Firestore,
): Promise<string> {
  let db: Firestore | null = null;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    return localFallbackName(ticker);
  }

  try {
    const snap = await db.collection(COLLECTION).doc(ticker).get();
    if (snap.exists) {
      const data = snap.data() as TickerReferenceDoc | undefined;
      if (data?.name) return data.name;
    }
  } catch {
    // continue to Polygon fetch
  }

  const fetched = await fetchFromPolygon(ticker);
  if (fetched) {
    try {
      await db
        .collection(COLLECTION)
        .doc(ticker)
        .set({ name: fetched, fetchedAt: new Date().toISOString() });
    } catch {
      // cache write is best-effort
    }
    return fetched;
  }
  return localFallbackName(ticker);
}

/**
 * Bulk lookup. Reads all cache docs in parallel, fetches only the
 * misses from Polygon (concurrency-limited), writes them back, returns
 * a complete `{ticker: name}` map. Order is irrelevant — callers index
 * by ticker.
 *
 * Used by the russell2k / sp500 scans to enrich snapshots in O(misses)
 * Polygon calls per scan. After the first warm-up scan, misses → 0.
 */
export async function enrichTickerNames(
  tickers: string[],
  dbOverride?: Firestore,
): Promise<Record<string, string>> {
  const unique = Array.from(new Set(tickers));
  const out: Record<string, string> = {};
  if (unique.length === 0) return out;

  let db: Firestore | null = null;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    for (const t of unique) out[t] = localFallbackName(t);
    return out;
  }

  const reads = await Promise.all(
    unique.map((t) =>
      db!
        .collection(COLLECTION)
        .doc(t)
        .get()
        .then(
          (s) =>
            [t, s.exists ? (s.data() as TickerReferenceDoc | undefined) ?? null : null] as const,
        )
        .catch(() => [t, null] as const),
    ),
  );

  const misses: string[] = [];
  for (const [t, data] of reads) {
    if (data?.name) {
      out[t] = data.name;
    } else {
      misses.push(t);
    }
  }

  if (misses.length === 0) return out;

  for (let i = 0; i < misses.length; i += POLYGON_CONCURRENCY) {
    const batch = misses.slice(i, i + POLYGON_CONCURRENCY);
    const fetched = await Promise.all(
      batch.map(async (t) => [t, await fetchFromPolygon(t)] as const),
    );
    const writes: Array<Promise<unknown>> = [];
    const fetchedAt = new Date().toISOString();
    for (const [t, name] of fetched) {
      if (name) {
        out[t] = name;
        writes.push(
          db
            .collection(COLLECTION)
            .doc(t)
            .set({ name, fetchedAt })
            .catch(() => undefined),
        );
      } else {
        out[t] = localFallbackName(t);
      }
    }
    await Promise.all(writes);
  }

  return out;
}

async function fetchFromPolygon(ticker: string): Promise<string | null> {
  const key = polygonKey();
  if (!key) return null;
  const url = `${POLYGON}/v3/reference/tickers/${encodeURIComponent(ticker)}?apiKey=${key}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), POLYGON_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: { name?: string } };
    const name = data?.results?.name;
    return typeof name === 'string' && name.length > 0 ? name : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Exposed for tests.
export const _internals = { COLLECTION };
