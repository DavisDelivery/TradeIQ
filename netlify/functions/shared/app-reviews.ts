// APP REVIEW VELOCITY — consumer demand as a FLOW, available today.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// `app-ratings.ts` reports Apple's `userRatingCount`, which is lifetime
// cumulative: it says the app is big, which market cap already said. The
// honest conclusion there was that only the daily CHANGE carries information,
// and that the change series would have to be accumulated over months.
//
// That conclusion was too pessimistic. Apple's customer-reviews RSS feed
// returns INDIVIDUAL REVIEWS, each with a timestamp, a star rating and the app
// version. Counting them by date gives reviews-per-day directly — a real
// consumer-demand flow, computable on the first call, with no waiting.
//
// Verified 2026-08-04: Wingstop (454719277) returned 50 reviews per page
// spanning 2026-06-18..07-31 on page 1 and 2026-05-20..06-18 on page 2 — 100
// dated reviews over 72 days, comfortably enough to compare a recent 28-day
// window against the prior 28.
//
// ---------------------------------------------------------------------------
// THE CENSORING PROBLEM, WHICH IS THE WHOLE DIFFICULTY
//
// The feed returns a FIXED COUNT (≈50 per page, capped around 10 pages), not
// every review in a window. So the observation is "the most recent N reviews",
// and the time span they cover is an OUTPUT, not an input.
//
// That is fine for a rate: N reviews spanning D days really is N/D per day,
// because those N are a complete enumeration of the most recent ones. It is
// NOT fine for a recent-vs-prior comparison unless the span actually reaches
// back across both windows. A hot app can burn 500 reviews in a week; naively
// differencing would then compare a full recent window against a prior window
// the feed never covered, and manufacture a collapse in demand out of nothing
// but truncation.
//
// So `spanDays` is measured, `truncated` is reported, and the comparison is
// NULL rather than wrong whenever the span does not cover both windows.
//
// ---------------------------------------------------------------------------
// OTHER LIMITS, STATED
//
//   - US STORE ONLY. This is a US-iOS sample, not global demand. An app that
//     is big in Europe or on Android is invisible here.
//   - REVIEWS ARE NOT SALES. They are a biased sample of users — the delighted
//     and the furious — and Apple's in-app review prompt means the rate partly
//     tracks how aggressively the developer asks. A version release that adds
//     a prompt will lift the rate with no change in demand, which is why
//     `versionsInWindow` rides along.
//   - UNWEIGHTED, like every other attention leg. It earns weight through the
//     paper tracker or not at all.

import { logger } from './logger';

const log = logger.child({ mod: 'app-reviews' });

const RSS = 'https://itunes.apple.com/us/rss/customerreviews';

/** Comparison window in days, each side. */
export const WINDOW_DAYS = 28;
/** Feed pages to walk. Apple caps the feed around 10; 4 ≈ 200 reviews. */
export const MAX_PAGES = 4;
/** Below this many reviews no rate is reported — a handful is noise. */
export const MIN_REVIEWS = 10;

export interface ReviewPoint {
  date: string;
  rating: number;
  version: string | null;
}

export interface ReviewVelocity {
  available: boolean;
  appId: number | null;
  /** Reviews actually retrieved. */
  count: number;
  /** Days between the oldest and newest retrieved review. An OUTPUT. */
  spanDays: number | null;
  /** True when the feed ran out of pages before covering both windows. */
  truncated: boolean;
  /** Reviews/day over the recent window. Null when unmeasurable. */
  recentPerDay: number | null;
  /** Reviews/day over the prior window. Null when the span did not reach it. */
  priorPerDay: number | null;
  /** recent/prior - 1, as a percentage. NULL when either side is null. */
  velocityPct: number | null;
  /** Mean stars in the recent window, and in the prior one. */
  recentRating: number | null;
  priorRating: number | null;
  /** Distinct app versions seen in the recent window — see the prompt caveat. */
  versionsInWindow: number | null;
  newestReview: string | null;
  oldestReview: string | null;
  reason: string | null;
  caveat: string;
}

export const REVIEWS_CAVEAT =
  'US App Store reviews only — a US-iOS sample, not global demand. Reviews are a biased sample of ' +
  'users and the rate partly reflects how hard the app prompts for them, so a version release can ' +
  'lift it with no change in demand. A recent-vs-prior comparison is reported only when the feed ' +
  'actually covered both windows. The star average here is NOT comparable to the lifetime average ' +
  'from the ratings endpoint — this feed skews negative. No weight in any score.';

// THE STAR AVERAGE HERE IS NOT THE APP'S RATING. Measured 2026-08-04: Wingstop
// shows 4.91★ lifetime but 1.72★ across its most recent reviews; Crocs 4.73★
// lifetime versus 1.00★ recent. That is not a collapse in either product — the
// lifetime figure is dominated by silent one-tap ratings from Apple's in-app
// prompt, while people who take the trouble to WRITE a review skew heavily
// negative. Comparing `recentRating` here against `rating` from app-ratings.ts
// would manufacture a catastrophe out of a sampling difference.
//
// `recentRating` vs `priorRating` is a fair comparison — same feed, same bias
// on both sides. Anything else is not.

function empty(appId: number | null, reason: string): ReviewVelocity {
  return {
    available: false, appId, count: 0, spanDays: null, truncated: false,
    recentPerDay: null, priorPerDay: null, velocityPct: null,
    recentRating: null, priorRating: null, versionsInWindow: null,
    newestReview: null, oldestReview: null, reason, caveat: REVIEWS_CAVEAT,
  };
}

/**
 * Pull dated reviews out of Apple's RSS JSON.
 *
 * Entry 0 of the feed is the APP ITSELF, not a review — it carries no
 * `im:rating`, which is how it is filtered out here. Counting it would add a
 * phantom review dated to the app's last update.
 */
export function parseReviewEntries(body: any): ReviewPoint[] {
  const entries = body?.feed?.entry;
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
  const out: ReviewPoint[] = [];
  for (const e of list) {
    const rating = Number(e?.['im:rating']?.label);
    const date = e?.updated?.label;
    if (!Number.isFinite(rating) || rating < 1 || !date) continue;   // drops the app entry
    out.push({
      date: String(date).slice(0, 10),
      rating,
      version: e?.['im:version']?.label ? String(e['im:version'].label) : null,
    });
  }
  return out;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/**
 * Pure compute. `asOf` is injected so tests are not time-dependent and so the
 * caller controls what "now" means.
 */
export function computeVelocity(appId: number | null, reviews: ReviewPoint[], asOf: string): ReviewVelocity {
  if (reviews.length < MIN_REVIEWS) {
    return { ...empty(appId, `only ${reviews.length} reviews retrieved; need ${MIN_REVIEWS}`), count: reviews.length };
  }

  const sorted = [...reviews].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const newest = sorted[0].date;
  const oldest = sorted[sorted.length - 1].date;
  const spanDays = Math.max(1, dayDiff(newest, oldest));

  const back = (days: number) => new Date(Date.parse(asOf) - days * 86_400_000).toISOString().slice(0, 10);
  const recentCut = back(WINDOW_DAYS);
  const priorCut = back(2 * WINDOW_DAYS);

  const recent = sorted.filter((r) => r.date > recentCut);
  const prior = sorted.filter((r) => r.date <= recentCut && r.date > priorCut);

  // The feed is a fixed-count window. If its oldest review is NEWER than the
  // start of the prior window, that window was never covered and any
  // comparison against it would be measuring truncation, not demand.
  const coversPrior = oldest <= priorCut;
  const truncated = !coversPrior;

  const recentPerDay = recent.length ? Math.round((recent.length / WINDOW_DAYS) * 100) / 100 : 0;
  const priorPerDay = coversPrior ? Math.round((prior.length / WINDOW_DAYS) * 100) / 100 : null;

  const velocityPct =
    priorPerDay != null && priorPerDay > 0
      ? Math.round(((recentPerDay / priorPerDay) - 1) * 1000) / 10
      : null;

  return {
    available: true,
    appId,
    count: sorted.length,
    spanDays,
    truncated,
    recentPerDay,
    priorPerDay,
    velocityPct,
    recentRating: recent.length ? Math.round((mean(recent.map((r) => r.rating)) ?? 0) * 100) / 100 : null,
    priorRating: prior.length ? Math.round((mean(prior.map((r) => r.rating)) ?? 0) * 100) / 100 : null,
    versionsInWindow: recent.length ? new Set(recent.map((r) => r.version).filter(Boolean)).size : null,
    newestReview: newest,
    oldestReview: oldest,
    reason: truncated
      ? `feed covered only ${spanDays} days — not enough to compare against the prior ${WINDOW_DAYS}-day window, so no comparison is reported`
      : null,
    caveat: REVIEWS_CAVEAT,
  };
}

export async function fetchReviewVelocity(
  appId: number,
  opts: { fetchImpl?: typeof fetch; maxPages?: number; asOf?: string } = {},
): Promise<ReviewVelocity> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxPages = Math.min(opts.maxPages ?? MAX_PAGES, 10);
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const all: ReviewPoint[] = [];

  try {
    for (let p = 1; p <= maxPages; p++) {
      const url = `${RSS}/page=${p}/id=${appId}/sortBy=mostRecent/json`;
      const res = await doFetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        if (p === 1) return empty(appId, `Apple reviews RSS HTTP ${res.status}`);
        break;
      }
      // Apple serves this as text/javascript — parse the text, as elsewhere.
      const page = parseReviewEntries(JSON.parse(await res.text()));
      if (!page.length) break;
      all.push(...page);

      // Stop as soon as the span covers both windows; there is no reason to
      // keep paging Apple once the comparison is already computable.
      const oldest = all.reduce((m, r) => (r.date < m ? r.date : m), all[0].date);
      if (dayDiff(asOf, oldest) > 2 * WINDOW_DAYS) break;
    }
  } catch (err: any) {
    return empty(appId, `Apple reviews: ${String(err?.message ?? err)}`);
  }

  if (!all.length) return empty(appId, 'Apple returned no reviews for this app');
  const out = computeVelocity(appId, all, asOf);
  log.info('review_velocity', { appId, count: out.count, spanDays: out.spanDays, truncated: out.truncated, recentPerDay: out.recentPerDay });
  return out;
}
