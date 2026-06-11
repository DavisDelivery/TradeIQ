// GET /api/lynch-rationale?ticker=AAPL
//
// Phase 6 W1 — on-demand per-ticker Lynch rationale endpoint. Mirrors the
// Phase 4q /api/target-rationale pattern: live-recompute the Lynch (GARP)
// style score for one ticker and return the decomposed per-component
// breakdown, a synthesized thesis paragraph, and falsifiable risk callouts.
//
// Surface-only: this endpoint does NOT change scoring. It re-uses `runLynch`
// and decomposes the score it already produces (see shared/score-breakdown.ts).

import type { Handler } from '@netlify/functions';
import {
  getFundamentals,
  getEarningsHistory,
  getPreviousClose,
} from './shared/data-provider';
import { runLynch } from './styles/lynch';
import { deriveLynchSignalFromAnalyst } from './styles/lynch-signal';
import { buildLynchComponents, type ScoreComponent } from './shared/score-breakdown';
import { generateLynchThesis } from './shared/thesis-generation';
import { lynchRiskCallouts } from './shared/risk-callouts';
import { findEntry } from './shared/universe';
import { sideFromScore, type StyleSide } from './shared/style-types';
import { createLogger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';

const log = createLogger('lynch-rationale');

interface LynchRationaleResponse {
  ok: boolean;
  ticker: string;
  name?: string;
  sector?: string;
  score?: number;
  direction?: 'long' | 'short' | 'neutral';
  side?: StyleSide;
  confidence?: number;
  signal?: ReturnType<typeof deriveLynchSignalFromAnalyst>;
  thesis?: string;
  components?: ScoreComponent[];
  riskCallouts?: string[];
  price?: number | null;
  modelVersion?: string;
  scoredAt?: string;
  error?: string;
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase().trim();
  if (!ticker) {
    return json(400, { ok: false, ticker: '', error: 'ticker required' });
  }

  log.info('request', { ticker });
  try {
    const entry = findEntry(ticker);
    const [fund, earnings, snap] = await Promise.all([
      getFundamentals(ticker).catch(() => null),
      getEarningsHistory(ticker, 4).catch(() => []),
      getPreviousClose(ticker).catch(() => null),
    ]);

    // Lynch is a fundamentals strategy. With no fundamentals AND no earnings
    // history there is nothing to score — return an explicit no-data 404 so
    // the SPA renders the honest "no Lynch read" state rather than a zero.
    if (!fund && (!earnings || earnings.length === 0)) {
      log.warn('no_fundamentals', { ticker, durationMs: Date.now() - start });
      return json(404, { ok: false, ticker, error: 'no fundamentals available for ticker' });
    }

    const s = runLynch({
      ticker,
      peRatio: fund?.ttmEps && snap ? snap.c / fund.ttmEps : undefined,
      epsGrowthTTM: fund?.epsGrowthTTM,
      revenueGrowthYoY: fund?.revenueGrowthYoY,
      debtToEquity: fund?.debtToEquity,
      operatingMargin: fund?.operatingMargin,
      earningsHistory: earnings,
      marketCapUsd: undefined,
      recentReturnPct: undefined,
      sector: entry?.sector,
    });

    const signal = deriveLynchSignalFromAnalyst(
      { score: s.score, signals: s.signals },
      { currentPrice: snap?.c, ttmEps: fund?.ttmEps },
    );
    const components = buildLynchComponents(s.signals);

    const name = entry?.name ?? ticker;
    const sector = entry?.sector ?? 'Unknown';

    const thesis = generateLynchThesis(components, { ticker, name, sector, score: s.score });
    const riskCallouts = lynchRiskCallouts(components, s.score);

    const direction: 'long' | 'short' | 'neutral' =
      s.score >= 30 ? 'long' : s.score <= -10 ? 'short' : 'neutral';

    const body: LynchRationaleResponse = {
      ok: true,
      ticker,
      name,
      sector,
      score: +s.score.toFixed(1),
      direction,
      side: sideFromScore(s.score),
      confidence: +s.confidence.toFixed(2),
      signal,
      thesis,
      components,
      riskCallouts,
      price: snap?.c ?? null,
      modelVersion: MODEL_VERSION,
      scoredAt: new Date().toISOString(),
    };

    log.info('response', { status: 200, ticker, score: s.score, durationMs: Date.now() - start });
    return json(200, body);
  } catch (err: any) {
    log.error('failed', { ticker, error: err, durationMs: Date.now() - start });
    return json(500, { ok: false, ticker, error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: LynchRationaleResponse) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
    body: JSON.stringify(body),
  };
}
