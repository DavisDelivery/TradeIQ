// FIX-2 W2 — GET /api/earnings-edge-study?universe=sp500&years=7
//
// Fronts the background event-study runner. Contract:
//   - A COMPLETE, fresh (within daily TTL), non-empty study for this
//     (universe, years) → 200 with the assembled result (served cached).
//   - A pending/running study started <30 min ago → 202 "running".
//   - Otherwise → allocate a study doc, dispatch the bg runner (awaited
//     with a 3s timeout race so the container can't freeze before the
//     POST leaves), return 202 with the studyId to poll.
//
// Never serves or caches an empty study — the earnings-radar cache-
// poisoning incident (PR #103) is the precedent: a failure-shaped empty
// result must self-heal into a re-run, not stick for the day.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { getEarningsHistory, getDailyBars } from './shared/data-provider';
import { gatherTickerEvents } from './shared/earnings-study-gather';
import {
  studyIdFor,
  readStudy,
  findFreshCompleteStudy,
  findLeadingStudy,
  readMostRecentStudy,
  persistStudyPending,
  type StudyDoc,
} from './shared/earnings-study-store';

/** Local ISO date shift for the debug window (avoids importing the gather's private helper). */
function addDaysDebug(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const headers = { 'Content-Type': 'application/json' };

const SUPPORTED_UNIVERSES = ['sp500', 'russell2k', 'ndx', 'dow'] as const;
type StudyUniverse = (typeof SUPPORTED_UNIVERSES)[number];

// The pre-committed measurement window ends here (matches the FIX-2 rule
// in reports/fix-2/pead-study.md). windowStart is derived from `years`.
const WINDOW_END = '2024-12-31';
const WINDOW_END_YEAR = 2024;

function windowStartFor(years: number): string {
  // years=7 → 2018-01-31, matching the pre-committed rule window exactly.
  return `${WINDOW_END_YEAR - years + 1}-01-31`;
}

function inferOrigin(event: { headers: Record<string, string | undefined> }): string {
  const host =
    event.headers['x-forwarded-host'] ??
    event.headers['X-Forwarded-Host'] ??
    event.headers.host ??
    event.headers.Host;
  const proto = event.headers['x-forwarded-proto'] ?? event.headers['X-Forwarded-Proto'] ?? 'https';
  if (host) return `${proto}://${host}`;
  return process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
}

/**
 * POST the background runner for `studyId`, awaited with a 3s timeout race
 * so the trigger container can't freeze before the dispatch leaves (same
 * AWS-Lambda-freeze hazard the backtest trigger guards against). The
 * background reads the study's cursor, so this both starts a fresh run and
 * resumes a stalled one — the cursor decides.
 */
async function dispatchBackground(
  origin: string,
  studyId: string,
  log: ReturnType<typeof logger.child>,
): Promise<number | undefined> {
  const backgroundUrl = `${origin}/.netlify/functions/earnings-edge-study-background`;
  const DISPATCH_TIMEOUT_MS = 3000;
  try {
    const dispatch = fetch(backgroundUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studyId }),
    });
    const raced = await Promise.race([
      dispatch.then((r) => ({ r })),
      new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), DISPATCH_TIMEOUT_MS)),
    ]);
    if ('r' in raced) {
      log.info('background_dispatched', { studyId, status: raced.r.status });
      return raced.r.status;
    }
    log.warn('background_dispatch_timeout', { studyId });
  } catch (e: any) {
    log.error('background_dispatch_failed', { studyId, err: String(e?.message ?? e) });
  }
  return undefined;
}

export const handler: Handler = async (event, context) => {
  const log = logger.child({ fn: 'earnings-edge-study' });
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method not allowed' }) };
  }

  const q = event.queryStringParameters ?? {};
  const universe = (q.universe ?? 'sp500') as StudyUniverse;
  const years = Math.max(1, Math.min(15, Number(q.years ?? 7) || 7));
  const forceRefresh = q.refresh === '1' || q.force === '1';

  // DIAGNOSTIC: ?debug=<TICKER> runs the gather for one ticker synchronously
  // and returns the raw inputs (earnings history, bar count) + the windowed
  // events, so the 0-event failure can be inspected against the deployed
  // env's real Finnhub/Polygon keys. No background, no Firestore writes.
  if (q.debug) {
    const ticker = q.debug.toUpperCase();
    const wStart = windowStartFor(years);
    try {
      const [rawNoAsof, rawWithJoin, bars] = await Promise.all([
        getEarningsHistory(ticker, 44).catch((e: any) => ({ err: String(e?.message ?? e) })),
        getEarningsHistory(ticker, 44, { withAnnounceDates: true }).catch((e: any) => ({ err: String(e?.message ?? e) })),
        getDailyBars(ticker, addDaysDebug(wStart, -10), addDaysDebug(WINDOW_END, 120)).catch((e: any) => ({ err: String(e?.message ?? e) })),
      ]);
      const events = await gatherTickerEvents(ticker, wStart, WINDOW_END, new Map()).catch((e: any) => ({ err: String(e?.message ?? e) }));
      // Raw Finnhub stock/earnings probe — HTTP status + body snippet — to
      // distinguish a plan/key gate from a response-shape mismatch.
      let rawProbe: unknown = 'skipped';
      try {
        const key = process.env.FINNHUB_API_KEY;
        if (!key) {
          rawProbe = { error: 'FINNHUB_API_KEY not set on this env' };
        } else {
          const r = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${ticker}&limit=8&token=${key}`);
          const txt = await r.text();
          rawProbe = { httpStatus: r.status, keyLen: key.length, bodySnippet: txt.slice(0, 300) };
        }
      } catch (e: any) {
        rawProbe = { error: String(e?.message ?? e) };
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          debug: ticker,
          window: [wStart, WINDOW_END],
          barCount: Array.isArray(bars) ? bars.length : bars,
          historyNoJoin: Array.isArray(rawNoAsof) ? { count: rawNoAsof.length, sample: rawNoAsof.slice(0, 3) } : rawNoAsof,
          historyWithJoin: Array.isArray(rawWithJoin) ? { count: rawWithJoin.length, sample: rawWithJoin.slice(0, 4) } : rawWithJoin,
          rawFinnhubProbe: rawProbe,
          eventCount: Array.isArray(events) ? events.length : events,
          eventSample: Array.isArray(events) ? events.slice(0, 3) : undefined,
        }),
      };
    } catch (e: any) {
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, debug: ticker, error: String(e?.message ?? e) }) };
    }
  }
  // Optional cap on universe members — lets a study finalize in a single
  // background batch (no reinvoke chain) when reliability matters more than
  // full coverage. 0/absent = full universe.
  const maxTickers = Math.max(0, Math.floor(Number(q.limit ?? 0) || 0));

  if (!SUPPORTED_UNIVERSES.includes(universe)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: `unsupported universe "${universe}"; use one of ${SUPPORTED_UNIVERSES.join(', ')}` }),
    };
  }

  const nowMs = Date.now();
  const windowStart = windowStartFor(years);
  const dayIso = new Date(nowMs).toISOString().slice(0, 10);

  // CAPPED PATH: a `limit`-scoped study is handled purely by its own
  // studyId (no universe+years discovery, which would collide with the
  // full-universe run). serve-if-complete / resume-if-progress / else
  // allocate-fresh. Designed to finalize in a single background batch.
  if (maxTickers > 0) {
    const cappedId = studyIdFor(universe, years, dayIso, maxTickers);
    try {
      const existing = await readStudy(cappedId);
      // Serve only a NON-EMPTY complete study; an empty result (0 events) is
      // treated as a miss and re-run, never cached — same honesty guard as
      // the full path / earnings-radar.
      if (existing?.status === 'complete' && existing.result && existing.result.eventCount > 0 && !forceRefresh) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: 'complete', cached: true, study: existing.result, studyId: cappedId }) };
      }
      const idx = existing?.cursor?.nextTickerIndex ?? 0;
      const liveMs = Date.parse(existing?.updatedAt ?? '');
      const isLive = Number.isFinite(liveMs) && nowMs - liveMs < 90_000;
      if (existing && existing.status !== 'complete' && idx > 0 && !forceRefresh) {
        if (!isLive) await dispatchBackground(inferOrigin(event as any), cappedId, log);
        return { statusCode: 202, headers, body: JSON.stringify({ ok: true, status: isLive ? 'running' : 'resuming', studyId: cappedId, nextTickerIndex: idx, totalTickers: existing.cursor?.totalTickers }) };
      }
      const now = new Date(nowMs).toISOString();
      await persistStudyPending({ studyId: cappedId, universe, years, maxTickers, windowStart, windowEnd: WINDOW_END, status: 'pending', startedAt: now, updatedAt: now, cursor: null });
      const dispatchStatus = await dispatchBackground(inferOrigin(event as any), cappedId, log);
      return { statusCode: 202, headers, body: JSON.stringify({ ok: true, status: 'pending', studyId: cappedId, universe, years, maxTickers, windowStart, windowEnd: WINDOW_END, dispatchStatus }) };
    } catch (e: any) {
      log.error('capped_path_failed', { cappedId, err: String(e?.message ?? e) });
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: String(e?.message ?? e) }) };
    }
  }

  // 1. Serve a fresh, non-empty complete study if we have one.
  if (!forceRefresh) {
    try {
      const fresh = await findFreshCompleteStudy(universe, years, nowMs);
      if (fresh?.result) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: 'complete', cached: true, study: fresh.result, studyId: fresh.studyId }) };
      }
    } catch (e: any) {
      log.warn('fresh_lookup_failed', { err: String(e?.message ?? e) });
    }
  }

  // 2. Drive the LEADING pending/running study (the most-progressed one).
  // If it's live, report it. If it stalled (dropped self-reinvoke — the
  // FIX-1 reinvoke fragility), RESUME it from its cursor. Lower-progress
  // coexisting docs (e.g. an abandoned earlier run) are ignored, so they
  // can't steal the heartbeat or ping-pong the resume target.
  if (!forceRefresh) {
    try {
      const leading = await findLeadingStudy(universe, years, nowMs);
      if (leading) {
        if (leading.isLive) {
          return {
            statusCode: 202,
            headers,
            body: JSON.stringify({
              ok: true,
              status: leading.doc.status,
              studyId: leading.doc.studyId,
              nextTickerIndex: leading.doc.cursor?.nextTickerIndex,
              totalTickers: leading.doc.cursor?.totalTickers,
              message: 'study already running; poll this studyId',
            }),
          };
        }
        // Stalled leader with progress → resume; leader with zero progress
        // that's dead falls through to a fresh allocation.
        if (leading.progress > 0) {
          const origin = inferOrigin(event as any);
          await dispatchBackground(origin, leading.doc.studyId, log);
          return {
            statusCode: 202,
            headers,
            body: JSON.stringify({
              ok: true,
              status: 'resuming',
              studyId: leading.doc.studyId,
              nextTickerIndex: leading.doc.cursor?.nextTickerIndex,
              totalTickers: leading.doc.cursor?.totalTickers,
              message: 'stalled chain resumed from checkpoint',
            }),
          };
        }
      }
    } catch (e: any) {
      log.warn('leading_check_failed', { err: String(e?.message ?? e) });
    }
  }

  // 3. Allocate + dispatch a fresh run. First capture WHY the last run
  // ended (diagnostic surface) — a failed run that keeps re-allocating
  // from zero is otherwise invisible.
  let priorFailure: { status?: string; error?: string; nextTickerIndex?: number } | undefined;
  try {
    const recent = await readMostRecentStudy(universe, years);
    if (recent && (recent.status === 'failed' || recent.error)) {
      priorFailure = { status: recent.status, error: recent.error, nextTickerIndex: recent.cursor?.nextTickerIndex };
    }
  } catch {
    /* diagnostic only */
  }

  const studyId = studyIdFor(universe, years, dayIso);
  const now = new Date(nowMs).toISOString();

  // NON-DESTRUCTIVE guard: if a doc for this id already carries real cursor
  // progress and isn't complete, RESUME it rather than resetting to zero.
  // findLeadingStudy can transiently return null (a status-flip window or a
  // Firestore read-consistency lag); without this guard every such blip
  // wiped the cursor and restarted the whole sweep from 0 — the real reason
  // sp500 never converged.
  if (!forceRefresh) {
    try {
      const existing = await readStudy(studyId);
      if (
        existing &&
        existing.status !== 'complete' &&
        (existing.cursor?.nextTickerIndex ?? 0) > 0
      ) {
        await dispatchBackground(inferOrigin(event as any), studyId, log);
        return {
          statusCode: 202,
          headers,
          body: JSON.stringify({
            ok: true,
            status: 'resuming',
            studyId,
            nextTickerIndex: existing.cursor?.nextTickerIndex,
            totalTickers: existing.cursor?.totalTickers,
            message: 'resumed existing run (non-destructive)',
          }),
        };
      }
    } catch (e: any) {
      log.warn('nondestructive_resume_check_failed', { err: String(e?.message ?? e) });
    }
  }

  const doc: StudyDoc = {
    studyId,
    universe,
    years,
    windowStart,
    windowEnd: WINDOW_END,
    status: 'pending',
    startedAt: now,
    updatedAt: now,
    cursor: null,
  };

  // A same-day refresh re-uses the deterministic id: reset it to pending so
  // the bg runner starts clean rather than resuming a stale cursor.
  try {
    const prior = await readStudy(studyId);
    if (prior && (forceRefresh || prior.status === 'failed')) {
      doc.startedAt = now;
    }
    await persistStudyPending(doc);
  } catch (e: any) {
    log.error('pending_write_failed', { studyId, err: String(e?.message ?? e) });
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: `failed to queue study: ${String(e?.message ?? e)}` }) };
  }

  const origin = inferOrigin(event as any);
  const dispatchStatus = await dispatchBackground(origin, studyId, log);

  return {
    statusCode: 202,
    headers,
    body: JSON.stringify({ ok: true, status: 'pending', studyId, universe, years, windowStart, windowEnd: WINDOW_END, dispatchStatus, priorFailure }),
  };
};
