// RETAIL MENTIONS — the WallStreetBets leg Quiver will not sell us.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// Probed 2026-08-04 with a live key: Quiver's /historical/wallstreetbets and
// /historical/twitter return 403 on the Hobbyist plan, and neither appears on
// ANY tier Quiver publishes — the $75/mo Trader upgrade buys app ratings, not
// mentions. So the investor-saturation leg cannot be bought from Quiver at all.
//
// ApeWisdom publishes the same measurement free and keyless: mention counts
// per ticker across r/wallstreetbets and ~a dozen other finance subreddits,
// with the 24h-ago count alongside, so velocity comes for free.
//
// ---------------------------------------------------------------------------
// THE LIMITATION THAT SHAPES THIS WHOLE MODULE
//
// IT IS A LIVE SNAPSHOT, NOT A HISTORY. There is no per-ticker time series
// endpoint. Verified 2026-08-04: 757 tickers tracked across 8 pages of
// `all-stocks`, ranked by current mentions, down to a floor of 1 mention.
//
// So the series we will want in three months only exists if we start
// recording it today. `snapshotMentions()` writes one Firestore doc per day
// and `readMentionSnapshot(date)` reads a day back. That is the point of this
// file — the fetch is the easy part.
//
// NOTE: there is deliberately no `mentionHistory()` range reader yet. Nothing
// needs one until enough days have accumulated to be worth reading, and a
// range API written against an empty collection is a guess about a shape we
// cannot see. Build it when there is a series to read.
//
// ---------------------------------------------------------------------------
// ABSENCE IS NOT ZERO, AND IT IS NOT NOTHING
//
// A ticker missing from the list has mentions BELOW THE TRACKING FLOOR, not
// zero mentions. `mentions` is therefore `null` for an untracked name, never
// 0 — the same discipline that caught the fake +16.2% backtest result.
//
// But absence is still informative in this frame, which is why it gets its
// own state rather than being folded into "no data": in the Camillo setup an
// undiscovered small-cap SHOULD be absent. Confirmed on the live list —
// CROX rank 399 (1 mention), CELH rank 73 (7), GME rank 100 (5), while BROS,
// CHWY, YETI, DECK and WING were not tracked at all.
//
// ---------------------------------------------------------------------------
// SOURCE RISK, STATED PLAINLY
//
// ApeWisdom publishes NO terms of service, NO rate limits and NO commercial-use
// statement (checked 2026-08-04). That is fine for personal research and NOT
// fine as the backbone of a product you charge for. Two consequences:
//
//   1. Every call is best-effort. A failure is `available: false` with a
//      reason; nothing downstream is allowed to hard-depend on it.
//   2. If TradeIQ ever goes commercial, replace this with the official Reddit
//      API (OAuth, 100 QPM, free tier is non-commercial) or get written
//      permission. The adapter boundary is deliberately narrow so the swap is
//      one file.
//
// UNWEIGHTED, like every other attention leg here. It earns weight through the
// paper tracker or not at all.

import { getAdminDb } from './firebase-admin';
import { logger } from './logger';

const log = logger.child({ mod: 'social-mentions' });

const APEWISDOM = 'https://apewisdom.io/api/v1.0/filter';
const UA = 'TradeIQ/1.0 (research; +https://github.com/DavisDelivery/TradeIQ)';

/** Firestore: one doc per calendar day, ~757 rows ≈ 25KB, far under the 1MiB cap. */
export const MENTION_COLLECTION = 'socialMentionSnapshots';

/** Pages to walk. 8 covers the full tracked list with headroom. */
const MAX_PAGES = 10;

export interface MentionRow {
  ticker: string;
  name: string | null;
  rank: number;
  mentions: number;
  upvotes: number | null;
  /** Mentions 24h earlier. Null when the source had no prior observation. */
  mentions24hAgo: number | null;
  rank24hAgo: number | null;
}

export interface MentionSnapshot {
  date: string;
  filter: string;
  available: boolean;
  rows: MentionRow[];
  /** Lowest mention count present — the tracking floor. Below this = untracked. */
  floor: number | null;
  reason: string | null;
  fetchedAt: string;
}

/** One ticker's read, with absence modelled explicitly. */
export interface TickerMentions {
  ticker: string;
  /** TRACKED = on the list. BELOW_FLOOR = quieter than the quietest tracked
   *  name. UNAVAILABLE = we could not look. These are three different facts. */
  state: 'TRACKED' | 'BELOW_FLOOR' | 'UNAVAILABLE';
  /** Null when not tracked — NEVER 0. Absence is a floor, not a count. */
  mentions: number | null;
  mentions24hAgo: number | null;
  rank: number | null;
  /** Of how many tracked tickers. Context for the rank. */
  universeSize: number | null;
  /** The tracking floor, so "below floor" has a number attached. */
  floor: number | null;
  date: string | null;
  reason: string | null;
  caveat: string;
}

export const MENTIONS_CAVEAT =
  'Retail mention counts from ApeWisdom (r/wallstreetbets and related subreddits), a live snapshot ' +
  'with no per-ticker history and no published terms of service. Absence from the list means BELOW ' +
  'THE TRACKING FLOOR, not zero. Displayed as context only — carries no weight in any score, and in ' +
  'this frame heavy retail chatter argues AGAINST an undiscovered setup.';

const iso = (d = new Date()) => d.toISOString().slice(0, 10);

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Normalise one ApeWisdom result row. Rows without a ticker or count are dropped. */
export function normaliseMentionRows(pages: unknown[]): MentionRow[] {
  const out: MentionRow[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const results = (page as any)?.results;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      const ticker = typeof r?.ticker === 'string' ? r.ticker.toUpperCase().trim() : null;
      const mentions = num(r?.mentions);
      const rank = num(r?.rank);
      if (!ticker || mentions == null || rank == null) continue;
      if (seen.has(ticker)) continue;   // pages can overlap on a live-updating list
      seen.add(ticker);
      out.push({
        ticker,
        name: typeof r?.name === 'string' && r.name.trim() ? r.name.trim() : null,
        rank,
        mentions,
        upvotes: num(r?.upvotes),
        // null (not 0) when the source has no prior observation — a brand-new
        // entrant and a name that fell to zero are different events.
        mentions24hAgo: num(r?.mentions_24h_ago),
        rank24hAgo: num(r?.rank_24h_ago),
      });
    }
  }
  out.sort((a, b) => a.rank - b.rank);
  return out;
}

/**
 * Walk the paginated list and build today's snapshot.
 *
 * Stops early when a page returns nothing, and stops hard at MAX_PAGES so a
 * source-side change to `pages` cannot turn this into an unbounded crawl.
 */
export async function fetchMentionSnapshot(
  filter = 'all-stocks',
  opts: { fetchImpl?: typeof fetch; maxPages?: number } = {},
): Promise<MentionSnapshot> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxPages = Math.min(opts.maxPages ?? MAX_PAGES, MAX_PAGES);
  const fetchedAt = new Date().toISOString();
  const pages: unknown[] = [];

  try {
    let declared: number | null = null;
    for (let p = 1; p <= maxPages; p++) {
      const res = await doFetch(`${APEWISDOM}/${encodeURIComponent(filter)}/page/${p}`, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
      });
      if (!res.ok) {
        if (p === 1) {
          return { date: iso(), filter, available: false, rows: [], floor: null, fetchedAt, reason: `ApeWisdom HTTP ${res.status}` };
        }
        break;   // partial is still useful; the reason rides along below
      }
      // The endpoint has served application/json and text/javascript at
      // different times, so parse the text rather than trusting the header.
      const body = JSON.parse(await res.text());
      pages.push(body);
      declared = num(body?.pages) ?? declared;
      if (!Array.isArray(body?.results) || body.results.length === 0) break;
      if (declared != null && p >= declared) break;
    }
  } catch (err: any) {
    return { date: iso(), filter, available: false, rows: [], floor: null, fetchedAt, reason: `ApeWisdom: ${String(err?.message ?? err)}` };
  }

  const rows = normaliseMentionRows(pages);
  if (!rows.length) {
    return { date: iso(), filter, available: false, rows: [], floor: null, fetchedAt, reason: 'ApeWisdom returned no usable rows' };
  }
  const floor = Math.min(...rows.map((r) => r.mentions));
  log.info('mention_snapshot', { filter, rows: rows.length, floor });
  return { date: iso(), filter, available: true, rows, floor, reason: null, fetchedAt };
}

/**
 * Persist one day's snapshot. Idempotent on date+filter, so a re-run replaces
 * rather than duplicating.
 *
 * A snapshot that is not `available` is NEVER written — caching a failure as a
 * value would freeze a day into "nobody mentioned anything", which is a lie
 * that would survive in the history forever.
 */
export async function snapshotMentions(snap: MentionSnapshot): Promise<boolean> {
  if (!snap.available || !snap.rows.length) {
    log.warn('snapshot_not_written', { reason: snap.reason });
    return false;
  }
  const db = getAdminDb();
  await db.collection(MENTION_COLLECTION).doc(`${snap.date}_${snap.filter}`).set({
    date: snap.date,
    filter: snap.filter,
    fetchedAt: snap.fetchedAt,
    floor: snap.floor,
    universeSize: snap.rows.length,
    rows: snap.rows,
  });
  log.info('snapshot_written', { date: snap.date, rows: snap.rows.length });
  return true;
}

/** Firestore: one doc per day of cumulative app-rating counts. */
export const APP_RATING_COLLECTION = 'appRatingSnapshots';

export interface AppRatingObservation {
  ticker: string;
  appId: number | null;
  appName: string | null;
  rating: number | null;
  /** Lifetime cumulative — the whole reason this needs recording daily. */
  ratingCount: number | null;
}

/**
 * Persist one day of cumulative rating counts.
 *
 * `app-reviews.ts` gives review velocity immediately, so this is no longer the
 * only route to a flow — but the two measure different things. Reviews are the
 * subset of users who wrote something; the rating COUNT includes every silent
 * one-tap rating from Apple's prompt, which is a much larger and less
 * self-selected population. Its daily delta is the better demand proxy of the
 * two, and it is only obtainable by differencing days we recorded ourselves.
 *
 * Rows with no ratingCount are dropped rather than stored as 0 — a fabricated
 * zero here would show up months later as a demand collapse.
 */
export async function snapshotAppRatings(date: string, rows: AppRatingObservation[]): Promise<number> {
  const usable = rows.filter((r) => r.ratingCount != null && r.appId != null);
  if (!usable.length) {
    log.warn('app_rating_snapshot_empty');
    return 0;
  }
  const db = getAdminDb();
  await db.collection(APP_RATING_COLLECTION).doc(date).set({
    date,
    fetchedAt: new Date().toISOString(),
    count: usable.length,
    rows: usable,
  });
  log.info('app_rating_snapshot_written', { date, rows: usable.length });
  return usable.length;
}

/** One recorded day of cumulative app-rating counts. */
export interface AppRatingDay {
  date: string;
  rows: AppRatingObservation[];
}

/**
 * Read the last `days` recorded days of app-rating counts, oldest first.
 *
 * The counterpart to `readMentionHistory`, and the reader this collection has
 * been waiting for: `snapshotAppRatings` has been writing a row per consumer
 * name every day since the cron went live and NOTHING has ever read it back.
 *
 * Why it matters more than the mention leg: the trend study's own conclusion
 * is that "signals from what consumers DO (sales rank, review velocity,
 * downloads) do not reverse; signals from what people LOOK AT do". Wikipedia
 * pageviews and forum chatter are both look-at signals. An app-rating count is
 * a do signal — somebody opened the app and tapped a star.
 *
 * Reads by constructed doc id, so no composite index and one `getAll` round
 * trip. A day the cron did not run is simply absent; the caller is given the
 * count so it can refuse to compute on too thin a history.
 */
export async function readAppRatingHistory(
  days: number,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<AppRatingDay[]> {
  const n = Math.max(1, Math.floor(days));
  const db = getAdminDb();
  const base = Date.parse(`${asOf}T00:00:00Z`);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  }
  const docs = await db.getAll(...ids.map((id) => db.collection(APP_RATING_COLLECTION).doc(id)));
  const out: AppRatingDay[] = [];
  for (const doc of docs) {
    if (!doc.exists) continue;
    const d = doc.data() as any;
    out.push({ date: d.date, rows: (d.rows ?? []) as AppRatingObservation[] });
  }
  // Oldest first — a series, not a stack.
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  log.info('app_rating_history_read', { requested: n, found: out.length });
  return out;
}

/** Read a stored day back. Null when that day was never recorded. */
export async function readMentionSnapshot(date: string, filter = 'all-stocks'): Promise<MentionSnapshot | null> {
  const db = getAdminDb();
  const doc = await db.collection(MENTION_COLLECTION).doc(`${date}_${filter}`).get();
  if (!doc.exists) return null;
  const d = doc.data() as any;
  return {
    date: d.date, filter: d.filter, available: true, rows: d.rows ?? [],
    floor: d.floor ?? null, reason: null, fetchedAt: d.fetchedAt,
  };
}

/**
 * Read the last `days` recorded days, newest first, skipping days that were
 * never written.
 *
 * The header of this file says there is deliberately no range reader "until
 * enough days have accumulated to be worth reading". That day is arriving:
 * `trend-detect.ts` needs a mention SERIES to compare a recent window against
 * a baseline, and the only place that series can come from is the docs this
 * module has been writing since the snapshot cron went live.
 *
 * It reads by CONSTRUCTED DOC ID rather than by query, so it needs no
 * composite index and costs one `getAll` round trip. Missing days are simply
 * absent from the result — a day the cron did not run is not a day with no
 * chatter, and the caller is given the count so it can refuse to compute on
 * too thin a history.
 */
export async function readMentionHistory(
  days: number,
  filter = 'all-stocks',
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<MentionSnapshot[]> {
  const n = Math.max(1, Math.floor(days));
  const db = getAdminDb();
  const base = Date.parse(`${asOf}T00:00:00Z`);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(base - i * 86_400_000).toISOString().slice(0, 10);
    ids.push(`${d}_${filter}`);
  }
  const refs = ids.map((id) => db.collection(MENTION_COLLECTION).doc(id));
  const docs = await db.getAll(...refs);
  const out: MentionSnapshot[] = [];
  for (const doc of docs) {
    if (!doc.exists) continue;
    const d = doc.data() as any;
    out.push({
      date: d.date, filter: d.filter, available: true, rows: d.rows ?? [],
      floor: d.floor ?? null, reason: null, fetchedAt: d.fetchedAt,
    });
  }
  // Newest first regardless of the order Firestore returns them in.
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  log.info('mention_history_read', { requested: n, found: out.length });
  return out;
}

/**
 * Resolve one ticker against a snapshot, keeping the three states distinct.
 * Pure — takes the snapshot rather than fetching, so it is trivially testable.
 */
export function readTicker(ticker: string, snap: MentionSnapshot | null): TickerMentions {
  const t = ticker.toUpperCase();
  const base = { ticker: t, caveat: MENTIONS_CAVEAT };
  if (!snap || !snap.available) {
    return {
      ...base, state: 'UNAVAILABLE', mentions: null, mentions24hAgo: null, rank: null,
      universeSize: null, floor: null, date: snap?.date ?? null,
      reason: snap?.reason ?? 'no mention snapshot available',
    };
  }
  const hit = snap.rows.find((r) => r.ticker === t);
  if (!hit) {
    return {
      ...base, state: 'BELOW_FLOOR',
      // Deliberately null. "Fewer than `floor`" is the honest statement and
      // `floor` carries it; a 0 here would be a measurement we did not make.
      mentions: null, mentions24hAgo: null, rank: null,
      universeSize: snap.rows.length, floor: snap.floor, date: snap.date,
      reason: `not among the ${snap.rows.length} tickers tracked; fewer than ${snap.floor} mentions`,
    };
  }
  return {
    ...base, state: 'TRACKED', mentions: hit.mentions, mentions24hAgo: hit.mentions24hAgo,
    rank: hit.rank, universeSize: snap.rows.length, floor: snap.floor, date: snap.date, reason: null,
  };
}

/** Convenience: live fetch + resolve, for the on-demand research path. */
export async function fetchTickerMentions(ticker: string, filter = 'all-stocks'): Promise<TickerMentions> {
  const snap = await fetchMentionSnapshot(filter).catch(() => null);
  return readTicker(ticker, snap);
}
