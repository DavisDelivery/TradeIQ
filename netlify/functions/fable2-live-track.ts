// FABLE-2 R4 — schedule trigger for the live horse race (prod only:
// Netlify schedules do not fire on deploy previews; until PR #110
// merges, the race is nudged by an external scheduled task).
// 00:30 UTC Tue-Sat = shortly after each US close, after the nightly
// scan crons have finished with the Finnhub budget.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';

export const handler = schedule('30 0 * * 2-6', async () => {
  const log = logger.child({ fn: 'fable2-live-track-cron' });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  try {
    await Promise.race([
      fetch(`${origin}/.netlify/functions/fable2-live-track-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    log.info('fable2_live_track_dispatched', {});
  } catch (e: any) {
    log.error('fable2_live_track_dispatch_failed', { err: String(e?.message ?? e) });
  }
  return { statusCode: 200 };
});
