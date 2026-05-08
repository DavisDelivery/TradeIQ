// Frontend Sentry init.
//
// No-op until VITE_SENTRY_DSN is configured. main.jsx calls initSentry()
// before render so cold-start errors and the App ErrorBoundary both have
// a place to send events.
//
// captureException(err, ctx?) is a thin wrapper used by the ErrorBoundary
// componentDidCatch hook in App.jsx.

import * as Sentry from '@sentry/react';

let initialized = false;

export function initSentry() {
  if (initialized) return;
  const dsn = import.meta.env?.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    // Release tag — wire to APP_VERSION at the call site if helpful for filters.
    release: import.meta.env?.VITE_APP_VERSION || undefined,
    environment: import.meta.env?.MODE ?? 'production',
    // Errors only for now. Tracing is expensive on the free tier.
    tracesSampleRate: 0,
    // Session replay only for unhandled errors — saves quota.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
  });
  initialized = true;
}

export function captureException(err, ctx) {
  initSentry();
  if (!import.meta.env?.VITE_SENTRY_DSN) {
    // Local fallback so errors aren't silent in dev.
    // eslint-disable-next-line no-console
    console.error('[sentry-noop]', err, ctx);
    return;
  }
  Sentry.withScope((scope) => {
    if (ctx) {
      for (const [k, v] of Object.entries(ctx)) {
        scope.setExtra(k, v);
      }
    }
    Sentry.captureException(err);
  });
}
