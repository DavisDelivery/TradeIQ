// QS-1 — Quiet Strength: thin cron dispatcher (holiday guard → worker POST).
//
// 22:40 UTC weekdays, in the gap between trident (22:15) and target-board
// (23:00), and comfortably before forward-test-nightly at 00:20 UTC. A slot
// at or after 00:20 would be captured by the league a day late, every day,
// forever.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';
import { isMarketClosed } from './shared/us-market-holidays';

export const CRON = '40 22 * * 1-5';

export const handler = schedule(CRON, async () => {
  const log = logger.child({ fn: 'scan-quiet-strength', schedule: CRON });
  // Without this a holiday re-publishes the prior session's names under a
  // fresh generatedAt, and the forward league enters a duplicate cohort into
  // a record that is never edited afterwards.
  if (isMarketClosed(new Date())) {
    log.info('skipped_market_closed', {});
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: 'market_closed' }) };
  }
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  try {
    const res = await fetch(`${origin}/.netlify/functions/scan-quiet-strength-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    log.info('worker_dispatched', { status: res.status });
    return { statusCode: 200, body: JSON.stringify({ ok: true, workerStatus: res.status }) };
  } catch (err: any) {
    log.error('worker_dispatch_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
});
