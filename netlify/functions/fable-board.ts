// GET /api/fable-board?limit=25[&force=1]
//
// Snapshot-first read of MY board (see reports/fable/design.md). sp500
// only in v1. `force=1` dispatches a fresh background scan (fire-and-
// forget with a 3s race) and still serves the current snapshot — the
// caller polls until generatedAt advances.

import type { Handler } from '@netlify/functions';
import { latestSnapshot, isSnapshotFresh, snapshotAgeMs } from './shared/snapshot-store';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';

const headers = { 'Content-Type': 'application/json' };

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'fable-board' });
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method not allowed' }) };
  }
  const q = event.queryStringParameters ?? {};
  const limit = Math.max(1, Math.min(100, Number(q.limit ?? 25) || 25));

  if (q.force === '1') {
    const origin =
      (event.headers['x-forwarded-proto'] ?? 'https') +
      '://' +
      (event.headers['x-forwarded-host'] ?? event.headers.host ?? 'tradeiq-alpha.netlify.app');
    try {
      await Promise.race([
        fetch(`${origin}/.netlify/functions/scan-fable-sp500-background`, {
          method: 'POST',
          headers,
          body: '{}',
        }),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      log.info('force_rescan_dispatched', {});
    } catch (e: any) {
      log.warn('force_rescan_failed', { err: String(e?.message ?? e) });
    }
  }

  try {
    const snap = await latestSnapshot('fable', 'sp500');
    if (!snap) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          board: 'fable',
          universe: 'sp500',
          picks: [],
          regime: null,
          note: 'no snapshot yet — trigger a scan with ?force=1 and re-poll',
          modelVersion: MODEL_VERSION,
        }),
      };
    }
    const regimeWarning = (snap.warnings ?? []).find((w) => w.startsWith('regime:'));
    const gateWarning = (snap.warnings ?? []).find((w) => w.startsWith('gatePassers:'));
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        board: 'fable',
        universe: 'sp500',
        generatedAt: snap.generatedAt,
        ageMs: snapshotAgeMs(snap),
        stale: !isSnapshotFresh(snap),
        degraded: snap.degraded ?? false,
        regime: regimeWarning ? regimeWarning.split(':')[1] : null,
        gatePassers: gateWarning ? Number(gateWarning.split(':')[1]) : null,
        universeChecked: snap.universeChecked,
        picks: (snap.results as unknown[]).slice(0, limit),
        modelVersion: snap.modelVersion,
      }),
    };
  } catch (err: any) {
    log.error('fable_board_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
};
