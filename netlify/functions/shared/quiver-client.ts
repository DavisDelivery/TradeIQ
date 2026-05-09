// Shared Quiver Quantitative API client.

import type { ZodSchema } from 'zod';
import { parseOrFallback } from './schemas/parse';

const QUIVER_BASE = 'https://api.quiverquant.com/beta';

function quiverKey(): string {
  const k = process.env.QUIVER_API_KEY;
  if (!k) throw new Error('QUIVER_API_KEY not set');
  return k;
}

const cache = new Map<string, { data: any; at: number }>();
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export async function quiverGet<T = any>(
  path: string,
  opts: { ttlMs?: number } = {},
): Promise<T | null> {
  const url = `${QUIVER_BASE}${path}`;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;
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
      cache.set(url, { data: null, at: Date.now() }); return null;
    }
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.toLowerCase().includes('json')) {
      cache.set(url, { data: null, at: Date.now() }); return null;
    }
    const text = await res.text();
    if (!text || text.trim().startsWith('<')) {
      cache.set(url, { data: null, at: Date.now() }); return null;
    }
    let data: T;
    try { data = JSON.parse(text) as T; }
    catch { cache.set(url, { data: null, at: Date.now() }); return null; }
    cache.set(url, { data, at: Date.now() });
    return data;
  } catch {
    cache.set(url, { data: null, at: Date.now() });
    return null;
  }
}

export async function quiverGetTicker<T = any>(
  endpoint: string,
  ticker: string,
  opts: { ttlMs?: number; schema?: ZodSchema<T[]> } = {},
): Promise<T[]> {
  const data = await quiverGet<T[] | { data?: T[]; records?: T[] }>(
    `/historical/${endpoint}/${encodeURIComponent(ticker)}`,
    opts,
  );
  let rows: T[] = [];
  if (Array.isArray(data)) rows = data;
  else if (data && typeof data === 'object') {
    const obj = data as any;
    if (Array.isArray(obj.data)) rows = obj.data;
    else if (Array.isArray(obj.records)) rows = obj.records;
  }
  if (rows.length === 0) return [];

  // Optional schema validation. Only applied when caller supplies one.
  // We validate the array as a whole (so schema_mismatch is logged once
  // per request, not once per record) and fall back to the unvalidated
  // rows on parse failure — Quiver's field-name churn means strict
  // validation would constantly tank the response, and the providers
  // already normalize via q()/qn()/qdate(). Schemas exist here as drift
  // sensors, not gates.
  if (opts.schema) {
    return parseOrFallback(
      opts.schema,
      rows,
      { provider: 'quiver', endpoint, ticker },
      rows,
    );
  }
  return rows;
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
