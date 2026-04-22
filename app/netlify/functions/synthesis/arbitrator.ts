// Analyst arbitrator — Claude resolves conflicts when per-ticker analysts disagree.
//
// Use case: technical says +80, fundamental says -60, news says +10. Raw average is wrong
// because it ignores WHY each analyst arrived at their view. Claude reads all six rationales
// and decides which analyst is most likely correct for this specific setup — or concludes
// the signal is genuinely mixed and the candidate should be skipped.
//
// Endpoint: POST /api/arbitrator
// Body:    { ticker: string, analystScores: AnalystScore[], context?: {...} }
// Returns: { arbitratedScore, dominantAnalysts, discountedAnalysts, rationale, recommendation }

import type { Handler } from '@netlify/functions';
import { callClaude, MODELS } from '../shared/claude';
import type { AnalystScore } from '../shared/types';

const SYSTEM_PROMPT = `You are a senior analyst arbitrator. Six specialized analysts produce scores on a single ticker. Your job is to reconcile disagreements.

You do NOT average. You weight analysts based on:
- Regime appropriateness (technical analysts lose edge in regime transitions; fundamental gains edge)
- Signal type vs. holding period (flow signals matter for days, fundamentals for months)
- Conflict source (is disagreement noise, or a genuine timing/thesis mismatch?)
- Analyst confidence — a 0.9-confidence technical signal beats a 0.3-confidence fundamental

Output a final arbitrated score (-100 to +100) and name which analysts DROVE the decision vs which you discounted. Be explicit about why.

If analysts genuinely contradict and the contradiction cannot be resolved with available evidence, return recommendation "skip" — do not paper over real conflicts with a middling score.

OUTPUT FORMAT — valid JSON only:
{
  "arbitratedScore": number,  // -100 to +100
  "confidence": number,        // 0 to 1
  "dominantAnalysts": string[],
  "discountedAnalysts": string[],
  "rationale": "3-5 sentence reasoning — what resolved the conflict",
  "recommendation": "trade" | "skip" | "watch"
}`;

interface ArbitratorRequest {
  ticker: string;
  analystScores: AnalystScore[];
  context?: {
    price?: number;
    sector?: string;
    regime?: string;
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST.' });
  }

  let body: ArbitratorRequest;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  if (!body.ticker || !Array.isArray(body.analystScores) || body.analystScores.length < 2) {
    return json(400, { error: 'ticker and analystScores[] (min 2) required' });
  }

  const userMsg = `Ticker: ${body.ticker}${
    body.context?.sector ? ` (${body.context.sector})` : ''
  }${body.context?.price ? ` @ $${body.context.price}` : ''}
Regime: ${body.context?.regime ?? 'unknown'}

Analyst scores:
${JSON.stringify(body.analystScores, null, 2)}

Arbitrate.`;

  try {
    const result = await callClaude<{
      arbitratedScore: number;
      confidence: number;
      dominantAnalysts: string[];
      discountedAnalysts: string[];
      rationale: string;
      recommendation: 'trade' | 'skip' | 'watch';
    }>({
      model: MODELS.SONNET,
      system: SYSTEM_PROMPT,
      user: userMsg,
      maxTokens: 800,
      temperature: 0.25,
      expectJson: true,
    });

    return json(200, {
      ticker: body.ticker,
      ...result.content,
      tokensUsed: result.inputTokens + result.outputTokens,
      modelUsed: result.model,
    });
  } catch (err: any) {
    console.error('arbitrator failed', err);
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
