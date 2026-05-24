// GET /api/williams-rationale?ticker=NVDA
//
// Phase 6 W1 — on-demand per-ticker Williams rationale endpoint. Mirrors the
// Phase 4q /api/target-rationale pattern: live-recompute the Williams style
// score for one ticker and return the decomposed per-component breakdown, a
// synthesized thesis paragraph, and falsifiable risk callouts.
//
// Surface-only: this endpoint does NOT change scoring. It re-uses `runWilliams`
// and decomposes the score it already produces (see shared/score-breakdown.ts).
//
// On-demand, not snapshot-inline — same reasoning as 4q: carrying the full
// component breakdown + thesis on every board pick would bloat the Firestore
// snapshot doc. The SPA session-memoizes per ticker.

import type { Handler } from '@netlify/functions';
import { getDailyBars } from './shared/data-provider';
import { runWilliams } from './styles/williams';
import { deriveWilliamsSignal } from './styles/williams-signal';
import { buildWilliamsComponents, type ScoreComponent } from './shared/score-breakdown';
import { generateWilliamsThesis } from './shared/thesis-generation';
import { williamsRiskCallouts } from './shared/risk-callouts';
import { findEntry } from './shared/universe';
import { createLogger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';

const log = createLogger('williams-rationale');

interface WilliamsRationaleResponse {
  ok: boolean;
  ticker: string;
  name?: string;
  sector?: string;
  score?: number;
  direction?: 'long' | 'short' | 'neutral';
  side?: 'long' | 'short';
  signal?: ReturnType<typeof deriveWilliamsSignal>;
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
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
    const bars = await getDailyBars(ticker, from, to);

    if (!bars || bars.length < 30) {
      log.warn('no_bars', { ticker, bars: bars?.length ?? 0, durationMs: Date.now() - start });
      return json(404, { ok: false, ticker, error: 'insufficient price history for ticker' });
    }

    const s = runWilliams({ ticker, bars });
    const signal = deriveWilliamsSignal({ score: s.score, signals: s.signals }, bars);
    const components = buildWilliamsComponents(s.signals);

    const entry = findEntry(ticker);
    const name = entry?.name ?? ticker;
    const sector = entry?.sector ?? 'Unknown';

    const thesis = generateWilliamsThesis(components, { ticker, name, sector, score: s.score });
    const riskCallouts = williamsRiskCallouts(components, s.score);

    const direction: 'long' | 'short' | 'neutral' =
      s.score >= 20 ? 'long' : s.score <= -20 ? 'short' : 'neutral';

    const body: WilliamsRationaleResponse = {
      ok: true,
      ticker,
      name,
      sector,
      score: +s.score.toFixed(1),
      direction,
      side: s.score >= 0 ? 'long' : 'short',
      signal,
      thesis,
      components,
      riskCallouts,
      price: bars.length > 0 ? bars[bars.length - 1].c : null,
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

function json(statusCode: number, body: WilliamsRationaleResponse) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
    body: JSON.stringify(body),
  };
}
