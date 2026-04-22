// GET /api/regime
// Returns the live macro regime computed from FRED (VIX + 2y/10y curve).
import type { Handler } from '@netlify/functions';
import { computeRegime } from './shared/regime';

const headers = { 'Content-Type': 'application/json' };

export const handler: Handler = async () => {
  try {
    const regime = await computeRegime();
    return { statusCode: 200, headers, body: JSON.stringify(regime) };
  } catch (err: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err?.message ?? err) }),
    };
  }
};
