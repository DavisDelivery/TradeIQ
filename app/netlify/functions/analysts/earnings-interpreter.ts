// Earnings interpreter — Claude reads earnings call transcripts and extracts structured signals.
//
// Most quant systems fail on earnings because they only see the beat/miss numbers and
// guidance deltas. The actual alpha is in HOW management communicates — hedging, tone shifts,
// analyst pushback, concrete product/customer details, or lack thereof.
//
// Endpoint: POST /api/earnings-interpreter
// Body:    { ticker, transcript, eps: { actual, estimate }, revenue: { actual, estimate }, guidance?: {...} }
// Returns: structured interpretation with per-theme sentiment scores
//
// Uses Sonnet 4.6 (balance of cost and reasoning quality on long transcripts).

import type { Handler } from '@netlify/functions';
import { callClaude, MODELS } from '../shared/claude';

const SYSTEM_PROMPT = `You are an earnings call analyst with a decade of buy-side experience. You read transcripts for signals the headline numbers miss.

You look for:
- TONE: confident vs hedging, improving vs deteriorating vs Q/Q
- SPECIFICITY: concrete customer wins/losses, named products, hard numbers vs vague language
- ANALYST PUSHBACK: did analysts seem satisfied or did they ask the same question 3 ways?
- GUIDANCE QUALITY: bracketed range vs point, explicit assumptions vs "macro-dependent" hand-waving
- CAPITAL ALLOCATION: buybacks, dividend, M&A posture — especially posture shifts
- UNSPOKEN: what should have been addressed and wasn't?

You are skeptical of prepared remarks and more trusting of Q&A. The most important minute of any call is the worst analyst question and management's response to it.

OUTPUT FORMAT — JSON only:
{
  "overallSignal": number,        // -100 to +100
  "confidence": number,            // 0-1
  "themes": [
    {
      "name": "e.g. 'Data Center demand', 'Margin trajectory'",
      "sentiment": number,          // -100 to +100
      "evidence": "1-2 sentence quote-paraphrase or observation"
    }
  ],
  "tonalShifts": "observations about tone changes vs prior calls (or null if no prior context)",
  "analystPushback": "what analysts pushed on and how management handled it",
  "redFlags": string[],            // specific concerns (empty array if none)
  "greenFlags": string[],
  "tradingImplication": "2-3 sentence actionable takeaway for a 1-3 month holding horizon"
}`;

interface EarningsRequest {
  ticker: string;
  transcript: string;
  eps?: { actual: number; estimate: number };
  revenue?: { actual: number; estimate: number };
  guidance?: {
    revenueLow?: number;
    revenueHigh?: number;
    epsLow?: number;
    epsHigh?: number;
  };
  priorCallSummary?: string; // optional context
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST.' });
  }

  let body: EarningsRequest;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  if (!body.ticker || !body.transcript || body.transcript.length < 500) {
    return json(400, { error: 'ticker and transcript (min 500 chars) required' });
  }

  // Cap transcript at ~40k chars to control token cost. Typical calls ~25-35k.
  const transcript = body.transcript.slice(0, 40_000);

  const numbers = [
    body.eps
      ? `EPS: $${body.eps.actual} actual vs $${body.eps.estimate} est (${delta(body.eps.actual, body.eps.estimate)})`
      : null,
    body.revenue
      ? `Revenue: $${body.revenue.actual}M vs $${body.revenue.estimate}M est (${delta(body.revenue.actual, body.revenue.estimate)})`
      : null,
    body.guidance
      ? `Guidance: rev $${body.guidance.revenueLow}-${body.guidance.revenueHigh}M, eps $${body.guidance.epsLow}-${body.guidance.epsHigh}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const userMsg = `${body.ticker} earnings call.

${numbers || '(headline numbers not provided)'}

${body.priorCallSummary ? `Prior call summary:\n${body.priorCallSummary}\n\n` : ''}TRANSCRIPT:
"""
${transcript}
"""

Interpret.`;

  try {
    const result = await callClaude({
      model: MODELS.SONNET,
      system: SYSTEM_PROMPT,
      user: userMsg,
      maxTokens: 2000,
      temperature: 0.2,
      expectJson: true,
    });

    return json(200, {
      ticker: body.ticker,
      interpretation: result.content,
      tokensUsed: result.inputTokens + result.outputTokens,
      modelUsed: result.model,
      latencyMs: result.latencyMs,
    });
  } catch (err: any) {
    console.error('earnings-interpreter failed', err);
    return json(500, { error: String(err?.message ?? err) });
  }
};

function delta(actual: number, est: number): string {
  const diff = actual - est;
  const pct = est !== 0 ? (diff / Math.abs(est)) * 100 : 0;
  const sign = diff >= 0 ? '+' : '';
  return `${sign}${diff.toFixed(2)}, ${sign}${pct.toFixed(1)}%`;
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
