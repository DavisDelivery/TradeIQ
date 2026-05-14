// Phase 4e-1 follow-up — background runner for the portfolio backtest.
//
// 15-min container (via -background.ts filename suffix). Receives a
// runId + window from portfolio-backtest-trigger.ts, runs the harness
// against live Polygon data and Firestore-backed Prophet snapshots,
// writes the result to portfolioBacktests/{runId} on completion.
//
// The harness already supports injected PriceSource + RankingSignal.
// Here we wire `compositeRankingSignal` (reads Firestore snapshots)
// and a Polygon-backed PriceSource. SPY / QQQ / IWF benchmark series
// share the same price source.

import type { Handler } from '@netlify/functions';
import { Timestamp } from 'firebase-admin/firestore';
import { getDailyBars } from './shared/data-provider';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';
import {
  runPortfolioBacktest,
  type BacktestWindow,
  type PriceSource,
} from './shared/prophet-portfolio/backtest-harness';
import { compositeRankingSignal } from './shared/prophet-portfolio/signal';
import type { PortfolioConfig } from './shared/prophet-portfolio/types';

const RULE_CONFIG_BASE: Omit<PortfolioConfig, 'startDate'> = {
  universe: 'largecap',
  startCapital: 100_000,
  positionCount: 10,
  minHoldDays: 30,
  maxSwapsPerRebalance: 3,
  sectorCap: 4,
  slippageBps: 10,
  minComposite: 50,
  candidatePool: 15,
  version: 'v1',
};

function makeWindow(label: string, start: string, end: string): BacktestWindow {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const marks: string[] = [];
  for (let t = startMs; t <= endMs; t += 86_400_000) {
    marks.push(new Date(t).toISOString().slice(0, 10));
  }
  const rebalances: string[] = [];
  for (let t = startMs; t <= endMs; t += 7 * 86_400_000) {
    rebalances.push(new Date(t).toISOString().slice(0, 10));
  }
  return { label, start, end, rebalanceDates: rebalances, markDates: marks };
}

function windowSpec(label: string): BacktestWindow {
  switch (label) {
    case 'full':
      return makeWindow('full', '2018-01-01', '2026-01-01');
    case 'half-2018':
      return makeWindow('half-2018', '2018-01-01', '2022-01-01');
    case 'half-2022':
      return makeWindow('half-2022', '2022-01-01', '2026-01-01');
    case 'covid':
      return makeWindow('covid', '2020-02-01', '2020-09-01');
    case 'rate-hikes':
      return makeWindow('rate-hikes', '2022-01-01', '2022-12-31');
    case 'short-demo':
      return makeWindow('short-demo', '2024-01-08', '2024-04-08');
    default:
      if (label.startsWith('rolling-')) {
        const year = Number(label.slice('rolling-'.length));
        if (Number.isFinite(year)) {
          return makeWindow(label, `${year}-01-01`, `${year + 1}-01-01`);
        }
      }
      throw new Error(`Unknown window label: ${label}`);
  }
}

const livePriceSource: PriceSource = {
  async closeAt(ticker: string, date: string) {
    const from = new Date(Date.parse(`${date}T00:00:00Z`) - 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const bars = await getDailyBars(ticker, from, date).catch(() => []);
    for (let i = bars.length - 1; i >= 0; i--) {
      const b = bars[i] as { c?: number };
      if (typeof b.c === 'number') return b.c;
    }
    return null;
  },
};

async function writeStatus(
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await getAdminDb()
    .collection('portfolioBacktests')
    .doc(runId)
    .set({ ...patch, updatedAt: Timestamp.now() }, { merge: true });
}

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'run-portfolio-backtest-background' });

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload: { runId?: string; window?: string };
  try {
    payload = JSON.parse(event.body ?? '{}');
  } catch (e: any) {
    log.error('payload_parse_failed', { err: String(e?.message ?? e) });
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid payload' }) };
  }
  const { runId, window: label } = payload;
  if (!runId || !label) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'missing runId or window' }) };
  }

  const start = Date.now();
  try {
    const win = windowSpec(label);
    await writeStatus(runId, { status: 'running', runningAt: new Date().toISOString() });

    const config: PortfolioConfig = { ...RULE_CONFIG_BASE, startDate: win.start };

    const result = await runPortfolioBacktest({
      config,
      window: win,
      signal: compositeRankingSignal,
      prices: livePriceSource,
      benchmarks: {
        spy: livePriceSource,
        qqq: livePriceSource,
        iwf: livePriceSource,
      },
    });

    // Firestore docs cap at 1 MiB. The equity curve + swap arrays can
    // approach that on the full window; trim them in the summary doc
    // and store the full result in a subcollection.
    const summary = {
      runId,
      window: label,
      status: 'done' as const,
      startDate: result.startDate,
      endDate: result.endDate,
      portfolioReturnPct: result.portfolioReturnPct,
      spyReturnPct: result.spyReturnPct,
      qqqReturnPct: result.qqqReturnPct,
      iwfReturnPct: result.iwfReturnPct,
      excessReturnPct: result.excessReturnPct,
      sharpe: result.sharpe,
      spySharpe: result.spySharpe,
      maxDDPct: result.maxDDPct,
      spyMaxDDPct: result.spyMaxDDPct,
      longestUnderwaterDays: result.longestUnderwaterDays,
      swapCount: result.swapCount,
      avgHoldDays: result.avgHoldDays,
      turnoverPct: result.turnoverPct,
      costDragPct: result.costDragPct,
      rebalanceCount: result.rebalanceCount,
      warningsCount: result.warnings.length,
      durationMs: Date.now() - start,
      completedAt: new Date().toISOString(),
    };
    await writeStatus(runId, summary);

    // Detail (full equity curve + swaps + warnings) in a subdoc to
    // avoid the 1 MiB limit.
    await getAdminDb()
      .collection('portfolioBacktests')
      .doc(runId)
      .collection('detail')
      .doc('full')
      .set({
        equityCurve: result.equityCurve,
        swaps: result.swaps,
        warnings: result.warnings,
      });

    log.info('backtest_complete', { runId, window: label, durationMs: summary.durationMs });
    return { statusCode: 200, body: JSON.stringify({ ok: true, runId, summary }) };
  } catch (err: any) {
    log.error('backtest_failed', { runId, err: String(err?.message ?? err) });
    await writeStatus(runId, {
      status: 'failed',
      error: String(err?.message ?? err),
      failedAt: new Date().toISOString(),
    }).catch(() => {});
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
};
