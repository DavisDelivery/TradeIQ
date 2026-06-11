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

// Hard ceiling on a single Anthropic request (code-review-2026-06 infra
// minor 10). 60s is generous for an Opus long-form generation but bounded:
// a hung TCP connection must not pin a Netlify function until the platform
// kills it. Timeouts abort the fetch and count as circuit failures.
const FETCH_TIMEOUT_MS = 60_000;

// Retry-once policy for transient upstream pressure: 429 (rate limited)
// and 529 (Anthropic overloaded). Honor a numeric Retry-After when
// present, capped so a pathological header can't stall a function.
const RETRY_BASE_BACKOFF_MS = 2_000;
const RETRY_AFTER_CAP_MS = 15_000;

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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Delay before the single retry on 429/529 — numeric Retry-After
 *  (seconds) when present, capped; otherwise the base backoff. */
function retryDelayMs(resp: Response): number {
  const retryAfter = resp.headers.get('Retry-After') ?? resp.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
    }
  }
  return RETRY_BASE_BACKOFF_MS;
}

export interface CallAnthropicOpts {
  /** Test seam: sleep N ms (used for the 429/529 retry backoff). */
  sleep?: (ms: number) => Promise<void>;
}

export async function callAnthropic(
  body: AnthropicMessageBody,
  opts: CallAnthropicOpts = {},
): Promise<AnthropicResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const sleep = opts.sleep ?? defaultSleep;

  // Pre-flight gates. Fail-fast before opening a network connection.
  await checkCircuit();
  const estCost = estimateCostUsd(body.max_tokens, estInputTokens(body));
  await preflightBudget(estCost);

  // One attempt, bounded by FETCH_TIMEOUT_MS via AbortController. A
  // timeout surfaces as a fetch throw (AbortError) and counts toward the
  // breaker like any other network-level failure.
  async function attempt(): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  let resp: Response;
  try {
    resp = await attempt();
    // Retry ONCE on transient upstream pressure (429 rate limit / 529
    // overloaded) with backoff. Anything else falls through unchanged.
    if (resp.status === 429 || resp.status === 529) {
      await sleep(retryDelayMs(resp));
      resp = await attempt();
    }
  } catch (err) {
    // Network-level failure (DNS, connection refused, timeout/abort) —
    // count toward the breaker, then re-throw.
    await recordCircuitFailure();
    throw err;
  }

  if (!resp.ok) {
    // Circuit discrimination (code-review-2026-06 infra minor 10): only
    // infrastructure-side failures (5xx incl. 529) trip the breaker.
    // 4xx — malformed requests (400), bad config (401/403), rate-limit
    // pressure that survived the retry (429) — are NOT upstream outages;
    // letting them open the circuit blacked out every AI surface for
    // 5 minutes on a single buggy call-site.
    if (resp.status >= 500) {
      await recordCircuitFailure();
    }
    const text = await resp.text().catch(() => '');
    throw new AnthropicHttpError(resp.status, text);
  }

  let data: AnthropicResponse;
  try {
    data = (await resp.json()) as AnthropicResponse;
  } catch {
    // A 2xx with an unparseable body is an upstream fault — record it as
    // a circuit failure rather than bypassing both recorders.
    await recordCircuitFailure();
    throw new AnthropicHttpError(resp.status, 'malformed JSON in success response body');
  }

  // Success — reset circuit and record actual spend.
  await Promise.all([
    recordCircuitSuccess(),
    data.usage ? recordSpend(data.usage) : Promise.resolve(),
  ]);

  return data;
}
