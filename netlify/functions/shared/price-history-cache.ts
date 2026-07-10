// DESK-1 W1 — shared per-ticker price-bar cache, extracted from
// price-history.ts so /api/desk-stats can read the SAME Firestore cache
// (`priceHistory/{ticker}.ranges.{range}`) instead of maintaining a
// parallel one. Contract unchanged: daily ranges are fresh for the
// calendar day they were fetched; intraday ranges (1D/5D, DESK-1) are
// fresh for 5 minutes (INTRADAY_TTL_MS) since minute bars move.

import type { Firestore } from 'firebase-admin/firestore';
import type { Bar } from './data-provider';
import { getAdminDb } from './firebase-admin';

export const PRICE_HISTORY_COLLECTION = 'priceHistory';

/** 1D/5D cache freshness window (minute bars move; daily bars don't). */
export const INTRADAY_TTL_MS = 5 * 60 * 1000;

export interface PriceBar {
  date: string;  // YYYY-MM-DD (UTC) for daily bars; "YYYY-MM-DD HH:mm" for intraday
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CachedRange {
  asOfDate: string;  // YYYY-MM-DD when these bars were fetched
  /** Fetch timestamp (ms epoch) — set for intraday ranges so the 5-min
   *  TTL can be evaluated. Daily ranges may omit it (date-keyed). */
  asOfMs?: number;
  bars: PriceBar[];
  /** True when the Polygon plan rejected intraday resolution and the
   *  bars are a daily-bar fallback. UI hides the 1D/5D toggles. */
  intradayUnavailable?: boolean;
}

export interface PriceHistoryDoc {
  ranges?: Partial<Record<string, CachedRange>>;
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function toPriceBar(b: Bar): PriceBar {
  // Polygon bar timestamp is ms since epoch (UTC). Slice to YYYY-MM-DD.
  return {
    date: new Date(b.t).toISOString().slice(0, 10),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  };
}

export function toIntradayPriceBar(b: Bar): PriceBar {
  // Keep minute resolution: "YYYY-MM-DD HH:mm" (UTC — honest about the
  // snapshot timezone; the chart renders the label as-is).
  const iso = new Date(b.t).toISOString();
  return {
    date: `${iso.slice(0, 10)} ${iso.slice(11, 16)}`,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  };
}

export async function readRangeCache(
  ticker: string,
  range: string,
  dbOverride?: Firestore,
): Promise<CachedRange | null> {
  let db: Firestore;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    return null;
  }
  try {
    const snap = await db.collection(PRICE_HISTORY_COLLECTION).doc(ticker).get();
    if (!snap.exists) return null;
    const data = snap.data() as PriceHistoryDoc | undefined;
    return data?.ranges?.[range] ?? null;
  } catch {
    return null;
  }
}

export async function writeRangeCache(
  ticker: string,
  range: string,
  payload: CachedRange,
  dbOverride?: Firestore,
): Promise<void> {
  let db: Firestore;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    return;
  }
  // Merge so the document accumulates ranges over time - opening 1M
  // shouldn't wipe the cached 6M (or vice versa).
  await db
    .collection(PRICE_HISTORY_COLLECTION)
    .doc(ticker)
    .set({ ranges: { [range]: payload } }, { merge: true });
}

/** Is a cached intraday range still inside its 5-minute TTL? */
export function isIntradayFresh(cached: CachedRange, nowMs: number): boolean {
  return typeof cached.asOfMs === 'number' && nowMs - cached.asOfMs < INTRADAY_TTL_MS;
}
