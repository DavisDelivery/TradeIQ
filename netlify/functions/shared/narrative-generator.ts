// Shared narrative generator. Single Claude Opus 4.7 call producing a
// 3-4 sentence trader's read for a Prophet pick.
//
// Used by:
//   - prophet-picks.ts (top-N narration on cached snapshots / live scans)
//   - prophet-narrate.ts (on-demand single-pick narration for the UI)
//   - scan-prophet-*.ts (narrate-all on scheduled scans, post 4c-1)
//
// Per Phase 4a hotfix, Opus 4.7 does NOT accept the `temperature` param;
// adding it returns 400 invalid_request_error. Do not re-introduce it.
//
// Anthropic budget cap was explicitly dropped 2026-05-12; we still catch
// BudgetExhaustedError / CircuitOpenError gracefully (returning null) so
// callers degrade to the W1 UI placeholder when the existing infra-level
// guard trips. We do not add new refusal logic.

import { callAnthropic, BudgetExhaustedError, CircuitOpenError, AnthropicHttpError } from './anthropic-client';
import { getCachedNarrative, setCachedNarrative } from './narrative-cache';

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 350;

const SYSTEM_PROMPT =
  'You are a veteran swing trader writing a concise thesis. Be specific with price levels. No boilerplate, no "DYOR", no disclaimers.';

// Minimal input shape — only the fields the prompt template references.
// Both prophet-picks (ProphetPick) and prophet-narrate (request body) satisfy
// this shape without coupling either side to the other's type.
export interface NarrativeInput {
  ticker: string;
  name?: string | null;
  sector?: string | null;
  price?: number | null;
  priceChangePct?: number | null;
  composite: number;
  conviction?: string | null;
  layersPassed?: number | null;
  flags?: string[] | null;
  entry?: number | null;
  stop?: number | null;
  targets?: number[] | null;
  invalidation?: number | null;
  layers?: Record<string, { score: number; pass: boolean; details?: Record<string, unknown> }> | null;
}

function buildPrompt(pick: NarrativeInput): string {
  const layerLines = Object.entries(pick.layers ?? {})
    .map(([name, r]) =>
      `${name}: score ${r.score} ${r.pass ? '✓' : '✗'} — ${Object.entries(r.details ?? {})
        .slice(0, 4)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    )
    .join('\n');

  const priceStr = pick.price != null ? `$${pick.price.toFixed(2)}` : '$?';
  const chgStr =
    pick.priceChangePct != null
      ? `${pick.priceChangePct >= 0 ? '+' : ''}${pick.priceChangePct}%`
      : '';
  const targets = pick.targets?.length ? pick.targets.join(', ') : '—';

  return `Ticker: ${pick.ticker}${pick.name ? ` (${pick.name}${pick.sector ? `, ${pick.sector}` : ''})` : ''}
Price: ${priceStr}${chgStr ? ` (${chgStr})` : ''}
PROPHET composite: ${pick.composite}/100${pick.conviction ? ` · conviction ${pick.conviction}` : ''}${pick.layersPassed != null ? ` · ${pick.layersPassed}/7 layers pass` : ''}
Flags: ${(pick.flags ?? []).join(', ')}
Entry: $${pick.entry ?? '?'} · Stop: $${pick.stop ?? '?'} · Targets: ${targets} · Invalidation: $${pick.invalidation ?? '?'}

Layer breakdown:
${layerLines}

Write a 3-4 sentence trader's read: what the chart + catalysts + fundamentals together are saying, and one specific invalidation condition. Reference actual price levels. No disclaimers.`;
}

export function sanitizeNarrative(s: string): string {
  return s.replace(/[\u0000-\u001f]/g, ' ');
}

/**
 * Generate a single narrative. Returns null `text` on budget exhaustion,
 * circuit open, or any upstream failure — callers should treat null as
 * "no narrative available right now" and surface the W1 UI placeholder.
 *
 * On failure, `errorCode` carries a short token identifying the failure
 * class (for surfacing to UI/curl as a diagnostic hint); `errorDetail`
 * carries the upstream body for logging (callers MUST log this and MUST
 * NOT echo it back over the wire — it may contain account-scoped info).
 *
 * Cache-aware: checks `narrative-cache` first by `{ticker}:{compositeBand}`.
 * On a cache hit, returns the cached text without calling Anthropic.
 */
export async function generateNarrative(
  pick: NarrativeInput,
): Promise<{ text: string | null; cached: boolean; errorCode?: string; errorDetail?: string }> {
  // Cache hit short-circuit — no API call, no spend.
  const hit = getCachedNarrative(pick.ticker, pick.composite);
  if (hit) return { text: hit, cached: true };

  try {
    const user = buildPrompt(pick);
    const data = await callAnthropic({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // NOTE: do NOT add `temperature` — Opus 4.7 returns 400.
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
    });
    const raw = data.content.find((b) => b.type === 'text')?.text?.trim();
    if (!raw) return { text: null, cached: false, errorCode: 'empty_response' };
    const text = sanitizeNarrative(raw);
    setCachedNarrative(pick.ticker, pick.composite, text);
    return { text, cached: false };
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      return { text: null, cached: false, errorCode: 'budget_exhausted' };
    }
    if (err instanceof CircuitOpenError) {
      return { text: null, cached: false, errorCode: 'circuit_open' };
    }
    if (err instanceof AnthropicHttpError) {
      return {
        text: null,
        cached: false,
        errorCode: `anthropic_http_${err.status}`,
        errorDetail: err.bodyText.slice(0, 200),
      };
    }
    // Any other failure (network, parse, etc.).
    return {
      text: null,
      cached: false,
      errorCode: 'unknown',
      errorDetail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }
}

/**
 * Narrate up to `n` picks within a wall-time budget. Used by the live
 * prophet-picks endpoint to narrate the top of the list inline. Mutates
 * `pick.narrative` in place; returns the count actually narrated.
 *
 * Stops at the budget boundary — partial narration is acceptable, the
 * un-narrated picks ship without a narrative and the UI's lazy-load
 * (W2 + W3) handles them on demand.
 */
export async function narrateTopN<T extends NarrativeInput & { narrative?: string | null }>(
  picks: T[],
  n: number,
  budgetMs: number,
  onWarn?: (msg: string, ticker: string, err: unknown) => void,
): Promise<number> {
  const start = Date.now();
  const max = Math.min(n, picks.length);
  let narrated = 0;
  for (let i = 0; i < max; i++) {
    if (Date.now() - start > budgetMs) break;
    try {
      const { text } = await generateNarrative(picks[i]);
      if (text) {
        picks[i].narrative = text;
        narrated++;
      }
    } catch (err) {
      onWarn?.('narrate_failed', picks[i].ticker, err);
    }
  }
  return narrated;
}

/**
 * Narrate ALL picks in parallel with a fixed concurrency. Used by the
 * scheduled scanner (W4) — runs inside the 15-min background container.
 *
 * `budgetMs` bounds total wall time. When the budget is exhausted, the
 * remaining un-narrated picks ship without a narrative and the W1+W2
 * lazy-load handles them on demand. This is the right behavior for
 * russell where 200 qualified picks at 2s each could push past the
 * container limit if uncapped.
 *
 * Per Chad's decision 2026-05-12, the Anthropic budget cap was dropped.
 * This function emits per-call cost telemetry via the existing
 * `recordSpend` infrastructure (in anthropic-client) but never refuses.
 * Callers can compare aggregate before/after spend to detect anomalies.
 */
export async function narrateAll<T extends NarrativeInput & { narrative?: string | null }>(
  picks: T[],
  opts: { concurrency?: number; budgetMs?: number; onWarn?: (msg: string, ticker: string, err: unknown) => void } = {},
): Promise<{ narrated: number; failed: number; skipped: number; durationMs: number }> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const budgetMs = opts.budgetMs ?? Infinity;
  const start = Date.now();
  let narrated = 0;
  let failed = 0;
  let skipped = 0;

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < picks.length) {
      if (Date.now() - start > budgetMs) {
        // Count un-claimed picks as skipped — best-effort estimate; another
        // worker may have just claimed the slot we'd have taken.
        const remaining = Math.max(0, picks.length - cursor);
        skipped = Math.max(skipped, remaining);
        return;
      }
      const idx = cursor++;
      const pick = picks[idx];
      // Skip picks that already have a narrative (e.g. set by a prior
      // narrateTopN pass) so we don't double-spend.
      if (pick.narrative) continue;
      try {
        const { text } = await generateNarrative(pick);
        if (text) {
          pick.narrative = text;
          narrated++;
        }
      } catch (err) {
        failed++;
        opts.onWarn?.('narrate_failed', pick.ticker, err);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { narrated, failed, skipped, durationMs: Date.now() - start };
}
