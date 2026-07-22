// News-sentiment board — the "Most Bullish / Most Bearish" screener.
//
// Data: Finnhub `/company-news` (free tier) — recent headlines per ticker.
// Scoring: a deterministic finance lexicon over headline+summary text. No
// LLM cost, fully explainable (we surface the driving headline), and cheap
// enough to sweep the S&P 500 in one background run. This is intentionally a
// SCREENER, not a validated edge: news sentiment is a coincident, noisy
// signal (it reacts to price as much as it leads it), so the board lives in
// the "Unvalidated" section and always shows the headline behind the score.
//
// Design mirrors scan-insider.ts: a per-ticker fetch paced through the
// Finnhub token bucket, a batch runner with a wall-clock abort, and a row
// builder that drops no-news tickers (an empty sentiment row is noise).

import { fetchWithRateLimit, getFinnhubBucket } from './rate-limiter';
import { mapWithConcurrency } from './full-scan-iterator';
import { inIndex } from './universe';
import type { Logger } from './logger';

const FINNHUB = 'https://finnhub.io/api/v1';

function finnhubKey(): string {
  const k = process.env.FINNHUB_API_KEY;
  if (!k) throw new Error('FINNHUB_API_KEY not set');
  return k;
}

export interface CompanyNewsItem {
  headline: string;
  summary: string;
  url: string;
  source: string;
  datetime: number; // epoch seconds
}

export interface SentimentBoardRow {
  ticker: string;
  name: string | null;
  sector: string | null;
  /** -100 (most bearish) … +100 (most bullish). */
  score: number;
  label: 'bullish' | 'bearish' | 'neutral';
  /** Article count over the window (the "buzz"). */
  articleCount: number;
  positiveCount: number;
  negativeCount: number;
  /** The single most impactful headline behind the score, with its sign. */
  topHeadline: {
    headline: string;
    url: string;
    source: string;
    datetime: number;
    sentiment: 'positive' | 'negative' | 'neutral';
  } | null;
  price?: number | null;
  priceChangePct?: number | null;
}

// ---------------------------------------------------------------------------
// Finance lexicon. Weights are small integers; an article's raw score is the
// summed weight of matched terms (positive − negative), clamped to ±3 so a
// single sensational headline can't dominate a ticker's aggregate.
// ---------------------------------------------------------------------------

const POSITIVE: Record<string, number> = {
  beat: 2, beats: 2, tops: 2, topped: 2, surge: 2, surges: 2, surged: 2,
  soar: 2, soars: 2, soared: 2, jump: 2, jumps: 2, jumped: 2, rally: 2,
  rallies: 2, rallied: 2, upgrade: 2, upgraded: 2, upgrades: 2, outperform: 2,
  bullish: 2, record: 1, records: 1, growth: 1, grows: 1, gains: 1, gain: 1,
  rises: 1, rise: 1, climbs: 1, climb: 1, rebound: 1, rebounds: 1, strong: 1,
  strength: 1, profit: 1, profits: 1, raised: 1, raises: 1, boost: 1, boosts: 1,
  approval: 1, approved: 1, wins: 1, win: 1, awarded: 1, buyback: 1, dividend: 1,
  expands: 1, expansion: 1, breakthrough: 2, milestone: 1, momentum: 1, buy: 1,
};

const NEGATIVE: Record<string, number> = {
  miss: 2, misses: 2, missed: 2, plunge: 2, plunges: 2, plunged: 2, slump: 2,
  slumps: 2, tumble: 2, tumbles: 2, tumbled: 2, crash: 2, crashes: 2, sink: 2,
  sinks: 2, sank: 2, downgrade: 2, downgraded: 2, downgrades: 2, underperform: 2,
  bearish: 2, falls: 1, fall: 1, fell: 1, drops: 1, drop: 1, declines: 1,
  decline: 1, slips: 1, slip: 1, weak: 1, weakness: 1, loss: 1, losses: 1,
  cut: 1, cuts: 1, slashed: 1, slashes: 1, warns: 2, warning: 2, warned: 2,
  lawsuit: 2, sues: 1, sued: 1, probe: 2, investigation: 2, fraud: 3, halt: 2,
  halted: 2, recall: 2, bankruptcy: 3, default: 2, delay: 1, delays: 1,
  delayed: 1, layoffs: 2, layoff: 2, sell: 1, downturn: 1, disappoints: 2,
  disappointing: 2, concerns: 1, risk: 1, risks: 1,
};

// High-signal multiword phrases checked as substrings (order-independent).
const PHRASES: Array<{ re: RegExp; weight: number }> = [
  { re: /price target (?:raised|hiked|lifted)/i, weight: 2 },
  { re: /price target (?:cut|lowered|slashed)/i, weight: -2 },
  { re: /beats? (?:on |earnings|estimates|expectations)/i, weight: 2 },
  { re: /miss(?:es|ed)? (?:on |earnings|estimates|expectations)/i, weight: -2 },
  { re: /raises? (?:guidance|outlook|forecast)/i, weight: 2 },
  { re: /(?:cuts?|lowers?) (?:guidance|outlook|forecast)/i, weight: -2 },
  { re: /all-time high/i, weight: 2 },
  { re: /52-week high/i, weight: 1 },
  { re: /52-week low/i, weight: -1 },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Raw sentiment weight of one article's text, clamped to ±3. */
export function scoreArticleText(text: string): number {
  const lower = (text || '').toLowerCase();
  let s = 0;
  for (const tok of lower.split(/[^a-z]+/)) {
    if (!tok) continue;
    if (POSITIVE[tok]) s += POSITIVE[tok];
    else if (NEGATIVE[tok]) s -= NEGATIVE[tok];
  }
  for (const p of PHRASES) if (p.re.test(lower)) s += p.weight;
  return clamp(s, -3, 3);
}

/** Aggregate a ticker's articles into a board row's sentiment fields. */
export function aggregateSentiment(items: CompanyNewsItem[]): {
  score: number;
  label: SentimentBoardRow['label'];
  articleCount: number;
  positiveCount: number;
  negativeCount: number;
  topHeadline: SentimentBoardRow['topHeadline'];
} {
  const scored = items.map((a) => ({ a, s: scoreArticleText(`${a.headline} ${a.summary}`) }));
  const count = scored.length;
  if (count === 0) {
    return { score: 0, label: 'neutral', articleCount: 0, positiveCount: 0, negativeCount: 0, topHeadline: null };
  }
  const net = scored.reduce((sum, x) => sum + x.s, 0);
  // Mean article score (~ -3..3) scaled to -100..100.
  const score = clamp(Math.round((net / count) * 33), -100, 100);
  const positiveCount = scored.filter((x) => x.s > 0).length;
  const negativeCount = scored.filter((x) => x.s < 0).length;
  // Most impactful (largest |score|); newest breaks ties.
  const top = scored
    .slice()
    .sort((x, y) => Math.abs(y.s) - Math.abs(x.s) || y.a.datetime - x.a.datetime)[0];
  const label: SentimentBoardRow['label'] = score >= 15 ? 'bullish' : score <= -15 ? 'bearish' : 'neutral';
  return {
    score,
    label,
    articleCount: count,
    positiveCount,
    negativeCount,
    topHeadline: {
      headline: top.a.headline,
      url: top.a.url,
      source: top.a.source,
      datetime: top.a.datetime,
      sentiment: top.s > 0 ? 'positive' : top.s < 0 ? 'negative' : 'neutral',
    },
  };
}

// ---------------------------------------------------------------------------
// Finnhub company-news fetch (status-aware, paced through the token bucket).
// ---------------------------------------------------------------------------

export interface NewsFetchStatus {
  items: CompanyNewsItem[];
  rateLimited: boolean;
  errored: boolean;
}

export async function getCompanyNewsWithStatus(
  ticker: string,
  daysBack = 7,
  now = Date.now(),
): Promise<NewsFetchStatus> {
  try {
    await getFinnhubBucket().acquire();
    const from = new Date(now - daysBack * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(now).toISOString().slice(0, 10);
    const url = `${FINNHUB}/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${finnhubKey()}`;
    const { res, rateLimitHits } = await fetchWithRateLimit(url, undefined, {
      maxRetries: 5,
      initialBackoffMs: 2_000,
      maxBackoffMs: 20_000,
    });
    if (!res.ok) {
      if (res.status === 429) return { items: [], rateLimited: true, errored: false };
      return { items: [], rateLimited: rateLimitHits > 0, errored: true };
    }
    const raw = await res.json();
    const items: CompanyNewsItem[] = (Array.isArray(raw) ? raw : [])
      .filter((r: any) => r && (r.headline || r.summary))
      .map((r: any) => ({
        headline: String(r.headline ?? ''),
        summary: String(r.summary ?? ''),
        url: String(r.url ?? ''),
        source: String(r.source ?? ''),
        datetime: Number(r.datetime ?? 0),
      }));
    return { items, rateLimited: rateLimitHits > 0, errored: false };
  } catch {
    return { items: [], rateLimited: false, errored: true };
  }
}

// ---------------------------------------------------------------------------
// Universe resolution + scan
// ---------------------------------------------------------------------------

export type SentimentUniverseKey = 'sp500' | 'ndx' | 'dow' | 'russell2k';

export function resolveSentimentUniverse(
  universe: SentimentUniverseKey,
): { ticker: string; name: string | null; sector: string | null }[] {
  return inIndex(universe).map((u: any) => ({
    ticker: u.ticker,
    name: u.name ?? null,
    sector: u.sector ?? null,
  }));
}

export interface RunSentimentScanResult {
  rows: SentimentBoardRow[];
  tickersChecked: number;
  finnhubCalls: number;
  finnhubRateLimited: number;
  finnhubErrors: number;
  warnings: string[];
}

/**
 * Single-shot sweep: fetch each ticker's recent news, score it, keep only
 * tickers with news, sort most-bullish-first. `shouldAbort` lets the caller
 * stop on a wall-clock budget — a subset is still a valid snapshot (the row
 * count and `tickersChecked` reported reflect what was actually scanned).
 */
export async function runSentimentScan(opts: {
  universe: SentimentUniverseKey;
  daysBack?: number;
  concurrency?: number;
  now?: number;
  shouldAbort?: () => boolean;
  logger?: Logger;
}): Promise<RunSentimentScanResult> {
  const daysBack = opts.daysBack ?? 7;
  const now = opts.now ?? Date.now();
  const meta = resolveSentimentUniverse(opts.universe);
  const byTicker = new Map(meta.map((m) => [m.ticker, m]));
  const tickers = meta.map((m) => m.ticker);

  let finnhubCalls = 0;
  let finnhubRateLimited = 0;
  let finnhubErrors = 0;
  let checked = 0;

  const results = await mapWithConcurrency<SentimentBoardRow | null>(
    tickers,
    async (ticker) => {
      const st = await getCompanyNewsWithStatus(ticker, daysBack, now);
      finnhubCalls += 1;
      checked += 1;
      if (st.rateLimited) finnhubRateLimited += 1;
      if (st.errored) finnhubErrors += 1;
      if (st.items.length === 0) return null; // no news → not a board row
      const agg = aggregateSentiment(st.items);
      const m = byTicker.get(ticker)!;
      return {
        ticker,
        name: m.name,
        sector: m.sector,
        score: agg.score,
        label: agg.label,
        articleCount: agg.articleCount,
        positiveCount: agg.positiveCount,
        negativeCount: agg.negativeCount,
        topHeadline: agg.topHeadline,
      };
    },
    // batchSize is the effective in-flight concurrency (a batch runs via
    // Promise.allSettled); shouldAbort is checked once per batch.
    { batchSize: opts.concurrency ?? 4, concurrency: opts.concurrency ?? 4, shouldAbort: opts.shouldAbort },
  );

  const rows = results.filter((r): r is SentimentBoardRow => r != null);
  // Most bullish first; buzz breaks ties so a loud +40 outranks a quiet +40.
  rows.sort((a, b) => b.score - a.score || b.articleCount - a.articleCount);

  const warnings: string[] = [];
  if (finnhubRateLimited > 0) warnings.push(`finnhub rate-limited on ${finnhubRateLimited}/${finnhubCalls} tickers`);
  if (finnhubErrors > 0) warnings.push(`finnhub errors on ${finnhubErrors}/${finnhubCalls} tickers`);

  return { rows, tickersChecked: checked, finnhubCalls, finnhubRateLimited, finnhubErrors, warnings };
}
