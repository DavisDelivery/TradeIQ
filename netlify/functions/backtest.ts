// GET /api/backtest?lookbackDays=365&tickers=NVDA,AAPL&sampleEvery=5
// Generates historical signals across bars, measures forward 5/10/20d alpha vs SPY.

import type { Handler } from '@netlify/functions';
import { getDailyBars } from './shared/data-provider';
import { SPY, SECTOR_ETFS, findEntry } from './shared/universe';
import type { Bar } from './shared/data-provider';
import { runTechnical } from './analysts/technical';
import { runSectorRotation } from './analysts/sector-rotation';
import type { BacktestResponse, BacktestTrade, BacktestWindowStats, Tier, Direction } from './shared/types';

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const lookbackDays = Math.min(Number(qs.lookbackDays ?? 365), 900);
  const sampleEvery = Math.max(1, Number(qs.sampleEvery ?? 5));
  const tickersParam = qs.tickers ?? 'NVDA,AAPL,MSFT,GOOGL,AMZN,META,TSLA,AVGO,AMD,INTC';
  const tickers = tickersParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);

  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - (lookbackDays + 220) * 86400000).toISOString().slice(0, 10);

    // Collect bars: tickers + their sector ETFs + SPY
    const needed = new Set<string>([SPY]);
    for (const t of tickers) {
      needed.add(t);
      const e = findEntry(t);
      if (e && SECTOR_ETFS[e.sector]) needed.add(SECTOR_ETFS[e.sector]);
    }
    const barMap: Record<string, Bar[]> = {};
    const list = Array.from(needed);
    const concurrency = 8;
    for (let i = 0; i < list.length; i += concurrency) {
      const chunk = list.slice(i, i + concurrency);
      const results = await Promise.all(chunk.map((s) => getDailyBars(s, from, to).then((b) => [s, b] as const).catch(() => [s, [] as Bar[]] as const)));
      for (const [s, b] of results) barMap[s] = b;
    }

    const spy = barMap[SPY];
    if (!spy || spy.length < 50) return json(200, { ok: false, error: 'SPY bars unavailable' });

    const trades: BacktestTrade[] = [];

    // For each ticker, walk forward through history, sample every N days
    for (const ticker of tickers) {
      const bars = barMap[ticker];
      if (!bars || bars.length < 50) continue;
      const entry = findEntry(ticker);
      const sectorName = entry?.sector ?? 'Unknown';
      const sectorEtf = SECTOR_ETFS[sectorName] ?? '';
      const sectorBars = barMap[sectorEtf] ?? [];

      // Determine cutoff: only look at bars within lookbackDays AND with 20d forward runway
      const cutoffTs = Date.now() - 20 * 86400000;
      const startTs = Date.now() - lookbackDays * 86400000;

      for (let i = 50; i < bars.length; i += sampleEvery) {
        const entryBar = bars[i];
        if (entryBar.t < startTs || entryBar.t > cutoffTs) continue;

        // Score as of that bar
        const barsUpTo = bars.slice(0, i + 1);
        const sectorUpTo = sectorBars.filter((b) => b.t <= entryBar.t);
        const spyUpTo = spy.filter((b) => b.t <= entryBar.t);
        if (barsUpTo.length < 50 || spyUpTo.length < 50) continue;

        const tech = runTechnical(barsUpTo);
        const sec = runSectorRotation(barsUpTo, sectorUpTo, spyUpTo, sectorName);
        const composite = Math.round(
          (tech.score * 0.6 + sec.score * 0.4),
        );
        const direction: Direction = tech.direction === sec.direction ? tech.direction : (tech.confidence > sec.confidence ? tech.direction : sec.direction);
        if (direction === 'neutral') continue;
        const tier: Tier = composite >= 80 ? 'A' : composite >= 65 ? 'B' : 'C';

        // Forward returns
        const fwd5 = fwdReturn(bars, i, 5);
        const fwd10 = fwdReturn(bars, i, 10);
        const fwd20 = fwdReturn(bars, i, 20);
        const spy5 = fwdReturn(spy, spyIndexAt(spy, entryBar.t), 5);
        const spy10 = fwdReturn(spy, spyIndexAt(spy, entryBar.t), 10);
        const spy20 = fwdReturn(spy, spyIndexAt(spy, entryBar.t), 20);

        const signMult = direction === 'long' ? 1 : -1;

        trades.push({
          ticker,
          entryDate: new Date(entryBar.t).toISOString().slice(0, 10),
          entryPrice: +entryBar.c.toFixed(2),
          composite,
          tier,
          direction,
          fwd5: fwd5 !== null ? +(signMult * fwd5).toFixed(4) : undefined,
          fwd10: fwd10 !== null ? +(signMult * fwd10).toFixed(4) : undefined,
          fwd20: fwd20 !== null ? +(signMult * fwd20).toFixed(4) : undefined,
          fwd5_alpha: fwd5 !== null && spy5 !== null ? +((signMult * fwd5) - spy5).toFixed(4) : undefined,
          fwd10_alpha: fwd10 !== null && spy10 !== null ? +((signMult * fwd10) - spy10).toFixed(4) : undefined,
          fwd20_alpha: fwd20 !== null && spy20 !== null ? +((signMult * fwd20) - spy20).toFixed(4) : undefined,
        });
      }
    }

    // Summary stats
    const summary = {
      fwd5: summarize(trades, 'fwd5', 'fwd5_alpha'),
      fwd10: summarize(trades, 'fwd10', 'fwd10_alpha'),
      fwd20: summarize(trades, 'fwd20', 'fwd20_alpha'),
    };

    const byTier: any = {};
    for (const t of ['A', 'B', 'C']) {
      const subset = trades.filter((tr) => tr.tier === t);
      byTier[t] = { n: subset.length, fwd5: summarize(subset, 'fwd5', 'fwd5_alpha'), fwd10: summarize(subset, 'fwd10', 'fwd10_alpha'), fwd20: summarize(subset, 'fwd20', 'fwd20_alpha') };
    }
    const byDirection: any = {};
    for (const d of ['long', 'short']) {
      const subset = trades.filter((tr) => tr.direction === d);
      byDirection[d] = { n: subset.length, fwd5: summarize(subset, 'fwd5', 'fwd5_alpha'), fwd10: summarize(subset, 'fwd10', 'fwd10_alpha'), fwd20: summarize(subset, 'fwd20', 'fwd20_alpha') };
    }

    const response: BacktestResponse = {
      ok: true,
      summary,
      byTier,
      byDirection,
      trades: { count: trades.length, sample: trades.slice(-200) },
      lookbackDays,
      tickers,
    };
    return json(200, response);
  } catch (err: any) {
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
};

function fwdReturn(bars: Bar[], fromIdx: number, days: number): number | null {
  const endIdx = fromIdx + days;
  if (endIdx >= bars.length) return null;
  return (bars[endIdx].c - bars[fromIdx].c) / bars[fromIdx].c;
}
function spyIndexAt(spy: Bar[], ts: number): number {
  for (let i = 0; i < spy.length; i++) if (spy[i].t >= ts) return i;
  return spy.length - 1;
}
function summarize(trades: BacktestTrade[], retKey: keyof BacktestTrade, alphaKey: keyof BacktestTrade): BacktestWindowStats {
  const rets = trades.map((t) => t[retKey]).filter((x): x is number => typeof x === 'number');
  const alphas = trades.map((t) => t[alphaKey]).filter((x): x is number => typeof x === 'number');
  if (rets.length === 0) return { n: 0, winRate: 0, avgReturn: 0, avgAlphaVsSPY: 0, medianReturn: 0 };
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    n: rets.length,
    winRate: rets.filter((r) => r > 0).length / rets.length,
    avgReturn: avg(rets),
    avgAlphaVsSPY: avg(alphas),
    medianReturn: sorted[Math.floor(sorted.length / 2)],
  };
}
function avg(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function json(statusCode: number, body: unknown) { return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }, body: JSON.stringify(body) }; }
