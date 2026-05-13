// GET /api/prophet-portfolio
//   ?universe=largecap (only universe supported in 4e-1)
//
// Reads the persisted portfolio state, last 20 swaps, and last 252-day
// equity curve from Firestore, then computes return-vs-benchmark metrics
// on the fly for the sinceInception, YTD, and trailing-1Y windows.
//
// Pre-W5 (live rebalance scheduled function): state will be null and
// the endpoint returns `{ ok: true, state: null, swaps: [], equityCurve: [], metrics: { ... zeros } }`.
// The UI tab (Phase 4e-2) renders an "engine pending" placeholder in
// that case.

import type { Handler } from '@netlify/functions';
import {
  getPortfolioState,
  listEquityCurve,
  listRecentSwaps,
} from './shared/prophet-portfolio/state';
import type {
  EquityCurvePoint,
  PortfolioUniverse,
} from './shared/prophet-portfolio/types';
import { logger } from './shared/logger';

const SUPPORTED_UNIVERSES: PortfolioUniverse[] = ['largecap', 'russell2k'];

interface WindowMetrics {
  portfolioReturnPct: number;
  spyReturnPct: number;
  excessReturnPct: number;
  sharpe: number;
  maxDDPct: number;
  days: number;
}

const ZERO_METRICS: WindowMetrics = {
  portfolioReturnPct: 0,
  spyReturnPct: 0,
  excessReturnPct: 0,
  sharpe: 0,
  maxDDPct: 0,
  days: 0,
};

function sliceCurve(
  curve: EquityCurvePoint[],
  fromDate: string,
): EquityCurvePoint[] {
  return curve.filter((p) => p.date >= fromDate);
}

function pctChange(values: number[]): number {
  if (values.length < 2) return 0;
  const first = values[0];
  const last = values[values.length - 1];
  if (first <= 0) return 0;
  return +(((last - first) / first) * 100).toFixed(4);
}

function maxDDPct(values: number[]): number {
  if (values.length === 0) return 0;
  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return +(maxDD * 100).toFixed(4);
}

function dailyReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) out.push((values[i] - values[i - 1]) / values[i - 1]);
  }
  return out;
}

function annualizedSharpe(rets: number[]): number {
  if (rets.length < 2) return 0;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return 0;
  return +((mean / stdev) * Math.sqrt(252)).toFixed(4);
}

export function computeWindowMetrics(curve: EquityCurvePoint[]): WindowMetrics {
  if (curve.length === 0) return ZERO_METRICS;
  const portfolio = curve.map((p) => p.equity);
  const spy = curve
    .map((p) => p.spyClose)
    .filter((v): v is number => v != null && v > 0);
  const portReturn = pctChange(portfolio);
  const spyReturn = pctChange(spy);
  return {
    portfolioReturnPct: portReturn,
    spyReturnPct: spyReturn,
    excessReturnPct: +(portReturn - spyReturn).toFixed(4),
    sharpe: annualizedSharpe(dailyReturns(portfolio)),
    maxDDPct: maxDDPct(portfolio),
    days: curve.length,
  };
}

const CACHE_TTL_MS = 5 * 60_000;
type CachedResponse = { body: any; at: number };
const cache = new Map<string, CachedResponse>();

export const handler: Handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: 'method not allowed' }),
    };
  }

  const qs = event.queryStringParameters ?? {};
  const universe = (qs.universe as PortfolioUniverse) ?? 'largecap';
  if (!SUPPORTED_UNIVERSES.includes(universe)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: `unsupported universe: ${universe}` }),
    };
  }
  const log = logger.child({ fn: 'prophet-portfolio', universe });

  const cacheKey = universe;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return ok({ ...cached.body, cached: true });
  }

  try {
    const [state, swaps, curve] = await Promise.all([
      getPortfolioState(universe),
      listRecentSwaps(universe, 20),
      listEquityCurve(universe, 252),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const ytdStart = `${today.slice(0, 4)}-01-01`;
    const oneYearAgo = new Date(Date.now() - 365 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const metrics = {
      sinceInception: computeWindowMetrics(curve),
      ytd: computeWindowMetrics(sliceCurve(curve, ytdStart)),
      last1y: computeWindowMetrics(sliceCurve(curve, oneYearAgo)),
    };

    const body = {
      ok: true,
      universe,
      state,
      swaps,
      equityCurve: curve,
      metrics,
      generatedAt: new Date().toISOString(),
    };
    // Only cache populated reads. Pre-W5 reads (state===null) flip to
    // populated as soon as the first rebalance writes; we don't want a
    // 5-min cache window hiding that transition.
    if (state) {
      cache.set(cacheKey, { body, at: Date.now() });
    }
    log.info('portfolio_read', {
      hasState: !!state,
      swaps: swaps.length,
      curvePoints: curve.length,
    });
    return ok({ ...body, cached: false });
  } catch (err: any) {
    log.error('portfolio_read_failed', { err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
    };
  }
};

function ok(body: any) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}
