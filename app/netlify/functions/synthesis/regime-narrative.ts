// Regime narrative — Claude writes a daily macro context narrative.
//
// The existing system uses a hardcoded rule (VIX < 15 + 10Y stable = RISK_ON) which is
// mechanically correct but misses regime TRANSITIONS and market internals. This endpoint
// feeds Claude the current macro state plus relevant news and gets a narrative + a refined
// regime classification that can override the mechanical rule in borderline cases.
//
// Endpoint: POST /api/regime-narrative
// Body:    { vix, yield10y, spread2s10s, recentNewsHeadlines?: string[], mechanicalRegime?: string }
// Returns: { regime, narrative, keyRisks, watchPoints, confidence }
//
// Result is persisted in 'regime-narrative' blob store keyed by YYYY-MM-DD.

import type { Handler } from '@netlify/functions';
import { callClaude, MODELS } from '../shared/claude';
import { blobSet, todayKey } from '../shared/blobs';

const SYSTEM_PROMPT = `You are a macro strategist. Given current market internals and recent news, you produce a compact narrative for the trading desk.

You are NOT writing for retail. Assume the reader knows what VIX, 2s10s, and term premium mean. Write dense, specific, actionable.

You weight market INTERNALS (yield curve, vol, credit) more heavily than news headlines — news is often noise, internals are hard signal. But persistent narrative shifts in news can lead internals by days.

Regime classification rules (your call can override borderline mechanical inputs):
- risk_on: vol compressed, curve stable/steepening, credit tight, no major event risk in 2 weeks
- risk_off: vol elevated or rising fast, credit widening, curve inverting or flight-to-quality bid
- neutral: mixed signals, transition zone, or major binary event within 2 weeks

OUTPUT FORMAT — JSON only:
{
  "regime": "risk_on" | "risk_off" | "neutral",
  "confidence": number,             // 0-1
  "narrative": "3-5 sentences of dense market context",
  "keyRisks": string[],             // 2-4 specific risks with concrete triggers
  "watchPoints": string[],          // 2-4 things to watch tomorrow (specific levels or events)
  "sectorBias": {                   // what sectors you'd lean into/avoid in this regime
    "favor": string[],
    "avoid": string[]
  },
  "disagreesWithMechanical": boolean,  // true if your regime differs from the rule-based input
  "disagreementReason": string | null
}`;

interface RegimeRequest {
  vix: number;
  yield10y: number;
  spread2s10s: number;
  mechanicalRegime?: 'risk_on' | 'risk_off' | 'neutral';
  recentNewsHeadlines?: string[];
  priorDayRegime?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST.' });
  }

  let body: RegimeRequest;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  if (
    typeof body.vix !== 'number' ||
    typeof body.yield10y !== 'number' ||
    typeof body.spread2s10s !== 'number'
  ) {
    return json(400, { error: 'vix, yield10y, spread2s10s (numbers) required' });
  }

  const userMsg = `Current macro state (US):
- VIX: ${body.vix}
- 10Y yield: ${body.yield10y}%
- 2s10s: ${body.spread2s10s}bp${body.spread2s10s < 0 ? ' (INVERTED)' : ''}
- Mechanical rule says: ${body.mechanicalRegime ?? 'not computed'}
- Prior day regime: ${body.priorDayRegime ?? 'unknown'}

${
  body.recentNewsHeadlines && body.recentNewsHeadlines.length
    ? `Recent headlines (last 24h):\n${body.recentNewsHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : '(no news headlines provided)'
}

Produce the narrative.`;

  try {
    const result = await callClaude({
      model: MODELS.SONNET,
      system: SYSTEM_PROMPT,
      user: userMsg,
      maxTokens: 1200,
      temperature: 0.3,
      expectJson: true,
    });

    const payload = {
      ...(result.content as unknown as object),
      updatedAt: new Date().toISOString(),
      inputs: {
        vix: body.vix,
        yield10y: body.yield10y,
        spread2s10s: body.spread2s10s,
        mechanicalRegime: body.mechanicalRegime ?? null,
      },
      tokensUsed: result.inputTokens + result.outputTokens,
      modelUsed: result.model,
    };

    // Persist today's narrative
    await blobSet('regime-narrative', todayKey(), payload);

    return json(200, payload);
  } catch (err: any) {
    console.error('regime-narrative failed', err);
    return json(500, { error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
