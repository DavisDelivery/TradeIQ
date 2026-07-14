// FABLE-2 — insider PIT-cache warm-up sweep (background, budgeted).
//
// POST /.netlify/functions/fable2-insider-warm-background
// Body: { universe?: 'sp500'|'ndx', startAfter?: number }
//
// Why: v1's insider cache keys sit at +30d-drift rebalance dates, not
// month-ends, so FABLE-2's (checkpoint × gate-passer) pairs (~7k for
// sp500 2018-2023) are cold — a single invocation cannot fetch them at
// 55 rpm. This endpoint prefetches pairs [startAfter..] into the pit
// cache under FABLE-2's month-end keys until ~80% of the 15-min window
// is spent, then reports the next cursor. Fire it repeatedly (each call
// returns 202 immediately; progress lands in fable2InsiderWarm/progress)
// until `done: true`. Idempotent: cached pairs are skipped at full speed.
//
// Uses the TRAIN window bounds; the holdout sweep happens only with the
// (separate, post-freeze) confirmatory tooling.

import type { Handler } from '@netlify/functions';
import { DEFAULT_POLICY_CONFIG } from './shared/backtest/policy-engine';
import { loadPolicyInputs, buildInsiderWorkList } from './shared/backtest/policy-data';
import { getFinnhubInsiderTransactionsWithStatus } from './shared/data-provider';
import { pitCacheWrap, pitCacheHas } from './shared/pit-cache';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';
import type { IndexTag } from './shared/universe';

const TRAIN_END_MAX = '2023-12-31';
const WARMUP_FROM = '2016-06-01';
const BUDGET_MS = 12 * 60 * 1000;

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'fable2-insider-warm' });
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  let body: { universe?: IndexTag; startAfter?: number };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid json' }) };
  }
  const universe: IndexTag = body.universe === 'ndx' ? 'ndx' : 'sp500';
  const startAfter = Math.max(0, Number(body.startAfter ?? 0) || 0);
  const start = Date.now();
  const db = getAdminDb();
  const progressDoc = db.collection('fable2InsiderWarm').doc(`${universe}`);

  try {
    // Bars are pit-cached by now (explore runs fetch them) — this load is fast.
    const { inputs } = await loadPolicyInputs({
      universe,
      config: { ...DEFAULT_POLICY_CONFIG, startDate: '2018-01-01', endDate: TRAIN_END_MAX },
      warmupFrom: WARMUP_FROM,
      concurrency: 8,
      logger: log,
      insiderMode: 'none', // we only need bars + checkpoints + the work list
    });
    const work = buildInsiderWorkList(inputs.tickers, inputs.checkpoints);

    let idx = startAfter;
    let fetched = 0;
    let cachedSkips = 0;
    let failures = 0;
    while (idx < work.length && Date.now() - start < BUDGET_MS) {
      const w = work[idx];
      const key = {
        provider: 'finnhub' as const,
        dataClass: 'insider' as const,
        ticker: w.t.ticker,
        asOfDate: w.cp,
        extra: 'daysBack=200:fable',
      };
      try {
        if (await pitCacheHas(key)) {
          cachedSkips++;
        } else {
          await pitCacheWrap(key, async () => {
            const status = await getFinnhubInsiderTransactionsWithStatus(w.t.ticker, 200, { asOfDate: w.cp });
            if (status.rateLimitExhausted || status.errorMessage) {
              throw new Error(status.errorMessage ?? 'rate-limit exhausted');
            }
            return status.data;
          });
          fetched++;
        }
      } catch {
        failures++; // uncached; a later sweep pass retries it
      }
      idx++;
    }

    const done = idx >= work.length;
    const progress = {
      universe,
      totalPairs: work.length,
      cursor: idx,
      done,
      lastBatch: { startAfter, fetched, cachedSkips, failures, ms: Date.now() - start },
      updatedAt: new Date().toISOString(),
    };
    await progressDoc.set(progress, { merge: true });
    log.info('fable2_insider_warm_batch', progress.lastBatch);
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...progress }) };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('fable2_insider_warm_failed', { err: msg });
    await progressDoc.set({ lastError: msg, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
