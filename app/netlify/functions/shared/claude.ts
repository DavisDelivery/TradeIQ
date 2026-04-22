// Anthropic SDK wrapper for TradeIQ
// Centralizes model selection, retries, and structured output parsing.
// Env var required: ANTHROPIC_API_KEY

import Anthropic from '@anthropic-ai/sdk';

export type ClaudeModel =
  | 'claude-haiku-4-5-20251001' // fast, cheap — news sentiment, simple classification
  | 'claude-sonnet-4-6' // default reasoning — arbitration, research briefs
  | 'claude-opus-4-7'; // highest quality — Claude-as-PM, final trade decisions

export const MODELS = {
  HAIKU: 'claude-haiku-4-5-20251001' as const,
  SONNET: 'claude-sonnet-4-6' as const,
  OPUS: 'claude-opus-4-7' as const,
};

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY env var not set');
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export interface ClaudeCallOptions {
  model: ClaudeModel;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  // If true, we ask Claude to return valid JSON and parse the response.
  expectJson?: boolean;
}

export interface ClaudeCallResult<T = string> {
  content: T;
  raw: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  latencyMs: number;
}

/**
 * Call Claude with built-in retry on transient errors.
 * If expectJson is true, attempts to parse the response as JSON
 * and re-asks on parse failure once.
 */
export async function callClaude<T = string>(
  opts: ClaudeCallOptions,
): Promise<ClaudeCallResult<T>> {
  const { model, system, user, maxTokens = 1500, temperature = 0.3, expectJson } = opts;

  const systemPrompt = expectJson
    ? `${system}\n\nCRITICAL: Respond ONLY with valid JSON. No preamble, no markdown fences, no explanation. Just the JSON object.`
    : system;

  const start = Date.now();
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await client().messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: user }],
      });

      const textBlock = resp.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('Claude returned no text content');
      }
      const raw = textBlock.text.trim();

      let content: any = raw;
      if (expectJson) {
        const jsonStr = stripJsonFences(raw);
        try {
          content = JSON.parse(jsonStr);
        } catch (parseErr) {
          // Retry once with stricter instruction
          if (attempt === 0) {
            lastErr = parseErr;
            continue;
          }
          throw new Error(`Claude JSON parse failed: ${parseErr}. Raw: ${raw.slice(0, 200)}`);
        }
      }

      return {
        content: content as T,
        raw,
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        model: resp.model,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      lastErr = err;
      // Exponential backoff: 500ms, 1500ms
      if (attempt < 2) await sleep(500 * Math.pow(3, attempt));
    }
  }

  throw new Error(`Claude call failed after 3 attempts: ${lastErr}`);
}

function stripJsonFences(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1].trim();
  // Sometimes Claude adds a leading sentence before the JSON
  const firstBrace = s.search(/[\[{]/);
  if (firstBrace > 0) return s.slice(firstBrace).trim();
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
