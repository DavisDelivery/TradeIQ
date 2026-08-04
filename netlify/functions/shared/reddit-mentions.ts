// REDDIT MENTION COUNTS — counted from the source, under a licence.
//
// Same measurement `social-mentions.ts` gets from ApeWisdom, obtained by
// reading the subreddit directly. The reason to prefer it is not accuracy, it
// is provenance: Reddit publishes terms, ApeWisdom does not.
//
// DORMANT unless REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are set. Nothing in
// the app degrades when it is off, which is why it can ship before approval
// comes through.
//
// ---------------------------------------------------------------------------
// COUNTING TICKERS IN FREE TEXT IS THE HARD PART, NOT THE HTTP
//
// Naive substring matching turns r/wallstreetbets into noise. Every one of
// these is a false positive waiting to happen:
//
//   "A" "I" "IT" "ON" "SO" "BE"   — common words that are also real tickers
//   "DD"  "CEO" "IPO" "ATH" "FD"  — subreddit jargon, some of them tickers
//   "$GME"                        — the cashtag form, which IS unambiguous
//
// So the matcher requires either a cashtag ($TSLA) or an all-caps standalone
// token, and it refuses bare short symbols outright unless cashtagged. That
// deliberately UNDERCOUNTS: a post saying "bought some crocs today" is not
// counted for CROX. Undercounting a saturation gauge is the safe direction —
// it makes a name look quieter, and quiet is the state that argues FOR a
// setup, so the error works against the thesis rather than for it.
//
// Verified against the same three-state model as ApeWisdom: a ticker with no
// hits is BELOW_FLOOR (nobody mentioned it in the sampled window), never a
// hard zero, because the sample is bounded by what the listing returned.

import { redditConfigured, redditGet } from './reddit-client';
import { logger } from './logger';

const log = logger.child({ mod: 'reddit-mentions' });

/** Subreddits sampled, in the order they are fetched. */
export const SUBREDDITS = ['wallstreetbets', 'stocks', 'investing', 'stockmarket'];

/** Posts pulled per subreddit. Reddit caps a single listing page at 100. */
export const POSTS_PER_SUB = 100;

/**
 * Symbols that are ordinary English words or subreddit jargon. These are only
 * ever counted when written as a cashtag, never bare.
 *
 * Not exhaustive and deliberately generous — a missed mention is cheaper than
 * a phantom one, per the header.
 */
export const AMBIGUOUS = new Set([
  'A', 'I', 'IT', 'ON', 'SO', 'BE', 'AT', 'BY', 'GO', 'HE', 'IF', 'IN', 'IS', 'ME', 'MY', 'NO',
  'OR', 'OUT', 'PM', 'AM', 'AN', 'AS', 'ARE', 'ALL', 'CAN', 'FOR', 'HAS', 'NOW', 'ONE', 'SEE',
  'TWO', 'USA', 'WELL', 'LOVE', 'OPEN', 'PLAY', 'REAL', 'RUN', 'SAVE', 'TRUE', 'WORK', 'NICE',
  'DD', 'CEO', 'IPO', 'ATH', 'FD', 'FDS', 'YOLO', 'OTM', 'ITM', 'EPS', 'ER', 'IV', 'TA', 'EOD',
  'EOW', 'WSB', 'US', 'UK', 'EU', 'AI', 'EV', 'CPI', 'GDP', 'FED', 'SEC', 'ROI', 'PE', 'TLDR',
]);

export interface RedditMentionCounts {
  available: boolean;
  /** ticker -> number of posts mentioning it. Only tickers with >=1 appear. */
  counts: Record<string, number>;
  /** Posts actually scanned. The denominator for any rate. */
  postsScanned: number;
  subreddits: string[];
  /** Oldest post timestamp seen, ISO. Bounds the window the counts describe. */
  oldestPost: string | null;
  reason: string | null;
}

/** Cashtag: unambiguous, always counted. */
const CASHTAG = /\$([A-Za-z]{1,5})\b/g;
/** Bare all-caps token, 2-5 chars, not adjacent to other letters. */
const BARE = /(?<![A-Za-z$])([A-Z]{2,5})(?![A-Za-z])/g;

/**
 * Count DISTINCT tickers in one post's text.
 *
 * Returns a Set, not a tally: a post repeating "GME" nine times is one post
 * mentioning GME, not nine mentions. Counting raw occurrences would let a
 * single ranting post dominate the whole board.
 */
export function tickersInText(text: string, known?: Set<string>): Set<string> {
  const found = new Set<string>();
  if (!text) return found;

  for (const m of text.matchAll(CASHTAG)) {
    const t = m[1].toUpperCase();
    if (!known || known.has(t)) found.add(t);      // cashtag overrides ambiguity
  }
  for (const m of text.matchAll(BARE)) {
    const t = m[1];
    if (AMBIGUOUS.has(t)) continue;                // bare ambiguous token: skip
    if (known && !known.has(t)) continue;          // unknown symbol: skip
    found.add(t);
  }
  return found;
}

interface Listing {
  data?: { children?: Array<{ data?: { title?: string; selftext?: string; created_utc?: number } }> };
}

/**
 * Sample recent posts across the configured subreddits and count mentions.
 *
 * `known` restricts counting to a real ticker universe. Without it, every
 * all-caps acronym in the corpus becomes a "ticker" — pass the Finviz
 * universe in production and this is the difference between a signal and
 * a word-frequency table.
 */
export async function fetchRedditMentions(
  opts: { known?: Set<string>; fetchImpl?: typeof fetch; subreddits?: string[] } = {},
): Promise<RedditMentionCounts> {
  const subs = opts.subreddits ?? SUBREDDITS;
  const base: RedditMentionCounts = {
    available: false, counts: {}, postsScanned: 0, subreddits: subs, oldestPost: null, reason: null,
  };

  if (!redditConfigured()) {
    return { ...base, reason: 'Reddit is not configured (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET unset) — ApeWisdom covers this leg meanwhile' };
  }

  const counts: Record<string, number> = {};
  let scanned = 0;
  let oldest: number | null = null;
  const failures: string[] = [];

  for (const sub of subs) {
    const res = await redditGet<Listing>(`/r/${sub}/new`, {
      fetchImpl: opts.fetchImpl,
      searchParams: { limit: String(POSTS_PER_SUB) },
    });
    if (!res.ok || !res.data) {
      failures.push(`${sub}: ${res.reason ?? 'unknown'}`);
      continue;
    }
    for (const child of res.data.data?.children ?? []) {
      const d = child?.data;
      if (!d) continue;
      scanned++;
      if (typeof d.created_utc === 'number') {
        oldest = oldest == null ? d.created_utc : Math.min(oldest, d.created_utc);
      }
      for (const t of tickersInText(`${d.title ?? ''}\n${d.selftext ?? ''}`, opts.known)) {
        counts[t] = (counts[t] ?? 0) + 1;
      }
    }
  }

  // Every subreddit failing is a transport problem, not a quiet market. It
  // must not be reported as "nobody mentioned anything".
  if (scanned === 0) {
    return { ...base, reason: failures.length ? `all subreddits failed — ${failures.join('; ')}` : 'no posts returned' };
  }

  log.info('reddit_mentions', { scanned, tickers: Object.keys(counts).length, failures: failures.length });
  return {
    available: true,
    counts,
    postsScanned: scanned,
    subreddits: subs,
    oldestPost: oldest == null ? null : new Date(oldest * 1000).toISOString(),
    reason: failures.length ? `partial: ${failures.join('; ')}` : null,
  };
}
