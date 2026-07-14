// FABLE-2 R4 — the LIVE HORSE RACE (Chad's call, 2026-07-14).
//
// Two variants of the frozen FABLE-2 construction paper-trade against
// SPY in real time; the tape — not another backtest — decides which
// ships as the board:
//   A "insider-live":  the frozen APPENDIX A system exactly.
//   B "insider-free":  identical construction, insider pillar off.
//
// Method: each run re-simulates BOTH variants from RACE_START to today
// with the pure policy engine. Deterministic, uses only past data, and
// self-healing (a missed day is simply recomputed next run). Inception
// is the 2026-06-30 month-end checkpoint so the books form immediately;
// everything from LIVE_SINCE (2026-07-14, the day the race was declared)
// forward is genuinely live — the doc discloses both dates.
//
// No lookahead is possible by construction: the sim only ever sees bars
// that exist at fire time, and the live-window cache guard in
// policy-data keeps today's still-growing series out of the PIT cache.
//
// POST /.netlify/functions/fable2-live-track-background  Body: {} —
// invoked by the prod schedule (fable2-live-track.ts) once merged, or
// manually / via a scheduled task against the preview until then.

import type { Handler } from '@netlify/functions';
import { runPolicyBacktest, type PolicyConfig } from './shared/backtest/policy-engine';
import { loadPolicyInputs } from './shared/backtest/policy-data';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const RACE_START = '2026-06-01'; // window start so the 2026-06-30 checkpoint seeds the books
const TRACKING_SINCE = '2026-06-30'; // first checkpoint = book inception
const LIVE_SINCE = '2026-07-14'; // race declared; before this = disclosed backfill
const WARMUP_FROM = '2024-06-01';
const COLLECTION = 'fable2LiveTrack';

// Same knobs as the frozen APPENDIX A config; only the window differs.
const RACE_CONFIG_BASE: Omit<PolicyConfig, 'endDate'> = {
  startDate: RACE_START,
  initialCapital: 100_000,
  enterPctl: 90,
  exitPctl: 60,
  maxHoldDays: 126,
  stopPct: 0.12,
  slippageBpsPerLeg: 10,
  sizeAlpha: 1.0,
  maxPositionPct: 0.20,
  maxPositions: 15,
  regimeMode: 'none',
  // The race window is legitimately young (inception 2026-06-30); the
  // default 100-day floor is a backtest guard, not a tracker one.
  minCalendarDays: 5,
};

const VARIANTS = [
  { id: 'A', label: 'insider-live', insiderMode: 'live' as const },
  { id: 'B', label: 'insider-free', insiderMode: 'none' as const },
];

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'fable2-live-track' });
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  const db = getAdminDb();
  const today = new Date().toISOString().slice(0, 10);
  const results: Record<string, unknown> = {};

  for (const v of VARIANTS) {
    try {
      const config: PolicyConfig = { ...RACE_CONFIG_BASE, endDate: today };
      const { inputs, stats } = await loadPolicyInputs({
        universe: 'sp500',
        config,
        warmupFrom: WARMUP_FROM,
        concurrency: 8,
        logger: log,
        insiderMode: v.insiderMode,
      });
      const res = runPolicyBacktest(inputs);
      // 'end'-reason exits are the CURRENT open book (force-marked at
      // today's close for accounting), not realized round trips.
      const holdings = res.trades
        .filter((t) => t.exitReason === 'end')
        .map((t) => ({ ticker: t.ticker, entryDate: t.entryDate, entryPx: +t.entryPx.toFixed(2), unrealizedPct: t.returnPct }));
      const realized = res.trades.filter((t) => t.exitReason && t.exitReason !== 'end');
      await db
        .collection(COLLECTION)
        .doc(v.id)
        .set({
          variant: v.id,
          label: v.label,
          insiderMode: v.insiderMode,
          trackingSince: TRACKING_SINCE,
          liveSince: LIVE_SINCE,
          asOf: today,
          config,
          metrics: res.metrics,
          holdings,
          realizedTrades: realized.length,
          equityDaily: res.equity.map((r) => ({ d: r.date, v: +r.value.toFixed(2), s: +r.spy.toFixed(2) })),
          warnings: res.warnings,
          stats,
          updatedAt: new Date().toISOString(),
        });
      results[v.id] = {
        net: res.metrics.totalReturnPct,
        spy: res.metrics.spyTotalReturnPct,
        excess: res.metrics.excessVsSpyPp,
        holdings: holdings.length,
      };
      log.info('fable2_live_track_variant', { variant: v.id, ...(results[v.id] as object) });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      log.error('fable2_live_track_failed', { variant: v.id, err: msg });
      await db
        .collection(COLLECTION)
        .doc(v.id)
        .set({ lastError: msg, lastErrorAt: new Date().toISOString() }, { merge: true })
        .catch(() => {});
      results[v.id] = { error: msg };
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, asOf: today, results }) };
};
