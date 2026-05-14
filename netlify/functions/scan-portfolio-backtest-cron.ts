// Phase 4e-1 follow-up — daily backtest cron.
//
// Cycles deterministically through 13 backtest windows, one per weekday.
// Full cycle takes ~13 weekdays. After deploy + 13 weekdays, every
// window in `portfolioBacktests/` has a fresh result; the
// /api/portfolio-verdict endpoint reads them all and emits the
// populated verdict markdown.
//
// Schedule: 0 22 * * 1-5 (weekday 22:00 UTC, after US market close).
//
// Shorter windows first so the easier ones populate quickly:
//   covid (~7mo), rate-hikes (~12mo), rolling-* (12mo each),
//   half-* (~4yr), full (~8yr — most likely to hit the 15-min cap).
//
// The cron POSTs to /.netlify/functions/portfolio-backtest-trigger
// rather than doing the work inline so the trigger's pending-row +
// status machinery is exercised consistently.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';

const WINDOW_CYCLE = [
  'covid',
  'rate-hikes',
  'rolling-2024',
  'rolling-2023',
  'rolling-2022',
  'rolling-2021',
  'rolling-2020',
  'rolling-2019',
  'rolling-2018',
  'rolling-2025',
  'half-2022',
  'half-2018',
  'full',
];

function pickWindow(now: Date): string {
  // Day-of-year deterministic pick — wraps around the cycle.
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const diff = now.getTime() - start;
  const dayOfYear = Math.floor(diff / 86_400_000);
  return WINDOW_CYCLE[dayOfYear % WINDOW_CYCLE.length];
}

export const handler = schedule('0 22 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-portfolio-backtest-cron' });
  const now = new Date();
  const window = pickWindow(now);
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  const url = `${origin}/.netlify/functions/portfolio-backtest-trigger`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ window }),
    });
    const body = await res.text();
    log.info('cron_dispatched', { window, status: res.status, body: body.slice(0, 200) });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, window, triggerStatus: res.status }),
    };
  } catch (err: any) {
    log.error('cron_failed', { window, err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, window, error: String(err?.message ?? err) }),
    };
  }
});

// Exposed so unit tests can verify the cycle without invoking schedule().
export const _internals = { WINDOW_CYCLE, pickWindow };
