// EARNINGS ANNOUNCEMENT DATES — from SEC 8-K Item 2.02 (ground truth).
//
// Why this module exists (measured 2026-07-24): `avgPriorMove` — how much a
// stock historically moves on its earnings day — was null for 379 of 380
// names on the board, and had been for as long as the data existed. That one
// null silently disabled HALF the earnings model: the long-straddle branch
// tests `(avgPriorMove ?? 0) > expectedMove * 1.15`, which is `0 > positive`
// = always false, and the iron-condor branch requires `avgPriorMove !== null`.
// A live snapshot confirmed it — 262 of 369 names scored the "no clear edge"
// floor and ZERO volatility plays had ever fired in production.
//
// The root cause was upstream: measuring an earnings reaction needs the
// ANNOUNCEMENT date, and the vendor calendar this app is entitled to does not
// serve historical calendar entries (the same coverage gap that hid next
// week's mega-cap reports from the board entirely).
//
// The fix is not a proxy — it is the actual event. When a company reports, it
// files an 8-K carrying Item 2.02 ("Results of Operations and Financial
// Condition") the same day as the press release. That filing date IS the
// announcement date. Verified against MSFT: 8-K/2.02 on 2026-04-29,
// 2026-01-28, 2025-10-29, 2025-07-30 — mapping exactly onto the fiscal
// quarters 2026-03-31, 2025-12-31, 2025-09-30, 2025-06-30.
//
// Deliberately NOT used: 10-Q/10-K filing dates. A company announces days
// before it files, so windowing a T-1→T+1 price move on a filing date
// measures the wrong two days — quietly corrupting a number a user may trade
// on. Item 2.02 is the announcement itself, which is why it's the only form
// this module accepts.
//
// Cost: one SEC call per ticker, cached 7 days (past announcements are
// immutable). EDGAR is free and paced at 8 req/s by edgarFetch.

// NB: imports are deliberately limited to cycle-free modules. `vector-data`
// and `provider-live-cache` import nothing from `data-provider`, which
// consumes this file — routing the CIK map through `trident/institutional`
// (which does import data-provider) would close a data-provider →
// announce-dates → institutional → data-provider loop. TypeScript accepts
// such a cycle; the ESM bundle can resolve one side to `undefined` at
// runtime, so the cache is reimplemented here instead of imported.
import { edgarFetch, getCikTickerMap } from './vector-data';
import { liveCacheGet, liveCacheSet } from './provider-live-cache';

const CIK_MAP_TTL_MS = 7 * 24 * 60 * 60_000;

/** CIK→ticker map, Firestore-cached (mirrors trident/institutional's helper
 *  without importing it — see the cycle note above). */
async function loadCikTickerMap(): Promise<Map<string, string>> {
  const key = { provider: 'sec', endpoint: 'company-tickers', ticker: '_all', extra: 'v1' };
  const hit = await liveCacheGet<Record<string, string>>(key, () => CIK_MAP_TTL_MS);
  if (hit && Object.keys(hit).length > 1000) return new Map(Object.entries(hit));
  const fresh = await getCikTickerMap();
  if (fresh.size > 1000) await liveCacheSet(key, Object.fromEntries(fresh)).catch(() => {});
  return fresh;
}

/** Past announcements never change; only the tail grows. */
const ANNOUNCE_TTL_MS = 7 * 24 * 60 * 60_000;
/** A ticker with no resolvable CIK/filings shouldn't be re-fetched hourly. */
const EMPTY_TTL_MS = 24 * 60 * 60_000;

/** The 8-K item that IS an earnings release. */
const EARNINGS_ITEM = '2.02';

let tickerToCik: Map<string, string> | null = null;

/** ticker → zero-padded CIK, built by inverting the SEC company_tickers map. */
async function resolveCik(ticker: string): Promise<string | null> {
  if (!tickerToCik) {
    const cikToTicker = await loadCikTickerMap();
    const inverted = new Map<string, string>();
    for (const [cik, t] of cikToTicker) {
      // First CIK wins: company_tickers lists one row per ticker, but a
      // re-registered symbol can appear twice; the earlier entry is the
      // live registrant.
      if (!inverted.has(t)) inverted.set(t, cik);
    }
    tickerToCik = inverted;
  }
  return tickerToCik.get(ticker.toUpperCase()) ?? null;
}

interface SubmissionsRecent {
  form?: string[];
  filingDate?: string[];
  items?: string[];
}

/**
 * Announcement dates (YYYY-MM-DD, newest first) for a ticker, sourced from
 * 8-K filings carrying Item 2.02. Returns [] when the ticker has no CIK, no
 * filings, or SEC is unreachable — callers must treat [] as "unknown" and
 * leave announceDate null rather than substituting anything.
 */
export async function getAnnouncementDates(ticker: string): Promise<string[]> {
  const key = { provider: 'sec', endpoint: '8k-item-202', ticker: ticker.toUpperCase(), extra: 'v1' };
  const hit = await liveCacheGet<string[]>(key, (v) => (v.length > 0 ? ANNOUNCE_TTL_MS : EMPTY_TTL_MS));
  if (Array.isArray(hit)) return hit;

  let dates: string[] = [];
  try {
    const cik = await resolveCik(ticker);
    if (cik) {
      const res = await edgarFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
      const data = (await res.json()) as { filings?: { recent?: SubmissionsRecent } };
      const recent = data?.filings?.recent;
      const forms = recent?.form ?? [];
      const filingDates = recent?.filingDate ?? [];
      const items = recent?.items ?? [];
      const out: string[] = [];
      for (let i = 0; i < forms.length; i++) {
        // 8-K and 8-K/A both carry the release; the amendment restates it.
        if (!String(forms[i] ?? '').startsWith('8-K')) continue;
        if (!String(items[i] ?? '').includes(EARNINGS_ITEM)) continue;
        const d = String(filingDates[i] ?? '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.push(d);
      }
      // Newest first, de-duplicated (an 8-K/A can repeat a date).
      dates = [...new Set(out)].sort((a, b) => b.localeCompare(a));
    }
  } catch {
    // SEC unreachable / WAF / shape change — return empty, never guess.
    dates = [];
  }

  await liveCacheSet(key, dates).catch(() => {});
  return dates;
}

/**
 * Pick the announcement date for one fiscal period end.
 *
 * A report is announced AFTER the quarter closes and within a bounded lag;
 * among the candidates satisfying that, the EARLIEST is the right one (the
 * next quarter's release also satisfies "after this period end", so taking
 * the max would attribute the wrong event). Returns null when nothing
 * plausible exists — the caller then leaves the row unresolved.
 */
export function pickAnnouncementForPeriod(
  period: string,
  announcements: string[],
  maxLagDays: number,
): string | null {
  const pMs = Date.parse(`${period}T00:00:00Z`);
  if (!Number.isFinite(pMs)) return null;
  let best: string | null = null;
  let bestMs = Infinity;
  for (const a of announcements) {
    const aMs = Date.parse(`${a}T00:00:00Z`);
    if (!Number.isFinite(aMs)) continue;
    if (aMs <= pMs) continue; // must follow the quarter it reports
    if (aMs - pMs > maxLagDays * 86400000) continue; // implausibly late
    if (aMs < bestMs) {
      bestMs = aMs;
      best = a;
    }
  }
  return best;
}

/** Test seam — clears the memoized ticker→CIK inversion. */
export function _resetCikCacheForTests(): void {
  tickerToCik = null;
}
