// Phase 6 PR-H — Firestore-backed thesis cache keyed by
// (ticker, snapshotDate).
//
// Why per-snapshot: a snapshot is the canonical input to the Claude
// prompt — same ticker on different snapshots can produce a different
// thesis because price/score/layer-pass shifts. Keying on snapshotDate
// makes the cache hit-rate excellent within a trading day (every panel
// re-open serves from cache) and naturally rolls over when the next
// scheduled snapshot lands.
//
// Collection: `thesisCache/{ticker}__{snapshotDate}`. Read returns null
// on miss. Write is a single set() — best-effort, errors swallowed (a
// cache write failure must never break the panel response).

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from './firebase-admin';

const COLLECTION = 'thesisCache';

export interface ThesisCacheEntry {
  ticker: string;
  snapshotDate: string;   // YYYY-MM-DD
  text: string;
  model: string;
  generatedAt: string;    // ISO 8601 UTC
}

function docId(ticker: string, snapshotDate: string): string {
  return `${ticker.toUpperCase()}__${snapshotDate}`;
}

let _dbOverride: Firestore | null = null;

/** Test seam. */
export function __setThesisDbForTesting(db: Firestore | null): void {
  _dbOverride = db;
}

function db(): Firestore {
  return _dbOverride ?? getAdminDb();
}

export async function getCachedThesis(
  ticker: string,
  snapshotDate: string,
): Promise<ThesisCacheEntry | null> {
  try {
    const snap = await db().collection(COLLECTION).doc(docId(ticker, snapshotDate)).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data?.text || typeof data.text !== 'string') return null;
    return {
      ticker: data.ticker ?? ticker.toUpperCase(),
      snapshotDate: data.snapshotDate ?? snapshotDate,
      text: data.text,
      model: data.model ?? 'unknown',
      generatedAt: data.generatedAt ?? '',
    };
  } catch {
    return null;
  }
}

export async function setCachedThesis(
  ticker: string,
  snapshotDate: string,
  text: string,
  model: string,
): Promise<void> {
  try {
    await db()
      .collection(COLLECTION)
      .doc(docId(ticker, snapshotDate))
      .set({
        ticker: ticker.toUpperCase(),
        snapshotDate,
        text,
        model,
        generatedAt: new Date().toISOString(),
      } satisfies ThesisCacheEntry);
  } catch {
    // best-effort
  }
}
