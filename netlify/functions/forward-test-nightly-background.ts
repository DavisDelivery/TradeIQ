// Nightly forward-test run (background worker).
//
// POST {} → capture tonight's top-N entrants across all tracked boards and
// mark/freeze every open pick (see shared/forward-test.ts). Idempotent: a
// re-run on the same evalDate recaptures nothing (open picks dedupe on
// (board, universe, ticker)) and re-marks to the same closes.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { runForwardTestNightly } from './shared/forward-test';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const log = logger.child({ fn: 'forward-test-nightly-background' });
  const started = Date.now();
  try {
    const report = await runForwardTestNightly(log);
    log.info('run_done', { ...report, ms: Date.now() - started });
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...report }) };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('run_failed', { err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
