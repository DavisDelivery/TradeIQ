// GET /api/health
import type { Handler } from '@netlify/functions';

export const handler: Handler = async () => {
  const checks = {
    polygon: !!process.env.POLYGON_API_KEY,
    finnhub: !!process.env.FINNHUB_API_KEY,
    fred: !!process.env.FRED_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
  };
  const allGreen = Object.values(checks).every(Boolean);
  return {
    statusCode: allGreen ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: allGreen,
      service: 'tradeiq-alpha',
      version: '0.2.0-alpha',
      checks,
      timestamp: new Date().toISOString(),
    }),
  };
};
