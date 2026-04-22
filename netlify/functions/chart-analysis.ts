// GET /api/chart-analysis?ticker=NVDA&lookback=180
// Returns OHLCV bars, computed indicators (SMA20/50/200, RSI14, MACD 12/26/9),
// detected technical setups, and a Claude-generated narrative signal.

import type { Handler } from '@netlify/functions';
import { getDailyBars } from './shared/data-provider';
import { detectSetups, scoreSetups } from './shared/technical-setups';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const headers = { 'Content-Type': 'application/json' };
const json = (code: number, body: unknown) => ({
  statusCode: code,
  headers,
  body: JSON.stringify(body),
});

// Simple in-memory cache (TTL 10 min)
const cache = new Map<string, { data: any; at: number }>();
const TTL_MS = 10 * 60 * 1000;

function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? +(sum / period).toFixed(4) : null);
  }
  return out;
}

function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let emaPrev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (emaPrev === null) {
      const seed = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
      emaPrev = seed;
      out.push(+seed.toFixed(4));
      continue;
    }
    emaPrev = values[i] * k + emaPrev * (1 - k);
    out.push(+emaPrev.toFixed(4));
  }
  return out;
}

function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = [];
  if (closes.length < period + 1) return closes.map(() => null);
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg >= 0) gainSum += chg;
    else lossSum -= chg;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      out.push(null);
      continue;
    }
    if (i > period) {
      const chg = closes[i] - closes[i - 1];
      const gain = chg >= 0 ? chg : 0;
      const loss = chg < 0 ? -chg : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const val = 100 - 100 / (1 + rs);
    out.push(+val.toFixed(2));
  }
  return out;
}

function macd(closes: number[]): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => {
    const a = ema12[i];
    const b = ema26[i];
    return a !== null && b !== null ? +(a - b).toFixed(4) : null;
  });
  // Signal = EMA9 of macdLine (only where macdLine has value)
  const firstIdx = macdLine.findIndex((x) => x !== null);
  const signalLine: (number | null)[] = closes.map(() => null);
  if (firstIdx >= 0) {
    const vals = macdLine.slice(firstIdx).map((v) => v as number);
    const sig9 = ema(vals, 9);
    for (let i = 0; i < sig9.length; i++) signalLine[firstIdx + i] = sig9[i];
  }
  const hist = closes.map((_, i) => {
    const m = macdLine[i];
    const s = signalLine[i];
    return m !== null && s !== null ? +(m - s).toFixed(4) : null;
  });
  return { macd: macdLine, signal: signalLine, hist };
}

export const handler: Handler = async (event) => {
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase().trim();
  const lookback = parseInt(event.queryStringParameters?.lookback ?? '180', 10);
  const skipAi = event.queryStringParameters?.skipAi === '1';
  if (!ticker) return json(400, { ok: false, error: 'ticker required' });

  const cacheKey = `${ticker}:${lookback}:${skipAi ? 'noai' : 'ai'}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return json(200, { ...hit.data, cached: true });

  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - lookback * 86400000).toISOString().slice(0, 10);
    const bars = await getDailyBars(ticker, from, to);
    if (bars.length < 30) {
      return json(200, { ok: false, error: `insufficient data for ${ticker} (${bars.length} bars)` });
    }

    const closes = bars.map((b) => b.c);
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const rsi14 = rsi(closes, 14);
    const { macd: macdLine, signal: macdSignal, hist: macdHist } = macd(closes);

    const latest = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const priceChangePct = prev ? +((latest.c - prev.c) / prev.c * 100).toFixed(2) : 0;

    const setups = detectSetups(bars);
    const setupScore = scoreSetups(setups);

    // Derive a rule-based signal
    const longSetups = setups.filter((s) => s.direction === 'long').length;
    const shortSetups = setups.filter((s) => s.direction === 'short').length;
    const rsiNow = rsi14[rsi14.length - 1] ?? 50;
    const macdNow = macdHist[macdHist.length - 1] ?? 0;
    const above50 = sma50[sma50.length - 1] != null && latest.c > (sma50[sma50.length - 1] as number);
    const above200 = sma200[sma200.length - 1] != null && latest.c > (sma200[sma200.length - 1] as number);

    let signal: 'BUY' | 'HOLD' | 'SELL' = 'HOLD';
    let signalConfidence = 0.5;
    const bullPoints: string[] = [];
    const bearPoints: string[] = [];
    if (longSetups >= 2) { bullPoints.push(`${longSetups} long setups active`); }
    if (shortSetups >= 2) { bearPoints.push(`${shortSetups} short setups active`); }
    if (above50 && above200) bullPoints.push('price above 50d + 200d SMA');
    if (!above50 && !above200) bearPoints.push('price below 50d + 200d SMA');
    if (macdNow > 0) bullPoints.push('MACD histogram positive');
    if (macdNow < 0) bearPoints.push('MACD histogram negative');
    if (rsiNow < 30) bullPoints.push(`RSI ${rsiNow.toFixed(0)} oversold`);
    if (rsiNow > 70) bearPoints.push(`RSI ${rsiNow.toFixed(0)} overbought`);

    const bullScore = bullPoints.length;
    const bearScore = bearPoints.length;
    if (bullScore >= 3 && bullScore - bearScore >= 2) { signal = 'BUY'; signalConfidence = Math.min(0.95, 0.5 + bullScore * 0.1); }
    else if (bearScore >= 3 && bearScore - bullScore >= 2) { signal = 'SELL'; signalConfidence = Math.min(0.95, 0.5 + bearScore * 0.1); }

    // AI narrative (Claude Sonnet). Graceful fallback if unavailable.
    let narrative: string | null = null;
    if (!skipAi && process.env.ANTHROPIC_API_KEY) {
      try {
        const last5 = bars.slice(-5).map((b) => `${new Date(b.t).toISOString().slice(0, 10)} O${b.o.toFixed(2)} H${b.h.toFixed(2)} L${b.l.toFixed(2)} C${b.c.toFixed(2)} V${(b.v / 1e6).toFixed(1)}M`).join('\n');
        const setupSummary = setups.length ? setups.map((s) => `• ${s.label} (${s.direction}, strength ${(s.strength * 100).toFixed(0)}%): ${s.rationale}`).join('\n') : '(no setups detected)';
        const indicatorSummary = [
          `Price: $${latest.c.toFixed(2)} (${priceChangePct >= 0 ? '+' : ''}${priceChangePct}%)`,
          `SMA20: ${sma20[sma20.length - 1]?.toFixed(2) ?? 'n/a'}`,
          `SMA50: ${sma50[sma50.length - 1]?.toFixed(2) ?? 'n/a'}`,
          `SMA200: ${sma200[sma200.length - 1]?.toFixed(2) ?? 'n/a'}`,
          `RSI(14): ${rsiNow.toFixed(1)}`,
          `MACD histogram: ${macdNow.toFixed(3)}`,
          `Rule signal: ${signal} (${(signalConfidence * 100).toFixed(0)}% conf)`,
        ].join('\n');
        const user = `Ticker: ${ticker}\n\nIndicator snapshot:\n${indicatorSummary}\n\nDetected setups:\n${setupSummary}\n\nLast 5 bars:\n${last5}\n\nWrite a 3-4 sentence trading view that an experienced discretionary trader would actually use: what the chart is showing, what the edge case is, and a specific invalidation level. No hype, no disclaimers.`;

        const resp = await fetch(ANTHROPIC_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 400,
            temperature: 0.25,
            system: 'You are a veteran swing trader reviewing a chart. Be concise, specific, and give a clear edge-case read. Reference actual price levels. No disclaimers, no "always DYOR", just the read.',
            messages: [{ role: 'user', content: user }],
          }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { content: Array<{ type: string; text?: string }> };
          narrative = data.content.find((b) => b.type === 'text')?.text?.trim() ?? null;
        }
      } catch { /* swallow */ }
    }

    const response = {
      ok: true,
      ticker,
      lookbackDays: lookback,
      generatedAt: new Date().toISOString(),
      price: latest.c,
      priceChangePct,
      bars: bars.map((b, i) => ({
        date: new Date(b.t).toISOString().slice(0, 10),
        o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
        sma20: sma20[i], sma50: sma50[i], sma200: sma200[i],
        rsi: rsi14[i],
        macd: macdLine[i], macdSignal: macdSignal[i], macdHist: macdHist[i],
      })),
      indicators: {
        latest: {
          sma20: sma20[sma20.length - 1],
          sma50: sma50[sma50.length - 1],
          sma200: sma200[sma200.length - 1],
          rsi: rsiNow,
          macd: macdLine[macdLine.length - 1],
          macdSignal: macdSignal[macdSignal.length - 1],
          macdHist: macdNow,
        },
      },
      setups,
      setupScore,
      signal: {
        action: signal,
        confidence: +signalConfidence.toFixed(2),
        bullPoints,
        bearPoints,
      },
      narrative,
    };

    cache.set(cacheKey, { data: response, at: Date.now() });
    return json(200, response);
  } catch (err: any) {
    return json(500, { ok: false, ticker, error: String(err?.message ?? err) });
  }
};
