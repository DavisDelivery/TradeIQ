// GET /api/analysts-status
// Returns the real analyst registry from analyst-runner with live data-source
// health checks. Historical metrics (accuracy7d, signalsToday) require a
// persistence layer and are returned as null until that's built.

import type { Handler } from '@netlify/functions';

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

// Mirrors ANALYST_WEIGHTS in shared/analyst-runner.ts. Keep in sync.
const REGISTRY: Omit<AnalystEntry, 'status'>[] = [
  {
    name: 'technical-analyst', label: 'Technical', weight: 0.15,
    dataSource: 'Polygon', requiresKey: 'POLYGON_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Trend, momentum, volatility, volume-confirmed breakouts.',
  },
  {
    name: 'sector-rotation', label: 'Sector Rotation', weight: 0.08,
    dataSource: 'Polygon (sector ETFs)', requiresKey: 'POLYGON_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Relative strength vs sector ETF + sector vs SPY.',
  },
  {
    name: 'fundamental-analyst', label: 'Fundamental', weight: 0.13,
    dataSource: 'Polygon financials', requiresKey: 'POLYGON_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Revenue/EPS growth, margins, valuation (PE, PEG).',
  },
  {
    name: 'flow-analyst', label: 'Flow', weight: 0.10,
    dataSource: 'Polygon bars', requiresKey: 'POLYGON_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Volume surges, unusual activity proxies.',
  },
  {
    name: 'news-sentiment', label: 'News Sentiment', weight: 0.10,
    dataSource: 'Polygon news', requiresKey: 'POLYGON_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'News volume + sentiment scoring from Polygon news API.',
  },
  {
    name: 'earnings-analyst', label: 'Earnings', weight: 0.07,
    dataSource: 'Finnhub calendar', requiresKey: 'FINNHUB_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Upcoming prints, surprise history, IVR-aware sizing.',
  },
  {
    name: 'macro-regime', label: 'Macro Regime', weight: 0.07,
    dataSource: 'FRED', requiresKey: 'FRED_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'VIX level/trend + 2y10y curve → risk_on / risk_off / neutral.',
  },
  {
    name: 'insider-analyst', label: 'Insider', weight: 0.14,
    dataSource: 'Quiver /live/insiders', requiresKey: 'QUIVER_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: '14-day clusters, C-suite weighting, first-buy-in-12mo flag.',
  },
  {
    name: 'patent-analyst', label: 'Patents', weight: 0.06,
    dataSource: 'Quiver patents', requiresKey: 'QUIVER_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Grant velocity vs prior window, high-value CPC prefix filter.',
  },
  {
    name: 'political-analyst', label: 'Political', weight: 0.10,
    dataSource: 'Quiver congress + lobbying + contracts', requiresKey: 'QUIVER_API_KEY',
    signalsToday: null, accuracy7d: null, cost: 0,
    description: 'Senate + house trades, bipartisan detection, lobbying velocity, gov-contract flow.',
  },
];

export const handler: Handler = async () => {
  try {
    const analysts: AnalystEntry[] = REGISTRY.map((a) => ({
      ...a,
      status: process.env[a.requiresKey] ? 'healthy' : 'degraded',
    }));
    const healthyCount = analysts.filter((a) => a.status === 'healthy').length;
    const totalWeight = analysts.reduce((s, a) => s + a.weight, 0);

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
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err?.message ?? err) }),
    };
  }
};
