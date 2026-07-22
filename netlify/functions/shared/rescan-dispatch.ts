// On-demand "Force rescan" dispatch for snapshot-only boards.
//
// Large universes (sp500 ~503, russell2k ~1928) are never inline-scanned in
// a web request — they'd blow the 26s function ceiling. So the board
// endpoints serve the last scheduled snapshot, and "Force rescan" used to
// be a silent no-op there (it just re-served the same snapshot).
//
// Instead, a forced rescan now POSTs the matching checkpoint-resume
// background worker (the same entrypoint the cron trigger fires). The worker
// rescans the full universe over a few self-chaining invocations and swaps
// _latest when done; the board response returns immediately with
// `rescanDispatched: true` so the UI can say "rescan started — composites
// update shortly" while live prices refresh right away.
//
// Only (board, universe) pairs that actually have a bg worker are
// dispatchable; everything else returns false and the caller keeps the
// existing serve-snapshot behavior.

import type { Logger } from './logger';

// (board → universe → background function name). Mirrors the files under
// netlify/functions/scan-*-background.ts.
const RESCAN_WORKERS: Record<string, Record<string, string>> = {
  'target-board': {
    sp500: 'scan-target-board-sp500-background',
    russell2k: 'scan-target-board-russell2k-background',
  },
  catalyst: {
    sp500: 'scan-catalyst-sp500-background',
    russell2k: 'scan-catalyst-russell2k-background',
  },
  insider: {
    sp500: 'scan-insider-sp500-background',
    russell2k: 'scan-insider-russell2k-background',
  },
  lynch: {
    russell2k: 'scan-lynch-russell2k-background',
  },
  sentiment: {
    sp500: 'scan-sentiment-sp500-background',
  },
};

/** The bg worker function name for a (board, universe), or null if none. */
export function rescanWorkerFor(board: string, universe: string): string | null {
  return RESCAN_WORKERS[board]?.[universe] ?? null;
}

/** True when a forced rescan can actually re-scan this (board, universe). */
export function canDispatchRescan(board: string, universe: string): boolean {
  return rescanWorkerFor(board, universe) !== null;
}

/**
 * Fire the background re-scan worker for a (board, universe). Returns true if
 * a worker was dispatched. Best-effort: a dispatch failure is logged and
 * returns false (the caller still serves the existing snapshot).
 *
 * Netlify background functions ack with 202 immediately, so this resolves
 * fast and does not hold up the board response.
 */
export async function dispatchRescan(
  board: string,
  universe: string,
  log?: Logger,
): Promise<boolean> {
  const fn = rescanWorkerFor(board, universe);
  if (!fn) return false;
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  const url = `${origin}/.netlify/functions/${fn}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    log?.info('rescan_dispatched', { board, universe, fn, status: res.status });
    return true;
  } catch (err: any) {
    log?.warn('rescan_dispatch_failed', { board, universe, fn, err: String(err?.message ?? err) });
    return false;
  }
}
