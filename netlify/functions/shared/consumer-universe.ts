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
import { applyUniversePolicy, type ExclusionReason } from './research-policy';

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
  return selectConsumerRows(snap.rows ?? [], limit).kept;
}

/**
 * Finviz reports "Average Volume" in THOUSANDS of shares — see
 * `camillo-research.ts`, which renders it as `${avgVolume}k`. The research
 * policy wants a dollar figure, so it is shares x 1000 x price.
 *
 * NOTE THE SUBSTITUTION, because the field is named for a median: this is an
 * AVERAGE, which is the only volume statistic the screener exposes. For a name
 * with one enormous print it reads higher than the median would, so the
 * liquidity floor is very slightly more permissive here than the policy
 * intends. Stated rather than silently glossed.
 */
export function dollarVolumeOf(row: FinvizRow): number | null {
  const vol = row.avgVolume;
  const px = row.price;
  if (!Number.isFinite(vol as number) || !Number.isFinite(px as number)) return null;
  return (vol as number) * 1000 * (px as number);
}

export interface ConsumerSelection {
  kept: FinvizRow[];
  /** Ticker -> why it was dropped, so the cut is never silent. */
  excluded: Record<string, ExclusionReason>;
  counts: Record<ExclusionReason, number>;
}

/**
 * Pure selection, split out so the rules are testable without a network or a
 * Finviz key.
 *
 * The ratified universe policy (`shared/research-policy.ts`, PR #198) is
 * applied BEFORE the cap sort, not after: filtering after the truncation would
 * mean a dropped name silently shrinks the watchlist below `limit` instead of
 * letting the next eligible name take its place. Those floors are code rather
 * than documentation precisely because a rule in a comment already drifted
 * once in this repo.
 */
export function selectConsumerRows(rows: FinvizRow[], limit: number): ConsumerSelection {
  const cap = Math.max(0, Math.floor(limit));
  const consumer = rows.filter((r) =>
    CONSUMER_SECTORS.includes(r.sector as (typeof CONSUMER_SECTORS)[number]));

  const policy = applyUniversePolicy(
    consumer.map((r) => ({ ...r, medianDollarVol: dollarVolumeOf(r) })),
  );

  const kept = policy.kept
    .sort((a, b) => (b.marketCapM ?? 0) - (a.marketCapM ?? 0) || a.ticker.localeCompare(b.ticker))
    .slice(0, cap)
    // Drop the derived field again so callers get a plain FinvizRow.
    .map(({ medianDollarVol: _ignored, ...row }) => row as FinvizRow);

  return { kept, excluded: policy.excluded, counts: policy.counts };
}
