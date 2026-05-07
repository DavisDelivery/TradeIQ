// Anthropic spend cap + circuit breaker.
//
// Why: Opus 4.7 is hitting research, prophet narratives, and chart-analysis
// from a single-user app. One bad loop or a flaky upstream can spend $100+
// before anyone notices. This module gates every Claude call behind two
// independent guards backed by Netlify Blobs (free, durable, region-local).
//
// Spend cap:
//   Daily key 'anthropic-spend:{YYYY-MM-DD}' tracks accumulated $ for the day.
//   ANTHROPIC_DAILY_BUDGET_USD env var sets the ceiling (default $25).
//   pre-flight: estimate cost from max_tokens + estimated input size.
//                if estimate > remaining → throw 'budget_exhausted'.
//   post-flight: increment by actual usage from response.
//
// Circuit breaker:
//   Key 'anthropic-circuit'. Tracks {errors, firstErrorAt, openUntil}.
//   On 5 errors in 60s → open for 5 min. Calls during open → 'circuit_open'.
//   When openUntil passes, allow one half-open probe; success closes,
//   failure re-opens.
//
// All blob operations are wrapped so a Blobs outage degrades gracefully
// (allows the call rather than blocking the whole AI surface). The point
// of these guards is cost protection, not availability.

import { getStore, Store } from '@netlify/blobs';

// Opus 4.7 pricing (2026): $15 / 1M input, $75 / 1M output.
const OPUS_INPUT_USD_PER_MTOK = 15;
const OPUS_OUTPUT_USD_PER_MTOK = 75;

const STORE_NAME = 'tradeiq-budget';
const SPEND_KEY_PREFIX = 'anthropic-spend:';
const CIRCUIT_KEY = 'anthropic-circuit';

const CIRCUIT_THRESHOLD = 5;          // errors
const CIRCUIT_WINDOW_MS = 60 * 1000;  // within 60s
const CIRCUIT_OPEN_MS = 5 * 60 * 1000;  // open for 5 min

export class BudgetExhaustedError extends Error {
  code = 'budget_exhausted' as const;
  constructor(public spent: number, public limit: number) {
    super(`Anthropic daily budget exhausted: $${spent.toFixed(4)} / $${limit.toFixed(2)}`);
  }
}

export class CircuitOpenError extends Error {
  code = 'circuit_open' as const;
  constructor(public openUntil: number) {
    super(`Anthropic circuit breaker open until ${new Date(openUntil).toISOString()}`);
  }
}

interface CircuitState {
  errors: number;
  firstErrorAt: number;
  openUntil: number | null;
}

interface SpendState {
  totalUsd: number;
  calls: number;
}

function todayKey(): string {
  return SPEND_KEY_PREFIX + new Date().toISOString().slice(0, 10);
}

function dailyLimitUsd(): number {
  const v = Number(process.env.ANTHROPIC_DAILY_BUDGET_USD);
  return Number.isFinite(v) && v > 0 ? v : 25;
}

// In-memory shadow used in environments without Netlify Blobs (local dev,
// unit tests). The Blobs SDK throws when not configured; we catch and
// fall back so the wrapper stays usable.
const memStore: Map<string, any> = new Map();

async function safeStore(): Promise<Store | null> {
  try {
    return getStore({ name: STORE_NAME, consistency: 'strong' });
  } catch {
    return null;
  }
}

async function readJson<T>(key: string): Promise<T | null> {
  const store = await safeStore();
  if (!store) return (memStore.get(key) ?? null) as T | null;
  try {
    return (await store.get(key, { type: 'json' })) as T | null;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const store = await safeStore();
  if (!store) {
    memStore.set(key, value);
    return;
  }
  try {
    await store.setJSON(key, value);
  } catch {
    memStore.set(key, value);
  }
}

// ─── Spend ────────────────────────────────────────────────────────────────

export function estimateCostUsd(maxTokens: number, estInputTokens: number): number {
  return (
    (estInputTokens * OPUS_INPUT_USD_PER_MTOK) / 1_000_000 +
    (maxTokens * OPUS_OUTPUT_USD_PER_MTOK) / 1_000_000
  );
}

export function actualCostUsd(usage: { input_tokens?: number; output_tokens?: number }): number {
  const inT = usage.input_tokens ?? 0;
  const outT = usage.output_tokens ?? 0;
  return (
    (inT * OPUS_INPUT_USD_PER_MTOK) / 1_000_000 +
    (outT * OPUS_OUTPUT_USD_PER_MTOK) / 1_000_000
  );
}

export async function getSpendToday(): Promise<SpendState> {
  const s = await readJson<SpendState>(todayKey());
  return s ?? { totalUsd: 0, calls: 0 };
}

export async function recordSpend(usage: { input_tokens?: number; output_tokens?: number }): Promise<number> {
  const cost = actualCostUsd(usage);
  const cur = await getSpendToday();
  const next: SpendState = { totalUsd: cur.totalUsd + cost, calls: cur.calls + 1 };
  await writeJson(todayKey(), next);
  return next.totalUsd;
}

export async function preflightBudget(estCostUsd: number): Promise<void> {
  const limit = dailyLimitUsd();
  const cur = await getSpendToday();
  if (cur.totalUsd + estCostUsd > limit) {
    throw new BudgetExhaustedError(cur.totalUsd, limit);
  }
}

// ─── Circuit ──────────────────────────────────────────────────────────────

async function readCircuit(): Promise<CircuitState> {
  return (await readJson<CircuitState>(CIRCUIT_KEY)) ?? {
    errors: 0,
    firstErrorAt: 0,
    openUntil: null,
  };
}

export async function checkCircuit(): Promise<void> {
  const state = await readCircuit();
  const now = Date.now();
  if (state.openUntil && state.openUntil > now) {
    throw new CircuitOpenError(state.openUntil);
  }
}

export async function recordCircuitSuccess(): Promise<void> {
  // Any success resets the breaker.
  await writeJson(CIRCUIT_KEY, { errors: 0, firstErrorAt: 0, openUntil: null });
}

export async function recordCircuitFailure(): Promise<void> {
  const state = await readCircuit();
  const now = Date.now();

  // If we were in half-open (openUntil expired but state never reset to 0)
  // and a probe just failed, re-open immediately.
  if (state.openUntil && state.openUntil <= now) {
    await writeJson(CIRCUIT_KEY, {
      errors: 1,
      firstErrorAt: now,
      openUntil: now + CIRCUIT_OPEN_MS,
    });
    return;
  }

  // Outside the window? start a fresh count.
  if (now - state.firstErrorAt > CIRCUIT_WINDOW_MS) {
    await writeJson(CIRCUIT_KEY, { errors: 1, firstErrorAt: now, openUntil: null });
    return;
  }

  const errors = state.errors + 1;
  if (errors >= CIRCUIT_THRESHOLD) {
    await writeJson(CIRCUIT_KEY, {
      errors,
      firstErrorAt: state.firstErrorAt,
      openUntil: now + CIRCUIT_OPEN_MS,
    });
  } else {
    await writeJson(CIRCUIT_KEY, { errors, firstErrorAt: state.firstErrorAt, openUntil: null });
  }
}

// ─── Test hooks ───────────────────────────────────────────────────────────

export const __testInternals = {
  reset: () => {
    memStore.clear();
  },
  setMem: (key: string, value: unknown) => memStore.set(key, value),
  getMem: (key: string) => memStore.get(key),
  CIRCUIT_THRESHOLD,
  CIRCUIT_WINDOW_MS,
  CIRCUIT_OPEN_MS,
  STORE_NAME,
  CIRCUIT_KEY,
  spendKey: todayKey,
};
