// CONSUMER WATCHLIST — the one definition of "the names the Camillo stack
// looks at", shared by everything that needs it.
//
// This logic was written inline in `snapshot-social.ts` first. It is lifted
// here unchanged because a SECOND caller now needs the identical list, and
// two copies would drift: the daily social snapshot records app-rating and
// mention observations for exactly these tickers, and the detect pass reads
// those observations back. If the two lists ever disagree, the detect pass
// silently loses its history for the names that fell out of the other one.
//
// WHY LARGEST-FIRST, WHICH LOOKS BACKWARDS FOR A SMALL-CAP STRATEGY
//
// It is a STABILITY choice, not a quality ranking, and it is load-bearing for
// the history: ApeWisdom serves no per-ticker history and Apple's rating count
// is lifetime-cumulative, so both only become a series because this job writes
// one down every day. A watchlist that churns produces a ragged panel where
// most tickers have two observations and none has a series. Sorting by market
// cap inside an already-small-cap universe (russell2k) is simply the most
// stable orderable field available.
//
// THE COST, STATED PLAINLY: the set is effectively FIXED. A name outside the
// top `limit` of the consumer sectors can never be surfaced by anything built
// on this list, however loudly it is trending. That is a real coverage ceiling
// and it is the first thing to revisit if the detect pass ever earns its keep.

import { getFinvizUniverseSnapshot, type FinvizRow, type FinvizUniverse } from './finviz';

/** Finviz sectors that count as consumer-facing for this strategy. */
export const CONSUMER_SECTORS = ['Consumer Cyclical', 'Consumer Defensive'] as const;

/** Default size. Matches the Apple polling budget in `snapshot-social.ts`. */
export const DEFAULT_WATCHLIST_LIMIT = 40;

/**
 * The consumer names worth tracking, biggest float first so the list is
 * stable day to day.
 *
 * Returns `null` — never `[]` — when the universe snapshot could not be
 * fetched. An empty array would read downstream as "there are no consumer
 * names", which is a claim about the market rather than about our data.
 */
export async function consumerWatchlist(
  limit = DEFAULT_WATCHLIST_LIMIT,
  universe: FinvizUniverse = 'russell2k',
): Promise<FinvizRow[] | null> {
  const snap = await getFinvizUniverseSnapshot(universe).catch(() => null);
  if (!snap) return null;
  return selectConsumerRows(snap.rows ?? [], limit);
}

/**
 * Pure selection, split out so the ordering rule is testable without a
 * network or a Finviz key.
 */
export function selectConsumerRows(rows: FinvizRow[], limit: number): FinvizRow[] {
  const cap = Math.max(0, Math.floor(limit));
  return rows
    .filter((r) => CONSUMER_SECTORS.includes(r.sector as (typeof CONSUMER_SECTORS)[number]))
    .filter((r) => typeof r.marketCapM === 'number' && (r.marketCapM as number) > 0)
    .sort((a, b) => (b.marketCapM ?? 0) - (a.marketCapM ?? 0) || a.ticker.localeCompare(b.ticker))
    .slice(0, cap);
}
