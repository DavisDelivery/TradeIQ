// Phase 6 PR-G0 — generic Promise-with-fallback timeout wrapper.
//
// Why this exists: Netlify functions that fan out to N upstream providers
// in a single Promise.all are only as fast as the slowest one. If a single
// provider HANGS (no error, no resolution), the entire function waits past
// the Netlify gateway's wall-clock cap (~40-45s) and the user sees a 502.
//
// `withTimeout(promise, ms, fallback)` races the promise against a timer.
// On timeout the wrapper resolves with `fallback`, the orphaned promise is
// allowed to settle on its own (garbage-collected eventually — we don't
// have AbortController plumbing on every provider), and the caller
// continues. Rejections are caught and treated like timeouts: resolve with
// the same fallback. The caller never sees an exception from this helper.
//
// This is the W1c "no silent empty" discipline applied at the aggregation
// boundary: a slow/hanging dep becomes a clean degraded fallback, not a
// fatal 502.

export interface WithTimeoutResult<T> {
  value: T;
  /** True iff the timer fired before the promise settled. */
  timedOut: boolean;
  /** True iff the underlying promise rejected. */
  errored: boolean;
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

/**
 * Variant that returns metadata about whether the timer or an error
 * caused the fallback to fire — useful for `_reason` strings in
 * honest-no-data responses.
 */
export function withTimeoutStatus<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<WithTimeoutResult<T>> {
  return new Promise<WithTimeoutResult<T>>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ value: fallback, timedOut: true, errored: false });
    }, ms);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve({ value: v, timedOut: false, errored: false });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve({ value: fallback, timedOut: false, errored: true });
      },
    );
  });
}
