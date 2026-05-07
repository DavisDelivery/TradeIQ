// GET /api/research?ticker=NVDA&force=1
// Claude Opus reads recent news + price action, returns structured research brief.
// All Anthropic calls go through callAnthropic, which gates on the daily
// spend cap and the per-deployment circuit breaker.

import type { Handler } from '@netlify/functions';
import { getNews, getPreviousClose } from './shared/data-provider';
import type { ResearchResponse, ResearchBrief } from './shared/types';
import {
  callAnthropic,
  AnthropicHttpError,
  BudgetExhaustedError,
  CircuitOpenError,
} from './shared/anthropic-client';

const MODEL = 'claude-opus-4-7';

// In-memory cache; Netlify function instances live ~15-60 min, good enough for this
const cache = new Map<string, { at: number; brief: ResearchBrief; newsCount: number }>();
const TTL_MS = 30 * 60 * 1000; // 30 min

const SYSTEM_PROMPT = `You are an equity analyst writing a concise research brief. Be specific, cite real price levels and dates when present. No hype.

Output ONLY valid JSON matching this schema:
{
  "summary": "2-3 sentences: the net thesis",
  "bull_case": "2-3 sentences",
  "bear_case": "2-3 sentences",
  "key_catalyst": "1 sentence — the specific thing to watch (earnings date, product launch, data point)",
  "confidence": "high" | "medium" | "low",
  "time_horizon": "short (days-weeks) | medium (weeks-months) | long (months-quarters)",
  "citations": ["source 1 headline", "source 2 headline"]
}`;

export const handler: Handler = async (event) => {
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase();
  const force = event.queryStringParameters?.force === '1';
  if (!ticker) return json(400, { ok: false, error: 'ticker required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { ok: false, error: 'ANTHROPIC_API_KEY not set' });

  // Cache hit
  const cached = cache.get(ticker);
  if (cached && !force && Date.now() - cached.at < TTL_MS) {
    const resp: ResearchResponse = {
      ok: true,
      ticker,
      brief: cached.brief,
      cached: true,
      cacheAgeMs: Date.now() - cached.at,
      newsCount: cached.newsCount,
    };
    return json(200, resp);
  }

  try {
    const [news, prev] = await Promise.all([
      getNews(ticker, 15).catch(() => []),
      getPreviousClose(ticker).catch(() => null),
    ]);

    const newsBlock = news.length === 0
      ? '(no recent news)'
      : news.slice(0, 12).map((n, i) => `${i + 1}. [${n.publishedUtc.slice(0, 10)}] ${n.title}${n.description ? ` — ${n.description.slice(0, 200)}` : ''}`).join('\n');

    const priceBlock = prev ? `Current ${ticker}: $${prev.c.toFixed(2)}, day ${((prev.c - prev.o) / prev.o * 100).toFixed(2)}%, volume ${(prev.v / 1e6).toFixed(1)}M.` : `Ticker ${ticker}, recent close unavailable.`;

    const user = `${priceBlock}\n\nRecent news:\n${newsBlock}\n\nWrite the brief.`;

    let data: { content: Array<{ type: string; text?: string }> };
    try {
      data = await callAnthropic({
        model: MODEL,
        max_tokens: 1200,
        temperature: 0.3,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: user }],
      });
    } catch (err: any) {
      if (err instanceof BudgetExhaustedError) {
        return json(503, {
          ok: false,
          ticker,
          error: 'budget_exhausted',
          message: 'AI features paused — daily Anthropic budget reached. Resets at 00:00 UTC.',
        });
      }
      if (err instanceof CircuitOpenError) {
        return json(503, {
          ok: false,
          ticker,
          error: 'circuit_open',
          message: 'AI temporarily unavailable due to upstream errors. Retry shortly.',
          openUntil: new Date(err.openUntil).toISOString(),
        });
      }
      if (err instanceof AnthropicHttpError) {
        return json(500, { ok: false, ticker, error: `Claude API ${err.status}: ${err.bodyText.slice(0, 200)}` });
      }
      throw err;
    }

    const textBlock = data.content.find((b) => b.type === 'text');
    if (!textBlock?.text) return json(500, { ok: false, ticker, error: 'Claude returned no text' });

    const raw = textBlock.text.trim();
    const jsonStart = raw.search(/[\[{]/);
    const cleaned = jsonStart >= 0 ? raw.slice(jsonStart) : raw;
    let brief: ResearchBrief;
    try {
      brief = JSON.parse(cleaned.replace(/```json\s*|\s*```/g, ''));
    } catch {
      return json(500, { ok: false, ticker, error: 'Claude returned non-JSON', raw: raw.slice(0, 300) });
    }

    cache.set(ticker, { at: Date.now(), brief, newsCount: news.length });

    const response: ResearchResponse = {
      ok: true,
      ticker,
      brief,
      cached: false,
      newsCount: news.length,
    };
    return json(200, response);
  } catch (err: any) {
    return json(500, { ok: false, ticker, error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) { return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
