// Shared Quiver Quantitative API client.

import type { ZodSchema } from 'zod';
import { parseOrFallback } from './schemas/parse';

const QUIVER_BASE = 'https://api.quiverquant.com/beta';

function quiverKey(): string {
  const k = process.env.QUIVER_API_KEY;
  if (!k) throw new Error('QUIVER_API_KEY not set');
  return k;
}

const cache = new Map<string, { data: any; ok: boolean; at: number }>();
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Status envelope for Quiver fetches (code-review-2026-06 M8).
 *
 * `ok` distinguishes a VERIFIED response (HTTP 200 with parseable JSON —
 * including a genuinely-empty array) from a TRANSPORT failure (fetch
 * throw, non-OK status incl. 403 subscription gates and 429 exhaustion,
 * non-JSON body, malformed JSON). Providers must treat ok=false as
 * "data unavailable" (return null → analyst no-data rescale), never as
 * "verified no activity".
 */
export interface QuiverResult<T> {
  data: T | null;
  ok: boolean;
}

export async function quiverGetWithStatus<T = any>(
  path: string,
  opts: { ttlMs?: number } = {},
): Promise<QuiverResult<T>> {
  const url = `${QUIVER_BASE}${path}`;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return { data: hit.data as T, ok: hit.ok };
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Token ${quiverKey()}` },
    });
    if (!res.ok) {
      // Tier-gated datasets (the account's plan doesn't include this endpoint)
      // return 403 with body {"detail": "Upgrade your subscription plan..."}.
      // Path-not-found returns 404. Log both — silent null returns made it
      // impossible to tell why the catalyst board's insider scoring was zero
      // for a year before we caught it. Logging is per-cold-start (cached
      // null below means we don't spam).
      if (res.status === 403) {
        console.warn(`[quiver] 403 (subscription gate) on ${path} — dataset not available on this plan`);
      } else if (res.status === 404) {
        console.warn(`[quiver] 404 on ${path} — endpoint path may have changed`);
      } else if (res.status === 429) {
        console.warn(`[quiver] 429 rate-limited on ${path}`);
      }
      cache.set(url, { data: null, ok: false, at: Date.now() }); return { data: null, ok: false };
    }
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.toLowerCase().includes('json')) {
      cache.set(url, { data: null, ok: false, at: Date.now() }); return { data: null, ok: false };
    }
    const text = await res.text();
    if (!text || text.trim().startsWith('<')) {
      cache.set(url, { data: null, ok: false, at: Date.now() }); return { data: null, ok: false };
    }
    let data: T;
    try { data = JSON.parse(text) as T; }
    catch { cache.set(url, { data: null, ok: false, at: Date.now() }); return { data: null, ok: false }; }
    cache.set(url, { data, ok: true, at: Date.now() });
    return { data, ok: true };
  } catch {
    cache.set(url, { data: null, ok: false, at: Date.now() });
    return { data: null, ok: false };
  }
}

export async function quiverGet<T = any>(
  path: string,
  opts: { ttlMs?: number } = {},
): Promise<T | null> {
  return (await quiverGetWithStatus<T>(path, opts)).data;
}

/**
 * Status-aware sibling of `quiverGetTicker` (code-review-2026-06 M8).
 * `ok: true` + empty rows means VERIFIED-empty (HTTP 200, no records);
 * `ok: false` means the fetch itself failed and the rows are missing,
 * not absent.
 */
export async function quiverGetTickerWithStatus<T = any>(
  endpoint: string,
  ticker: string,
  opts: { ttlMs?: number; schema?: ZodSchema<T[]> } = {},
): Promise<{ rows: T[]; ok: boolean }> {
  const { data, ok } = await quiverGetWithStatus<T[] | { data?: T[]; records?: T[] }>(
    `/historical/${endpoint}/${encodeURIComponent(ticker)}`,
    opts,
  );
  if (!ok) return { rows: [], ok: false };
  let rows: T[] = [];
  if (Array.isArray(data)) rows = data;
  else if (data && typeof data === 'object') {
    const obj = data as any;
    if (Array.isArray(obj.data)) rows = obj.data;
    else if (Array.isArray(obj.records)) rows = obj.records;
  }
  if (rows.length === 0) return { rows: [], ok: true };

  // Optional schema validation. Only applied when caller supplies one.
  // We validate the array as a whole (so schema_mismatch is logged once
  // per request, not once per record) and fall back to the unvalidated
  // rows on parse failure — Quiver's field-name churn means strict
  // validation would constantly tank the response, and the providers
  // already normalize via q()/qn()/qdate(). Schemas exist here as drift
  // sensors, not gates.
  if (opts.schema) {
    return {
      rows: parseOrFallback(
        opts.schema,
        rows,
        { provider: 'quiver', endpoint, ticker },
        rows,
      ),
      ok: true,
    };
  }
  return { rows, ok: true };
}

/**
 * Legacy rows-only variant — transport failures collapse into `[]`.
 * Callers that must distinguish "verified empty" from "fetch failed"
 * (the M8 provider-discipline contract) use quiverGetTickerWithStatus.
 */
export async function quiverGetTicker<T = any>(
  endpoint: string,
  ticker: string,
  opts: { ttlMs?: number; schema?: ZodSchema<T[]> } = {},
): Promise<T[]> {
  return (await quiverGetTickerWithStatus<T>(endpoint, ticker, opts)).rows;
}

export function q(row: any, ...names: string[]): any {
  for (const n of names) {
    if (row && row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
  }
  return undefined;
}

export function qn(row: any, ...names: string[]): number | undefined {
  const v = q(row, ...names);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function qdate(row: any, ...names: string[]): string {
  const v = q(row, ...names);
  if (!v) return '';
  const s = String(v);
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
