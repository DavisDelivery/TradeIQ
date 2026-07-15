// scan-prophet-portfolio-fwd-returns-background — 15-min background worker.
//
// Dead-cron remediation (runtime audit 2026-07-15): this scan previously
// ran INLINE in its scheduled function. Netlify grants the 15-minute
// budget only to *-background names; the inline scan was killed at the
// synchronous ceiling before writeSnapshot — the same failure class the
// #95-#97 remediation fixed for four other boards. The cron file is now a
// thin dispatcher; the scan body below is verbatim from the old inline
// handler.

// Phase 4e-1 — Lagged forward-return populator for the decisionLog.
//
// Daily scheduled function (21:00 UTC, every day). Scans the
// prophetPortfolio/{universe}/decisionLog/ collection for rows old
// enough that one of their forward-return windows has matured, and
// fills in the corresponding return from Polygon daily bars. Phase 5c
// consumes these rows to train an alternative ranking signal.
//
// Windows: 30d, 60d, 90d. A row is "needs update" if its decisionDate
// is at least N+5 calendar days in the past AND the corresponding
// forwardReturnNd field is still missing. (The +5 buffer lets weekends
// and holidays settle so we don't re-write rows multiple times.)
//
// This function lands dormant pre-W5 — decisionLog is empty until the
// rebalance scheduled function ships and starts writing rows. Until
// then this scan is a no-op each day.
//
// Wave 3A / M5 — starvation fix: listDecisionLogRowsOlderThan returns
// the OLDEST ≤200 pending rows. Rows that can never resolve (delisted
// ticker → no bars; exit bar forever past the data) used to be retried
// and pile up at the head of that window until no younger row was ever
// batched again. Now each failed attempt on a matured window increments
// `fwdReturnAttempts`; after MAX_FWD_RETURN_ATTEMPTS the row is marked
// `fwdReturnsStatus: 'exhausted'` with explicit nulls for its unfilled
// windows, and rows whose three windows all fill get
// `fwdReturnsStatus: 'complete'` — both states drop out of the
// pending-only query (see state.ts) so younger rows keep flowing.

import type { Handler } from '@netlify/functions';
import { getDailyBars } from './shared/data-provider';
import { logger } from './shared/logger';
import {
  listDecisionLogRowsOlderThan,
  updateDecisionLogForwardReturns,
} from './shared/prophet-portfolio/state';
import {
  computeForwardReturns,
  type PriceBar,
} from './shared/prophet-portfolio/decision-log';
import type {
  DecisionLogRow,
  PortfolioUniverse,
} from './shared/prophet-portfolio/types';

const UNIVERSES: PortfolioUniverse[] = ['largecap'];

/** Wave 3A / M5 — after this many runs where a MATURED window stayed
 *  unfilled (no bars / unresolvable exit), the row is written off as
 *  'exhausted' (explicit nulls) so it stops occupying the oldest-first
 *  query head. In practice a ticker whose matured 30d window fails N
 *  consecutive daily runs has stopped trading — later windows are dead
 *  too, so the whole row is closed out rather than aged to 95d. */
export const MAX_FWD_RETURN_ATTEMPTS = 5;

const ALL_WINDOWS = [30, 60, 90] as const;

function daysBetweenStrings(a: string, b: string): number {
  const ams = Date.parse(`${a}T00:00:00Z`);
  const bms = Date.parse(`${b}T00:00:00Z`);
  return Math.round((bms - ams) / 86_400_000);
}

/**
 * Identify the windows on this row that have matured (decisionDate +
 * window + 5d buffer ≤ today) AND are still null in the row.
 */
export function maturedWindowsFor(
  row: DecisionLogRow,
  today: string,
): number[] {
  const out: number[] = [];
  const age = daysBetweenStrings(row.decisionDate, today);
  for (const w of [30, 60, 90]) {
    if (age < w + 5) continue;
    const fieldName = `forwardReturn${w}d` as keyof DecisionLogRow;
    if (row[fieldName] == null) out.push(w);
  }
  return out;
}

async function fetchBars(
  ticker: string,
  fromDate: string,
  toDate: string,
): Promise<PriceBar[]> {
  try {
    const raw = await getDailyBars(ticker, fromDate, toDate);
    return raw
      .filter((b: { t?: number; c?: number }) => typeof b.t === 'number' && typeof b.c === 'number')
      .map((b: { t?: number; c?: number }) => ({
        date: new Date(b.t as number).toISOString().slice(0, 10),
        close: b.c as number,
      }));
  } catch {
    return [];
  }
}

export interface PopulateResult {
  rowsConsidered: number;
  rowsUpdated: number;
  rowsExhausted: number;
  warnings: string[];
}

export async function populateForwardReturns(
  universe: PortfolioUniverse,
  today: string,
  batchLimit: number = 200,
): Promise<PopulateResult> {
  const warnings: string[] = [];
  // Rows older than today-30-5d are the earliest that could have
  // matured windows. Pull a broad batch and filter row-by-row.
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 35 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const rows = await listDecisionLogRowsOlderThan(universe, cutoff, batchLimit);
  let updated = 0;
  let exhausted = 0;
  for (const row of rows) {
    // Defensive: the pending-only query already excludes these; skip in
    // case a caller hands us rows from another source.
    if (row.fwdReturnsStatus === 'exhausted' || row.fwdReturnsStatus === 'complete') {
      continue;
    }
    const windows = maturedWindowsFor(row, today);
    if (windows.length === 0) {
      // Nothing matured AND nothing missing? Then every window is filled
      // — close the row out so it leaves the pending query.
      if (ALL_WINDOWS.every((w) => row[`forwardReturn${w}d`] != null)) {
        await updateDecisionLogForwardReturns(universe, row.ticker, row.decisionDate, {
          fwdReturnsStatus: 'complete',
        });
      }
      continue;
    }
    const maxWindow = Math.max(...windows);
    const fromDate = row.decisionDate;
    const toDate = new Date(
      Date.parse(`${row.decisionDate}T00:00:00Z`) +
        (maxWindow + 5) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const bars = await fetchBars(row.ticker, fromDate, toDate);
    const ret =
      bars.length > 0
        ? computeForwardReturns(row.decisionDate, bars, windows)
        : ({} as Record<string, number | null>);
    const patch: Record<string, number | null | string> = {};
    const unresolved: number[] = [];
    for (const w of windows) {
      const key = `forwardReturn${w}d`;
      if (ret[key] != null) patch[key] = ret[key];
      else unresolved.push(w);
    }
    if (bars.length === 0) {
      warnings.push(`no bars for ${row.ticker} ${row.decisionDate}..${toDate}`);
    }

    if (unresolved.length > 0) {
      // M5 — a matured window stayed unfilled: count the attempt; at the
      // cap, write the row off with explicit nulls so it stops blocking
      // the oldest-first batch window.
      const attempts = (row.fwdReturnAttempts ?? 0) + 1;
      patch.fwdReturnAttempts = attempts;
      if (attempts >= MAX_FWD_RETURN_ATTEMPTS) {
        for (const w of ALL_WINDOWS) {
          const key = `forwardReturn${w}d` as const;
          if (row[key] == null && patch[key] === undefined) {
            patch[key] = null;
          }
        }
        patch.fwdReturnsStatus = 'exhausted';
        exhausted++;
        warnings.push(
          `exhausted ${row.ticker} ${row.decisionDate} after ${attempts} attempts (windows ${unresolved.join('/')} unresolved)`,
        );
      }
    } else if (
      ALL_WINDOWS.every(
        (w) => patch[`forwardReturn${w}d`] != null || row[`forwardReturn${w}d`] != null,
      )
    ) {
      patch.fwdReturnsStatus = 'complete';
    }

    if (Object.keys(patch).length > 0) {
      await updateDecisionLogForwardReturns(
        universe,
        row.ticker,
        row.decisionDate,
        patch as any,
      );
      updated++;
    }
  }
  return {
    rowsConsidered: rows.length,
    rowsUpdated: updated,
    rowsExhausted: exhausted,
    warnings,
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const log = logger.child({ fn: 'scan-prophet-portfolio-fwd-returns' });
  const today = new Date().toISOString().slice(0, 10);
  const summary: Record<string, PopulateResult> = {};
  try {
    for (const u of UNIVERSES) {
      summary[u] = await populateForwardReturns(u, today);
      log.info('fwd_returns_universe_done', {
        universe: u,
        rowsConsidered: summary[u].rowsConsidered,
        rowsUpdated: summary[u].rowsUpdated,
        rowsExhausted: summary[u].rowsExhausted,
      });
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, today, summary }),
    };
  } catch (err: any) {
    log.error('fwd_returns_failed', { err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
    };
  }
};
