// GET /api/analysts-status
// Returns the real analyst registry from analyst-runner with live data-source
// health checks. Historical metrics (accuracy7d, signalsToday) require a
// persistence layer and are returned as null until that's built.

import type { Handler } from '@netlify/functions';
import { createLogger } from './shared/logger';
import { ANALYST_WEIGHTS } from './shared/analyst-weights';

const log = createLogger('analysts-status');
const headers = { 'Content-Type': 'application/json' };

interface AnalystEntry {
  name: string;
  label: string;
  weight: number;
  dataSource: string;
  requiresKey: string;
  status: 'healthy' | 'degraded';
  signalsToday: number | null;
  accuracy7d: number | null;
  cost: number;
  description: string;
}

// Weights come from ANALYST_WEIGHTS (shared/analyst-weights.ts) at request
// time — the registry only carries metadata, so it cannot drift from the
// weights the runner actually applies. (The previous hardcoded copy had
// drifted: macro-regime/patent-analyst were reported at 0.07/0.06 long
// after the runner pinned both to 0.)
const REGISTRY: Omit<AnalystEntry, 'status' | 'weight'>[] = [
  {
    name: 'technical-analyst', label: 'Technical',
    dataSource: 'Polygon', requiresKey: 'POLYGON_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Trend, momentum, volatility, volume-confirmed breakouts.',
  },
  {
    name: 'sector-rotation', label: 'Sector Rotation',
    dataSource: 'Polygon (sector ETFs)', requiresKey: 'POLYGON_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Relative strength vs sector ETF + sector vs SPY.',
  },
  {
    name: 'fundamental-analyst', label: 'Fundamental',
    dataSource: 'Polygon financials', requiresKey: 'POLYGON_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Revenue/EPS growth, margins, valuation (PE, PEG).',
  },
  {
    name: 'flow-analyst', label: 'Flow',
    dataSource: 'Polygon bars', requiresKey: 'POLYGON_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Volume surges, unusual activity proxies.',
  },
  {
    name: 'news-sentiment', label: 'News Sentiment',
    dataSource: 'Polygon news', requiresKey: 'POLYGON_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'News volume + sentiment scoring from Polygon news API.',
  },
  {
    name: 'earnings-analyst', label: 'Earnings',
    dataSource: 'Finnhub calendar', requiresKey: 'FINNHUB_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Upcoming prints, surprise history, IVR-aware sizing.',
  },
  {
    name: 'macro-regime', label: 'Macro Regime',
    dataSource: 'FRED', requiresKey: 'FRED_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'VIX level/trend + 2y10y curve → risk_on / risk_off / neutral. REMOVED (weight 0) — no_upstream, see phase-4f audit.',
  },
  {
    name: 'insider-analyst', label: 'Insider',
    dataSource: 'Quiver /live/insiders', requiresKey: 'QUIVER_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: '14-day clusters, C-suite weighting, first-buy-in-12mo flag.',
  },
  {
    name: 'patent-analyst', label: 'Patents',
    dataSource: 'Quiver patents', requiresKey: 'QUIVER_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Grant velocity vs prior window, high-value CPC prefix filter. REMOVED (weight 0) — no_upstream, see phase-4f audit.',
  },
  {
    name: 'political-analyst', label: 'Political',
    dataSource: 'Quiver congress + lobbying + contracts', requiresKey: 'QUIVER_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Senate + house trades, bipartisan detection, lobbying velocity, gov-contract flow.',
  },
];

export const handler: Handler = async () => {
  const start = Date.now();
  log.info('request');
  try {
    const analysts: AnalystEntry[] = REGISTRY.map((a) => ({
      ...a,
      weight: ANALYST_WEIGHTS[a.name] ?? 0,
      status: process.env[a.requiresKey] ? 'healthy' : 'degraded',
    }));
    const healthyCount = analysts.filter((a) => a.status === 'healthy').length;
    const totalWeight = analysts.reduce((s, a) => s + a.weight, 0);

    log.info('response', {
      status: 200, healthy: healthyCount, degraded: analysts.length - healthyCount,
      durationMs: Date.now() - start,
    });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        analysts,
        summary: {
          total: analysts.length,
          healthy: healthyCount,
          degraded: analysts.length - healthyCount,
          totalWeight: +totalWeight.toFixed(2),
          metricsNote: 'signalsToday and accuracy7d will populate once a signal-history persistence layer is deployed.',
        },
        generatedAt: new Date().toISOString(),
      }),
    };
  } catch (err: any) {
    log.error('failed', { error: err, durationMs: Date.now() - start });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err?.message ?? err) }),
    };
  }
};
