// 4c-2 Sieve Stage 2 — earnings-quality + RS narrowing of Stage 1 survivors.
//
// Goal: reduce ~300-600 Stage 1 survivors to ~60-120 in ~4 minutes.
//
// What's added vs Stage 1:
//   - Polygon fundamentals (revenue, EPS, margins, debt) via getFundamentals
//   - Earnings intel (beats history, acceleration, surprise magnitude) via getEarningsIntel
//   - Relative strength vs SPY (60d return diff)
//   - **Earnings-quality gate** (Chad's product priority — 2026-05-13). A
//     ticker MUST pass the gate to reach Stage 3. The gate considers EPS
//     growth, margin trend, multiple expansion, and beats streak; missing
//     data is lenient (don't punish unknowns) but clearly weak signal sets
//     fail.
//
// Survival = (passed earnings gate) AND (composite >= threshold).

import type { Bar } from '../data-provider';
import { getFundamentals } from '../data-provider';
import { getEarningsIntel } from '../earnings-intel';
import { mapWithConcurrency } from '../full-scan-iterator';
import type { Logger } from '../logger';
import type { StageMeta, Stage1Result, Stage2Result } from './types';
import { SIEVE_BUDGETS } from './budgets';

interface FundBundle {
  ticker: string;
  epsGrowthYoY?: number;
  revenueGrowthYoY?: number;
  operatingMarginTrendPp?: number;
  grossMarginTrendPp?: number;
  peExpansion?: number;
  epsAcceleration?: number;
  beatsLast4: number | null;
  rsVsSpy: number | null;
  /** A 0-100 quality composite (Stage 2 internal). */
  qualityScore: number;
  /** Earnings-quality gate: does this ticker meet the threshold to reach Stage 3? */
  gatePassed: boolean;
  gateReason: string;
}

export async function runStage2(
  stage1Survivors: Stage1Result[],
  spyBars: Bar[],
  barsCache: Map<string, Bar[]>,
  opts: { logger?: Logger; budgetMs?: number; concurrency?: number } = {},
): Promise<{ results: Stage2Result[]; survivors: Stage2Result[]; meta: StageMeta }> {
  const start = Date.now();
  const budgetMs = opts.budgetMs ?? SIEVE_BUDGETS.stage2.budgetMs;
  const concurrency = opts.concurrency ?? SIEVE_BUDGETS.stage2.concurrency;
  const log = opts.logger;
  const warnings: string[] = [];

  let budgetExceeded = false;

  const stage1By = new Map(stage1Survivors.map((s) => [s.ticker, s]));
  const tickers = stage1Survivors.map((s) => s.ticker);

  const bundles = await mapWithConcurrency<FundBundle | null>(
    tickers,
    async (ticker) => {
      if (Date.now() - start > budgetMs) {
        budgetExceeded = true;
        return null;
      }
      try {
        const [fund, intel] = await Promise.all([
          getFundamentals(ticker).catch(() => null),
          getEarningsIntel(ticker).catch(() => null),
        ]);
        const bars = barsCache.get(ticker) ?? [];
        return computeFundBundle(ticker, fund, intel, bars, spyBars);
      } catch (err) {
        warnings.push(`stage2_fetch:${ticker}:${(err as any)?.message ?? err}`);
        return null;
      }
    },
    { batchSize: concurrency },
  );

  const scored = bundles.filter((b): b is FundBundle => b != null);

  // Build Stage 2 results: combine Stage 1 composite with quality composite.
  // Per Chad's direction, lean on earnings-quality heavily — 60% quality / 40% Stage 1 carry-over.
  const results: Stage2Result[] = scored.map((b) => {
    const s1 = stage1By.get(b.ticker);
    const s1c = s1?.composite ?? 50;
    const composite = Math.round(0.4 * s1c + 0.6 * b.qualityScore);
    return {
      ticker: b.ticker,
      composite,
      passed: false,
      earningsGate: b.gatePassed,
      earningsGateReason: b.gateReason,
      signals: {
        stage1Composite: s1c,
        epsGrowthYoY: b.epsGrowthYoY ?? null,
        revenueGrowthYoY: b.revenueGrowthYoY ?? null,
        operatingMarginTrendPp: b.operatingMarginTrendPp ?? null,
        peExpansionPct: b.peExpansion != null ? +(b.peExpansion * 100) : null,
        rsVsSpy: b.rsVsSpy,
      },
    };
  });

  // Sort by composite desc, then apply survival rule.
  // CRITICAL: a ticker must pass the earnings gate to be eligible for Stage 3.
  results.sort((a, b) => b.composite - a.composite);

  const gatedPool = results.filter((r) => r.earningsGate);
  const cfg = SIEVE_BUDGETS.stage2.survivors;
  const minComposite = SIEVE_BUDGETS.stage2.minComposite;
  const topN = Math.round(gatedPool.length * cfg.topPct);
  const targetSurvivors = Math.min(cfg.max, Math.max(cfg.min, topN));

  let thresholdScore: number | null = null;
  if (gatedPool.length > 0) {
    const cutoffIdx = Math.min(targetSurvivors - 1, gatedPool.length - 1);
    thresholdScore = Math.max(minComposite, gatedPool[cutoffIdx].composite);
  }

  const survivors: Stage2Result[] = [];
  for (const r of results) {
    if (
      r.earningsGate &&
      thresholdScore !== null &&
      r.composite >= thresholdScore &&
      survivors.length < cfg.max
    ) {
      r.passed = true;
      survivors.push(r);
    } else {
      r.passed = false;
    }
  }

  const meta: StageMeta = {
    scored: scored.length,
    survived: survivors.length,
    thresholdScore,
    budgetMs: Date.now() - start,
    partial: budgetExceeded,
    warnings,
  };

  log?.info('stage2_complete', {
    scored: meta.scored,
    gated: gatedPool.length,
    survived: meta.survived,
    thresholdScore: meta.thresholdScore,
    budgetMs: meta.budgetMs,
    partial: meta.partial,
    warnings: warnings.length,
  });

  return { results, survivors, meta };
}

// ---------------------------------------------------------------------------
// Per-ticker quality bundle + earnings-quality gate
// ---------------------------------------------------------------------------

function computeFundBundle(
  ticker: string,
  fund: Awaited<ReturnType<typeof getFundamentals>>,
  intel: Awaited<ReturnType<typeof getEarningsIntel>> | null,
  bars: Bar[],
  spyBars: Bar[],
): FundBundle {
  // Multiple expansion — uses TTM-to-TTM for apples-to-apples (priorTtmEps,
  // not the single-quarter priorEps).
  let peExpansion: number | undefined;
  if (fund?.priorTtmEps && fund.priorTtmEps > 0 && bars.length >= 252 && fund.ttmEps && fund.ttmEps > 0) {
    const yearAgoBar = bars[bars.length - 252];
    const latestBar = bars[bars.length - 1];
    if (yearAgoBar?.c && latestBar?.c) {
      const pe = latestBar.c / fund.ttmEps;
      const pe1y = yearAgoBar.c / fund.priorTtmEps;
      if (pe1y > 0) peExpansion = (pe - pe1y) / pe1y;
    }
  }

  // Margin trends (pp)
  const operatingMarginTrendPp =
    fund?.operatingMargin != null && fund?.priorOperatingMarginYoY != null
      ? (fund.operatingMargin - fund.priorOperatingMarginYoY) * 100
      : undefined;
  const grossMarginTrendPp =
    fund?.grossMargin != null && fund?.priorGrossMarginYoY != null
      ? (fund.grossMargin - fund.priorGrossMarginYoY) * 100
      : undefined;

  // RS vs SPY (60d return diff)
  let rsVsSpy: number | null = null;
  if (bars.length >= 60 && spyBars.length >= 60) {
    const bLast = bars[bars.length - 1]?.c;
    const bPrior = bars[bars.length - 60]?.c;
    const sLast = spyBars[spyBars.length - 1]?.c;
    const sPrior = spyBars[spyBars.length - 60]?.c;
    if (bLast && bPrior && sLast && sPrior && bPrior > 0 && sPrior > 0) {
      rsVsSpy = (bLast - bPrior) / bPrior - (sLast - sPrior) / sPrior;
    }
  }

  // Quality composite (0-100). Weighted toward Chad's priority signals.
  let qualityScore = 50; // neutral baseline

  const eps = fund?.epsGrowthYoY;
  if (eps != null) {
    if (eps > 0.50) qualityScore += 18;
    else if (eps > 0.25) qualityScore += 14;
    else if (eps > 0.10) qualityScore += 8;
    else if (eps > 0) qualityScore += 3;
    else if (eps < -0.10) qualityScore -= 15;
  }

  const rev = fund?.revenueGrowthYoY;
  if (rev != null) {
    if (rev > 0.20) qualityScore += 8;
    else if (rev > 0.10) qualityScore += 5;
    else if (rev > 0) qualityScore += 2;
    else if (rev < -0.05) qualityScore -= 8;
  }

  if (intel?.epsAcceleration != null) {
    if (intel.epsAcceleration > 0.10) qualityScore += 10;
    else if (intel.epsAcceleration > 0.03) qualityScore += 5;
    else if (intel.epsAcceleration < -0.15) qualityScore -= 8;
  }

  if (operatingMarginTrendPp != null) {
    if (operatingMarginTrendPp > 2) qualityScore += 8;
    else if (operatingMarginTrendPp > 0.5) qualityScore += 4;
    else if (operatingMarginTrendPp < -2) qualityScore -= 6;
  }

  if (peExpansion != null) {
    if (peExpansion > 0.20) qualityScore += 6;
    else if (peExpansion > 0.05) qualityScore += 3;
    else if (peExpansion < -0.15) qualityScore -= 5;
  }

  if (intel?.beatsLast4 != null) {
    if (intel.beatsLast4 >= 3) qualityScore += 6;
    else if (intel.beatsLast4 <= 1) qualityScore -= 4;
  }

  if (rsVsSpy != null) {
    if (rsVsSpy > 0.10) qualityScore += 5;
    else if (rsVsSpy < -0.10) qualityScore -= 5;
  }

  qualityScore = Math.max(0, Math.min(100, qualityScore));

  // Earnings-quality gate. Mirrors layerFundamental's gate but operates on
  // Stage 2's bundle. Lenient on missing data; strict on clearly weak signals.
  const gate = computeStage2Gate({
    eps,
    operatingMarginTrendPp,
    peExpansion,
    epsAcceleration: intel?.epsAcceleration,
    beatsLast4: intel?.beatsLast4,
  });

  return {
    ticker,
    epsGrowthYoY: fund?.epsGrowthYoY,
    revenueGrowthYoY: fund?.revenueGrowthYoY,
    operatingMarginTrendPp,
    grossMarginTrendPp,
    peExpansion,
    epsAcceleration: intel?.epsAcceleration,
    beatsLast4: intel?.beatsLast4 ?? null,
    rsVsSpy,
    qualityScore,
    gatePassed: gate.passed,
    gateReason: gate.reason,
  };
}

interface GateInput {
  eps?: number;
  operatingMarginTrendPp?: number;
  peExpansion?: number;
  epsAcceleration?: number;
  beatsLast4?: number | null;
}

export function computeStage2Gate(input: GateInput): { passed: boolean; reason: string } {
  const eps = input.eps;

  // Hard stop on deep earnings contraction.
  if (eps !== undefined && eps < -0.15) {
    return { passed: false, reason: 'eps_contraction_severe' };
  }

  // No EPS signal at all — let other signals decide via composite.
  if (eps === undefined) return { passed: true, reason: 'no_eps_signal' };

  // Anemic EPS growth — needs at least one quality offset to reach Stage 3.
  if (eps < 0.05) {
    const marginExpanding = (input.operatingMarginTrendPp ?? 0) > 1;
    const multipleExpanding = (input.peExpansion ?? 0) > 0.05;
    const accelerating = (input.epsAcceleration ?? 0) > 0.05;
    const beatsStreak = (input.beatsLast4 ?? 0) >= 3;
    if (!marginExpanding && !multipleExpanding && !accelerating && !beatsStreak) {
      return { passed: false, reason: 'eps_weak_no_quality_offsets' };
    }
  }

  return { passed: true, reason: 'ok' };
}
