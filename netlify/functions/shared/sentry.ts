// Sentry init + helpers for Netlify functions.
//
// Why: Phase 0 brief calls for "an exception in /api/prophet-picks shows up
// in Sentry within 30s". Two integration points achieve this without
// wrapping 16 handlers:
//
//   1. captureException(err) — direct call from any error path.
//   2. logger.ts log.error(...) calls captureException(err) automatically
//      (one line of integration there gives every function Sentry coverage
//      for free).
//
// The withSentry(handler) wrapper is also exported as belt-and-suspenders
// for any error paths that escape the inner try/catch (e.g. a syntax error
// in module init, a Promise rejection that doesn't reach the catch block).
//
// All paths are no-ops when SENTRY_DSN is unset, so the code can ship
// before the user creates the Sentry project. Once DSN is added to
// Netlify env, every error path lights up automatically.

import type { Handler } from '@netlify/functions';
import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;  // No-op until DSN is configured

  Sentry.init({
    dsn,
    environment: process.env.CONTEXT ?? process.env.NODE_ENV ?? 'production',
    release: process.env.COMMIT_REF || process.env.GIT_SHA || undefined,
    // Keep tracing off for now — costs sample budget and we don't have a
    // performance bottleneck to diagnose. Errors only.
    tracesSampleRate: 0,
    // Don't capture console.* automatically — we drive Sentry deliberately
    // from logger.ts so we have full control over what becomes an event.
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== 'Console' && i.name !== 'OnUncaughtException'),
  });
  initialized = true;
}

export function captureException(err: unknown, ctx?: Record<string, unknown>): void {
  // Lazy init in case the function ran before any explicit init() call.
  initSentry();
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (ctx) {
      for (const [k, v] of Object.entries(ctx)) {
        scope.setExtra(k, v);
      }
    }
    Sentry.captureException(err);
  });
}

// Wrap a Netlify handler. Catches anything that escapes the handler's own
// try/catch and reports it. Re-throws so Netlify's own 500 path runs.
export function withSentry(handler: Handler): Handler {
  // The Netlify Handler type is a discriminated union over callback and
  // promise styles; the runtime contract is "return a HandlerResponse".
  // Casting the wrapped function lets us preserve that contract while
  // keeping the inner await against the union return type.
  const wrapped = async (event: any, context: any) => {
    initSentry();
    try {
      const result = await handler(event, context, () => {});
      // handler may return void via the callback path; pass that through.
      return result as any;
    } catch (err) {
      captureException(err, { handler: handler.name });
      throw err;
    }
  };
  return wrapped as Handler;
}

// Test hook
export const __testInternals = {
  reset: () => {
    initialized = false;
  },
  isInitialized: () => initialized,
};
