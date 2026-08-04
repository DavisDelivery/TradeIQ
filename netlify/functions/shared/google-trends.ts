// GOOGLE TRENDS — present, displayed, DELIBERATELY UNWEIGHTED.
//
// Requested to be visible in the app. It is wired as context only and must
// never enter a score, a rank, or a screen predicate. Two independent
// reasons, both measured rather than assumed:
//
//   1. NO MEASURED EDGE. This system's own study built its consumer-velocity
//      leg on Google Trends and it failed a placebo test — random entry into
//      the same names matched it (reports/trend/social-arb-study.md, verdict
//      NO_EDGE in verdicts.ts). The literature agrees on direction:
//      Da/Engelberg/Gao (2011) measure the attention effect at ~34bp over two
//      weeks and REVERSING over weeks 5-52.
//   2. THE INDEX IS NOT COMPARABLE ACROSS CALLS. Trends returns 0-100 scaled
//      to the max of the window you requested. The same keyword over two
//      different windows gives two different series. Wikipedia pageviews,
//      already wired, are ABSOLUTE — which is why they carry the attention
//      display and this is the second opinion.
//
// TWO TRANSPORTS, and the choice is a compliance decision, not a preference:
//
//   SerpApi (SERPAPI_KEY)  — the sanctioned path. A licensed intermediary
//     with its own ToS position. Costs money. USED WHENEVER THE KEY IS SET.
//
//   Direct (opt-in only)   — trends.google.com/trends/api/*. Verified
//     2026-08-03: trends.google.com/robots.txt contains `Disallow:
//     /trends/explore?`, and Google's ToS prohibit automated access that
//     violates robots.txt. It also requires a two-step token dance and
//     breaks without notice (pytrends, the reference client, was archived
//     2025-04-17). Requires GOOGLE_TRENDS_ALLOW_DIRECT=1 — an explicit,
//     logged decision, never a silent default.
//
// With neither configured the module returns `{ available: false }` and the
// UI says so. It does not fabricate a series.

import { logger } from './logger';

const log = logger.child({ mod: 'google-trends' });

const SERPAPI = 'https://serpapi.com/search.json';

export interface TrendsPoint {
  date: string;
  /** 0-100, scaled to the max of THIS window. Not comparable across calls. */
  value: number;
}

export interface TrendsSeries {
  available: boolean;
  keyword: string;
  timeframe: string;
  geo: string;
  transport: 'serpapi' | 'direct' | 'none';
  points: TrendsPoint[];
  /** Mean of the last 4 weeks vs the prior 12, in index points. Display only. */
  recentVsBase: number | null;
  /** Why it is unavailable, when it is. Shown to the user verbatim. */
  reason: string | null;
  /** Travels with the payload so a UI refactor cannot drop the caveat. */
  caveat: string;
}

export const TRENDS_CAVEAT =
  'Google Trends is a 0-100 index rescaled to the requested window, so two lookups are not comparable. ' +
  'Displayed for context only — it carries NO weight in any score or screen, and this system measured no predictive edge from it.';

function empty(keyword: string, reason: string): TrendsSeries {
  return {
    available: false, keyword, timeframe: '', geo: '', transport: 'none',
    points: [], recentVsBase: null, reason, caveat: TRENDS_CAVEAT,
  };
}

/** Last 4 weeks vs the prior 12, in raw index points. Descriptive only. */
export function recentVsBase(points: TrendsPoint[]): number | null {
  if (points.length < 16) return null;
  const recent = points.slice(-4);
  const base = points.slice(-16, -4);
  const mean = (a: TrendsPoint[]) => a.reduce((s, p) => s + p.value, 0) / a.length;
  const b = mean(base);
  if (!b) return null;
  return Math.round((mean(recent) - b) * 10) / 10;
}

export function parseSerpApi(body: any, keyword: string, timeframe: string, geo: string): TrendsSeries {
  const raw = body?.interest_over_time?.timeline_data;
  if (!Array.isArray(raw)) {
    return empty(keyword, 'SerpApi returned no interest_over_time timeline');
  }
  const points: TrendsPoint[] = [];
  for (const row of raw) {
    // SerpApi marks the in-progress bucket; including it makes the last
    // point look like a collapse in interest when it is just incomplete.
    if (row?.partial_data) continue;
    const v = row?.values?.[0];
    const value = typeof v?.extracted_value === 'number' ? v.extracted_value : Number(v?.value);
    const date = row?.date ?? row?.timestamp;
    if (!date || !Number.isFinite(value)) continue;
    points.push({ date: String(date), value });
  }
  return {
    available: points.length > 0,
    keyword, timeframe, geo, transport: 'serpapi', points,
    recentVsBase: recentVsBase(points),
    reason: points.length ? null : 'SerpApi timeline had no complete buckets',
    caveat: TRENDS_CAVEAT,
  };
}

export function trendsEnabled(): boolean {
  return Boolean(process.env.SERPAPI_KEY) || process.env.GOOGLE_TRENDS_ALLOW_DIRECT === '1';
}

export async function fetchTrends(
  keyword: string,
  opts: { timeframe?: string; geo?: string; fetchImpl?: typeof fetch } = {},
): Promise<TrendsSeries> {
  const timeframe = opts.timeframe ?? 'today 12-m';
  const geo = opts.geo ?? 'US';
  const doFetch = opts.fetchImpl ?? fetch;
  const kw = keyword.trim();
  if (!kw) return empty(keyword, 'empty keyword');

  const serpKey = process.env.SERPAPI_KEY;
  if (serpKey) {
    try {
      const qs = new URLSearchParams({
        engine: 'google_trends', q: kw, data_type: 'TIMESERIES',
        date: timeframe, geo, api_key: serpKey,
      });
      const res = await doFetch(`${SERPAPI}?${qs.toString()}`, { headers: { accept: 'application/json' } });
      if (!res.ok) return empty(kw, `SerpApi HTTP ${res.status}`);
      const body: any = await res.json();
      if (body?.error) return empty(kw, `SerpApi: ${body.error}`);
      const out = parseSerpApi(body, kw, timeframe, geo);
      log.info('trends', { keyword: kw, transport: 'serpapi', points: out.points.length });
      return out;
    } catch (err: any) {
      return empty(kw, `SerpApi: ${String(err?.message ?? err)}`);
    }
  }

  if (process.env.GOOGLE_TRENDS_ALLOW_DIRECT === '1') {
    // Deliberately NOT implemented as a silent fallback. The direct endpoint
    // is disallowed by trends.google.com/robots.txt and breaks without
    // notice; wiring it in by default would put a compliance decision behind
    // an env var nobody read. If you want it, implement it here knowingly.
    log.warn('direct_transport_requested_but_not_implemented');
    return empty(
      kw,
      'Direct Google Trends access is opt-in and intentionally not implemented: ' +
      'trends.google.com/robots.txt disallows /trends/explore, and the endpoint ' +
      'is unstable (pytrends archived 2025-04-17). Set SERPAPI_KEY for the ' +
      'sanctioned path.',
    );
  }

  return empty(
    kw,
    'Google Trends is not configured. Set SERPAPI_KEY (sanctioned, paid) to enable it. ' +
    'It is context only and carries no weight, so nothing else degrades without it.',
  );
}
