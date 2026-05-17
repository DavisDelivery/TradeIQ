// Phase 4h W3 — persistent ticker → company-name cache.
// Phase 4j W1 — extended to full company info (description, branding,
//               key facts) for the detail-panel CompanyInfo block.
//
// Company name is enriched onto every snapshot pick so the UI can render
// "AAPL — Apple Inc." instead of a bare ticker. Polygon's
// /v3/reference/tickers/{ticker} is the canonical source; reference data
// effectively never changes, so cache aggressively in Firestore at
// `tickerReference/{ticker}` and only call Polygon on a miss.
//
// First scan of a fresh universe → ~N Polygon lookups. All subsequent
// scans → near-zero (cache hits). On Polygon failure, fall back to the
// in-repo `findEntry(ticker)?.name` so a transient network blip can't
// blank the company-name column.
//
// 4j extends the same Polygon call to extract `description`,
// `homepage_url`, `total_employees`, `market_cap`, `list_date`,
// `sic_description` (→ industry), and `branding.logo_url`/`icon_url`.
// Bumps `schemaV` so 4h-era cache docs (which carry only `{name,
// fetchedAt}`) are treated as a miss and re-fetched once on first read —
// without that, every already-cached ticker would show a permanently
// blank description in the detail panel.

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from './firebase-admin';
import { findEntry } from './universe';

const POLYGON = 'https://api.polygon.io';
const COLLECTION = 'tickerReference';
const POLYGON_TIMEOUT_MS = 5_000;
const POLYGON_CONCURRENCY = 6;

// Bump this whenever the cached shape changes. A doc with a smaller (or
// missing) schemaV is treated as a cache miss and re-fetched. 4h shipped
// the implicit schema v1 ({name, fetchedAt}); 4j is v2 (full info).
const SCHEMA_V = 2;

export interface TickerReferenceDoc {
  name: string;
  description?: string;
  homepageUrl?: string;
  logoUrl?: string;
  iconUrl?: string;
  employees?: number;
  marketCap?: number;
  listDate?: string;
  industry?: string;
  schemaV?: number;
  fetchedAt: string;
}

export interface TickerInfo {
  ticker: string;
  name: string;
  description: string | null;
  homepageUrl: string | null;
  logoUrl: string | null;
  iconUrl: string | null;
  employees: number | null;
  marketCap: number | null;
  listDate: string | null;
  industry: string | null;
}

/**
 * Local fallback used when Firestore + Polygon are unavailable. The
 * in-repo universe table carries authoritative names for the ~2,500
 * tickers TradeIQ scans today; we still go to Polygon first so the
 * cache stays canonical for any future ticker the table doesn't cover.
 */
export function localFallbackName(ticker: string): string {
  return findEntry(ticker)?.name ?? ticker;
}

function polygonKey(): string | null {
  return process.env.POLYGON_API_KEY ?? null;
}

// A cached doc is fresh-enough when it has the current schema version AND
// a description field. The description-presence check is belt-and-braces
// for any 4h doc that happened to be written without a schemaV.
function isFreshDoc(data: TickerReferenceDoc | undefined): boolean {
  if (!data) return false;
  if ((data.schemaV ?? 0) < SCHEMA_V) return false;
  return true;
}

/**
 * Single-ticker name lookup (unchanged contract). Cache-first; on miss →
 * Polygon → write-through → return. Other callers (scans) only need the
 * name, so this stays a name-returning function and remains compatible
 * with 4h callers.
 *
 * 4j note: a 4h cache doc (schemaV < 2) is treated as a name HIT for this
 * function only — names didn't change, no need to refetch just to serve
 * `getTickerName`. The migration refetch happens through `getTickerInfo`
 * which actually needs the new fields.
 */
export async function getTickerName(
  ticker: string,
  dbOverride?: Firestore,
): Promise<string> {
  let db: Firestore | null = null;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    return localFallbackName(ticker);
  }

  try {
    const snap = await db.collection(COLLECTION).doc(ticker).get();
    if (snap.exists) {
      const data = snap.data() as TickerReferenceDoc | undefined;
      if (data?.name) return data.name;
    }
  } catch {
    // continue to Polygon fetch
  }

  const fetched = await fetchInfoFromPolygon(ticker);
  if (fetched?.name) {
    try {
      await db
        .collection(COLLECTION)
        .doc(ticker)
        .set(buildCacheDoc(fetched));
    } catch {
      // cache write is best-effort
    }
    return fetched.name;
  }
  return localFallbackName(ticker);
}

/**
 * Single-ticker full-info lookup. Used by /api/ticker-info for the
 * detail-panel CompanyInfo block. Cache-first; on miss OR on a stale
 * 4h-era doc (schemaV < 2) → Polygon → write-through.
 *
 * Returns `null` ONLY when no name can be resolved (extremely unlikely —
 * even Polygon failure falls back to the in-repo universe name).
 */
export async function getTickerInfo(
  ticker: string,
  dbOverride?: Firestore,
): Promise<TickerInfo | null> {
  let db: Firestore | null = null;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    const fallback = localFallbackName(ticker);
    return fallback ? emptyInfo(ticker, fallback) : null;
  }

  let cached: TickerReferenceDoc | undefined;
  try {
    const snap = await db.collection(COLLECTION).doc(ticker).get();
    if (snap.exists) {
      cached = snap.data() as TickerReferenceDoc | undefined;
    }
  } catch {
    // continue to Polygon fetch
  }

  if (cached && isFreshDoc(cached)) {
    return docToInfo(ticker, cached);
  }

  // Cache miss OR stale 4h-era doc — refetch.
  const fetched = await fetchInfoFromPolygon(ticker);
  if (fetched?.name) {
    const doc = buildCacheDoc(fetched);
    try {
      await db.collection(COLLECTION).doc(ticker).set(doc);
    } catch {
      // cache write is best-effort
    }
    return docToInfo(ticker, doc);
  }

  // Polygon failed. If we have a stale 4h doc, return what we have
  // (name only) rather than wiping the name back to the ticker symbol.
  if (cached?.name) return emptyInfo(ticker, cached.name);
  return emptyInfo(ticker, localFallbackName(ticker));
}

function buildCacheDoc(p: PolygonInfo): TickerReferenceDoc {
  // Firestore is configured with ignoreUndefinedProperties at the admin
  // layer; still, only set fields that have a value so reads stay clean.
  const doc: TickerReferenceDoc = {
    name: p.name,
    schemaV: SCHEMA_V,
    fetchedAt: new Date().toISOString(),
  };
  if (p.description) doc.description = p.description;
  if (p.homepageUrl) doc.homepageUrl = p.homepageUrl;
  if (p.logoUrl) doc.logoUrl = p.logoUrl;
  if (p.iconUrl) doc.iconUrl = p.iconUrl;
  if (typeof p.employees === 'number') doc.employees = p.employees;
  if (typeof p.marketCap === 'number') doc.marketCap = p.marketCap;
  if (p.listDate) doc.listDate = p.listDate;
  if (p.industry) doc.industry = p.industry;
  return doc;
}

function docToInfo(ticker: string, d: TickerReferenceDoc): TickerInfo {
  return {
    ticker,
    name: d.name,
    description: d.description ?? null,
    homepageUrl: d.homepageUrl ?? null,
    logoUrl: d.logoUrl ?? null,
    iconUrl: d.iconUrl ?? null,
    employees: d.employees ?? null,
    marketCap: d.marketCap ?? null,
    listDate: d.listDate ?? null,
    industry: d.industry ?? null,
  };
}

function emptyInfo(ticker: string, name: string): TickerInfo {
  return {
    ticker,
    name,
    description: null,
    homepageUrl: null,
    logoUrl: null,
    iconUrl: null,
    employees: null,
    marketCap: null,
    listDate: null,
    industry: null,
  };
}

/**
 * Bulk lookup. Reads all cache docs in parallel, fetches only the
 * misses from Polygon (concurrency-limited), writes them back, returns
 * a complete `{ticker: name}` map. Order is irrelevant — callers index
 * by ticker.
 *
 * Used by the russell2k / sp500 scans to enrich snapshots in O(misses)
 * Polygon calls per scan. After the first warm-up scan, misses → 0.
 *
 * 4j contract: the scan path only needs names — 4h cache docs still
 * count as hits here even though they lack `description`. We do not want
 * to schema-migrate ~2,000 russell2k docs in a single scan; the
 * migration happens lazily through `getTickerInfo` when a user opens
 * the detail panel.
 */
export async function enrichTickerNames(
  tickers: string[],
  dbOverride?: Firestore,
): Promise<Record<string, string>> {
  const unique = Array.from(new Set(tickers));
  const out: Record<string, string> = {};
  if (unique.length === 0) return out;

  let db: Firestore | null = null;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    for (const t of unique) out[t] = localFallbackName(t);
    return out;
  }

  const reads = await Promise.all(
    unique.map((t) =>
      db!
        .collection(COLLECTION)
        .doc(t)
        .get()
        .then(
          (s) =>
            [t, s.exists ? (s.data() as TickerReferenceDoc | undefined) ?? null : null] as const,
        )
        .catch(() => [t, null] as const),
    ),
  );

  const misses: string[] = [];
  for (const [t, data] of reads) {
    if (data?.name) {
      out[t] = data.name;
    } else {
      misses.push(t);
    }
  }

  if (misses.length === 0) return out;

  for (let i = 0; i < misses.length; i += POLYGON_CONCURRENCY) {
    const batch = misses.slice(i, i + POLYGON_CONCURRENCY);
    const fetched = await Promise.all(
      batch.map(async (t) => [t, await fetchInfoFromPolygon(t)] as const),
    );
    const writes: Array<Promise<unknown>> = [];
    for (const [t, info] of fetched) {
      if (info?.name) {
        out[t] = info.name;
        writes.push(
          db
            .collection(COLLECTION)
            .doc(t)
            .set(buildCacheDoc(info))
            .catch(() => undefined),
        );
      } else {
        out[t] = localFallbackName(t);
      }
    }
    await Promise.all(writes);
  }

  return out;
}

interface PolygonInfo {
  name: string;
  description?: string;
  homepageUrl?: string;
  logoUrl?: string;
  iconUrl?: string;
  employees?: number;
  marketCap?: number;
  listDate?: string;
  industry?: string;
}

interface PolygonTickerResults {
  name?: string;
  description?: string;
  homepage_url?: string;
  total_employees?: number;
  market_cap?: number;
  list_date?: string;
  sic_description?: string;
  branding?: {
    logo_url?: string;
    icon_url?: string;
  };
}

async function fetchInfoFromPolygon(ticker: string): Promise<PolygonInfo | null> {
  const key = polygonKey();
  if (!key) return null;
  const url = `${POLYGON}/v3/reference/tickers/${encodeURIComponent(ticker)}?apiKey=${key}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), POLYGON_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: PolygonTickerResults };
    const r = data?.results;
    if (!r || typeof r.name !== 'string' || r.name.length === 0) return null;

    // Polygon's branding URLs require the API key appended for image
    // fetches — they return 401 without it. The CompanyInfo logo loads
    // these URLs directly from the browser, so we attach the key here.
    // This matches the existing Polygon-image pattern; the deploy's
    // POLYGON_API_KEY is read-scoped.
    const logoUrl = r.branding?.logo_url
      ? `${r.branding.logo_url}?apiKey=${key}`
      : undefined;
    const iconUrl = r.branding?.icon_url
      ? `${r.branding.icon_url}?apiKey=${key}`
      : undefined;

    return {
      name: r.name,
      description: typeof r.description === 'string' && r.description.length > 0
        ? r.description
        : undefined,
      homepageUrl: typeof r.homepage_url === 'string' && r.homepage_url.length > 0
        ? r.homepage_url
        : undefined,
      logoUrl,
      iconUrl,
      employees: typeof r.total_employees === 'number' && Number.isFinite(r.total_employees)
        ? r.total_employees
        : undefined,
      marketCap: typeof r.market_cap === 'number' && Number.isFinite(r.market_cap)
        ? r.market_cap
        : undefined,
      listDate: typeof r.list_date === 'string' && r.list_date.length > 0
        ? r.list_date
        : undefined,
      industry: typeof r.sic_description === 'string' && r.sic_description.length > 0
        ? r.sic_description
        : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Exposed for tests.
export const _internals = { COLLECTION, SCHEMA_V };
