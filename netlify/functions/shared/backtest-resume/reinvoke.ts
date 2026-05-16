// Phase 4e-1-infra — self-reinvoke helper for the backtest bg-functions.
//
// When a batch wraps and there's still more work to do, the bg-function
// dispatches a follow-on invocation of itself to continue. The dispatch
// MUST go through `context.waitUntil()`: AWS Lambda freezes the container
// the moment the handler's promise resolves, so a bare `fetch().then(...)`
// will be killed mid-flight and the next invocation never lands. This is
// the same race that PR #30 and #31 fixed at the trigger layer.
//
// We catch fetch failures here rather than letting them propagate — a
// failed reinvoke means the run will appear "stuck" at the cursor's
// last-written position; the orchestrator can recover via a manual
// re-invoke curl. The error is also stamped onto the cursor doc by the
// caller so it's visible without trawling logs.

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
  ok: boolean;
  error?: string;
}

/**
 * Self-reinvoke the same bg-function via POST. The fetch is enqueued
 * through `ctx.waitUntil` so Netlify keeps the container alive until the
 * request lands; if `waitUntil` is absent (older runtime, test harness),
 * we fall back to awaiting the fetch directly so the caller still observes
 * a complete dispatch attempt before returning.
 *
 * Returns a result object rather than throwing — the caller decides
 * whether to surface the failure to the cursor doc + Netlify's retry
 * mechanism via a non-200 response.
 */
export async function dispatchReinvoke(
  functionUrl: string,
  runId: string,
  ctx: ReinvokeContext,
  extraBody: Record<string, unknown> = {},
): Promise<DispatchReinvokeResult> {
  const body = JSON.stringify({ runId, resume: true, ...extraBody });
  try {
    const fetchPromise = fetch(functionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
      .then((res) => {
        // Background functions return 202 immediately; status >= 400 means
        // the function was rejected at the gateway (e.g., 4xx config issue).
        if (res.status >= 400) {
          console.error('reinvoke_dispatch_non_2xx', {
            runId,
            functionUrl,
            status: res.status,
          });
        } else {
          console.log('reinvoke_dispatched', {
            runId,
            functionUrl,
            status: res.status,
          });
        }
      })
      .catch((e: unknown) => {
        console.error('reinvoke_fetch_error', {
          runId,
          functionUrl,
          err: e instanceof Error ? e.message : String(e),
        });
      });
    if (typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(fetchPromise);
    } else {
      // No waitUntil — best effort: await the fetch so the caller at least
      // doesn't return before the dispatch lands. Production background
      // functions always have waitUntil; this branch is for tests.
      await fetchPromise;
    }
    return { ok: true };
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    console.error('reinvoke_dispatch_failed', { runId, functionUrl, err });
    return { ok: false, error: err };
  }
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
