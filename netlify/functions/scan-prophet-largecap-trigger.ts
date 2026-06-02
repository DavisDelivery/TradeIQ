// Phase 6 PR-H — manual trigger for the Prophet Large Cap snapshot scan.
//
// POST /api/scan-prophet-largecap-trigger?token=<SCHEDULED_SCAN_TRIGGER_TOKEN>
//   [&forcePartial=1]            — exercise the partial-safe write path
//   [&ignoreHoliday=1]            — let the test fire on a closed-market day
//
// Why this exists: the scheduled cron runs at 22:00 UTC weekdays. We
// need a way to test-run the scan once before relying on the schedule
// (and to re-run on demand after a missed slot).
//
// ARCHITECTURE — sync dispatcher in front of a background worker.
//   A complete largecap scan runs for minutes (~5–6 min, ~208 tickers).
//   A synchronous Netlify function is capped at ~26s, so this trigger
//   does NOT run the scan itself — it gates the request synchronously
//   (POST-only, token auth, holiday guard) and then POSTs to
//   `scan-prophet-largecap-trigger-background`, which inherits the
//   15-min background budget the scheduled cron uses. The trigger
//   returns 202 Accepted immediately; verify completion by polling
//   `/api/prophet-picks?universe=largecap` (source flips to "snapshot")
//   or `/api/health`. All three paths — cron, this trigger, and the
//   worker — call the same `runProphetSnapshot` body, so behaviour is
//   identical.
//
// Authentication: simple token check via the `SCHEDULED_SCAN_TRIGGER_TOKEN`
// environment variable. If unset, the endpoint refuses to run (fail-
// closed). The endpoint also refuses GET to make accidental browser
// hits a no-op. The same token is forwarded to the background worker
// (which re-checks it) via the `x-trigger-token` header.

import type { Handler, HandlerEvent } from '@netlify/functions';
import { logger } from './shared/logger';
import { isMarketClosed } from './shared/us-market-holidays';

const BACKGROUND_FUNCTION_PATH = '/.netlify/functions/scan-prophet-largecap-trigger-background';

// Cap on how long we wait for the background dispatch to be accepted.
// Netlify Background Functions return 202 from the gateway as soon as the
// invocation is queued (typically <1s); we await that so the POST actually
// leaves the container (AWS Lambda freezes the container the moment the
// handler Promise resolves, which would strand a fire-and-forget fetch —
// the lesson from the backtest-trigger bg-dispatch fix), but race it
// against a timeout so a slow gateway can't tie up the 26s trigger budget.
const DISPATCH_TIMEOUT_MS = 3000;

export interface DispatchArgs {
  forcePartial: boolean;
  ignoreHoliday: boolean;
  token: string;
  event: HandlerEvent;
}

/** Resolve the public origin for the self-invoke, mirroring the idiom in
 *  backtest-runs-trigger.ts. */
function inferOrigin(event: HandlerEvent): string {
  const headers = event.headers ?? {};
  const host =
    headers['x-forwarded-host'] ??
    headers['X-Forwarded-Host'] ??
    headers.host ??
    headers.Host;
  const proto = headers['x-forwarded-proto'] ?? headers['X-Forwarded-Proto'] ?? 'https';
  if (host) return `${proto}://${host}`;
  return process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
}

/** Default dispatch: POST to the background worker and await the 202. */
async function defaultDispatch(args: DispatchArgs): Promise<void> {
  const origin = inferOrigin(args.event);
  const qs = new URLSearchParams();
  if (args.forcePartial) qs.set('forcePartial', '1');
  const url = `${origin}${BACKGROUND_FUNCTION_PATH}${qs.toString() ? `?${qs.toString()}` : ''}`;

  const dispatch = fetch(url, {
    method: 'POST',
    headers: { 'x-trigger-token': args.token, 'Content-Type': 'application/json' },
    body: '{}',
  });
  await Promise.race([
    dispatch,
    new Promise<void>((resolve) => setTimeout(resolve, DISPATCH_TIMEOUT_MS)),
  ]);
}

// Test seam — the unit test injects `dispatch` so it can assert the trigger
// gated correctly and forwarded the right flags WITHOUT performing a real
// self-invoke, plus `marketClosed` to drive the holiday branch.
export interface TriggerDeps {
  dispatch: (args: DispatchArgs) => Promise<void>;
  marketClosed: typeof isMarketClosed;
}
const defaultDeps: TriggerDeps = { dispatch: defaultDispatch, marketClosed: isMarketClosed };

export function makeHandler(deps: TriggerDeps = defaultDeps): Handler {
  return async (event) => {
    const log = logger.child({ fn: 'scan-prophet-largecap-trigger' });

    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: 'method_not_allowed', expected: 'POST' });
    }

    const expectedToken = process.env.SCHEDULED_SCAN_TRIGGER_TOKEN;
    if (!expectedToken) {
      log.warn('trigger_unconfigured');
      return json(503, { ok: false, error: 'trigger_unconfigured' });
    }
    const providedToken = event.queryStringParameters?.token ?? '';
    if (providedToken !== expectedToken) {
      log.warn('trigger_auth_failed');
      return json(401, { ok: false, error: 'unauthorized' });
    }

    const forcePartial = event.queryStringParameters?.forcePartial === '1';
    const ignoreHoliday = event.queryStringParameters?.ignoreHoliday === '1';

    const now = new Date();
    if (!ignoreHoliday && deps.marketClosed(now)) {
      return json(200, {
        ok: true,
        skipped: true,
        reason: 'market_closed',
        date: now.toISOString().slice(0, 10),
        hint: 'pass ?ignoreHoliday=1 to run anyway',
      });
    }

    await deps.dispatch({ forcePartial, ignoreHoliday, token: providedToken, event });
    log.info('trigger_dispatched', { forcePartial });

    return json(202, {
      ok: true,
      accepted: true,
      board: 'prophet',
      universe: 'largecap',
      forcePartial,
      message:
        'scan dispatched to background worker (runs up to ~15 min); the trigger does not wait for it',
      verify:
        'poll GET /api/prophet-picks?universe=largecap (source flips to "snapshot") or GET /api/health',
    });
  };
}

export const handler: Handler = makeHandler();

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}
