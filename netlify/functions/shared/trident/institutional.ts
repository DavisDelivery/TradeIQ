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
