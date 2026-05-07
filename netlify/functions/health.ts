// GET /api/health
import type { Handler } from '@netlify/functions';
import { createLogger } from './shared/logger';

const log = createLogger('health');

export const handler: Handler = async () => {
  const start = Date.now();
  log.info('request');
  const checks = {
    polygon: !!process.env.POLYGON_API_KEY,
    finnhub: !!process.env.FINNHUB_API_KEY,
    fred: !!process.env.FRED_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
  };
  const allGreen = Object.values(checks).every(Boolean);
  const status = allGreen ? 200 : 500;
  log.info('response', { status, durationMs: Date.now() - start, allGreen });
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: allGreen,
      service: 'tradeiq-alpha',
      version: '0.8.0-alpha',
      checks,
      timestamp: new Date().toISOString(),
    }),
  };
};
