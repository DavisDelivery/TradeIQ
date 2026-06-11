// EDGAR role lookup — enrich insider names with their reporting role
// (CEO / CFO / Director / Officer / 10% Owner) from SEC EDGAR Form 4 XML.
//
// Why this exists: Finnhub's /stock/insider-transactions endpoint omits
// the insider's role/title entirely. Without role data, the catalyst
// board's "C-suite buy" bonus is unreachable, and the UI's Top Buyer
// column shows just a name with no context. EDGAR's Form 4 XML carries
// role data in <reportingOwnerRelationship>, surfaced via SEC's full-text
// search.
//
// Disambiguation: the same insider name can resolve to multiple people
// (e.g. "Ricks David A" is both Lilly's CEO and an Adobe board director).
// We constrain the search to the issuer's CIK so the right person is
// picked. Ticker→CIK mapping comes from SEC's public company_tickers.json
// (~800KB, fetched once per cold start, cached forever in-memory).
//
// Rate limits: SEC's fair-use policy is "10 req/sec with proper User-Agent".
// We comply with a compliant UA and concurrency cap of 5 per call.
// Per-name timeout is 1500ms — slow lookups are skipped (return null).

const EDGAR_UA = 'TradeIQ Alpha chad@davisdelivery.com';
const EFTS_BASE = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_ARCHIVE_BASE = 'https://www.sec.gov/Archives';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

// Per-cold-start cache: `${ticker}|${name}` → role (or null = looked up, none found).
// Including ticker in the key handles same-name-different-issuer correctly.
const roleCache = new Map<string, { role: string | null; at: number }>();
const ROLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PER_LOOKUP_TIMEOUT_MS = 1500;

// Ticker → CIK map. Loaded lazily on first use.
//
// Failure discipline (code-review-2026-06 infra minor 13): a transient
// failure fetching company_tickers.json must NOT be cached as an empty
// map for the life of the warm instance — that silently disabled all
// role enrichment until the next cold start. On failure we leave the
// success cache unset (so the next call retries) and record a backoff
// timestamp so a hard SEC outage isn't hammered more than once per
// TICKER_MAP_RETRY_BACKOFF_MS.
let tickerToCik: Map<string, string> | null = null;
let tickerMapPromise: Promise<Map<string, string>> | null = null;
let tickerMapFailedAt: number | null = null;
const TICKER_MAP_RETRY_BACKOFF_MS = 60_000;

async function getTickerToCikMap(): Promise<Map<string, string>> {
  if (tickerToCik) return tickerToCik;
  if (tickerMapPromise) return tickerMapPromise;
  // Within the failure backoff window — return an empty map WITHOUT
  // caching it; the next call after the window retries the fetch.
  if (tickerMapFailedAt !== null && Date.now() - tickerMapFailedAt < TICKER_MAP_RETRY_BACKOFF_MS) {
    return new Map();
  }
  const p = (async () => {
    try {
      const res = await fetch(SEC_TICKERS_URL, {
        headers: { 'User-Agent': EDGAR_UA, Accept: 'application/json' },
      });
      if (!res.ok) {
        console.warn(`[edgar] ticker map fetch failed: ${res.status}`);
        tickerMapFailedAt = Date.now();
        return new Map<string, string>();
      }
      const json = (await res.json()) as Record<string, { cik_str: number; ticker: string }>;
      const m = new Map<string, string>();
      for (const v of Object.values(json)) {
        if (v?.ticker && Number.isFinite(v.cik_str)) {
          m.set(v.ticker.toUpperCase(), String(v.cik_str).padStart(10, '0'));
        }
      }
      if (m.size === 0) {
        // A 200 that parses to zero tickers is indistinguishable from a
        // truncated/garbage body — treat as failure, don't cache.
        console.warn('[edgar] ticker map fetch returned 0 tickers; not caching');
        tickerMapFailedAt = Date.now();
        return m;
      }
      tickerToCik = m;
      tickerMapFailedAt = null;
      return m;
    } catch (e) {
      console.warn('[edgar] ticker map fetch error:', String(e));
      tickerMapFailedAt = Date.now();
      return new Map<string, string>();
    }
  })();
  tickerMapPromise = p;
  try {
    return await p;
  } finally {
    // Clear the in-flight handle once settled. On success tickerToCik is
    // set (fast path); on failure the backoff timestamp gates retries.
    tickerMapPromise = null;
  }
}

export interface EnrichedRole {
  name: string;
  role: string | null;
}

/**
 * Look up a single insider's role via EDGAR, scoped to the given issuer
 * ticker. The ticker scoping is critical for disambiguating same-name
 * insiders at different companies. Returns null if no Form 4 with role
 * data is found within timeout.
 */
export async function lookupInsiderRole(
  name: string,
  ticker: string,
): Promise<string | null> {
  const cleanedName = name.trim();
  const cleanedTicker = ticker.trim().toUpperCase();
  if (!cleanedName || !cleanedTicker) return null;

  const cacheKey = `${cleanedTicker}|${cleanedName}`;
  const hit = roleCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ROLE_CACHE_TTL_MS) return hit.role;

  try {
    const role = await withTimeout(fetchRole(cleanedName, cleanedTicker), PER_LOOKUP_TIMEOUT_MS);
    roleCache.set(cacheKey, { role, at: Date.now() });
    return role;
  } catch (e) {
    // Ticker map unavailable (SEC outage) — do NOT poison the 24h role
    // cache with nulls; once the map fetch recovers (see backoff above)
    // the next lookup gets a real shot.
    if (e instanceof TickerMapUnavailableError) return null;
    // Timeout or fetch error — cache the null so we don't re-attempt
    // every cold start. 24h TTL means tomorrow's call retries.
    roleCache.set(cacheKey, { role: null, at: Date.now() });
    return null;
  }
}

/**
 * Bulk-enrich an array of {name, ...} objects with a `role` field for the
 * given issuer ticker. Concurrency-capped at 5 per fair-use guidance.
 * Names that can't be resolved within timeout get role: null. Order preserved.
 */
export async function enrichRoles<T extends { name: string }>(
  items: T[],
  ticker: string,
): Promise<Array<T & { role: string | null }>> {
  const out: Array<T & { role: string | null }> = new Array(items.length);
  const concurrency = 5;
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const roles = await Promise.all(
      chunk.map((item) => lookupInsiderRole(item.name, ticker))
    );
    for (let j = 0; j < chunk.length; j++) {
      out[i + j] = { ...chunk[j], role: roles[j] };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

class TickerMapUnavailableError extends Error {
  constructor() { super('SEC ticker map unavailable'); }
}

async function fetchRole(name: string, ticker: string): Promise<string | null> {
  const cikMap = await getTickerToCikMap();
  // Empty map = the fetch failed (a real map has ~10k entries). Throw a
  // typed error so the caller skips the 24h null-cache for this lookup.
  if (cikMap.size === 0) throw new TickerMapUnavailableError();
  const issuerCik = cikMap.get(ticker);
  if (!issuerCik) return null; // Ticker not in SEC universe — can't disambiguate

  // Recent date window — only look at filings since 2023, the role today
  // matters more than what they were 10 years ago. Reduces hits to recent
  // and relevant; sorted desc by EDGAR.
  const startdt = '2023-01-01';
  const enddt = new Date().toISOString().slice(0, 10);
  const q = encodeURIComponent(`"${name}"`);
  const searchUrl = `${EFTS_BASE}?q=${q}&forms=4&ciks=${issuerCik}&dateRange=custom&startdt=${startdt}&enddt=${enddt}`;

  const sres = await fetch(searchUrl, {
    headers: { 'User-Agent': EDGAR_UA, Accept: 'application/json' },
  });
  if (!sres.ok) return null;
  const sjson = (await sres.json()) as { hits?: { hits?: Array<{ _id: string; _source: any }> } };
  const hits = sjson?.hits?.hits ?? [];
  if (hits.length === 0) return null;

  // Walk the first 3 hits — the first hit usually has the data we need,
  // but occasionally the role flags are blank on a particular filing
  // (e.g. amendments). Falling through to subsequent hits handles that.
  for (const hit of hits.slice(0, 3)) {
    try {
      const role = await extractRoleFromHit(hit, name);
      if (role) return role;
    } catch {
      continue;
    }
  }
  return null;
}

async function extractRoleFromHit(
  hit: { _id: string; _source: any },
  expectedName: string,
): Promise<string | null> {
  // _id format: "<accession-number>:<primary-document-name>"
  // Archive URL: https://www.sec.gov/Archives/edgar/data/<reporter-cik>/<adsh-no-dashes>/<doc>
  // _source.ciks[0] is the reporter (insider) CIK; ciks[1] is the issuer.
  const id = hit._id;
  const src = hit._source ?? {};
  const ciks: string[] = Array.isArray(src.ciks) ? src.ciks : [];
  if (!id.includes(':') || ciks.length === 0) return null;

  const [adsh, primaryDoc] = id.split(':');
  const adshNoDashes = adsh.replace(/-/g, '');
  // Reporter CIK comes first in the ciks array; that's the path component.
  const reporterCik = String(ciks[0]).replace(/^0+/, '');
  if (!reporterCik) return null;

  const xmlUrl = `${EDGAR_ARCHIVE_BASE}/edgar/data/${reporterCik}/${adshNoDashes}/${primaryDoc}`;
  const res = await fetch(xmlUrl, {
    headers: { 'User-Agent': EDGAR_UA, Accept: 'application/xml,text/xml,*/*' },
  });
  if (!res.ok) return null;
  const xml = await res.text();
  return parseFormFourRole(xml, expectedName);
}

/**
 * Parse role from Form 4 XML. The schema is fixed: <reportingOwner> contains
 * <reportingOwnerId><rptOwnerName> and <reportingOwnerRelationship> with
 * boolean flags isDirector / isOfficer / isTenPercentOwner / isOther plus
 * an optional <officerTitle> string.
 *
 * Multiple reportingOwner blocks can appear (rare on Form 4 but possible);
 * we match on the expected name to pull the right one.
 */
function parseFormFourRole(xml: string, expectedName: string): string | null {
  const blocks = matchAll(xml, /<reportingOwner[\s\S]*?<\/reportingOwner>/g);
  if (blocks.length === 0) return null;

  const normalized = normalizeName(expectedName);
  const target = blocks.find((b) => {
    const n = matchOne(b, /<rptOwnerName>([^<]+)<\/rptOwnerName>/);
    return n && nameMatches(normalizeName(n), normalized);
  }) ?? blocks[0];

  const isOfficer = boolFlag(target, 'isOfficer');
  const isDirector = boolFlag(target, 'isDirector');
  const isTenPct = boolFlag(target, 'isTenPercentOwner');
  const officerTitle = matchOne(target, /<officerTitle>([^<]*)<\/officerTitle>/)?.trim() ?? '';

  // Title precedence: explicit officerTitle > flag-derived label.
  // Note officerTitle can be empty string for directors who are not also
  // officers — that's the common case for board-only members.
  if (officerTitle) {
    return cleanTitle(officerTitle);
  }
  if (isOfficer && isDirector) return 'Officer/Director';
  if (isOfficer) return 'Officer';
  if (isDirector) return 'Director';
  if (isTenPct) return '10% Owner';
  return null;
}

function boolFlag(block: string, tag: string): boolean {
  // Form 4 wraps booleans either as bare "1"/"0" or as "true"/"false",
  // and may or may not have a <value> wrapper. Match the captured token.
  const m = new RegExp(`<${tag}>\\s*(?:<value>)?\\s*([01]|true|false)`, 'i').exec(block);
  if (!m) return false;
  const v = m[1].toLowerCase();
  return v === '1' || v === 'true';
}

function cleanTitle(t: string): string {
  // Decode common HTML entities EDGAR may have left in (rare but real)
  let u = t.trim()
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  u = u.replace(/\s+/g, ' ');
  // Common title patterns — collapse to the most useful short form.
  if (/president,?\s*chair,?\s*and\s*ceo/i.test(u)) return 'CEO/Chair';
  if (/chief executive officer|^CEO\b/i.test(u)) return 'CEO';
  if (/chief financial officer|^CFO\b/i.test(u)) return 'CFO';
  if (/chief operating officer|^COO\b/i.test(u)) return 'COO';
  if (/chief technology officer|^CTO\b/i.test(u)) return 'CTO';
  if (/chief medical officer|^CMO\b/i.test(u)) return 'CMO';
  if (/chief legal officer|general counsel/i.test(u)) return 'General Counsel';
  if (/chief.*officer/i.test(u)) return 'Chief Officer';
  if (/^pres(ident)?\b/i.test(u)) return 'President';
  if (/chair(man|person|woman)?\b/i.test(u)) return 'Chair';
  if (/director/i.test(u)) return 'Director';
  return u.length <= 30 ? u : u.slice(0, 30);
}

function normalizeName(n: string): string {
  return n.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}
function nameMatches(a: string, b: string): boolean {
  if (a === b) return true;
  // Form 4 typically uses "LAST FIRST [MIDDLE]"; Finnhub uses the same
  // convention. Loose match by token overlap to handle middle initials etc.
  const aTokens = new Set(a.split(' ').filter((t) => t.length >= 2));
  const bTokens = new Set(b.split(' ').filter((t) => t.length >= 2));
  let overlap = 0;
  for (const t of aTokens) if (bTokens.has(t)) overlap++;
  return overlap >= 2;
}

function matchAll(s: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}
function matchOne(s: string, re: RegExp): string | null {
  const m = re.exec(s);
  return m ? m[1] : null;
}
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** Tests only — wipe ticker-map + role caches and backoff state. */
export function _resetEdgarCachesForTests(): void {
  tickerToCik = null;
  tickerMapPromise = null;
  tickerMapFailedAt = null;
  roleCache.clear();
}

/** Tests only — direct access to the lazy ticker-map loader. */
export const _getTickerToCikMapForTests = getTickerToCikMap;
