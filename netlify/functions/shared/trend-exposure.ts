// TREND EXPOSURE — "who is exposed to this phrase?"
//
// This module answers an ATTRIBUTION question, not a prediction question.
// Given a consumer phrase ("Prime Hydration", "feta", "Crocs"), it returns
// the public filers who actually write that phrase into their 10-Ks, ranked
// by how many filings mention it. That is a fact about disclosure, and it
// is checkable — unlike "will this go up?", which the social-arbitrage
// study in reports/trend/social-arb-study.md failed to answer (see the
// `trend` row in verdicts.ts).
//
// Why this exists: linking an observed consumer trend to the ticker that
// monetises it is the genuinely hard part of consumer research, and the
// commercial products in this space gate it behind enterprise pricing.
// SEC EDGAR full-text search does it for free.
//
// Two sources, both free, both zero-ToS-risk:
//   - efts.sec.gov  — full-text search over filings, with an entity_filter
//                     aggregation whose buckets embed ticker + CIK.
//   - wikimedia.org — daily pageviews. ABSOLUTE counts, unlike Google
//                     Trends' 0-100 rescaled index, so two lookups are
//                     actually comparable. Descriptive context only.
//
// THE HOMONYM TRAP. A bare token like "Celsius" returns 359 filings whose
// top buckets are mining and chemicals companies using degrees Celsius.
// The defence is the specificity ratio — top bucket hits / total hits.
// "Crocs" scores 0.36, "Celsius Holdings" 0.71, bare "Celsius" 0.08.
// Anything under MIN_SPECIFICITY is reported as ambiguous rather than
// presented as an attribution.

import { logger } from './logger';

const log = logger.child({ mod: 'trend-exposure' });

const EFTS = 'https://efts.sec.gov/LATEST/search-index';
const WIKI_PV =
  'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia' +
  '/all-access/all-agents/{article}/daily/{start}/{end}';
const WIKI_SEARCH = 'https://en.wikipedia.org/w/api.php';

// SEC requires a descriptive User-Agent with contact info and caps at
// ~10 req/sec. Wikimedia asks for the same courtesy.
const UA = 'TradeIQ-Alpha/1.0 (personal research; chadwickblyth@gmail.com)';

/** Below this, the phrase is too generic to attribute to any one filer. */
export const MIN_SPECIFICITY = 0.25;

/** EDGAR full-text search only indexes filings from 2001 onward. */
export const EFTS_EPOCH = '2001-01-01';

export interface ExposureFiler {
  /** Display name as EDGAR reports it, e.g. "CROCS, INC. (CROX)". */
  name: string;
  /** Extracted ticker, null when the bucket has none (private/foreign). */
  ticker: string | null;
  cik: string | null;
  /** Filings in the window that contain the phrase. */
  filings: number;
  /** This filer's share of all filings matching the phrase. */
  share: number;
}

export interface TrendExposure {
  phrase: string;
  forms: string[];
  startDate: string;
  endDate: string;
  totalFilings: number;
  /** topBucket / totalFilings. Null when there are no hits at all. */
  specificity: number | null;
  /**
   * True when specificity is below MIN_SPECIFICITY — the phrase is a
   * homonym or a generic term and the ranking should not be read as
   * "these companies are exposed to this trend".
   */
  ambiguous: boolean;
  /**
   * True when EDGAR has zero 10-K hits. Usually means the brand is
   * privately held — which is itself the answer: there is no listed
   * pure-play to express the theme through.
   */
  noListedMention: boolean;
  filers: ExposureFiler[];
}

export interface PageviewSeries {
  article: string;
  /** Absolute daily pageviews, oldest first. */
  points: Array<{ date: string; views: number }>;
  /** Mean of the last 28 days vs the 28 days ending a year earlier. */
  yoyPct: number | null;
  /** Mean of the last 28 days vs the prior 28 days. */
  momPct: number | null;
}

// ---------------------------------------------------------------------------
// EDGAR
// ---------------------------------------------------------------------------

/**
 * Bucket keys arrive in three observed shapes (verified against live EDGAR
 * 2026-08-03):
 *
 *   'Crocs, Inc.  (CROX)  (CIK 0001334036)'
 *   'ALBEMARLE CORP  (ALB, ALB-PA)  (CIK 0000915913)'   <- multi-class
 *   'Blackstone Private Equity Strategies Fund L.P.  (CIK 0001930054)'
 *
 * The CIK group is always last; the ticker group, when present, precedes it.
 * A missing ticker is normal (private funds, foreign issuers) and is not an
 * error — it just means the filer is not directly investable.
 *
 * SEPARATOR DISCIPLINE (2026-08-03 review): the ticker group is required to
 * be preceded by TWO OR MORE spaces, which is how EDGAR delimits it in every
 * observed key. Without that, an all-caps parenthetical that is part of the
 * company's own name — "SANOFI (US)", "... (USA)" — matches the ticker
 * character class and gets misreported as a ticker. A single-space
 * parenthetical is part of the name; a double-space one is a field.
 */
export function parseBucketKey(key: string): {
  name: string;
  ticker: string | null;
  tickers: string[];
  cik: string | null;
} {
  let rest = key.trim();
  let cik: string | null = null;

  const cikMatch = rest.match(/\s*\(CIK\s+(\d{4,10})\)\s*$/i);
  if (cikMatch) {
    cik = cikMatch[1].padStart(10, '0');
    rest = rest.slice(0, cikMatch.index).trim();
  }

  let tickers: string[] = [];
  // NB: `\s{2,}` (not `\s*`) — see SEPARATOR DISCIPLINE above.
  const tickerMatch = rest.match(/\s{2,}\(([A-Z0-9.\-]{1,8}(?:\s*,\s*[A-Z0-9.\-]{1,8})*)\)$/);
  if (tickerMatch) {
    tickers = tickerMatch[1].split(',').map((t) => t.trim()).filter(Boolean);
    rest = rest.slice(0, tickerMatch.index).trim();
  }

  return { name: rest, ticker: tickers[0] ?? null, tickers, cik };
}

/**
 * Specificity = the top filer's share of all matching filings.
 *
 * A phrase that belongs to one company concentrates in that company's own
 * filings. A phrase that is a common noun scatters across hundreds of
 * unrelated filers, and the top bucket's share collapses.
 */
export function specificityOf(buckets: Array<{ doc_count: number }>, total: number): number | null {
  if (!total || !buckets.length) return null;
  const top = Math.max(...buckets.map((b) => b.doc_count));
  return top / total;
}

export async function fetchExposure(
  phrase: string,
  opts: {
    forms?: string[];
    startDate?: string;
    endDate?: string;
    limit?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<TrendExposure> {
  const forms = opts.forms?.length ? opts.forms : ['10-K'];
  const endDate = opts.endDate ?? new Date().toISOString().slice(0, 10);
  // Clamp to the EFTS epoch: full-text search does not index pre-2001
  // filings, so asking for an earlier startdt silently returns a window
  // EDGAR cannot answer and makes the reported window a lie.
  const requestedStart = opts.startDate ?? isoDaysAgo(730);
  const startDate = requestedStart < EFTS_EPOCH ? EFTS_EPOCH : requestedStart;
  const limit = opts.limit ?? 12;
  const doFetch = opts.fetchImpl ?? fetch;

  const url =
    `${EFTS}?q=${encodeURIComponent(`"${phrase}"`)}` +
    `&forms=${encodeURIComponent(forms.join(','))}` +
    `&startdt=${startDate}&enddt=${endDate}`;

  const res = await doFetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`EDGAR FTS ${res.status}`);
  const body: any = await res.json();

  // Silent-failure discipline: a payload with no `hits` block is a
  // malformed/throttled response, NOT "zero filings mention this phrase".
  // Those two mean opposite things to a user, so never conflate them.
  if (!body?.hits?.total || typeof body.hits.total.value !== 'number') {
    throw new Error('EDGAR FTS returned no hits block (throttled or malformed)');
  }

  const total: number = body.hits.total.value;
  const buckets: Array<{ key: string; doc_count: number }> =
    body?.aggregations?.entity_filter?.buckets ?? [];

  const specificity = specificityOf(buckets, total);
  const filers: ExposureFiler[] = buckets.slice(0, limit).map((b) => {
    const { name, ticker, cik } = parseBucketKey(b.key);
    return {
      name,
      ticker,
      cik,
      filings: b.doc_count,
      share: total ? b.doc_count / total : 0,
    };
  });

  log.info('exposure', {
    phrase, total, buckets: buckets.length, specificity,
  });

  return {
    phrase,
    forms,
    startDate,
    endDate,
    totalFilings: total,
    specificity,
    ambiguous: specificity !== null && specificity < MIN_SPECIFICITY,
    noListedMention: total === 0,
    filers,
  };
}

// ---------------------------------------------------------------------------
// Wikipedia pageviews — descriptive context, never a score
// ---------------------------------------------------------------------------

export async function resolveArticle(
  term: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const url =
    `${WIKI_SEARCH}?action=query&list=search&format=json&origin=*` +
    `&srlimit=1&srsearch=${encodeURIComponent(term)}`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`wiki search ${res.status}`);
  const body: any = await res.json();
  return body?.query?.search?.[0]?.title ?? null;
}

export async function fetchPageviews(
  article: string,
  opts: { days?: number; fetchImpl?: typeof fetch } = {},
): Promise<PageviewSeries> {
  const days = opts.days ?? 430;
  const doFetch = opts.fetchImpl ?? fetch;
  const end = isoDaysAgo(1);
  const start = isoDaysAgo(days);
  const url = WIKI_PV
    .replace('{article}', encodeURIComponent(article.replace(/ /g, '_')))
    .replace('{start}', start.replace(/-/g, ''))
    .replace('{end}', end.replace(/-/g, ''));

  const res = await doFetch(url, { headers: { 'User-Agent': UA } });
  // 404 means the article has no pageview record — a real answer, not an error.
  if (res.status === 404) return { article, points: [], yoyPct: null, momPct: null };
  if (!res.ok) throw new Error(`wiki pageviews ${res.status}`);
  const body: any = await res.json();

  const points = (body?.items ?? []).map((i: any) => ({
    date: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`,
    views: Number(i.views) || 0,
  }));

  return { article, points, yoyPct: yoy(points), momPct: mom(points) };
}

/** Mean of the trailing 28 days vs the 28 days ending 365 days earlier. */
export function yoy(points: Array<{ views: number }>): number | null {
  if (points.length < 393) return null;
  const now = mean(points.slice(-28).map((p) => p.views));
  const then = mean(points.slice(-393, -365).map((p) => p.views));
  if (!then) return null;
  return (now / then - 1) * 100;
}

/** Mean of the trailing 28 days vs the 28 days before that. */
export function mom(points: Array<{ views: number }>): number | null {
  if (points.length < 56) return null;
  const now = mean(points.slice(-28).map((p) => p.views));
  const then = mean(points.slice(-56, -28).map((p) => p.views));
  if (!then) return null;
  return (now / then - 1) * 100;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}
