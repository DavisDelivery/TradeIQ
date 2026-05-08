// GET /api/regime
// Returns the live macro regime computed from FRED (VIX + 2y/10y curve).
import type { Handler } from '@netlify/functions';
import { computeRegime } from './shared/regime';
import { createLogger } from './shared/logger';

const log = createLogger('regime');
const headers = { 'Content-Type': 'application/json' };

export const handler: Handler = async () => {
  const start = Date.now();
  log.info('request');
  try {
    const regime = await computeRegime();
    log.info('response', { status: 200, regime: regime.regime, durationMs: Date.now() - start });
    return { statusCode: 200, headers, body: JSON.stringify(regime) };
  } catch (err: any) {
    log.error('failed', { error: err, durationMs: Date.now() - start });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err?.message ?? err) }),
    };
  }
};
