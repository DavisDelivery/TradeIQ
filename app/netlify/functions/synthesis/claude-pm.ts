// Claude-as-PM — the flagship AI upgrade.
//
// Given a full target board (all ranked candidates + analyst scores + macro regime),
// Claude acts as a senior portfolio manager and picks the 3-7 positions to actually trade.
// Unlike the mechanical ranker, Claude reasons about:
//   - Cross-position correlation and sector concentration
//   - Regime-appropriate net/gross exposure
//   - Analyst signal quality and conviction, not just composite score
//   - Asymmetric risk/reward (avoids positions with vague upside or known catalysts against)
//   - Invalidation levels so positions can be cut cleanly
//
// Endpoint: POST /api/claude-pm
// Body:    { board: TargetBoard, options?: { maxPositions?: number; model?: ClaudeModel } }
// Returns: PMDecision
//
// Model: defaults to Opus 4.7 (highest quality). Haiku/Sonnet fallbacks via options.
// Persistence: writes result to blob store 'pm-decisions' keyed by YYYY-MM-DD.

import type { Handler } from '@netlify/functions';
import { callClaude, MODELS, type ClaudeModel } from '../shared/claude';
import { blobSet, todayKey } from '../shared/blobs';
import type { PMDecision, PMSelection, TargetBoard } from '../shared/types';

const SYSTEM_PROMPT = `You are a senior portfolio manager at a disciplined long/short equity fund.

Your job is to construct a concentrated portfolio from ranked trade candidates. You are NOT a ranker — the quantitative model already ranked. You are a judgment layer that applies portfolio construction discipline.

YOUR MINDSET:
- Capital preservation first. A -20% drawdown takes +25% to recover. Every position must have a clean invalidation level.
- Concentration over diversification for conviction trades. 4-6 great positions beat 15 mediocre ones.
- Respect correlation. Three semiconductor longs is one semiconductor bet, not three.
- Respect the regime. In RISK OFF, reduce gross exposure and prefer quality. In RISK ON, press winners.
- Skepticism about consensus. If every analyst screams the same thing, the edge is usually already priced in.
- Kill shorts with weak conviction. Short-side alpha is historically negative in this book (-3%); only short on high-conviction setups with clear catalysts.

HARD CONSTRAINTS:
- Select 3 to 7 positions total (not more, not fewer).
- Max 40% gross exposure in any single sector.
- Max 25% in any single position for high-conviction, 15% medium, 10% low.
- Net exposure bounds by regime: RISK ON 40-80%, NEUTRAL 20-50%, RISK OFF -20% to +20%.
- Every position MUST have a specific invalidation (price level or named event).
- Reject any candidate where the thesis depends on "multiple expansion" or "sentiment improvement" without a catalyst.

INPUT FORMAT:
You will receive a JSON target board with:
- regime: macro state (risk_on | risk_off | neutral), VIX, 10Y yield, 2s10s spread
- candidates: array of ranked tickers with composite score (0-100), tier (A/B/C), side (long/short), analyst-level scores and rationales, and conflictLevel

OUTPUT FORMAT:
Respond with ONLY valid JSON matching this schema. No preamble, no markdown.

{
  "selections": [
    {
      "ticker": "string",
      "side": "long" | "short",
      "conviction": "high" | "medium" | "low",
      "positionSizePct": number,
      "thesis": "2-4 sentence trade thesis — why this, why now, what's the edge",
      "risks": "1-2 sentence primary risks",
      "invalidation": "specific price level or event that kills the thesis (e.g. 'close below $85' or 'miss earnings 2026-05-06')"
    }
  ],
  "passes": [
    { "ticker": "string", "reason": "1 sentence why rejected despite good composite score" }
  ],
  "portfolioNotes": "2-4 sentences on overall construction — sector balance, correlation, regime appropriateness, what you're NOT doing and why",
  "grossExposurePct": number,
  "netExposurePct": number
}

Position sizes must sum to gross exposure. Longs - shorts = net exposure. Be numerically consistent.`;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST.' });
  }

  let body: { board?: TargetBoard; options?: { maxPositions?: number; model?: ClaudeModel } };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const board = body.board;
  if (!board || !Array.isArray(board.candidates) || board.candidates.length === 0) {
    return json(400, { error: 'body.board.candidates[] is required and non-empty' });
  }

  const model = body.options?.model ?? MODELS.OPUS;
  const maxPositions = Math.min(Math.max(body.options?.maxPositions ?? 7, 3), 10);

  // Construct the user message — keep it compact but information-rich.
  const userMsg = buildUserMessage(board, maxPositions);

  try {
    const result = await callClaude<Omit<PMDecision, 'date' | 'regime' | 'tokensUsed' | 'modelUsed'>>(
      {
        model,
        system: SYSTEM_PROMPT,
        user: userMsg,
        maxTokens: 3000,
        temperature: 0.2,
        expectJson: true,
      },
    );

    // Validate Claude's output structurally
    const err = validateDecision(result.content);
    if (err) {
      return json(502, {
        error: `Claude returned malformed decision: ${err}`,
        raw: result.raw.slice(0, 500),
      });
    }

    const decision: PMDecision = {
      date: todayKey(),
      regime: board.regime.regime,
      selections: result.content.selections as PMSelection[],
      passes: result.content.passes ?? [],
      portfolioNotes: result.content.portfolioNotes ?? '',
      grossExposurePct: result.content.grossExposurePct ?? 0,
      netExposurePct: result.content.netExposurePct ?? 0,
      tokensUsed: result.inputTokens + result.outputTokens,
      modelUsed: result.model,
    };

    // Persist
    await blobSet('pm-decisions', decision.date, decision);

    return json(200, decision);
  } catch (err: any) {
    console.error('claude-pm failed', err);
    return json(500, { error: String(err?.message ?? err) });
  }
};

function buildUserMessage(board: TargetBoard, maxPositions: number): string {
  // Compact candidate summary — we trim analyst signals to the most informative fields
  // to keep token cost manageable even with 20+ candidates.
  const compact = board.candidates.map((c) => ({
    ticker: c.ticker,
    price: c.price,
    pct: c.changePct,
    side: c.side,
    tier: c.tier,
    composite: c.composite,
    conflict: c.conflictLevel,
    sector: c.sector,
    blurb: c.blurb,
    analysts: c.analystScores.map((a) => ({
      name: a.analyst,
      score: a.score,
      confidence: a.confidence,
      why: a.rationale,
    })),
  }));

  return `Today's target board (${board.generatedAt}):

REGIME: ${board.regime.regime} | VIX ${board.regime.vix} | 10Y ${board.regime.yield10y}% | 2s10s ${board.regime.spread2s10s}bp${
    board.regime.narrative ? `\nMacro narrative: ${board.regime.narrative}` : ''
  }

CANDIDATES (${board.candidates.length} ranked, top 20 shown):
${JSON.stringify(compact.slice(0, 20), null, 2)}

Construct a concentrated portfolio of up to ${maxPositions} positions. Respect all hard constraints. Apply your judgment — you are NOT obligated to use every A-tier name, and you MAY skip the top-ranked if correlation or setup quality is poor.`;
}

function validateDecision(d: any): string | null {
  if (!d || typeof d !== 'object') return 'not an object';
  if (!Array.isArray(d.selections)) return 'selections not array';
  if (d.selections.length < 1) return 'must have at least 1 selection';
  if (d.selections.length > 10) return 'too many selections (>10)';
  for (const s of d.selections) {
    if (typeof s.ticker !== 'string') return 'selection.ticker invalid';
    if (!['long', 'short'].includes(s.side)) return 'selection.side invalid';
    if (!['high', 'medium', 'low'].includes(s.conviction)) return 'selection.conviction invalid';
    if (typeof s.positionSizePct !== 'number') return 'selection.positionSizePct not number';
    if (typeof s.thesis !== 'string' || s.thesis.length < 20) return 'selection.thesis too short';
    if (typeof s.invalidation !== 'string' || s.invalidation.length < 5)
      return 'selection.invalidation too short';
  }
  return null;
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
