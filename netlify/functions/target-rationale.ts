// GET /api/target-rationale?ticker=NVDA
//
// Phase 4q — on-demand per-ticker rationale endpoint. Live-recomputes
// the ten-analyst score for one ticker and returns, per analyst,
// `analyst`, `score`, `direction`, `weight`, `rationale`, and the full
// structured `signals` object (including `_noData` / `_reason` markers).
//
// **Why on-demand and not snapshot-inline:** the board snapshots cover
// ~50 picks per universe (russell2k: ~2k). Carrying every analyst's
// `rationale` string + structured `signals` object on every pick inflates
// the Firestore doc materially — Phase 4u just fixed a 1 MiB cap problem
// caused by exactly that kind of inline growth. The detail-panel
// accordion fires this endpoint when the user opens a stock, and the
// SPA memoizes per-ticker for the session, so re-opening the same stock
// doesn't re-fetch.
//
// Surface-only: this endpoint does NOT change scoring. It re-uses the
// existing `runAnalystsForTicker` path and just stops dropping the
// per-analyst detail that `composeTarget` discards when assembling the
// thin `AnalystContribution[]`.

import type { Handler } from '@netlify/functions';
import { fetchBarCache, runAnalystsForTicker } from './shared/analyst-runner';
import { computeRegime, regimeToMacroBias } from './shared/regime';
import { createLogger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';
import type { AnalystContribution, Direction } from './shared/types';

const log = createLogger('target-rationale');

interface AnalystRationaleRow {
  analyst: string;
  score: number;
  direction: Direction;
  weight: number;
  confidence: number;
  rationale: string;
  signals: Record<string, unknown>;
}

interface TargetRationaleResponse {
  ok: boolean;
  ticker: string;
  composite?: number;
  tier?: string;
  direction?: Direction;
  scoredAt?: string;
  modelVersion?: string;
  analysts?: AnalystRationaleRow[];
  error?: string;
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  // Accept ticker via querystring (?ticker=NVDA) — the redirect rule in
  // netlify.toml uses `/api/target-rationale` literal; if Chad later
  // wants `/api/target-rationale/:ticker` path-style, the redirect
  // splatter will land here as `?ticker=…`.
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase().trim();
  if (!ticker) {
    return json(400, { ok: false, ticker: '', error: 'ticker required' } satisfies TargetRationaleResponse);
  }

  log.info('request', { ticker });
  try {
    const [regime, barCache] = await Promise.all([
      computeRegime().catch(() => null),
      fetchBarCache([ticker]),
    ]);
    const macroBias = regime ? regimeToMacroBias(regime) : 0;
    const { target, analysts } = await runAnalystsForTicker({ ticker, barCache, macroBias });

    if (!target) {
      log.warn('no_bars', { ticker, durationMs: Date.now() - start });
      return json(404, {
        ok: false,
        ticker,
        error: 'no bars available for ticker',
      } satisfies TargetRationaleResponse);
    }

    // Pair each thin AnalystContribution (which carries the rescaled
    // effective weight) with the matching full AnalystOutput so the row
    // carries both: the composite-relevant weight AND the analyst's
    // own rationale + signals.
    const contribByAnalyst = new Map<string, AnalystContribution>(
      target.analystContributions.map((c) => [c.analyst, c]),
    );

    const rows: AnalystRationaleRow[] = Object.entries(analysts).map(([name, a]) => {
      const c = contribByAnalyst.get(name);
      return {
        analyst: name,
        score: a.score,
        direction: a.direction,
        weight: c?.weight ?? 0,
        confidence: a.confidence,
        rationale: a.rationale,
        signals: a.signals ?? {},
      };
    });

    const body: TargetRationaleResponse = {
      ok: true,
      ticker,
      composite: target.composite,
      tier: target.tier,
      direction: target.direction,
      scoredAt: target.scoredAt,
      modelVersion: MODEL_VERSION,
      analysts: rows,
    };

    log.info('response', { status: 200, ticker, composite: target.composite, durationMs: Date.now() - start });
    return json(200, body);
  } catch (err: any) {
    log.error('failed', { ticker, error: err, durationMs: Date.now() - start });
    return json(500, {
      ok: false,
      ticker,
      error: String(err?.message ?? err),
    } satisfies TargetRationaleResponse);
  }
};

function json(statusCode: number, body: TargetRationaleResponse) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Short browser cache: the underlying data is recomputed live, but
      // a stock the user opens twice within a few minutes does not need
      // a re-fetch. The session-scoped React-Query memoization in the
      // SPA does most of the dedup; this header just hardens it.
      'Cache-Control': 'public, max-age=60',
    },
    body: JSON.stringify(body),
  };
}
