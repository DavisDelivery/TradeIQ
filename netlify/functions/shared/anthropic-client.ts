// Thin wrapper around POST https://api.anthropic.com/v1/messages.
//
// Responsibilities:
//   - pre-flight: budget check + circuit-breaker check
//   - make the call (matches the existing fetch shape so call-sites only
//     swap the function name)
//   - post-flight: record actual spend, reset/trip circuit
//
// Call-sites pass the same body they'd pass to fetch; this wrapper adds
// headers and parses the JSON response.

import {
  preflightBudget,
  recordSpend,
  checkCircuit,
  recordCircuitFailure,
  recordCircuitSuccess,
  estimateCostUsd,
  BudgetExhaustedError,
  CircuitOpenError,
} from './anthropic-budget';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

export interface AnthropicMessageBody {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string;
  messages: Array<{ role: string; content: any }>;
  [k: string]: any;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: string; text?: string }>;
  model: string;
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicHttpError extends Error {
  code = 'anthropic_http_error' as const;
  constructor(public status: number, public bodyText: string) {
    super(`Anthropic API ${status}: ${bodyText.slice(0, 200)}`);
  }
}

export { BudgetExhaustedError, CircuitOpenError };

// Cheap heuristic for input tokens: ~4 chars per token. Used only for
// pre-flight estimation; real cost uses response.usage.
function estInputTokens(body: AnthropicMessageBody): number {
  let chars = 0;
  if (body.system) chars += body.system.length;
  for (const m of body.messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part?.text === 'string') chars += part.text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

export async function callAnthropic(body: AnthropicMessageBody): Promise<AnthropicResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  // Pre-flight gates. Fail-fast before opening a network connection.
  await checkCircuit();
  const estCost = estimateCostUsd(body.max_tokens, estInputTokens(body));
  await preflightBudget(estCost);

  let resp: Response;
  try {
    resp = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network-level failure (DNS, connection refused, etc.) — count toward
    // the breaker, then re-throw.
    await recordCircuitFailure();
    throw err;
  }

  if (!resp.ok) {
    await recordCircuitFailure();
    const text = await resp.text().catch(() => '');
    throw new AnthropicHttpError(resp.status, text);
  }

  const data = (await resp.json()) as AnthropicResponse;

  // Success — reset circuit and record actual spend.
  await Promise.all([
    recordCircuitSuccess(),
    data.usage ? recordSpend(data.usage) : Promise.resolve(),
  ]);

  return data;
}
