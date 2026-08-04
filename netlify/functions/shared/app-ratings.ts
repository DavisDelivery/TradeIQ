// APP-STORE RATINGS — the consumer-demand leg, free, straight from Apple.
//
// Quiver sells this on the $75/mo Trader tier. Apple's own iTunes Search API
// serves the same numbers keyless and unlimited-ish. Verified live 2026-08-04:
//
//   Crocs        4.73★  46,441 ratings
//   Dutch Bros   4.93★  862,554 ratings
//   Chewy        4.91★  1,054,643 ratings
//
// This is the ONE leg in the whole Camillo stack that measures behaviour
// rather than curiosity: a Wikipedia pageview or a Google search is someone
// looking, an app rating is someone who downloaded, used, and bothered to
// score it. That makes it the most interesting attention source here — and
// the most likely to eventually earn weight.
//
// ---------------------------------------------------------------------------
// THREE HAZARDS, ALL OF WHICH LOOK LIKE SIGNAL IF YOU IGNORE THEM
//
//   1. THE COUNT IS CUMULATIVE AND LIFETIME. `userRatingCount` only ever
//      rises. Its LEVEL says how big the app is, which you already knew from
//      market cap. Only the DAILY DELTA is a demand flow — which again means
//      the series must be recorded, not fetched. See social-mentions.ts for
//      the same argument.
//   2. THE CURRENT-VERSION SPLIT RESETS ON RELEASE.
//      `userRatingCountForCurrentVersion` looks like a lovely short-window
//      flow until you notice it zeroes every time the developer ships. It is
//      reported here but must never be differenced across a version change,
//      so `currentVersionReleaseDate` travels with it.
//   3. NAME MATCHING IS THE REAL RISK. Searching "crocs" for CROX works;
//      searching a holding company's legal name usually does not, and a wrong
//      match silently attributes a stranger's app to your ticker. So the
//      resolved app id, name and seller are ALWAYS returned for eyeballing,
//      and a low-confidence match is flagged rather than quietly used.
//
// UNWEIGHTED until the paper tracker says otherwise.
//
// Terms: this is Apple's public Search API. It is intended for surfacing
// Apple content and has no key or published rate limit, but Apple does throttle
// aggressively (~20 calls/min observed by others). Cache accordingly; never
// hammer it per screen row.

import { logger } from './logger';

const log = logger.child({ mod: 'app-ratings' });

const ITUNES_SEARCH = 'https://itunes.apple.com/search';

export interface AppRating {
  available: boolean;
  /** Apple's numeric app id — the stable key. Store this, not the name. */
  appId: number | null;
  appName: string | null;
  seller: string | null;
  /** Mean rating, all versions, 0-5. */
  rating: number | null;
  /** LIFETIME cumulative count. A level, not a flow. */
  ratingCount: number | null;
  /** Current-version mean. Resets on release — see hazard 2. */
  ratingCurrentVersion: number | null;
  ratingCountCurrentVersion: number | null;
  /** The date that reset happened. Required to interpret the two fields above. */
  currentVersionReleaseDate: string | null;
  /** How well the app matched the company name. Low = do not trust it. */
  matchConfidence: 'HIGH' | 'LOW' | 'NONE';
  matchedOn: string | null;
  reason: string | null;
  caveat: string;
}

export const APP_RATINGS_CAVEAT =
  'App-store ratings from Apple\'s public Search API. The rating COUNT is lifetime cumulative — only ' +
  'its daily change is a demand flow, and the current-version count resets on every release. The app ' +
  'is matched by company name, so check the resolved app name before believing it. No weight in any score.';

function empty(reason: string, confidence: AppRating['matchConfidence'] = 'NONE'): AppRating {
  return {
    available: false, appId: null, appName: null, seller: null, rating: null, ratingCount: null,
    ratingCurrentVersion: null, ratingCountCurrentVersion: null, currentVersionReleaseDate: null,
    matchConfidence: confidence, matchedOn: null, reason, caveat: APP_RATINGS_CAVEAT,
  };
}

const norm = (s: string) =>
  s.toLowerCase()
    // Strip corporate suffixes before comparing — "Crocs, Inc." should match
    // the "Crocs" app, but "Crocs" should not match "Crocs Wholesale Portal".
    .replace(/\b(inc|incorporated|corp|corporation|co|company|holdings?|group|plc|ltd|limited|sa|nv|ag)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Score a candidate app against the company name.
 *
 * The rule that matters is the one that keeps "Crocs Wallpapers HD" away from
 * CROX. An earlier version scored any app whose name STARTED with the company
 * name as HIGH, which promoted exactly that fan-made wallpaper app over the
 * real one — the wrong-attribution hazard in this file's header, created by
 * the very function meant to prevent it. Caught by test, not in production.
 *
 * So a trailing descriptor only counts when a DELIMITER separates it:
 * "Chewy - Pet Care & Pharmacy" is Chewy's app, "Chewy Vitamins Tracker" is
 * somebody else's. The delimiter has to be read off the raw string, because
 * normalisation strips the punctuation that carries the signal.
 */
export function scoreMatch(companyName: string, appName: string, seller: string | null): AppRating['matchConfidence'] {
  const c = norm(companyName);
  const a = norm(appName);
  const s = seller ? norm(seller) : '';
  if (!c || !a) return 'NONE';

  if (a === c) return 'HIGH';
  if (s && s === c) return 'HIGH';                     // publisher IS the company

  // "Chewy - Pet Care & Pharmacy" -> leading segment "Chewy".
  const lead = norm(appName.split(/[-–—:|(]/)[0] ?? '');
  if (lead && lead === c) return 'HIGH';

  // App name is a prefix of the company name: the "Deckers" app for
  // "Deckers Outdoor Corporation". Length-guarded so a stubby app name
  // cannot latch onto an unrelated issuer.
  if (a.length >= 4 && c.startsWith(`${a} `)) return 'HIGH';

  // Company name plus a GENERIC app-suffix word, undelimited — the standard
  // brand-app naming convention ("Texas Roadhouse Mobile", "Wendy's Rewards").
  // An allowlist rather than a wildcard: this is the same rule that, left
  // open, promoted "Crocs Wallpapers HD" over the real Crocs app.
  if (a.startsWith(`${c} `)) {
    const tail = a.slice(c.length + 1).split(' ').filter(Boolean);
    const GENERIC = new Set(['mobile', 'app', 'official', 'rewards', 'us', 'usa', 'shopping', 'online', 'store']);
    if (tail.length && tail.every((w) => GENERIC.has(w))) return 'HIGH';
  }

  if (a.includes(c) || c.includes(a)) return 'LOW';
  return 'NONE';
}

export function parseItunes(body: any, companyName: string): AppRating {
  const results = Array.isArray(body?.results) ? body.results : [];
  if (!results.length) return empty(`no iOS app found for "${companyName}"`);

  // Rank by match quality first, then by audience size — a HIGH match with
  // 400 ratings beats a LOW match with 4 million, because the LOW match is
  // probably a different company's app entirely.
  const RANK: Record<AppRating['matchConfidence'], number> = { HIGH: 2, LOW: 1, NONE: 0 };
  const scored: Array<{ r: any; conf: AppRating['matchConfidence'] }> = results.map((r: any) => ({
    r,
    conf: scoreMatch(companyName, String(r?.trackName ?? ''), r?.sellerName ?? null),
  }));
  scored.sort((x, y) =>
    RANK[y.conf] - RANK[x.conf] || (Number(y.r?.userRatingCount) || 0) - (Number(x.r?.userRatingCount) || 0));

  const best = scored[0];
  if (best.conf === 'NONE') {
    return empty(`found ${results.length} app(s) but none matched "${companyName}" — refusing a wrong attribution`);
  }

  const a = best.r;

  // AN APP WITH NO RATINGS IS NOT A DEMAND SIGNAL, however well the name
  // matched. "Celsius Holdings" resolves to an app literally called "Celsius"
  // with 0 ratings — a name collision with something unrelated, which the
  // matcher scores HIGH because the string really is identical. Common-word
  // brands make that unavoidable, so the rating count is the backstop:
  // nobody has rated it, so there is nothing here to read either way.
  const count = Number(a?.userRatingCount);
  if (!Number.isFinite(count) || count <= 0) {
    return empty(
      `resolved to "${a?.trackName}" but it has no ratings — no demand signal, and a common-word ` +
      `name match like this is often a different product entirely`,
      'LOW',
    );
  }
  // Number(null) is 0 and Number('') is 0, so a bare Number.isFinite guard
  // turns "Apple did not report this" into "zero ratings". That is the exact
  // None-to-0.0 coercion that manufactured this project's fake +16.2%
  // backtest result. Missing stays null.
  const n = (v: unknown) => {
    if (v == null || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    available: true,
    appId: n(a?.trackId),
    appName: a?.trackName ?? null,
    seller: a?.sellerName ?? null,
    rating: n(a?.averageUserRating),
    ratingCount: n(a?.userRatingCount),
    ratingCurrentVersion: n(a?.averageUserRatingForCurrentVersion),
    ratingCountCurrentVersion: n(a?.userRatingCountForCurrentVersion),
    currentVersionReleaseDate: a?.currentVersionReleaseDate ? String(a.currentVersionReleaseDate).slice(0, 10) : null,
    matchConfidence: best.conf,
    matchedOn: companyName,
    reason: best.conf === 'LOW' ? `weak name match — resolved to "${a?.trackName}" by ${a?.sellerName}; verify before using` : null,
    caveat: APP_RATINGS_CAVEAT,
  };
}

const SUFFIXES = /\b(inc|incorporated|corp|corporation|company|holdings?|group|plc|ltd|limited)\b\.?/gi;

/**
 * The string to actually search Apple with.
 *
 * Searching the full legal name demotes the real app: "Dutch Bros Inc"
 * returned "Dutch Bros U" (67 ratings) in the top five while the genuine
 * "Dutch Bros" app (862,554 ratings) fell outside it entirely. The legal
 * suffix is noise to a store search — strip it for the query, keep the
 * original for scoring the match.
 */
export function searchTerm(companyName: string): string {
  const t = companyName.replace(SUFFIXES, ' ').replace(/[,\s]+/g, ' ').trim();
  return t || companyName.trim();
}

export async function fetchAppRating(
  companyName: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<AppRating> {
  const name = companyName.trim();
  if (!name) return empty('no company name to search');
  const doFetch = opts.fetchImpl ?? fetch;
  const qs = new URLSearchParams({ term: searchTerm(name), entity: 'software', country: 'US', limit: '5' });
  try {
    const res = await doFetch(`${ITUNES_SEARCH}?${qs.toString()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return empty(`iTunes HTTP ${res.status}`);
    // Apple serves this as text/javascript, so parse the text — trusting the
    // content-type header here returns "not JSON" for a perfectly good body.
    const body = JSON.parse(await res.text());
    const out = parseItunes(body, name);
    log.info('app_rating', { company: name, appId: out.appId, conf: out.matchConfidence });
    return out;
  } catch (err: any) {
    return empty(`iTunes: ${String(err?.message ?? err)}`);
  }
}
