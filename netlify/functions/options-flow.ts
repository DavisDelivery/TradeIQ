// GET /api/options-flow
// Surfaces volume surges, vol regime changes, and price breakouts that typically
// precede unusual options flow. Real chain data requires TradeStation.

import type { Handler } from '@netlify/functions';
import { getDailyBars } from './shared/data-provider';
import { CORE_WATCHLIST } from './shared/universe';
import type { OptionsFlowResponse, OptionsCandidate } from './shared/types';

export const handler: Handler = async () => {
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);

    const candidates: OptionsCandidate[] = [];
    const concurrency = 8;

    for (let i = 0; i < CORE_WATCHLIST.length; i += concurrency) {
      const chunk = CORE_WATCHLIST.slice(i, i + concurrency);
      const batch = await Promise.all(chunk.map(async (ticker) => {
        try {
          const bars = await getDailyBars(ticker, from, to);
          if (bars.length < 30) return null;
          return scoreTicker(ticker, bars);
        } catch { return null; }
      }));
      for (const c of batch) if (c) candidates.push(c);
    }

    // Only keep interesting ones (score >= 60)
    const filtered = candidates.filter((c) => c.score >= 60).sort((a, b) => b.score - a.score);

    const response: OptionsFlowResponse = {
      candidates: filtered,
      proxyNote: 'Volume + breakout proxies. True options chain data requires TradeStation integration (pending).',
      generatedAt: new Date().toISOString(),
    };
    return json(200, response);
  } catch (err: any) {
    return json(500, { error: String(err?.message ?? err) });
  }
};

function scoreTicker(ticker: string, bars: any[]): OptionsCandidate | null {
  const latest = bars.at(-1);
  const prev = bars.at(-2);
  if (!latest || !prev) return null;

  const closes = bars.map((b) => b.c);
  const vols = bars.map((b) => b.v);

  const ma20 = avg(closes.slice(-20));
  const distFromMa20Pct = ((latest.c - ma20) / ma20) * 100;

  const avgVol20 = avg(vols.slice(-20));
  const volumeRatio = avgVol20 > 0 ? latest.v / avgVol20 : 1;

  // Realized vol regime: 5-day vol / 20-day vol
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i].c / bars[i - 1].c));
  const rv5 = stdev(rets.slice(-5));
  const rv20 = stdev(rets.slice(-20));
  const volRegime = rv20 > 0 ? rv5 / rv20 : 1;

  const intradayChangePct = ((latest.c - prev.c) / prev.c) * 100;

  let score = 0;
  let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';

  if (volumeRatio >= 2) score += 30;
  else if (volumeRatio >= 1.5) score += 15;

  if (volRegime >= 1.5) score += 20;
  else if (volRegime >= 1.3) score += 10;

  if (Math.abs(distFromMa20Pct) >= 5) score += 15;

  if (intradayChangePct > 1 && volumeRatio > 1.5) { score += 20; direction = 'bullish'; }
  else if (intradayChangePct < -1 && volumeRatio > 1.5) { score += 20; direction = 'bearish'; }
  else if (intradayChangePct > 0 && distFromMa20Pct > 0) direction = 'bullish';
  else if (intradayChangePct < 0 && distFromMa20Pct < 0) direction = 'bearish';

  // Approximate ATM strike (round to nearest $5 for > $100, $2.50 below)
  const approxAtm = latest.c > 100 ? Math.round(latest.c / 5) * 5 : Math.round(latest.c / 2.5) * 2.5;

  const parts: string[] = [];
  if (volumeRatio >= 2) parts.push(`volume ${volumeRatio.toFixed(1)}x avg`);
  if (volRegime >= 1.3) parts.push('vol regime shift');
  if (Math.abs(distFromMa20Pct) >= 5) parts.push(`${distFromMa20Pct > 0 ? '+' : ''}${distFromMa20Pct.toFixed(1)}% vs 20d MA`);
  if (Math.abs(intradayChangePct) >= 2) parts.push(`${intradayChangePct > 0 ? '+' : ''}${intradayChangePct.toFixed(1)}% today`);

  return {
    ticker,
    underlyingPrice: +latest.c.toFixed(2),
    intradayChangePct: +intradayChangePct.toFixed(2),
    direction,
    score: Math.min(100, Math.round(score)),
    volumeRatio: +volumeRatio.toFixed(2),
    volRegime: +volRegime.toFixed(2),
    distFromMa20Pct: +distFromMa20Pct.toFixed(2),
    approxAtmStrike: approxAtm,
    rationale: parts.join(', ') || 'normal activity',
  };
}

function avg(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = avg(xs);
  return Math.sqrt(avg(xs.map((x) => (x - m) ** 2)));
}
function json(statusCode: number, body: unknown) { return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' }, body: JSON.stringify(body) }; }
