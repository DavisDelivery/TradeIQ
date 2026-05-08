// Unit tests for anthropic-budget.ts (spend cap + circuit breaker).
//
// We use the in-memory fallback path of the module — it's the same code
// path the module uses when @netlify/blobs isn't configured (e.g. local
// dev or these tests). Each test calls __testInternals.reset() up front
// so spend/circuit state is clean.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  preflightBudget,
  recordSpend,
  getSpendToday,
  estimateCostUsd,
  actualCostUsd,
  checkCircuit,
  recordCircuitFailure,
  recordCircuitSuccess,
  BudgetExhaustedError,
  CircuitOpenError,
  __testInternals,
} from '../anthropic-budget';

beforeEach(() => {
  __testInternals.reset();
  delete process.env.ANTHROPIC_DAILY_BUDGET_USD;
});

describe('cost estimation', () => {
  it('estimateCostUsd uses Opus 4.7 pricing ($15/M in, $75/M out)', () => {
    // 1M output tokens = $75
    expect(estimateCostUsd(1_000_000, 0)).toBeCloseTo(75, 5);
    // 1M input tokens = $15
    expect(estimateCostUsd(0, 1_000_000)).toBeCloseTo(15, 5);
    // 1k out + 4k in = $0.075 + $0.060 = $0.135
    expect(estimateCostUsd(1000, 4000)).toBeCloseTo(0.135, 5);
  });

  it('actualCostUsd handles missing token counts as 0', () => {
    expect(actualCostUsd({})).toBe(0);
    expect(actualCostUsd({ input_tokens: 1000 })).toBeCloseTo(0.015, 5);
    expect(actualCostUsd({ output_tokens: 1000 })).toBeCloseTo(0.075, 5);
  });
});

describe('daily spend cap', () => {
  it('preflight passes when estimated cost is under remaining budget', async () => {
    process.env.ANTHROPIC_DAILY_BUDGET_USD = '25';
    await expect(preflightBudget(0.1)).resolves.toBeUndefined();
  });

  it('preflight throws BudgetExhaustedError when estimate would exceed daily cap', async () => {
    process.env.ANTHROPIC_DAILY_BUDGET_USD = '0.01';
    await expect(preflightBudget(0.5)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('cumulative spend pushes past the cap on subsequent calls', async () => {
    process.env.ANTHROPIC_DAILY_BUDGET_USD = '0.20';

    await preflightBudget(0.05);
    await recordSpend({ input_tokens: 5_000, output_tokens: 2_000 });  // ~$0.225

    // Now over budget — even a $0.001 call should be rejected.
    await expect(preflightBudget(0.001)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('default cap is $25 when env unset', async () => {
    expect(process.env.ANTHROPIC_DAILY_BUDGET_USD).toBeUndefined();
    await expect(preflightBudget(20)).resolves.toBeUndefined();
    await expect(preflightBudget(30)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('getSpendToday returns 0 baseline before any spend', async () => {
    const s = await getSpendToday();
    expect(s.totalUsd).toBe(0);
    expect(s.calls).toBe(0);
  });

  it('recordSpend accumulates calls and dollars', async () => {
    await recordSpend({ input_tokens: 1000, output_tokens: 500 });
    await recordSpend({ input_tokens: 1000, output_tokens: 500 });
    const s = await getSpendToday();
    expect(s.calls).toBe(2);
    // 2 * (15*1000/1e6 + 75*500/1e6) = 2 * (0.015 + 0.0375) = 0.105
    expect(s.totalUsd).toBeCloseTo(0.105, 5);
  });
});

describe('circuit breaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts closed (allows traffic)', async () => {
    await expect(checkCircuit()).resolves.toBeUndefined();
  });

  it('opens after 5 failures within 60s; subsequent calls throw CircuitOpenError', async () => {
    for (let i = 0; i < 5; i++) {
      // Step time forward a few seconds between failures, all within 60s.
      vi.advanceTimersByTime(5_000);
      await recordCircuitFailure();
    }
    await expect(checkCircuit()).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('failures spread > 60s apart do not trip the breaker', async () => {
    await recordCircuitFailure();
    vi.advanceTimersByTime(70_000);
    await recordCircuitFailure();
    vi.advanceTimersByTime(70_000);
    await recordCircuitFailure();
    vi.advanceTimersByTime(70_000);
    await recordCircuitFailure();
    vi.advanceTimersByTime(70_000);
    await recordCircuitFailure();
    await expect(checkCircuit()).resolves.toBeUndefined();
  });

  it('a single success resets the breaker', async () => {
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5_000);
      await recordCircuitFailure();
    }
    await recordCircuitSuccess();
    // After reset, more failures should start a new window from 0.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(5_000);
      await recordCircuitFailure();
    }
    // Only 4 failures since reset → still closed.
    await expect(checkCircuit()).resolves.toBeUndefined();
  });

  it('breaker auto-reopens for the configured duration after threshold', async () => {
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(5_000);
      await recordCircuitFailure();
    }
    await expect(checkCircuit()).rejects.toBeInstanceOf(CircuitOpenError);

    // Step past openUntil (5min default).
    vi.advanceTimersByTime(__testInternals.CIRCUIT_OPEN_MS + 1_000);

    // Half-open: a probe is allowed (no throw).
    await expect(checkCircuit()).resolves.toBeUndefined();
  });

  it('failure during half-open re-opens the breaker', async () => {
    // Trip it.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(5_000);
      await recordCircuitFailure();
    }
    // Step past the open window into half-open.
    vi.advanceTimersByTime(__testInternals.CIRCUIT_OPEN_MS + 1_000);

    // Half-open probe fails → re-open.
    await recordCircuitFailure();
    await expect(checkCircuit()).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe('error shapes', () => {
  it('BudgetExhaustedError carries spent + limit and a code', async () => {
    process.env.ANTHROPIC_DAILY_BUDGET_USD = '0.01';
    try {
      await preflightBudget(1);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExhaustedError);
      expect((err as BudgetExhaustedError).code).toBe('budget_exhausted');
      expect((err as BudgetExhaustedError).limit).toBe(0.01);
    }
  });

  it('CircuitOpenError carries openUntil and a code', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00Z'));
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(5_000);
      await recordCircuitFailure();
    }
    try {
      await checkCircuit();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).code).toBe('circuit_open');
      expect((err as CircuitOpenError).openUntil).toBeGreaterThan(Date.now());
    }
    vi.useRealTimers();
  });
});
