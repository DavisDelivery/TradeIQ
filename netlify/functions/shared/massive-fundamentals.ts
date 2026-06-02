// Phase 4w W2 — Massive Financials client.
//
// Replaces the Polygon vX `reference/financials` endpoint (sunset 2026-06-22)
// with the four canonical Massive Financials endpoints:
//
//   - /stocks/financials/v1/ratios                (current-snapshot ratios)
//   - /stocks/financials/v1/income-statements     (quarterly history, PIT)
//   - /stocks/financials/v1/balance-sheets        (quarterly history, PIT)
//   - /stocks/financials/v1/cash-flow-statements  (quarterly history, PIT)
//
// **Key separation:** the Massive Fundamentals add-on is a SEPARATE
// subscription/key from the Stocks Developer plan that powers prices and
// aggregates. Fundamentals access reads `MASSIVE_FUNDAMENTALS_API_KEY`;
// `POLYGON_API_KEY` is untouched and still powers `getDailyBars`, etc.
//
// **PIT discipline (W1c lesson — no silent empties):** each fetch returns a
// `{data, rateLimited, rateLimitExhausted, errorMessage?}` envelope. The
// orchestrator in `getFundamentals` THROWS on `rateLimitExhausted` or
// `errorMessage`, so the caller's `.catch(() => null)` converts the throw to
// null AND the pit-cache write is skipped (we never poison the cache with
// error-nulls — only verified results are persisted).
//
// **Caching:**
//   - LIVE mode (no asOf): 24h in-process map cache keyed by ticker, stores
//     the fully-assembled FundamentalsSnapshot. Mirrors sector-medians.ts
//     with a longer TTL.
//   - PIT mode (asOf set): per-endpoint pit-cache entries keyed by
//     (ticker, asOfDate, dataClass). Ratios is skipped in PIT mode because
//     it's vendor-side a current-snapshot endpoint (no historical mode);
//     the comprehensive ratio block is derived from the statement set
//     instead.

import {
  MassiveRatiosResponseSchema,
  MassiveIncomeStatementsResponseSchema,
  MassiveBalanceSheetsResponseSchema,
  MassiveCashFlowStatementsResponseSchema,
  type MassiveRatiosResult,
  type MassiveIncomeStatement,
  type MassiveBalanceSheet,
  type MassiveCashFlow,
  parseOrFallback,
} from './schemas';
import { pitCacheGet, pitCacheSet, type PitCacheKey, type PitDataClass } from './pit-cache';

const MASSIVE = 'https://api.massive.com';

function massiveKey(): string {
  const k = process.env.MASSIVE_FUNDAMENTALS_API_KEY;
  if (!k) throw new Error('MASSIVE_FUNDAMENTALS_API_KEY not set');
  return k;
}

// ---------------------------------------------------------------------------
// WithStatus envelope — mirrors getFinnhubInsiderTransactionsWithStatus.
// ---------------------------------------------------------------------------

export interface MassiveFetchStatus<T> {
  /** Verified rows. Empty + `errorMessage`/`rateLimitExhausted` set when the
   *  fetch failed; empty without either set means the endpoint returned
   *  honestly-empty data for the query. */
  data: T[];
  rateLimited: boolean;
  rateLimitExhausted: boolean;
  errorMessage?: string;
}

function emptyStatus<T>(): MassiveFetchStatus<T> {
  return { data: [], rateLimited: false, rateLimitExhausted: false };
}

// ---------------------------------------------------------------------------
// Fetch helpers (WithStatus variants)
// ---------------------------------------------------------------------------

interface StatementFetchOpts {
  /** Inclusive upper bound on filing_date — the PIT cutoff. */
  asOfDate?: string;
  /** Newest-first quarters returned. Default 8 (covers 1y current + 1y prior
   *  for TTM EPS and YoY margin baselines). */
  limit?: number;
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; body: unknown; bodyText?: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch { /* ignore */ }
    return { ok: false, status: res.status, body: null, bodyText };
  }
  const body = await res.json();
  return { ok: true, status: res.status, body };
}

export async function fetchRatiosWithStatus(
  ticker: string,
): Promise<MassiveFetchStatus<MassiveRatiosResult>> {
  try {
    const url = `${MASSIVE}/stocks/financials/v1/ratios?ticker=${encodeURIComponent(ticker)}&limit=1&apiKey=${massiveKey()}`;
    const r = await fetchJson(url);
    if (!r.ok) {
      if (r.status === 429) {
        return { data: [], rateLimited: true, rateLimitExhausted: true };
      }
      return { data: [], rateLimited: false, rateLimitExhausted: false, errorMessage: `massive ratios ${r.status}: ${r.bodyText?.slice(0, 200) ?? ''}` };
    }
    const data = parseOrFallback(
      MassiveRatiosResponseSchema,
      r.body,
      { provider: 'polygon', endpoint: 'massive/ratios', ticker },
      { results: [] },
    );
    // Ratios filters by the SINGULAR `ticker` field on the row (sending the
    // plural `tickers=` param is ignored here and returns the wrong company,
    // e.g. ?tickers=AVGO → Agilent). Verify identity; drop non-matching rows.
    // Ratios-alone failure is tolerable (getFundamentals derives the block
    // from statements), so a mismatch returns empty rather than erroring.
    const rows = (data.results ?? []).filter((row) => row.ticker === ticker);
    return { ...emptyStatus<MassiveRatiosResult>(), data: rows };
  } catch (err: unknown) {
    return { data: [], rateLimited: false, rateLimitExhausted: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchStatementWithStatus<T>(
  endpointPath: string,
  ticker: string,
  opts: StatementFetchOpts,
  parse: (body: unknown, ctx: { provider: 'polygon'; endpoint: string; ticker?: string }) => T[],
  endpointLabel: string,
): Promise<MassiveFetchStatus<T>> {
  try {
    const limit = opts.limit ?? 8;
    const filter = opts.asOfDate
      ? `&filing_date.lte=${encodeURIComponent(opts.asOfDate)}`
      : '';
    // The three statement endpoints filter by `tickers` (PLURAL). Sending
    // the singular `ticker` is silently IGNORED — the endpoint then returns
    // its default unfiltered page (whatever filed most recently), so e.g.
    // ?ticker=AVGO came back as Deere. (Ratios is the opposite: it filters
    // by the singular `ticker` and ignores `tickers`.) Each statement row
    // carries a `tickers: string[]` identity we verify below.
    const url =
      `${MASSIVE}${endpointPath}?tickers=${encodeURIComponent(ticker)}&timeframe=quarterly&limit=${limit}&sort=period_end.desc${filter}&apiKey=${massiveKey()}`;
    const r = await fetchJson(url);
    if (!r.ok) {
      if (r.status === 429) {
        return { data: [], rateLimited: true, rateLimitExhausted: true };
      }
      return { data: [], rateLimited: false, rateLimitExhausted: false, errorMessage: `${endpointLabel} ${r.status}: ${r.bodyText?.slice(0, 200) ?? ''}` };
    }
    const data = parse(r.body, { provider: 'polygon', endpoint: endpointLabel, ticker });

    // W1c discipline — no wrong-company data, no silent universe shrink.
    // Verify each row's `tickers` identity matches the request. A non-empty
    // response that matches NOTHING means the filter was ignored (a param
    // regression), so we must NEVER assemble another company's financials;
    // surface it as a hard error (the caller's null-on-error path keeps the
    // ticker out of scoring loudly, instead of silently feeding it the
    // default page). A legitimately-empty response (no coverage) stays empty.
    const matched = data.filter((row) => {
      const t = (row as { tickers?: string[] }).tickers;
      return Array.isArray(t) && t.includes(ticker);
    });
    if (data.length > 0 && matched.length === 0) {
      return {
        data: [],
        rateLimited: false,
        rateLimitExhausted: false,
        errorMessage: `${endpointLabel} returned ${data.length} row(s) but none match ${ticker} (tickers filter ignored?)`,
      };
    }
    return { ...emptyStatus<T>(), data: matched };
  } catch (err: unknown) {
    return { data: [], rateLimited: false, rateLimitExhausted: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchIncomeStatementsWithStatus(
  ticker: string,
  opts: StatementFetchOpts = {},
): Promise<MassiveFetchStatus<MassiveIncomeStatement>> {
  return fetchStatementWithStatus<MassiveIncomeStatement>(
    '/stocks/financials/v1/income-statements',
    ticker,
    opts,
    (body, ctx) => parseOrFallback(MassiveIncomeStatementsResponseSchema, body, ctx, { results: [] }).results ?? [],
    'massive/income-statements',
  );
}

export async function fetchBalanceSheetsWithStatus(
  ticker: string,
  opts: StatementFetchOpts = {},
): Promise<MassiveFetchStatus<MassiveBalanceSheet>> {
  return fetchStatementWithStatus<MassiveBalanceSheet>(
    '/stocks/financials/v1/balance-sheets',
    ticker,
    opts,
    (body, ctx) => parseOrFallback(MassiveBalanceSheetsResponseSchema, body, ctx, { results: [] }).results ?? [],
    'massive/balance-sheets',
  );
}

export async function fetchCashFlowStatementsWithStatus(
  ticker: string,
  opts: StatementFetchOpts = {},
): Promise<MassiveFetchStatus<MassiveCashFlow>> {
  return fetchStatementWithStatus<MassiveCashFlow>(
    '/stocks/financials/v1/cash-flow-statements',
    ticker,
    opts,
    (body, ctx) => parseOrFallback(MassiveCashFlowStatementsResponseSchema, body, ctx, { results: [] }).results ?? [],
    'massive/cash-flow-statements',
  );
}

// ---------------------------------------------------------------------------
// PIT-cached fetchers — the cached path the assembler actually uses in
// PIT (asOfDate-provided) mode. Each one:
//   1. Reads pit-cache; returns the cached value (incl. legitimately-null
//      "no data" answers) on hit.
//   2. On miss, calls the WithStatus fetcher.
//   3. THROWS on rateLimitExhausted / errorMessage so the caller's
//      `.catch(() => null)` returns null AND the cache write is skipped
//      (no error-null poisoning).
//   4. Persists only verified results — including legitimately-empty PIT
//      windows, which ARE PIT-stable.
// ---------------------------------------------------------------------------

async function pitCacheFetch<T>(
  key: PitCacheKey,
  fetcher: () => Promise<MassiveFetchStatus<T>>,
): Promise<T[]> {
  const hit = await pitCacheGet<T[]>(key);
  if (hit !== null) return hit;
  const r = await fetcher();
  if (r.rateLimitExhausted) {
    throw new Error('massive fundamentals rate-limit exhausted');
  }
  if (r.errorMessage) {
    throw new Error(r.errorMessage);
  }
  // Cache verified result (including [] — empty is PIT-stable).
  await pitCacheSet(key, r.data);
  return r.data;
}

function statementKey(ticker: string, asOfDate: string, dataClass: PitDataClass, limit: number): PitCacheKey {
  return { provider: 'polygon', dataClass, ticker, asOfDate, extra: `lim=${limit}:quarterly` };
}

export async function getIncomeStatementsPit(
  ticker: string,
  asOfDate: string,
  limit = 8,
): Promise<MassiveIncomeStatement[]> {
  return pitCacheFetch(
    statementKey(ticker, asOfDate, 'massive_income_statements', limit),
    () => fetchIncomeStatementsWithStatus(ticker, { asOfDate, limit }),
  );
}

export async function getBalanceSheetsPit(
  ticker: string,
  asOfDate: string,
  limit = 8,
): Promise<MassiveBalanceSheet[]> {
  return pitCacheFetch(
    statementKey(ticker, asOfDate, 'massive_balance_sheets', limit),
    () => fetchBalanceSheetsWithStatus(ticker, { asOfDate, limit }),
  );
}

export async function getCashFlowStatementsPit(
  ticker: string,
  asOfDate: string,
  limit = 8,
): Promise<MassiveCashFlow[]> {
  return pitCacheFetch(
    statementKey(ticker, asOfDate, 'massive_cash_flow_statements', limit),
    () => fetchCashFlowStatementsWithStatus(ticker, { asOfDate, limit }),
  );
}

// ---------------------------------------------------------------------------
// In-memory cache seam (test access).
// ---------------------------------------------------------------------------

interface LiveCacheEntry<V> {
  at: number;
  value: V;
}

const LIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function makeLiveCache<V>(): {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  clear(): void;
} {
  const map = new Map<string, LiveCacheEntry<V>>();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (Date.now() - e.at > LIVE_TTL_MS) {
        map.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value) { map.set(key, { at: Date.now(), value }); },
    clear() { map.clear(); },
  };
}
