// Wave 4B (code-review-2026-06 infra minor 10) — anthropic-client
// resilience:
//   (a) AbortController timeout on the fetch
//   (b) retry-once-with-backoff on 429/529, honoring numeric Retry-After
//   (c) circuit discrimination — only infra-side failures (5xx/timeouts)
//       trip the breaker; 400/401 request/config bugs must NOT black out
//       every AI surface for 5 minutes
//   (d) malformed-JSON 2xx body records a circuit failure instead of
//       bypassing both recorders

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../anthropic-budget', () => {
  class BudgetExhaustedError extends Error {}
  class CircuitOpenError extends Error {}
  return {
    preflightBudget: vi.fn(async () => {}),
    recordSpend: vi.fn(async () => 0),
    checkCircuit: vi.fn(async () => {}),
    recordCircuitFailure: vi.fn(async () => {}),
    recordCircuitSuccess: vi.fn(async () => {}),
    estimateCostUsd: vi.fn(() => 0.01),
    getSpendToday: vi.fn(async () => ({ totalUsd: 0, calls: 0 })),
    actualCostUsd: vi.fn(() => 0.01),
    BudgetExhaustedError,
    CircuitOpenError,
  };
});

import { callAnthropic, AnthropicHttpError } from '../anthropic-client';
import {
  recordCircuitFailure,
  recordCircuitSuccess,
  recordSpend,
  checkCircuit,
  preflightBudget,
} from '../anthropic-budget';

const ORIGINAL_FETCH = globalThis.fetch;

const BODY = {
  model: 'claude-opus-4-8',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
};

const SUCCESS_PAYLOAD = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hello' }],
  model: 'claude-opus-4-8',
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
};

function res(status: number, body: any, headers: Record<string, string> = {}): any {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => lower.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const sleeps: number[] = [];
const fakeSleep = async (ms: number): Promise<void> => {
  sleeps.push(ms);
};

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  sleeps.length = 0;
  vi.mocked(recordCircuitFailure).mockClear();
  vi.mocked(recordCircuitSuccess).mockClear();
  vi.mocked(recordSpend).mockClear();
  vi.mocked(checkCircuit).mockClear();
  vi.mocked(preflightBudget).mockClear();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('callAnthropic — retry-once on 429/529 (Wave 4B)', () => {
  it('retries a 429 once, honoring numeric Retry-After (seconds → ms)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return res(429, { error: 'rate limited' }, { 'Retry-After': '1' });
      return res(200, SUCCESS_PAYLOAD);
    }) as any;

    const out = await callAnthropic(BODY, { sleep: fakeSleep });
    expect(out.content[0].text).toBe('hello');
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(recordCircuitSuccess).toHaveBeenCalledTimes(1);
    expect(recordCircuitFailure).not.toHaveBeenCalled();
    expect(recordSpend).toHaveBeenCalledWith(SUCCESS_PAYLOAD.usage);
  });

  it('caps a pathological Retry-After at 15s', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return res(529, { error: 'overloaded' }, { 'Retry-After': '9999' });
      return res(200, SUCCESS_PAYLOAD);
    }) as any;

    await callAnthropic(BODY, { sleep: fakeSleep });
    expect(sleeps).toEqual([15_000]);
  });

  it('falls back to the base backoff when Retry-After is absent (529)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return res(529, { error: 'overloaded' });
      return res(200, SUCCESS_PAYLOAD);
    }) as any;

    await callAnthropic(BODY, { sleep: fakeSleep });
    expect(sleeps).toEqual([2_000]);
  });

  it('retries at most once — a second 429 surfaces as AnthropicHttpError without tripping the circuit', async () => {
    globalThis.fetch = vi.fn(async () => res(429, { error: 'rate limited' })) as any;

    await expect(callAnthropic(BODY, { sleep: fakeSleep })).rejects.toThrow(AnthropicHttpError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    // Rate-limit pressure is not an upstream outage — must not contribute
    // to blacking out all AI surfaces.
    expect(recordCircuitFailure).not.toHaveBeenCalled();
  });
});

describe('callAnthropic — circuit discrimination (Wave 4B)', () => {
  it('401 (bad config) does NOT trip the circuit breaker', async () => {
    globalThis.fetch = vi.fn(async () => res(401, { error: 'invalid x-api-key' })) as any;

    await expect(callAnthropic(BODY, { sleep: fakeSleep })).rejects.toMatchObject({ status: 401 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no retry for 4xx
    expect(recordCircuitFailure).not.toHaveBeenCalled();
    expect(recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('400 (request bug) does NOT trip the circuit breaker', async () => {
    globalThis.fetch = vi.fn(async () => res(400, { error: 'invalid request' })) as any;

    await expect(callAnthropic(BODY, { sleep: fakeSleep })).rejects.toMatchObject({ status: 400 });
    expect(recordCircuitFailure).not.toHaveBeenCalled();
  });

  it('500 DOES count as a circuit failure', async () => {
    globalThis.fetch = vi.fn(async () => res(500, { error: 'internal' })) as any;

    await expect(callAnthropic(BODY, { sleep: fakeSleep })).rejects.toMatchObject({ status: 500 });
    expect(recordCircuitFailure).toHaveBeenCalledTimes(1);
  });

  it('network throw / timeout abort counts as a circuit failure and re-throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      throw e;
    }) as any;

    await expect(callAnthropic(BODY, { sleep: fakeSleep })).rejects.toThrow('aborted');
    expect(recordCircuitFailure).toHaveBeenCalledTimes(1);
  });

  it('malformed JSON in a 2xx body records a circuit failure instead of bypassing both recorders', async () => {
    const bad = res(200, null);
    bad.json = async () => { throw new SyntaxError('Unexpected token < in JSON'); };
    globalThis.fetch = vi.fn(async () => bad) as any;

    await expect(callAnthropic(BODY, { sleep: fakeSleep })).rejects.toThrow(AnthropicHttpError);
    expect(recordCircuitFailure).toHaveBeenCalledTimes(1);
    expect(recordCircuitSuccess).not.toHaveBeenCalled();
  });
});

describe('callAnthropic — timeout wiring + gate order (Wave 4B)', () => {
  it('passes an AbortSignal to fetch (timeout enforcement)', async () => {
    let seenSignal: unknown = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      seenSignal = init?.signal;
      return res(200, SUCCESS_PAYLOAD);
    }) as any;

    await callAnthropic(BODY, { sleep: fakeSleep });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the pre-flight gate order: circuit check + budget before any fetch', async () => {
    const order: string[] = [];
    vi.mocked(checkCircuit).mockImplementation(async () => { order.push('circuit'); });
    vi.mocked(preflightBudget).mockImplementation(async () => { order.push('budget'); });
    globalThis.fetch = vi.fn(async () => {
      order.push('fetch');
      return res(200, SUCCESS_PAYLOAD);
    }) as any;

    await callAnthropic(BODY, { sleep: fakeSleep });
    expect(order).toEqual(['circuit', 'budget', 'fetch']);
  });
});
