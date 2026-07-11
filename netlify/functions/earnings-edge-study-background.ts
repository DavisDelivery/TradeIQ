// FIX-2 W2 — background runner for GET /api/earnings-edge-study.
//
// Mirrors the backtest bg-function pattern (run-backtest-background.ts):
// a `-background.ts` file gets Netlify's 15-min container window, and a
// per-ticker cursor + self-reinvoke chain extends past that ceiling. Each
// invocation processes a batch of universe members (fetch history + bars,
// window into events, stream the events to a subcollection), checkpoints
// the cursor, and self-POSTs to continue. The terminal batch reads every
// event back and runs the pure `assembleStudy` aggregation.

import type { Handler } from '@netlify/functions';
import { withSentry } from './shared/sentry';
import { logger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';
import { universePoolForDate } from './shared/backtest/universe-pool';
import type { BacktestUniverse } from './shared/backtest/types';
import { assembleStudy, type RegimeTag, type StudyEvent } from './shared/earnings-study';
import { gatherTickerEvents } from './shared/earnings-study-gather';
import {
  persistStudyStatus,
  persistStudyComplete,
  persistStudyFailed,
  writeStudyCursor,
  appendStudyEvents,
  readAllStudyEvents,
  clearStudyEvents,
  readStudy,
  type StudyCursor,
} from './shared/earnings-study-store';
import { createWatchdog } from './shared/backtest-resume/watchdog';
import { dispatchReinvoke, inferFunctionUrl, type ReinvokeContext } from './shared/backtest-resume/reinvoke';

// 13-min wall-clock budget → 90s margin under the 15-min kill ceiling.
const BUDGET_MS = Number(process.env.STUDY_BUDGET_MS ?? 13 * 60_000);
// Tickers per invocation is soft — the watchdog stops the batch early when
// the budget runs out; this bounds the batch when data is fast.
const BATCH_TICKERS = Number(process.env.STUDY_BATCH_TICKERS ?? 60);
const REINVOKE_JITTER_MS = Number(process.env.STUDY_REINVOKE_JITTER_MS ?? 1_500);

interface Payload {
  studyId: string;
  resume?: boolean;
}

function survivorshipNoteFor(
  universe: string,
  corrected: boolean,
  memberCount: number,
): string {
  return corrected
    ? `Survivorship-corrected: point-in-time ${universe} membership (${memberCount} names).`
    : `Survivorship-BIASED (upward): ${universe} universe is a current-membership ` +
        `seed of ${memberCount} names — delisted/acquired constituents are absent, ` +
        `so realized edge is an optimistic bound. Stated per the pre-committed rule.`;
}

export const handler: Handler = withSentry(async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const log = logger.child({ fn: 'earnings-edge-study-background' });

  let payload: Payload;
  try {
    payload = JSON.parse(event.body ?? '{}');
  } catch (e: any) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid payload json' }) };
  }
  const { studyId } = payload;
  if (!studyId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'missing studyId' }) };
  }

  const invocationStart = Date.now();
  const db = getAdminDb();

  try {
    const doc = await readStudy(studyId);
    if (!doc) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'study not found' }) };
    }
    const { universe, years, windowStart, windowEnd } = doc;

    // Resolve the member list (current-seed for sp500/russell2k). Deterministic
    // across invocations so the cursor index is stable.
    const pool = universePoolForDate(universe as BacktestUniverse, windowEnd);
    const tickers = pool.tickers;
    if (tickers.length === 0) {
      await persistStudyFailed(studyId, `no universe members for ${universe} @ ${windowEnd}`);
      return { statusCode: 200, body: JSON.stringify({ ok: false, studyId, status: 'failed' }) };
    }

    const existing = doc.cursor ?? null;
    const isResume = existing != null;
    const cursor: StudyCursor = isResume
      ? {
          ...existing,
          invocationCount: existing.invocationCount + 1,
          lastInvocationStartedAt: new Date().toISOString(),
        }
      : {
          nextTickerIndex: 0,
          totalTickers: tickers.length,
          eventCount: 0,
          invocationCount: 1,
          lastInvocationStartedAt: new Date().toISOString(),
        };

    if (!isResume) {
      // Fresh start: wipe any prior events so a re-dispatched run can't
      // accumulate on top of an earlier chain's rows (v2 race fix).
      await clearStudyEvents(studyId).catch(() => {});
      await persistStudyStatus(studyId, { status: 'running' }).catch(() => {});
    }

    log.info('batch_start', {
      studyId,
      universe,
      isResume,
      invocationCount: cursor.invocationCount,
      nextTickerIndex: cursor.nextTickerIndex,
      totalTickers: tickers.length,
    });

    const watchdog = createWatchdog(BUDGET_MS, () => {
      log.warn('watchdog_expired', { studyId, invocationCount: cursor.invocationCount });
    });
    watchdog.start();

    const regimeCache = new Map<string, RegimeTag | null>();
    const batchEvents: StudyEvent[] = [];
    let idx = cursor.nextTickerIndex;
    let processed = 0;
    try {
      while (idx < tickers.length && processed < BATCH_TICKERS && !watchdog.isExpired()) {
        const tkr = tickers[idx];
        try {
          const evs = await gatherTickerEvents(tkr, windowStart, windowEnd, regimeCache);
          batchEvents.push(...evs);
        } catch (e: any) {
          log.warn('ticker_gather_failed', { studyId, ticker: tkr, err: String(e?.message ?? e) });
        }
        idx += 1;
        processed += 1;
      }
    } finally {
      watchdog.stop();
    }

    // Stream this batch's events to the subcollection before checkpointing.
    if (batchEvents.length > 0) {
      await appendStudyEvents(studyId, batchEvents, cursor.eventCount);
    }
    const eventCount = cursor.eventCount + batchEvents.length;
    const done = idx >= tickers.length;

    if (done) {
      const allEvents = await readAllStudyEvents(studyId);
      const note = survivorshipNoteFor(universe, pool.survivorshipCorrected, tickers.length);
      const result = assembleStudy(universe, windowStart, windowEnd, allEvents, note);
      await persistStudyComplete(studyId, result);
      log.info('study_complete', {
        studyId,
        eventCount: result.eventCount,
        tickerCount: result.tickerCount,
        anySurvives: result.anySurvives,
        invocationCount: cursor.invocationCount,
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, studyId, status: 'complete', eventCount: result.eventCount }) };
    }

    // Non-terminal — checkpoint + reinvoke.
    const nextCursor: StudyCursor = { ...cursor, nextTickerIndex: idx, eventCount };
    await writeStudyCursor(studyId, nextCursor);

    const headers: Record<string, string | undefined> = {};
    if (event.headers) {
      for (const [k, v] of Object.entries(event.headers)) headers[k] = v ?? undefined;
    }
    const reinvokeUrl = inferFunctionUrl(headers, '/.netlify/functions/earnings-edge-study-background');
    const reinvokeCtx = context as unknown as ReinvokeContext;
    const dispatched = await dispatchReinvoke(reinvokeUrl, studyId, reinvokeCtx, { resume: true }, { jitterMs: REINVOKE_JITTER_MS });
    await writeStudyCursor(studyId, {
      ...nextCursor,
      lastReinvokeAt: new Date().toISOString(),
      ...(dispatched.ok ? { lastReinvokeError: undefined } : { lastReinvokeError: dispatched.error ?? 'dispatch failed' }),
    });
    if (!dispatched.ok) {
      log.error('reinvoke_dispatch_failed', { studyId, lastStatus: dispatched.lastStatus, err: dispatched.error });
    }

    log.info('batch_continuing', {
      studyId,
      nextTickerIndex: idx,
      totalTickers: tickers.length,
      eventCount,
      batchElapsedMs: Date.now() - invocationStart,
    });
    return {
      statusCode: 202,
      body: JSON.stringify({ ok: true, studyId, continuing: true, nextTickerIndex: idx, totalTickers: tickers.length, eventCount }),
    };
  } catch (err: any) {
    log.error('study_run_failed', { studyId, err: String(err?.message ?? err) });
    await persistStudyFailed(studyId, String(err?.message ?? err)).catch(() => {});
    return { statusCode: 500, body: JSON.stringify({ ok: false, studyId, error: String(err?.message ?? err) }) };
  }
});
