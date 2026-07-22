// GET /api/sentiment-board?index=sp500&sort=bullish|bearish&limit=100[&force=1]
//
// Snapshot-first news-sentiment board (the "Most Bullish / Most Bearish"
// screener). Like the insider/target boards on a full universe, it NEVER
// inline-scans (a live 500-name Finnhub sweep can't fit a request) — it
// serves the latest snapshot, stale-flagged past the freshness budget, and
// `force=1` kicks the background worker. Rows are stored most-bullish-first;
// `sort=bearish` reverses the read.

import type { Handler } from '@netlify/functions';
import {
  isSnapshotFresh,
  latestSnapshot,
  snapshotAgeMs,
  type UniverseKey,
} from './shared/snapshot-store';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';
import { dispatchRescan } from './shared/rescan-dispatch';
import type { SentimentBoardRow } from './shared/sentiment';

const DEFAULT_UNIVERSE: UniverseKey = 'sp500';
const ALLOWED_UNIVERSES = new Set<UniverseKey>(['sp500']);

function orderRows(rows: SentimentBoardRow[], sort: 'bullish' | 'bearish', limit: number) {
  const sorted = [...rows].sort((a, b) =>
    sort === 'bearish'
      ? a.score - b.score || b.articleCount - a.articleCount
      : b.score - a.score || b.articleCount - a.articleCount,
  );
  return sorted.slice(0, limit);
}

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const index = (qs.index as UniverseKey) ?? DEFAULT_UNIVERSE;
  const universe: UniverseKey = ALLOWED_UNIVERSES.has(index) ? index : DEFAULT_UNIVERSE;
  const sort: 'bullish' | 'bearish' = qs.sort === 'bearish' ? 'bearish' : 'bullish';
  const limit = Math.min(Number(qs.limit ?? 100), 200);
  const force = qs.force === '1' || qs.force === 'true';

  const log = logger.child({ fn: 'sentiment-board', universe, sort, force });

  let snap: any = null;
  try {
    snap = await latestSnapshot('sentiment', universe);
  } catch (err: any) {
    log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
    snap = null;
  }

  if (snap && !force && isSnapshotFresh(snap)) {
    const ageMs = snapshotAgeMs(snap);
    log.info('snapshot_hit', { ageMs, rows: (snap.results as any[]).length });
    return json(200, {
      rows: orderRows(snap.results as SentimentBoardRow[], sort, limit),
      universeChecked: snap.universeChecked,
      sort,
      generatedAt: snap.generatedAt,
      cached: true,
      source: 'snapshot',
      ageMs,
      modelVersion: snap.modelVersion,
    });
  }

  // Stale or missing — never inline-scan a full universe. Serve stale, or
  // empty, and (on force) kick the background worker.
  const dispatched = force ? await dispatchRescan('sentiment', universe, log) : false;
  if (snap) {
    const ageMs = snapshotAgeMs(snap);
    log.warn('snapshot_stale', { ageMs, rescanDispatched: dispatched });
    return json(200, {
      rows: orderRows(snap.results as SentimentBoardRow[], sort, limit),
      universeChecked: snap.universeChecked,
      sort,
      generatedAt: snap.generatedAt,
      cached: true,
      stale: true,
      source: 'snapshot-stale',
      ageMs,
      modelVersion: snap.modelVersion,
      rescanDispatched: dispatched,
      warning: `snapshot is older than the freshness budget (${Math.round(ageMs / 60_000)} min); next scheduled scan will refresh it`,
    });
  }

  log.warn('snapshot_missing');
  return json(200, {
    rows: [],
    universeChecked: 0,
    sort,
    generatedAt: new Date().toISOString(),
    cached: false,
    source: 'snapshot-missing',
    ageMs: 0,
    modelVersion: MODEL_VERSION,
    rescanDispatched: dispatched,
    warning: 'no sentiment snapshot built yet; next scheduled scan will populate it',
  });
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' },
    body: JSON.stringify(body),
  };
}
