// Shared safeParse wrapper for provider boundaries.
//
// Pattern in providers:
//   const json = await res.json();
//   const parsed = parseOrFallback(SomeSchema, json, {
//     provider: 'polygon', endpoint: 'aggregates'
//   }, { results: [] });
//   return parsed.results;
//
// The wrapper handles three cases:
//   1. Parse succeeds       -> returns parsed data
//   2. Parse fails          -> logs schema_mismatch (issues.slice(0,5)),
//                              returns the supplied fallback
//   3. Schema validation is disabled (env flag) -> bypass, return raw json
//      (escape hatch in case a vendor change breaks all schemas at once
//      and we need to ship a hotfix without yanking the schemas)
//
// Logging convention matches the existing logger's structured-warn shape so
// Sentry breadcrumbs / Netlify function logs aggregate cleanly.

import type { ZodSchema, ZodError } from 'zod';

export interface SchemaContext {
  provider: 'polygon' | 'finnhub' | 'fred' | 'quiver';
  endpoint: string;
  ticker?: string;
}

const SCHEMA_DISABLED =
  typeof process !== 'undefined' &&
  process.env?.TRADEIQ_DISABLE_SCHEMAS === '1';

export function parseOrFallback<T>(
  schema: ZodSchema<T>,
  raw: unknown,
  ctx: SchemaContext,
  fallback: T,
): T {
  if (SCHEMA_DISABLED) return raw as T;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logSchemaMismatch(ctx, parsed.error);
  return fallback;
}

/**
 * Like parseOrFallback but throws on parse failure. Use only when downstream
 * code can't tolerate a fallback (e.g., a single-source-of-truth response).
 * Most callers should prefer parseOrFallback.
 */
export function parseOrThrow<T>(
  schema: ZodSchema<T>,
  raw: unknown,
  ctx: SchemaContext,
): T {
  if (SCHEMA_DISABLED) return raw as T;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logSchemaMismatch(ctx, parsed.error);
  throw new Error(`schema_mismatch:${ctx.provider}:${ctx.endpoint}`);
}

function logSchemaMismatch(ctx: SchemaContext, error: ZodError): void {
  const issues = error.issues.slice(0, 5).map((i) => ({
    path: i.path.join('.'),
    code: i.code,
    message: i.message,
  }));
  // eslint-disable-next-line no-console
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'schema_mismatch',
      provider: ctx.provider,
      endpoint: ctx.endpoint,
      ticker: ctx.ticker,
      issueCount: error.issues.length,
      issues,
    }),
  );
}
