// GET /api/earnings-board?days=7
// Returns upcoming + recent earnings setups, scored and sorted, with
// pro-grade play categorization (long/short vol, directional, PEAD, reversal).
//
// Look-ahead window via ?days= param (3, 7, 14, 30). Default 7. Post-print
// (PEAD/reversal) included when days >= 7 by scanning the prior 5 trading days.
//
// Caching: per-window TTL 30min, but NEVER cache empty results (same fix
// pattern as v0.7.18 target-board and v0.7.19 prophet — empty caches lock
// users into 0 setups for the cache TTL).

import type { Handler } from '@netlify/functions';
import { getEarningsCalendarRange, getDailyBars, getEarningsHistory, getUpcomingEarnings } from './shared/data-provider';
import { CORE_WATCHLIST, UNIVERSE } from './shared/universe';
import type {
  EarningsBoardResponse, EarningsSetup, EarningsPlayType,
  PlayTriggers, HistoricalEdge,
} from './shared/types';

// Per-window result cache. Key is windowDays.
const resultCache = new Map<number, { data: EarningsBoardResponse; at: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

const ALLOWED_WINDOWS = [3, 7, 14, 30] as const;
const POST_PRINT_LOOKBACK_DAYS = 5;

export const handler: Handler = async (event) => {
  try {
    const rawDays = Number(event.queryStringParameters?.days);
    const windowDays: number = (ALLOWED_WINDOWS as readonly number[]).includes(rawDays)
      ? rawDays
      : 7;

    // Cache check
    const cached = resultCache.get(windowDays);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return json(200, { ...cached.data, cached: true });
    }

    // Get upcoming + (if window large enough) recently-printed events
    const lookAhead = windowDays;
    const lookBack = windowDays >= 7 ? POST_PRINT_LOOKBACK_DAYS : 0;
    const allEarnings = await getEarningsCalendarRange(lookAhead, lookBack);

    // Restrict to our tracked universe
    const universeTickers = new Set(UNIVERSE.map((u) => u.ticker));
    let inUniverse = allEarnings.filter((e) => universeTickers.has(e.ticker));

    // Fallback for plans that gate the calendar range endpoint
    if (inUniverse.length === 0) {
      const probed = await Promise.all(
        CORE_WATCHLIST.map((t) => getUpcomingEarnings(t, lookAhead).catch(() => null)),
      );
      inUniverse = probed.filter((e): e is NonNullable<typeof e> => e !== null);
    }

    const to = new Date().toISOString().slice(0, 10);
    // 400d of bars covers ~5 quarterly prints — enough that historicalEdge
    // can score against 3+ prior earnings reactions for the typical ticker.
    // 180d (the prior value) only caught 0-1 prior prints, leaving
    // historicalEdge null on virtually every setup.
    const from = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);

    const setups: EarningsSetup[] = [];
    const concurrency = 10;
    const SCAN_BUDGET_MS = 22000;
    const startedAt = Date.now();

    for (let i = 0; i < inUniverse.length; i += concurrency) {
      if (Date.now() - startedAt > SCAN_BUDGET_MS) break;
      const chunk = inUniverse.slice(i, i + concurrency);
      const batch = await Promise.all(
        chunk.map(async (e) => {
          try {
            const [bars, history] = await Promise.all([
              getDailyBars(e.ticker, from, to).catch(() => []),
              getEarningsHistory(e.ticker, 8).catch(() => []),
            ]);
            if (bars.length < 30) return null;

            const latest = bars.at(-1)!;
            const reportTs = new Date(e.date).getTime();
            const daysUntil = Math.round((reportTs - Date.now()) / 86400000);
            const postPrint = daysUntil < 0;

            // ---- Volatility metrics ----
            const returns: number[] = [];
            for (let j = 1; j < bars.length; j++) {
              if (bars[j].c > 0 && bars[j - 1].c > 0) {
                returns.push(Math.log(bars[j].c / bars[j - 1].c));
              }
            }
            const rv20 = annVol(returns.slice(-20));
            const chunked = chunksAnnVol(returns, 20).filter((v) => v > 0);
            const rv90Min = chunked.length ? Math.min(...chunked) : 0;
            const rv90Max = chunked.length ? Math.max(...chunked) : 0;
            // IV proxy clamped to 0-100 (the prior version was unbounded → 294 outliers)
            const ivrRaw = rv90Max > rv90Min
              ? ((rv20 - rv90Min) / (rv90Max - rv90Min)) * 100
              : 50;
            const ivr = Math.max(0, Math.min(100, Math.round(ivrRaw)));

            // Expected move from realized vol scaled to T-day horizon
            const horizonDays = Math.max(1, Math.abs(daysUntil) || 1);
            const expectedMove = rv20 * 100 * Math.sqrt(horizonDays / 365);

            // ---- Prior earnings reactions: T-1 → T+1 close-to-close move ----
            const priorMoves: number[] = [];
            const priorMovesSigned: number[] = [];
            for (const h of history.slice(0, 6)) {
              const hd = new Date(h.date).getTime();
              const barIdx = bars.findIndex((b) => Math.abs(b.t - hd) < 3 * 86400000);
              if (barIdx > 0 && barIdx < bars.length - 1) {
                const pre = bars[barIdx - 1].c;
                const post = bars[barIdx + 1].c;
                if (pre > 0) {
                  const signed = ((post - pre) / pre) * 100;
                  priorMoves.push(Math.abs(signed));
                  priorMovesSigned.push(signed);
                }
              }
            }
            const avgPriorMove = priorMoves.length > 0 ? avg(priorMoves) : null;
            const moveRatio = (avgPriorMove !== null && expectedMove > 0)
              ? avgPriorMove / expectedMove
              : null;

            // ---- Pre-print drift signal (5d, 20d trend into earnings) ----
            const last5 = bars.slice(-6);
            const last20 = bars.slice(-21);
            const drift5 = last5.length >= 6 && last5[0].c > 0
              ? ((last5.at(-1)!.c - last5[0].c) / last5[0].c) * 100 : 0;
            const drift20 = last20.length >= 21 && last20[0].c > 0
              ? ((last20.at(-1)!.c - last20[0].c) / last20[0].c) * 100 : 0;

            // ---- Volume on most-recent bar vs 20d avg (post-print continuation signal) ----
            const recentVol = bars.slice(-5).reduce((a, b) => a + (b.v || 0), 0) / 5;
            const avg20Vol = bars.slice(-25, -5).reduce((a, b) => a + (b.v || 0), 0) / 20;
            const volRatio = avg20Vol > 0 ? recentVol / avg20Vol : 1;

            // ---- Categorize the play ----
            const driftSignals: string[] = [];
            let driftLean: 'long' | 'short' | 'mixed' = 'mixed';
            if (drift20 > 5 && drift5 > 2) {
              driftSignals.push(`20d +${drift20.toFixed(1)}%`, `5d +${drift5.toFixed(1)}%`);
              driftLean = 'long';
            } else if (drift20 < -5 && drift5 < -2) {
              driftSignals.push(`20d ${drift20.toFixed(1)}%`, `5d ${drift5.toFixed(1)}%`);
              driftLean = 'short';
            }

            let playType: EarningsPlayType = 'skip';
            let bias: EarningsSetup['bias'] = 'neutral';
            let strategy = 'Wait';

            if (postPrint) {
              // PEAD / reversal: needs surprise data + recent volume + recent move
              const surprise = (history[0]?.surprisePct ?? null);
              const lastMove = priorMovesSigned[0] ?? null;
              if (surprise !== null && lastMove !== null && volRatio > 1.3) {
                if (surprise > 5 && lastMove > 3) {
                  playType = 'pead_long';
                  bias = 'buy_premium';
                  strategy = 'PEAD Long (continuation)';
                } else if (surprise < -5 && lastMove < -3) {
                  playType = 'pead_short';
                  bias = 'buy_premium';
                  strategy = 'PEAD Short (continuation)';
                } else if (Math.abs(lastMove) > 5 && volRatio > 1.5 && Math.sign(lastMove) !== Math.sign(surprise)) {
                  playType = 'reversal';
                  bias = 'buy_premium';
                  strategy = 'Earnings Reversal (gap-and-fade)';
                }
              }
            } else {
              // Pre-print categorization
              const ivLow = ivr <= 35;
              const ivRich = ivr >= 65;
              const movesBig = (avgPriorMove ?? 0) > expectedMove * 1.15;
              const movesContained = avgPriorMove !== null && avgPriorMove < expectedMove * 0.85;

              if (ivLow && movesBig) {
                playType = 'long_volatility';
                bias = 'buy_premium';
                strategy = 'Long Straddle (IV cheap, history of big moves)';
              } else if (ivRich && movesContained) {
                playType = 'short_volatility';
                bias = 'sell_premium';
                strategy = 'Iron Condor (IV rich, history of contained moves)';
              } else if (driftLean === 'long' && drift20 > 8) {
                playType = 'directional_long';
                bias = 'buy_premium';
                strategy = 'Directional Long (pre-earnings drift)';
              } else if (driftLean === 'short' && drift20 < -8) {
                playType = 'directional_short';
                bias = 'buy_premium';
                strategy = 'Directional Short (pre-earnings weakness)';
              } else {
                playType = 'skip';
                bias = 'neutral';
                strategy = 'Skip the event (mixed data)';
              }
            }

            // ---- Composite score ----
            let composite = 50;
            if (playType === 'short_volatility') composite = 75 + Math.min(15, Math.round((ivr - 65) / 2));
            else if (playType === 'long_volatility') composite = 75 + Math.min(15, Math.round((35 - ivr) / 2));
            else if (playType === 'directional_long' || playType === 'directional_short') {
              composite = 65 + Math.min(20, Math.round(Math.abs(drift20) / 2));
            }
            else if (playType === 'pead_long' || playType === 'pead_short') {
              composite = 70 + Math.min(20, Math.round(Math.abs(history[0]?.surprisePct ?? 0)));
            }
            else if (playType === 'reversal') composite = 65;
            else composite = 35; // skip

            if (Math.abs(daysUntil) <= 1 && !postPrint) composite -= 5;
            composite = Math.max(0, Math.min(100, composite));

            // ---- Triggers, stops, targets ----
            const triggers = computeTriggers(playType, latest.c, expectedMove, bars);

            // ---- Historical edge ----
            const historicalEdge = computeHistoricalEdge(playType, history, priorMovesSigned);

            // ---- Rationale ----
            const rationale = buildRationale({
              playType, ivr, expectedMove, avgPriorMove, daysUntil,
              drift20, surprise: history[0]?.surprisePct ?? null,
            });

            const setup: EarningsSetup = {
              ticker: e.ticker,
              price: +latest.c.toFixed(2),
              reportDate: e.date,
              reportTime: (e.hour as any) ?? 'dmh',
              daysUntil,
              bias,
              strategy,
              composite,
              ivr,
              expectedMove: +expectedMove.toFixed(2),
              avgPriorMove: avgPriorMove !== null ? +avgPriorMove.toFixed(2) : null,
              rationale,
              playType,
              moveRatio: moveRatio !== null ? +moveRatio.toFixed(2) : null,
              triggers,
              historicalEdge,
              prePrintDrift: !postPrint && driftLean !== 'mixed' ? {
                signalCount: driftSignals.length,
                lean: driftLean,
                details: driftSignals,
              } : undefined,
              postPrint,
            };
            return setup;
          } catch {
            return null;
          }
        }),
      );
      for (const s of batch) if (s) setups.push(s);
    }

    // Filter: composite >= 55 AND not 'skip' (skip is shown only as info, not actionable)
    const filtered = setups
      .filter((s) => s.composite >= 55 && s.playType !== 'skip')
      .sort((a, b) => b.composite - a.composite);

    const response: EarningsBoardResponse = {
      setups: filtered,
      universeChecked: inUniverse.length,
      windowDays,
      generatedAt: new Date().toISOString(),
      cached: false,
    };

    // CRITICAL: only cache when non-empty (v0.7.18/v0.7.19 cache-poisoning fix pattern)
    if (filtered.length > 0) {
      resultCache.set(windowDays, { data: response, at: Date.now() });
    }

    return json(200, response);
  } catch (err: any) {
    return json(500, { error: String(err?.message ?? err) });
  }
};

// ====================================================================
// Helpers
// ====================================================================

function computeTriggers(
  playType: EarningsPlayType,
  price: number,
  expectedMove: number,
  bars: { o: number; h: number; l: number; c: number; t: number; v?: number }[],
): PlayTriggers {
  const last20 = bars.slice(-20);
  const high20 = last20.length ? Math.max(...last20.map((b) => b.h)) : price;
  const low20 = last20.length ? Math.min(...last20.map((b) => b.l)) : price;
  const emPct = expectedMove / 100;

  let entry = 'See strategy notes';
  let stop: number | null = null;
  let t1: number | null = null;
  let t2: number | null = null;
  let t3: number | null = null;
  let positionSizePct = 0.5;

  switch (playType) {
    case 'long_volatility': {
      entry = `Buy ATM straddle 1-3d before print`;
      stop = +(price * (1 - emPct * 0.6)).toFixed(2);
      t1 = +(price * (1 + emPct * 1.2)).toFixed(2);
      t2 = +(price * (1 + emPct * 1.6)).toFixed(2);
      t3 = +(price * (1 + emPct * 2.0)).toFixed(2);
      positionSizePct = 0.5;
      break;
    }
    case 'short_volatility': {
      entry = `Sell iron condor wings at \u00b1${(emPct * 1.2 * 100).toFixed(0)}% strikes, 1d before print`;
      stop = +(price * (1 + emPct * 1.5)).toFixed(2);
      t1 = +(price * (1 - emPct * 0.3)).toFixed(2);
      t2 = price;
      t3 = +(price * (1 + emPct * 0.3)).toFixed(2);
      positionSizePct = 0.5;
      break;
    }
    case 'directional_long': {
      entry = `Buy on close above $${high20.toFixed(2)} (20d high) on volume`;
      stop = +(low20 * 1.005).toFixed(2);
      t1 = +(price * 1.05).toFixed(2);
      t2 = +(price * 1.10).toFixed(2);
      t3 = +(price * 1.18).toFixed(2);
      positionSizePct = 1.0;
      break;
    }
    case 'directional_short': {
      entry = `Short on close below $${low20.toFixed(2)} (20d low) on volume`;
      stop = +(high20 * 0.995).toFixed(2);
      t1 = +(price * 0.95).toFixed(2);
      t2 = +(price * 0.90).toFixed(2);
      t3 = +(price * 0.82).toFixed(2);
      positionSizePct = 1.0;
      break;
    }
    case 'pead_long': {
      entry = `Buy on pullback to post-print breakout level, hold 30-60d`;
      stop = +(price * 0.94).toFixed(2);
      t1 = +(price * 1.06).toFixed(2);
      t2 = +(price * 1.12).toFixed(2);
      t3 = +(price * 1.20).toFixed(2);
      positionSizePct = 1.0;
      break;
    }
    case 'pead_short': {
      entry = `Short on bounce to post-print breakdown level, hold 30-60d`;
      stop = +(price * 1.06).toFixed(2);
      t1 = +(price * 0.94).toFixed(2);
      t2 = +(price * 0.88).toFixed(2);
      t3 = +(price * 0.80).toFixed(2);
      positionSizePct = 1.0;
      break;
    }
    case 'reversal': {
      entry = `Fade the gap on day 2-3 reversal candle, hold 5-10d`;
      stop = +(price * 1.04).toFixed(2);
      t1 = +(price * 0.97).toFixed(2);
      t2 = +(price * 0.94).toFixed(2);
      t3 = +(price * 0.90).toFixed(2);
      positionSizePct = 0.5;
      break;
    }
    default: {
      entry = 'No actionable setup';
      positionSizePct = 0;
    }
  }

  let riskReward: number | null = null;
  if (stop !== null && t1 !== null && stop !== price) {
    const reward = Math.abs(t1 - price);
    const risk = Math.abs(price - stop);
    riskReward = risk > 0 ? +(reward / risk).toFixed(2) : null;
  }

  return { entry, stop, targets: { t1, t2, t3 }, riskReward, positionSizePct };
}

function computeHistoricalEdge(
  playType: EarningsPlayType,
  history: { date: string; surprisePct?: number }[],
  priorMovesSigned: number[],
): HistoricalEdge | null {
  if (history.length < 3 || priorMovesSigned.length < 3) return null;
  const total = priorMovesSigned.length;
  let hits = 0;
  let description = '';

  switch (playType) {
    case 'long_volatility':
      hits = priorMovesSigned.filter((m) => Math.abs(m) > 5).length;
      description = `${hits}/${total} prior prints moved >5% in either direction`;
      break;
    case 'short_volatility':
      hits = priorMovesSigned.filter((m) => Math.abs(m) < 5).length;
      description = `${hits}/${total} prior prints stayed within 5% (premium kept)`;
      break;
    case 'directional_long':
    case 'pead_long':
      hits = priorMovesSigned.filter((m) => m > 2).length;
      description = `${hits}/${total} prior prints closed +2% or more`;
      break;
    case 'directional_short':
    case 'pead_short':
      hits = priorMovesSigned.filter((m) => m < -2).length;
      description = `${hits}/${total} prior prints closed -2% or worse`;
      break;
    case 'reversal':
      hits = priorMovesSigned.filter((m) => Math.abs(m) > 3).length;
      description = `${hits}/${total} prior prints had >3% gap (reversal candidates)`;
      break;
    default:
      return null;
  }

  return {
    hits,
    total,
    ratePct: total > 0 ? Math.round((hits / total) * 100) : 0,
    description,
  };
}

function buildRationale(input: {
  playType: EarningsPlayType;
  ivr: number;
  expectedMove: number;
  avgPriorMove: number | null;
  daysUntil: number;
  drift20: number;
  surprise: number | null;
}): string {
  const { playType, ivr, expectedMove, avgPriorMove, daysUntil, drift20, surprise } = input;
  const em = `\u00b1${expectedMove.toFixed(1)}%`;
  const apm = avgPriorMove !== null ? `${avgPriorMove.toFixed(1)}%` : 'unknown';
  const when = daysUntil < 0
    ? `reported ${Math.abs(daysUntil)}d ago`
    : daysUntil === 0 ? 'reports today' : `${daysUntil}d to print`;

  switch (playType) {
    case 'long_volatility':
      return `IV cheap (${ivr}), expected ${em} but history avg ${apm} \u2192 premium underprices reality. ${when}.`;
    case 'short_volatility':
      return `IV rich (${ivr}), expected ${em} but history avg ${apm} \u2192 premium overprices reality. ${when}.`;
    case 'directional_long':
      return `Pre-earnings drift +${drift20.toFixed(1)}% over 20d, momentum into print. IV ${ivr}, ${when}.`;
    case 'directional_short':
      return `Pre-earnings weakness ${drift20.toFixed(1)}% over 20d, breakdown setup. IV ${ivr}, ${when}.`;
    case 'pead_long':
      return `Beat by ${surprise?.toFixed(1)}%, post-print continuation likely. ${when}.`;
    case 'pead_short':
      return `Miss by ${surprise?.toFixed(1)}%, post-print weakness likely. ${when}.`;
    case 'reversal':
      return `Gap-and-fade pattern: surprise vs reaction divergence. ${when}.`;
    default:
      return `Mixed data, no clear edge. ${when}.`;
  }
}

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
function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' },
    body: JSON.stringify(body),
  };
}
