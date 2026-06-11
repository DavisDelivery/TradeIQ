// Wave 2D (CR-7) — shared thin-cron dispatcher for the Prophet scans.
//
// Netlify scheduled functions execute with synchronous-function limits
// (~26s kill ceiling); only `*-background` functions get the 15-min
// container. The three Prophet crons used to run their 10–14-minute scan
// bodies in-handler — the platform kills those mid-scan before
// writeSnapshot ever runs. The fix is the pattern the repo already
// proved on the insider/target boards (`scan-insider-russell2k.ts`,
// `scan-target-board-sp500.ts`): the cron is a thin dispatcher that
// POSTs to a `-background` worker and returns immediately; the worker
// inherits the 15-minute budget and does the actual scan.
//
// This helper exists because all three Prophet crons need byte-identical
// dispatch plumbing (holiday guard → self-invoke POST → log + status
// passthrough); per-file copies are exactly the drift the June-2026
// review flagged ("per-board patches instead of shared mechanisms").
//
// HOLIDAY GUARD: the largecap cron always guarded with isMarketClosed
// (never overwrite a good snapshot with junk data from a closed-market
// day); russell/all previously did not. The guard now applies to all
// three — a market-closed weekday produces no price action worth
// scanning, and the previous good snapshot stays served.
//
// AUTH: none, deliberately — the insider/target cron→worker self-invokes
// are unauthenticated POSTs and this mirrors them exactly (owner
// decision: no token gating on scan paths). The token-gated manual
// largecap trigger (`scan-prophet-largecap-trigger.ts`) is a separate
// path and keeps its existing gate untouched.

import type { Handler } from '@netlify/functions';
import { logger } from './logger';
import { isMarketClosed } from './us-market-holidays';

export interface ProphetCronOpts {
  /** Logger tag, e.g. 'scan-prophet-largecap'. */
  fn: string;
  /** Prophet universe label surfaced in logs + response bodies. */
  universe: 'largecap' | 'russell' | 'all';
  /** Cron expression, logged for traceability (the schedule itself is
   *  bound by the `schedule(...)` wrapper in the cron file). */
  schedule: string;
  /** Path of the background worker to self-invoke. */
  workerPath: string;
}

// Test seam — the unit tests inject `fetchImpl` to assert the dispatch
// target/shape without a real self-invoke, and `marketClosed` to drive
// the holiday branch (mirrors the seam in scan-prophet-largecap-trigger.ts).
export interface ProphetCronDeps {
  fetchImpl: typeof fetch;
  marketClosed: typeof isMarketClosed;
}

const defaultDeps: ProphetCronDeps = { fetchImpl: fetch, marketClosed: isMarketClosed };

export function makeProphetCronHandler(
  opts: ProphetCronOpts,
  deps: ProphetCronDeps = defaultDeps,
): Handler {
  return async () => {
    const log = logger.child({
      fn: opts.fn,
      universe: opts.universe,
      schedule: opts.schedule,
    });

    const now = new Date();
    if (deps.marketClosed(now)) {
      log.info('scheduled_scan_skipped_market_closed', { date: now.toISOString().slice(0, 10) });
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          board: 'prophet',
          universe: opts.universe,
          skipped: true,
          reason: 'market_closed',
          date: now.toISOString().slice(0, 10),
        }),
      };
    }

    const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
    const url = `${origin}${opts.workerPath}`;

    try {
      const res = await deps.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Empty body: the worker treats this as a fresh-start invocation
        // (same convention as the insider/target dispatchers).
        body: JSON.stringify({}),
      });
      const body = await res.text();
      log.info('worker_dispatched', { status: res.status, body: body.slice(0, 200) });
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          board: 'prophet',
          universe: opts.universe,
          workerStatus: res.status,
        }),
      };
    } catch (err: any) {
      log.error('worker_dispatch_failed', { err: String(err?.message ?? err) });
      return {
        statusCode: 500,
        body: JSON.stringify({
          ok: false,
          board: 'prophet',
          universe: opts.universe,
          error: String(err?.message ?? err),
        }),
      };
    }
  };
}
