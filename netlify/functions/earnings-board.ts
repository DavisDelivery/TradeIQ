// GET /api/earnings-board
// Returns upcoming earnings setups within 14 days, scored and sorted.

import type { Handler } from '@netlify/functions';
import { getEarningsCalendarRange, getDailyBars, getEarningsHistory, getUpcomingEarnings } from './shared/data-provider';
import { CORE_WATCHLIST, UNIVERSE } from './shared/universe';
import type { EarningsBoardResponse, EarningsSetup } from './shared/types';

export const handler: Handler = async () => {
  try {
    // Primary path: full-market calendar range (1 API call, covers all tickers)
    const allEarnings = await getEarningsCalendarRange(14);

    // Restrict to our tracked universe (S&P 500 + Nasdaq 100 primarily)
    const universeTickers = new Set(UNIVERSE.map((u) => u.ticker));
    let inUniverse = allEarnings.filter((e) => universeTickers.has(e.ticker));

    // Fallback: if the range call returned nothing (some Finnhub plans gate this
    // endpoint), probe CORE_WATCHLIST per-ticker. Slower but always works.
    if (inUniverse.length === 0) {
      const probed = await Promise.all(
        CORE_WATCHLIST.map((t) => getUpcomingEarnings(t, 14).catch(() => null)),
      );
      inUniverse = probed.filter((e): e is NonNullable<typeof e> => e !== null);
    }

    // Score each setup
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);

    const setups: EarningsSetup[] = [];
    const concurrency = 8;

    for (let i = 0; i < inUniverse.length; i += concurrency) {
      const chunk = inUniverse.slice(i, i + concurrency);
      const batch = await Promise.all(
        chunk.map(async (e) => {
          try {
            const [bars, history] = await Promise.all([
              getDailyBars(e.ticker, from, to).catch(() => []),
              getEarningsHistory(e.ticker, 4).catch(() => []),
            ]);
            if (bars.length < 30) return null;

            const latest = bars.at(-1)!;
            // IV Rank proxy: current realized vol vs 90-day range
            const returns: number[] = [];
            for (let j = 1; j < bars.length; j++) returns.push(Math.log(bars[j].c / bars[j - 1].c));
            const rv20 = annVol(returns.slice(-20));
            const rv90Min = Math.min(...chunksAnnVol(returns, 20));
            const rv90Max = Math.max(...chunksAnnVol(returns, 20));
            const ivr = rv90Max > rv90Min
              ? Math.round(((rv20 - rv90Min) / (rv90Max - rv90Min)) * 100)
              : 50;

            // Expected move: realized vol scaled to days until earnings
            const daysUntil = Math.round((new Date(e.date).getTime() - Date.now()) / 86400000);
            const expectedMove = rv20 * 100 * Math.sqrt(Math.max(1, daysUntil) / 365);

            // Average prior earnings-day move
            const priorMoves: number[] = [];
            for (const h of history.slice(0, 4)) {
              const hd = new Date(h.date).getTime();
              const barIdx = bars.findIndex((b) => Math.abs(b.t - hd) < 3 * 86400000);
              if (barIdx > 0 && barIdx < bars.length - 1) {
                const move = Math.abs((bars[barIdx + 1].c - bars[barIdx - 1].c) / bars[barIdx - 1].c) * 100;
                priorMoves.push(move);
              }
            }
            const avgPriorMove = priorMoves.length > 0 ? avg(priorMoves) : null;

            // Strategy: sell premium if IVR high, buy premium if IVR low
            const bias: EarningsSetup['bias'] = ivr >= 60 ? 'sell_premium' : ivr <= 30 ? 'buy_premium' : 'neutral';
            const strategy = bias === 'sell_premium' ? 'Iron Condor' : bias === 'buy_premium' ? 'Long Straddle' : 'Wait';

            // Composite: IVR quality + prior-move consistency + timing
            let composite = 50;
            if (bias === 'sell_premium' && ivr >= 70) composite = 80;
            else if (bias === 'sell_premium') composite = 65;
            else if (bias === 'buy_premium' && ivr <= 20) composite = 78;
            else if (bias === 'buy_premium') composite = 60;

            if (avgPriorMove !== null && expectedMove > 0) {
              const priorVsExpected = avgPriorMove / expectedMove;
              if (bias === 'sell_premium' && priorVsExpected < 0.8) composite += 10; // prior moves smaller than expected → keep premium
              if (bias === 'buy_premium' && priorVsExpected > 1.2) composite += 10; // prior moves bigger than expected → buy cheap premium
            }
            if (daysUntil <= 2) composite -= 5; // event too close

            const rationale = `${bias === 'sell_premium' ? 'Sell premium' : bias === 'buy_premium' ? 'Buy premium' : 'Wait'}: IVR ${ivr}, expected move ±${expectedMove.toFixed(1)}%${avgPriorMove !== null ? `, avg prior move ${avgPriorMove.toFixed(1)}%` : ''}, ${daysUntil}d until print.`;

            const setup: EarningsSetup = {
              ticker: e.ticker,
              price: +latest.c.toFixed(2),
              reportDate: e.date,
              reportTime: (e.hour as any) ?? 'dmh',
              daysUntil,
              bias,
              strategy,
              composite: Math.max(0, Math.min(100, composite)),
              ivr,
              expectedMove: +expectedMove.toFixed(2),
              avgPriorMove: avgPriorMove !== null ? +avgPriorMove.toFixed(2) : null,
              rationale,
            };
            return setup;
          } catch {
            return null;
          }
        }),
      );
      for (const s of batch) if (s) setups.push(s);
    }

    // Filter: composite >= 55 to return only worth-looking-at setups
    const filtered = setups.filter((s) => s.composite >= 55).sort((a, b) => b.composite - a.composite);

    const response: EarningsBoardResponse = {
      setups: filtered,
      universeChecked: inUniverse.length,
      generatedAt: new Date().toISOString(),
    };
    return json(200, response);
  } catch (err: any) {
    return json(500, { error: String(err?.message ?? err) });
  }
};

function annVol(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = avg(returns);
  const variance = avg(returns.map((r) => (r - mean) ** 2));
  return Math.sqrt(variance) * Math.sqrt(252);
}
function chunksAnnVol(returns: number[], window: number): number[] {
  const out: number[] = [];
  for (let i = window; i <= returns.length; i += window) {
    out.push(annVol(returns.slice(i - window, i)));
  }
  return out;
}
function avg(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function json(statusCode: number, body: unknown) { return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' }, body: JSON.stringify(body) }; }
