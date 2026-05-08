// GET /api/prophet-picks
//   ?universe=largecap|russell|all (default largecap)
//   &minConviction=low|medium|high
//   &limit=30
//   &narrate=1|0 (default 1 — narrate top 5 from snapshot or live result)
//   [&force=1]
//
// Phase 1: snapshot-first. Snapshot stores ALL scored picks WITHOUT narratives
// (scheduled scan is forbidden from calling Anthropic). When serving from a
// snapshot, the live endpoint optionally narrates the top 5 picks on the fly,
// using the existing 6h narrative cache so repeat reads are free.

import type { Handler } from '@netlify/functions';
import {
  runProphetScan,
  filterProphetByConviction,
  type ProphetUniverseKey,
  type ProphetPick,
} from './shared/scan-prophet';
import {
  isSnapshotFresh,
  latestSnapshot,
  snapshotAgeMs,
  type UniverseKey,
} from './shared/snapshot-store';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';
import { callAnthropic, BudgetExhaustedError, CircuitOpenError } from './shared/anthropic-client';

const MODEL = 'claude-opus-4-7';

const SCAN_BUDGET_MS = 18_000;
const NARRATIVE_BUDGET_MS = 3_000;

// Live partial-scan fallback (in-memory).
const fallbackCache = new Map<string, { data: any; at: number }>();
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

// Narrative cache, keyed by ticker+composite-band.
const narrativeCache = new Map<string, { text: string; at: number }>();
const NARRATIVE_TTL_MS = 6 * 60 * 60 * 1000;

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const universe = (qs.universe as ProphetUniverseKey) ?? 'largecap';
  const minConviction = (qs.minConviction as 'low' | 'medium' | 'high') ?? 'low';
  const limit = Math.min(Number(qs.limit ?? 30), 100);
  const narrate = qs.narrate !== '0';
  const force = qs.force === '1' || qs.force === 'true';

  const log = logger.child({ fn: 'prophet-picks', universe, force });

  const snapshotUniverse: UniverseKey =
    universe === 'russell' ? 'russell2k' : (universe as UniverseKey);

  if (!force) {
    try {
      const snap = await latestSnapshot('prophet', snapshotUniverse);
      if (snap && isSnapshotFresh(snap)) {
        const ageMs = snapshotAgeMs(snap);
        log.info('snapshot_hit', { ageMs, modelVersion: snap.modelVersion });
        const all = snap.results as ProphetPick[];
        const filtered = filterProphetByConviction(all, minConviction);
        const sliced = filtered.slice(0, limit);

        if (narrate && process.env.ANTHROPIC_API_KEY) {
          await narrateTopN(sliced, 5, NARRATIVE_BUDGET_MS, log);
        }

        return json(200, {
          ok: true,
          universe,
          universeSize: snap.universeChecked,
          partial: false,
          generatedAt: snap.generatedAt,
          source: 'snapshot',
          cached: true,
          ageMs,
          modelVersion: snap.modelVersion,
          qualified: filtered.length,
          picks: sliced,
        });
      }
      if (snap) log.warn('snapshot_stale', { ageMs: snapshotAgeMs(snap) });
      else log.warn('snapshot_missing');
    } catch (err: any) {
      log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
    }
  }

  return runLiveAndRespond(
    universe,
    minConviction,
    limit,
    narrate,
    force ? 'forced-partial' : 'fallback-partial',
    log,
  );
};

async function runLiveAndRespond(
  universe: ProphetUniverseKey,
  minConviction: 'low' | 'medium' | 'high',
  limit: number,
  narrate: boolean,
  source: 'forced-partial' | 'fallback-partial',
  log: ReturnType<typeof logger.child>,
) {
  const cacheKey = `${universe}|${minConviction}|${source}`;
  if (source === 'fallback-partial') {
    const cached = fallbackCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FALLBACK_CACHE_TTL_MS) {
      return json(200, { ...cached.data, cached: true, source });
    }
  }

  try {
    // Live scan honors the legacy capped behavior: tighter budget and
    // sufficient-qualified early stop, so it returns inside the 26s window.
    const scan = await runProphetScan({
      universe,
      scanBudgetMs: SCAN_BUDGET_MS,
      concurrency: 7,
      sufficientQualified: limit * 3,
      logger: log,
    });

    const filtered = filterProphetByConviction(scan.picks, minConviction);
    const sliced = filtered.slice(0, limit);

    if (narrate && process.env.ANTHROPIC_API_KEY) {
      await narrateTopN(sliced, 5, NARRATIVE_BUDGET_MS, log);
    }

    const response = {
      ok: true,
      universe,
      universeSize: scan.universeChecked,
      tickersScanned: scan.tickersScanned,
      qualified: filtered.length,
      partial: scan.budgetExceeded,
      regime: scan.regime,
      generatedAt: new Date().toISOString(),
      source,
      cached: false,
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      picks: sliced,
      warning:
        source === 'fallback-partial'
          ? 'snapshot stale or missing; partial scan'
          : 'forced partial scan',
      warnings: scan.warnings,
    };

    if (source === 'fallback-partial' && filtered.length > 0) {
      fallbackCache.set(cacheKey, { data: response, at: Date.now() });
    }
    return json(200, response);
  } catch (err: any) {
    log.error('live_scan_failed', { err: String(err?.message ?? err) });
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
}

async function narrateTopN(
  picks: ProphetPick[],
  n: number,
  budgetMs: number,
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  const start = Date.now();
  const max = Math.min(n, picks.length);
  for (let i = 0; i < max; i++) {
    if (Date.now() - start > budgetMs) {
      log.info('narrate_budget_exceeded', { narrated: i });
      break;
    }
    try {
      const text = await getCachedNarrative(picks[i]);
      if (text) picks[i].narrative = sanitizeForJson(text);
    } catch (err: any) {
      log.warn('narrate_failed', { ticker: picks[i].ticker, err: String(err?.message ?? err) });
    }
  }
}

async function getCachedNarrative(pick: ProphetPick): Promise<string | null> {
  const band = Math.floor(pick.composite / 5) * 5;
  const key = `${pick.ticker}:${band}`;
  const hit = narrativeCache.get(key);
  if (hit && Date.now() - hit.at < NARRATIVE_TTL_MS) return hit.text;

  const text = await generateNarrative(pick);
  if (text) narrativeCache.set(key, { text, at: Date.now() });
  return text;
}

async function generateNarrative(pick: ProphetPick): Promise<string | null> {
  try {
    const layerLines = Object.entries(pick.layers)
      .map(
        ([name, r]) =>
          `${name}: score ${r.score} ${r.pass ? '✓' : '✗'} — ${Object.entries(r.details)
            .slice(0, 4)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`,
      )
      .join('\n');
    const user = `Ticker: ${pick.ticker} (${pick.name}, ${pick.sector})
Price: $${pick.price.toFixed(2)} (${pick.priceChangePct >= 0 ? '+' : ''}${pick.priceChangePct}%)
PROPHET composite: ${pick.composite}/100 · conviction ${pick.conviction} · ${pick.layersPassed}/7 layers pass
Flags: ${pick.flags.join(', ')}
Entry: $${pick.entry} · Stop: $${pick.stop} · Targets: ${pick.targets.join(', ')} · Invalidation: $${pick.invalidation}

Layer breakdown:
${layerLines}

Write a 3-4 sentence trader's read: what the chart + catalysts + fundamentals together are saying, and one specific invalidation condition. Reference actual price levels. No disclaimers.`;

    try {
      const data = await callAnthropic({
        model: MODEL,
        max_tokens: 350,
        // temperature parameter removed: Claude Opus 4.7 deprecated it
        // (returns 400 invalid_request_error).
        system:
          'You are a veteran swing trader writing a concise thesis. Be specific with price levels. No boilerplate, no "DYOR", no disclaimers.',
        messages: [{ role: 'user', content: user }],
      });
      return data.content.find((b) => b.type === 'text')?.text?.trim() ?? null;
    } catch (err) {
      // Narratives are best-effort — drop on budget/circuit/upstream
      // failure rather than failing the whole prophet response.
      if (err instanceof BudgetExhaustedError || err instanceof CircuitOpenError) return null;
      return null;
    }
  } catch {
    return null;
  }
}

function sanitizeForJson(s: string): string {
  return s.replace(/[\u0000-\u001f]/g, ' ');
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}
