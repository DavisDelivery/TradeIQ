// Phase 4e-1-infra — self-reinvoke helper for the backtest bg-functions.
// Phase 4r-W1b — hardened against gateway throttling under concurrent load.
//
// When a batch wraps and there's still more work to do, the bg-function
// dispatches a follow-on invocation of itself to continue. The dispatch
// MUST go through `context.waitUntil()`: AWS Lambda freezes the container
// the moment the handler's promise resolves, so a bare `fetch().then(...)`
// will be killed mid-flight and the next invocation never lands. This is
// the same race that PR #30 and #31 fixed at the trigger layer.
//
// Phase 4r-W1b — the original implementation returned `{ok: true}` for
// every outcome that wasn't a sync throw from `fetch()` itself: gateway
// 429/503 and connection-reset errors were *only* logged. Under 8-way
// concurrent fires the Netlify per-function concurrency ceiling is hit
// by clustered self-POSTs (all 8 watchdogs trip at the same 13-min mark),
// throttled dispatches die silently, runs freeze with intact cursors but
// no further invocations. This module now:
//   - retries the dispatch with bounded exponential backoff on transient
//     failures (5xx, 429, network errors),
//   - returns the actual outcome (last status, attempt count, error) so
//     the caller can stamp it onto the cursor,
//   - adds a small startup jitter to break up clustered arrivals when
//     many backtests reinvoke in the same window.
// See reports/phase-4r-w1b/diagnosis.md for the full chain analysis.

/**
 * Subset of Netlify v1 `HandlerContext` we actually need. Declaring it
 * locally lets the helper be unit-tested with a plain object and avoids
 * dragging the full Netlify Context types through every consumer.
 *
 * `waitUntil` is runtime-injected by Netlify for `-background.ts`
 * functions; the v1 `HandlerContext` type declaration doesn't include it,
 * which is why it's typed optional here. Production functions WILL have it.
 */
export interface ReinvokeContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface DispatchReinvokeResult {
  /** True iff at least one attempt returned a 2xx/3xx response. */
  ok: boolean;
  /** Number of fetch attempts made (1..maxAttempts). */
  attempts: number;
  /** HTTP status of the last attempt that produced a response. */
  lastStatus?: number;
  /** Error message from the final failed attempt, when applicable. */
  error?: string;
}

export interface DispatchReinvokeOptions {
  /** Max fetch attempts (default 4 — 1 initial + 3 retries). */
  maxAttempts?: number;
  /** Base backoff in ms between attempts (default 300; doubled each retry, capped at 4s). */
  baseBackoffMs?: number;
  /** Max jitter delay before the first attempt in ms (default 0 — caller opts in). */
  jitterMs?: number;
  /** Injectable sleep — tests mock to keep them fast. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable random — tests mock to make jitter deterministic. */
  random?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 4_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Self-reinvoke the same bg-function via POST, hardened against gateway
 * throttling. Awaits the full retry chain so the returned result reflects
 * the *actual* dispatch outcome — the caller stamps it onto the cursor
 * for diagnostics. The chain is also enqueued on `ctx.waitUntil` so the
 * container survives any in-flight network even if the handler returns
 * before the await fully unwinds (defence in depth: the handler return
 * triggers ctx.waitUntil drain anyway, but the redundancy is free).
 *
 * Worst-case wall-clock: maxAttempts × (fetch + backoff) — with defaults
 * (4 attempts, 300→4000 ms backoff) that's ~5s if every attempt fails.
 * The watchdog leaves 90s margin under Netlify's 15-min ceiling so this
 * fits comfortably.
 */
export async function dispatchReinvoke(
  functionUrl: string,
  runId: string,
  ctx: ReinvokeContext,
  extraBody: Record<string, unknown> = {},
  options: DispatchReinvokeOptions = {},
): Promise<DispatchReinvokeResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const jitterMs = options.jitterMs ?? 0;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  const body = JSON.stringify({ runId, resume: true, ...extraBody });

  const result: DispatchReinvokeResult = { ok: false, attempts: 0 };

  const chain = (async (): Promise<DispatchReinvokeResult> => {
    if (jitterMs > 0) {
      const wait = Math.floor(random() * jitterMs);
      if (wait > 0) await sleep(wait);
    }
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result.attempts = attempt;
      try {
        const res = await fetch(functionUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        result.lastStatus = res.status;
        // Background functions return 202 immediately on acceptance.
        // 2xx/3xx = accepted. 4xx (except 429) = config issue, no retry.
        // 429/5xx = transient — retry.
        if (res.status < 400) {
          result.ok = true;
          result.error = undefined;
          console.log('reinvoke_dispatched', {
            runId,
            functionUrl,
            status: res.status,
            attempt,
          });
          return result;
        }
        const transient = res.status === 429 || res.status >= 500;
        lastError = `HTTP ${res.status}`;
        console.error(
          transient ? 'reinvoke_dispatch_transient' : 'reinvoke_dispatch_non_2xx',
          { runId, functionUrl, status: res.status, attempt },
        );
        if (!transient) {
          result.error = lastError;
          return result;
        }
      } catch (e: unknown) {
        // Network-level failures (connection reset, DNS, etc.) — always
        // treated as transient.
        lastError = e instanceof Error ? e.message : String(e);
        console.error('reinvoke_fetch_error', {
          runId,
          functionUrl,
          err: lastError,
          attempt,
        });
      }
      if (attempt < maxAttempts) {
        const backoff = Math.min(
          MAX_BACKOFF_MS,
          baseBackoffMs * 2 ** (attempt - 1),
        );
        // Half-and-half jitter so retries from different runs don't
        // re-cluster after the backoff.
        const jittered = Math.floor(backoff / 2 + random() * (backoff / 2));
        await sleep(jittered);
      }
    }
    result.error = lastError;
    console.error('reinvoke_dispatch_exhausted', {
      runId,
      functionUrl,
      attempts: result.attempts,
      lastStatus: result.lastStatus,
      err: lastError,
    });
    return result;
  })();

  // Belt-and-braces: enqueue on waitUntil so the container survives even
  // if the handler somehow returns before `await chain` unwinds. The
  // primary mechanism that lets the caller observe the outcome is the
  // await on `chain` directly.
  if (typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(chain);
  }
  await chain;
  return result;
}

/**
 * Build the URL of a sibling Netlify function from an incoming request's
 * forwarded-host headers. Falls back to the URL env var (set by Netlify
 * in production) and finally to the alpha-deploy URL.
 *
 * Used by bg-functions to point their self-reinvoke at the same deploy
 * the trigger reached — important for preview/branch deploys so the
 * checkpoint chain doesn't accidentally cross deploy boundaries.
 */
export function inferFunctionUrl(
  headers: Record<string, string | undefined>,
  functionPath: string,
): string {
  const host =
    headers['x-forwarded-host'] ??
    headers['X-Forwarded-Host'] ??
    headers.host ??
    headers.Host;
  const proto =
    headers['x-forwarded-proto'] ??
    headers['X-Forwarded-Proto'] ??
    'https';
  if (host) return `${proto}://${host}${functionPath}`;
  const envUrl = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  return `${envUrl}${functionPath}`;
}
