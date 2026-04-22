// Per-ticker research brief. Claude reads available context (board data, recent news if provided)
// and returns a structured JSON brief that renders in the ticker detail modal.
//
// Endpoint: GET /api/research?ticker=X
//           POST /api/research { ticker, context? }

import type { Handler } from '@netlify/functions';
import { callClaude, MODELS } from './shared/claude';
import { blobGet } from './shared/blobs';
import type { TargetBoard } from './shared/types';

const SYSTEM_PROMPT = `You are an equity analyst writing a concise research brief.

Structure:
- Current thesis (bull case, 2-3 sentences)
- Current counter (bear case, 2-3 sentences)
- What you'd watch (2-4 specific things: levels, events, data points)
- Tactical setup (how to trade it if you were to trade it)

Be specific, not generic. Cite actual numbers and levels when available.

OUTPUT FORMAT — JSON only:
{
  "ticker": string,
  "thesis": string,
  "counter": string,
  "watchFor": string[],
  "tacticalSetup": string,
  "confidence": "high" | "medium" | "low"
}`;

export const handler: Handler = async (event) => {
  const ticker =
    event.queryStringParameters?.ticker ?? (event.body ? JSON.parse(event.body).ticker : null);

  if (!ticker || typeof ticker !== 'string') {
    return json(400, { error: 'ticker required' });
  }

  // Pull today's board for context
  const today = new Date().toISOString().slice(0, 10);
  const board = await blobGet<TargetBoard>('targetboard', today);
  const candidate = board?.candidates.find((c) => c.ticker === ticker.toUpperCase());

  const context = candidate
    ? `Board context for ${ticker}: side=${candidate.side}, tier=${candidate.tier}, composite=${candidate.composite}, conflict=${candidate.conflictLevel}, analysts=${JSON.stringify(candidate.analystScores)}`
    : `No board context for ${ticker}.`;

  const userMsg = `Write a research brief for ${ticker.toUpperCase()}.\n\n${context}\n\nRegime: ${board?.regime.regime ?? 'unknown'}.`;

  try {
    const result = await callClaude({
      model: MODELS.SONNET,
      system: SYSTEM_PROMPT,
      user: userMsg,
      maxTokens: 1200,
      temperature: 0.3,
      expectJson: true,
    });
    return json(200, {
      ...(result.content as unknown as object),
      tokensUsed: result.inputTokens + result.outputTokens,
      modelUsed: result.model,
    });
  } catch (err: any) {
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
