// 4c-2 sieve orchestrator. Runs Stage 1 → 2 → 3 against a universe of
// candidates and returns the final ranked picks + sieve metadata.
//
// Why this orchestrator exists separately from runProphetScan:
//   - Stage 1 needs to score the FULL universe (~2000 tickers) cheaply.
//   - Stage 2 narrows to ~80 with fundamentals + earnings-quality gate.
//   - Stage 3 runs the existing 7-layer scoring on Stage 2 survivors.
//   - runProphetScan today single-passes its universe; the sieve does
//     three passes with different cost profiles.
//
// Designed for the russell scheduled scanner. Other callers (live endpoints,
// largecap/all schedulers) continue using runProphetScan directly until
// performance dictates otherwise.

import { runProphetScan, type ProphetPick, type ProphetUniverseKey } from '../scan-prophet';
import type { UniverseEntry } from '../universe';
import { SPY } from '../universe';
import { getDailyBars } from '../data-provider';
import type { Logger } from '../logger';
import { runStage1 } from './stage1';
import { runStage2 } from './stage2';
import { SIEVE_BUDGETS } from './budgets';
import type { SieveMeta, StageMeta } from './types';

export interface SieveResult {
  picks: ProphetPick[];
  meta: SieveMeta;
  universeChecked: number;
  scanDurationMs: number;
  warnings: string[];
}

export interface RunSieveOpts {
  entries: UniverseEntry[];
  universe: ProphetUniverseKey;
  logger?: Logger;
  /** Override default per-stage budgets (useful for tests). */
  stage1BudgetMs?: number;
  stage2BudgetMs?: number;
  stage3BudgetMs?: number;
}

export async function runProphetSieve(opts: RunSieveOpts): Promise<SieveResult> {
  const start = Date.now();
  const log = opts.logger;
  const warnings: string[] = [];

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 300 * 86_400_000).toISOString().slice(0, 10);

  // SPY bars fetched once and reused across stages.
  const spyBars = await getDailyBars(SPY, from, to).catch(() => []);

  log?.info('sieve_started', {
    universe: opts.universe,
    entries: opts.entries.length,
    spyBars: spyBars.length,
  });

  // ─── STAGE 1 ───────────────────────────────────────────────────────────
  const s1 = await runStage1(
    { entries: opts.entries, from, to, spyBars },
    {
      logger: log,
      budgetMs: opts.stage1BudgetMs,
    },
  );
  warnings.push(...s1.meta.warnings);

  // ─── BARS CACHE ─────────────────────────────────────────────────────────
  // Stage 1 already fetched bars for every survivor. Stage 2 needs them
  // again for the 1y-ago P/E and RS-vs-SPY signals. Pre-fetch once into
  // a cache the Stage 2 worker reads from — avoids hammering Polygon a
  // second time.
  const barsCache = new Map();
  await Promise.all(
    s1.survivors.map(async (s) => {
      try {
        const bars = await getDailyBars(s.ticker, from, to);
        barsCache.set(s.ticker, bars);
      } catch {
        // skip — Stage 2 will see empty bars and degrade gracefully
      }
    }),
  );

  // ─── STAGE 2 ───────────────────────────────────────────────────────────
  const s2 = await runStage2(s1.survivors, spyBars, barsCache, {
    logger: log,
    budgetMs: opts.stage2BudgetMs,
  });
  warnings.push(...s2.meta.warnings);

  // ─── STAGE 3 ───────────────────────────────────────────────────────────
  // Score Stage 2 survivors with the existing 7-layer scan. We pass
  // explicitTickers so runProphetScan doesn't re-resolve the universe.
  const s3Start = Date.now();
  const s3Budget = opts.stage3BudgetMs ?? SIEVE_BUDGETS.stage3.budgetMs;

  const s3Run =
    s2.survivors.length > 0
      ? await runProphetScan({
          universe: opts.universe,
          scanBudgetMs: s3Budget,
          concurrency: SIEVE_BUDGETS.stage3.concurrency,
          sufficientQualified: Infinity,
          logger: log,
          explicitTickers: s2.survivors.map((s) => s.ticker),
        })
      : null;

  const s3Meta: StageMeta = {
    scored: s2.survivors.length,
    survived: s3Run?.picks.length ?? 0,
    thresholdScore: null,
    budgetMs: Date.now() - s3Start,
    partial: s3Run?.budgetExceeded ?? false,
    warnings: s3Run?.warnings ?? [],
  };
  if (s3Run) warnings.push(...s3Run.warnings);

  // Stamp sieve_stage_max on every pick so the UI can show telemetry.
  const picks = (s3Run?.picks ?? []).map((p) => ({
    ...p,
    _sieve_stage_max: 3 as const,
  }));

  const meta: SieveMeta = {
    stage1: s1.meta,
    stage2: s2.meta,
    stage3: s3Meta,
  };

  const scanDurationMs = Date.now() - start;
  log?.info('sieve_complete', {
    universe: opts.universe,
    stage1: { scored: s1.meta.scored, survived: s1.meta.survived },
    stage2: { scored: s2.meta.scored, survived: s2.meta.survived },
    stage3: { scored: s3Meta.scored, qualified: s3Meta.survived },
    scanDurationMs,
  });

  return {
    picks,
    meta,
    universeChecked: opts.entries.length,
    scanDurationMs,
    warnings,
  };
}
