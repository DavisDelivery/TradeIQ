// TRIDENT Smart Money context — assembles per-ticker InstitutionalInputs
// for the scans from what's actually ingested (design.md §4 phases).
//
// W2 state: activist 13D events (Firestore `tridentActivist`, fed by the
// watcher cron) + short interest (Massive, live-cached) + insider (wired
// in-scan). 13F conviction/cluster land in W3 — until then
// `convictionDataAvailable: false` tells the scorer to RENORMALIZE
// rather than score missing data as zero conviction.

import type { Firestore } from 'firebase-admin/firestore';
import { getShortInterest } from '../data-provider';
import { getCikTickerMap } from '../vector-data';
import { liveCacheGet, liveCacheSet } from '../provider-live-cache';
import type { InstitutionalInputs, ActivistEvent } from './scoring';
import type { ActivistEventDoc } from './activist-watch';

export const ACTIVIST_COLLECTION = 'tridentActivist';

/** One Firestore read per scan invocation: all live activist events →
 *  per-ticker lookup. Events older than 200d are ignored (the scorer's
 *  decay zeroes at 180d; the margin covers clock skew). */
export async function loadActivistMap(db: Firestore): Promise<Map<string, ActivistEvent>> {
  const cutoff = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
  const snap = await db
    .collection(ACTIVIST_COLLECTION)
    .where('filedAt', '>=', cutoff)
    .get();
  const byTicker = new Map<string, ActivistEvent>();
  for (const doc of snap.docs) {
    const d = doc.data() as ActivistEventDoc;
    const existing = byTicker.get(d.ticker);
    const candidate: ActivistEvent = {
      filer: d.filer,
      type: d.type,
      acceptedAt: d.filedAt,
    };
    // Keep the FRESHEST event per ticker (amendments refresh the clock).
    if (!existing || candidate.acceptedAt > existing.acceptedAt) {
      byTicker.set(d.ticker, candidate);
    }
  }
  return byTicker;
}

/** Build the scan's per-ticker institutionalFor callback. Short interest
 *  rides the provider live cache (7d TTL), so per-ticker cost after the
 *  first scan is one Firestore read. */
export function makeInstitutionalFor(
  activistByTicker: Map<string, ActivistEvent>,
): (ticker: string) => Promise<InstitutionalInputs | null> {
  return async (ticker: string) => {
    const activist = activistByTicker.get(ticker) ?? null;
    const si = await getShortInterest(ticker).catch(() => []);
    const latest = si[0] ?? null;
    return {
      activist,
      convictionAdds: [],
      convictionDataAvailable: false, // W3 flips this
      clusterCount: 0,
      shortInterestPctFloat: null, // float data not ingested; daysToCover carries crowding
      daysToCover: latest?.daysToCover ?? null,
      instShareOfFloatPct: null,
      breadthDecline: null,
      insiderNetBuyDollars: null, // filled in-scan from getInsiderActivity
    };
  };
}

const CIK_MAP_TTL_MS = 7 * 24 * 60 * 60_000;

/** SEC company_tickers.json behind the shared live cache — the canonical
 *  CIK→ticker map changes slowly, and EDGAR's WAF intermittently blocks
 *  Netlify's shared egress. One successful fetch serves a week of watcher
 *  runs; a cache hit means the watcher has NO hard EDGAR dependency
 *  beyond the per-day index files (which fail soft, day by day). */
export async function getCachedCikTickerMap(): Promise<Map<string, string>> {
  const key = { provider: 'sec', endpoint: 'company-tickers', ticker: '_all', extra: 'v1' };
  const hit = await liveCacheGet<Record<string, string>>(key, () => CIK_MAP_TTL_MS);
  if (hit && Object.keys(hit).length > 1000) return new Map(Object.entries(hit));
  const fresh = await getCikTickerMap();
  if (fresh.size > 1000) {
    await liveCacheSet(key, Object.fromEntries(fresh));
  }
  return fresh;
}
