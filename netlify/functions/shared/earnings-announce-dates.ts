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
/**
 * Announcements needed before we stop looking.
 *
 * Tied to the 400-day bar window the scorer runs on: a prior move can only be
 * measured where BARS exist, so at most ~4 quarters are ever usable. Asking
 * for more just forces shard fetches for data that can never be scored —
 * measured 2026-07-26, a threshold of 5 multiplied EDGAR calls during the very
 * cold-cache burst that was already failing, and coverage fell to 18%.
 */
// 8, not 4. The old value was explicitly calibrated to stock-detail's
// 400-day bar window (~4-5 quarters); that window is now 820 days and the
// profile renders eight quarters of earnings reactions. Left at 4, heavy
// filers would stop shard-walking as soon as four dates were found and the
// older half of the panel would be permanently blank for exactly the
// companies that file the most.
const MIN_ANNOUNCEMENTS = 8;
/** Hard cap on shard pages per ticker — bounds cost for heavy filers. */
const MAX_SHARDS = 3;

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
  const key = { provider: 'sec', endpoint: '8k-item-202', ticker: ticker.toUpperCase(), extra: 'v2' };
  const hit = await liveCacheGet<string[]>(key, (v) => (v.length > 0 ? ANNOUNCE_TTL_MS : EMPTY_TTL_MS));
  if (Array.isArray(hit)) return hit;

  let dates: string[] = [];
  // Did SEC actually ANSWER? A transient failure must never be persisted.
  // Measured 2026-07-25: the first full scan resolved only 122/376 names while
  // a direct sample showed 19/20 have 8-K/2.02 available — i.e. the data was
  // there and transient failures during a 376-call cold-cache burst were being
  // cached as "this ticker has no announcements" for 24h. That is exactly the
  // error-shaped empty the codebase forbids caching elsewhere (4t-W1c).
  let answered = false;
  try {
    const cik = await resolveCik(ticker);
    if (cik) {
      dates = await fetchAnnouncementsForCik(cik);
      answered = true;
    } else {
      // No CIK is a genuine, stable answer (not an error) — cache the empty so
      // unmappable symbols don't re-probe every run.
      answered = true;
    }
  } catch {
    // SEC unreachable / WAF / shape change. Return empty for THIS call so the
    // caller leaves rows unresolved, but do NOT persist — the next run retries.
    answered = false;
    dates = [];
  }

  if (answered) await liveCacheSet(key, dates).catch(() => {});
  return dates;
}

/** Extract 8-K item-2.02 filing dates from one submissions payload. */
function extract202(recent: SubmissionsRecent | undefined): string[] {
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
  return out;
}

/**
 * All known announcement dates for a CIK, newest first.
 *
 * Heavy filers overflow `filings.recent` into `filings.files[]` shards — JPM
 * carries 25,457 recent entries plus 68 shards. When `recent` yields too few
 * announcements to cover the quarters the scorer needs, walk shards newest-
 * first until we have enough. Bounded hard: shards are only fetched when the
 * ticker genuinely lacks coverage, and never more than MAX_SHARDS, so the
 * common case stays one SEC call per ticker.
 */
async function fetchAnnouncementsForCik(cik: string): Promise<string[]> {
  const res = await edgarFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const data = (await res.json()) as {
    filings?: { recent?: SubmissionsRecent; files?: Array<{ name?: string }> };
  };
  const out = extract202(data?.filings?.recent);

  if (out.length < MIN_ANNOUNCEMENTS) {
    const shards = (data?.filings?.files ?? []).slice(0, MAX_SHARDS);
    for (const sh of shards) {
      const name = String(sh?.name ?? '');
      if (!name) continue;
      try {
        const sres = await edgarFetch(`https://data.sec.gov/submissions/${name}`);
        // Shard payloads are the bare `recent`-shaped object.
        out.push(...extract202((await sres.json()) as SubmissionsRecent));
      } catch {
        break; // a failed shard just caps history; the primary answer stands
      }
      if (out.length >= MIN_ANNOUNCEMENTS) break;
    }
  }
  return [...new Set(out)].sort((a, b) => b.localeCompare(a));
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
