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
import { withTimeout } from './shared/with-timeout';

// 13-min wall-clock budget → 90s margin under the 15-min kill ceiling.
const BUDGET_MS = Number(process.env.STUDY_BUDGET_MS ?? 13 * 60_000);
// Ticker cap per invocation is a soft upper bound — the 13-min watchdog is
// the real limiter (each rate-limited ticker is slow). Set high so a batch
// runs the full budget and the chain needs FEWER self-reinvokes: every
// reinvoke is a chance for the FIX-1 dropped-handoff to kill the chain, so
// minimising handoffs is the cheapest reliability win. The GET endpoint's
// resume-on-stall is the backstop when one drops anyway.
const BATCH_TICKERS = Number(process.env.STUDY_BATCH_TICKERS ?? 400);
const REINVOKE_JITTER_MS = Number(process.env.STUDY_REINVOKE_JITTER_MS ?? 1_500);
// Per-ticker hard cap. A ticker's full gather (bars + earnings history +
// calendar join + regime) is normally a few seconds. Kept TIGHT (8s) so a
// cluster of slow/hung tickers can't consume the whole batch budget before
// the next checkpoint — a hang is cheap to skip. (A rare skipped slow
// ticker just contributes no events; the study is a base-rate aggregate,
// robust to a handful of drops.)
const TICKER_TIMEOUT_MS = Number(process.env.STUDY_TICKER_TIMEOUT_MS ?? 8_000);

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

    // Poison-pill skip. A corrupt/hard-crashing ticker (e.g. the malformed
    // "SGAFT" seen in the sp500 seed) kills the whole invocation before any
    // checkpoint — withTimeout can't rescue an out-of-band process kill —
    // so every resume re-hits it and the cursor pins at the same index. If
    // N invocations have started at the SAME index without advancing it,
    // treat that index as poison: skip exactly ONE ticker and record it.
    let startIdx = cursor.nextTickerIndex;
    const skipped = new Set<number>(cursor.skippedIdx ?? []);
    if (cursor.stallIdx === startIdx) {
      cursor.stallCount = (cursor.stallCount ?? 0) + 1;
    } else {
      cursor.stallIdx = startIdx;
      cursor.stallCount = 1;
    }
    const POISON_AFTER = 2;
    if ((cursor.stallCount ?? 0) >= POISON_AFTER && startIdx < tickers.length) {
      log.warn('poison_ticker_skipped', { studyId, index: startIdx, ticker: tickers[startIdx] });
      skipped.add(startIdx);
      startIdx += 1;
      cursor.nextTickerIndex = startIdx;
      cursor.stallIdx = startIdx;
      cursor.stallCount = 1;
      cursor.skippedIdx = Array.from(skipped);
      // Persist the skip immediately so even if THIS invocation also dies,
      // the next resume starts past the poison pill.
      await writeStudyCursor(studyId, cursor).catch(() => {});
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
    let batchEvents: StudyEvent[] = [];
    let idx = startIdx;
    let processed = 0;
    // eventCount = total events already streamed to the subcollection (the
    // startIdx for the next append). batchEvents holds the not-yet-flushed
    // tail.
    let eventCount = cursor.eventCount;

    // Mid-batch checkpoint: flush events + advance the cursor every N
    // tickers so a mid-batch container kill (or a hang that survives the
    // per-ticker timeout) can't strand progress. Before this the cursor
    // only moved at batch end, so a ticker that ate the whole 15-min
    // window pinned the run at the same index on every resume (observed:
    // sp500 stuck at 460/507).
    // Checkpoint after EVERY ticker: one small cursor write per name (≈500
    // total, ~25s aggregate — negligible vs the 13-min budget) makes the
    // poison-pill detector PRECISE. The cursor always points at the next
    // ticker to attempt, so a crash pins it on exactly the offending index
    // and the skip discards that one ticker, not a whole window.
    const CHECKPOINT_EVERY = 1;
    let sinceCheckpoint = 0;

    const flush = async (nextIdx: number, writeCursor: boolean) => {
      if (batchEvents.length > 0) {
        await appendStudyEvents(studyId, batchEvents, eventCount);
        eventCount += batchEvents.length;
        batchEvents = [];
      }
      if (writeCursor) {
        // Advancing the cursor IS progress → reset the stall tracker to the
        // new frontier so poison detection only fires on a genuinely stuck
        // index, not on normal forward motion.
        await writeStudyCursor(studyId, {
          ...cursor,
          nextTickerIndex: nextIdx,
          eventCount,
          stallIdx: nextIdx,
          stallCount: 1,
          skippedIdx: Array.from(skipped),
        });
      }
    };

    try {
      while (idx < tickers.length && processed < BATCH_TICKERS && !watchdog.isExpired()) {
        const tkr = tickers[idx];
        try {
          // Per-ticker timeout: a hung Polygon/Finnhub fetch must not eat
          // the whole batch. withTimeout resolves to [] and we move on.
          const evs = await withTimeout(
            gatherTickerEvents(tkr, windowStart, windowEnd, regimeCache),
            TICKER_TIMEOUT_MS,
            [] as StudyEvent[],
          );
          batchEvents.push(...evs);
        } catch (e: any) {
          log.warn('ticker_gather_failed', { studyId, ticker: tkr, err: String(e?.message ?? e) });
        }
        idx += 1;
        processed += 1;
        sinceCheckpoint += 1;

        if (sinceCheckpoint >= CHECKPOINT_EVERY && idx < tickers.length) {
          await flush(idx, true);
          sinceCheckpoint = 0;
        }
      }
    } finally {
      watchdog.stop();
    }

    // Flush the batch tail (no cursor write here — the terminal/non-terminal
    // branches below own the final cursor state).
    await flush(idx, false);
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

    // Non-terminal — checkpoint + reinvoke. idx advanced past the batch's
    // start, so reset the stall frontier to idx (progress = not stuck).
    const nextCursor: StudyCursor = {
      ...cursor,
      nextTickerIndex: idx,
      eventCount,
      stallIdx: idx,
      stallCount: 1,
      skippedIdx: Array.from(skipped),
    };
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
