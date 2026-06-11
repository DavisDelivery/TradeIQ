// Runs all analysts for a single ticker, composes Target.

import { getDailyBars, getFundamentals, getNews, getUpcomingEarnings, getEarningsHistory } from './data-provider';
import { runTechnical } from '../analysts/technical';
import { runSectorRotation } from '../analysts/sector-rotation';
import { runFundamental, runFlow, runEarnings, runNewsSentiment } from '../analysts/core';
import { runInsider } from '../analysts/insider';
import { runPatents } from '../analysts/patents';
import { runPolitical } from '../analysts/political';
import { getInsiderActivity } from './insider-provider';
import { getPatentActivity } from './patent-provider';
import { getPoliticalActivity } from './political-provider';
import { getGovContractActivity } from './govcontracts-provider';
import { SECTOR_ETFS, SPY, findEntry } from './universe';
import { ANALYST_WEIGHTS } from './analyst-weights';
import type { AnalystOutput, Direction, Target, Tier, ConflictLevel, AnalystContribution, TopSignal } from './types';
import { composeWeights } from './compose-weights';
import type { Bar } from './data-provider';

interface BarCache {
  [ticker: string]: Bar[];
}

export async function fetchBarCache(
  tickers: string[],
  daysBack: number = 220,
): Promise<BarCache> {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
  const needed = new Set<string>([SPY, ...tickers]);
  for (const t of tickers) {
    const e = findEntry(t);
    if (e && SECTOR_ETFS[e.sector]) needed.add(SECTOR_ETFS[e.sector]);
  }
  const cache: BarCache = {};
  const list = Array.from(needed);
  // Concurrency 4 — at 8 we hit DNS cache overflow on larger universes (russell2k scan).
  const concurrency = 4;
  for (let i = 0; i < list.length; i += concurrency) {
    const chunk = list.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map((s) =>
        getDailyBars(s, from, to).then((bars) => [s, bars] as const).catch(() => [s, [] as Bar[]] as const),
      ),
    );
    for (const [s, bars] of results) cache[s] = bars;
  }
  return cache;
}

// Weight table extracted to shared/analyst-weights.ts (single source of
// truth — analysts-status.ts derives its registry weights from the same
// module). See that file for the full rationale + Phase 4f removal notes.

export interface TargetForOneOpts {
  ticker: string;
  barCache: BarCache;
  macroBias?: number; // -1 to 1, fed in from regime
  /** Phase 4h W3 — caller-supplied company name (Polygon ticker-reference
   *  cache). When omitted, the per-ticker scorer falls back to the in-repo
   *  universe table. Bulk scans pre-fetch a name map to avoid 2k Polygon
   *  round trips at scoring time. */
  companyName?: string;
}

export async function runAnalystsForTicker(opts: TargetForOneOpts): Promise<{
  target: Target | null;
  analysts: Record<string, AnalystOutput>;
}> {
  const { ticker, barCache, macroBias = 0 } = opts;
  const entry = findEntry(ticker);
  const sector = entry?.sector ?? 'Unknown';
  // Phase 4h W3 — persisted sector mirrors the value sector-rotation
  // already uses for its sector-ETF lookup, so taxonomy stays in lock-step.
  const persistedSector: string | null = entry?.sector ?? null;
  const bars = barCache[ticker] ?? [];
  const sectorEtf = SECTOR_ETFS[sector];
  const sectorBars = sectorEtf ? barCache[sectorEtf] ?? [] : [];
  const spyBars = barCache[SPY] ?? [];

  if (bars.length < 50) {
    return { target: null, analysts: {} };
  }

  // Phase 4h W3 — prefer caller-supplied (Polygon-cached) name; fall
  // back to the in-repo universe table. Used for patent fuzzy match
  // AND persisted onto the Target for UI display.
  const companyName = opts.companyName ?? entry?.name ?? ticker;
  const [fundamentals, news, upcoming, history, insiderActivity, patentActivity, politicalActivity, contractActivity] = await Promise.all([
    getFundamentals(ticker).catch(() => null),
    getNews(ticker, 15).catch(() => []),
    getUpcomingEarnings(ticker, 45).catch(() => null),
    getEarningsHistory(ticker, 4).catch(() => []),
    getInsiderActivity(ticker, 90).catch(() => null),
    getPatentActivity(ticker, companyName, 180).catch(() => null),
    getPoliticalActivity(ticker, 180).catch(() => null),
    getGovContractActivity(ticker, 180).catch(() => null),
  ]);

  const tech = runTechnical(bars);
  const sec = runSectorRotation(bars, sectorBars, spyBars, sector);
  const fun = runFundamental(fundamentals);
  const flow = runFlow(bars);
  const earn = runEarnings(upcoming, history);
  const news_ = runNewsSentiment(news);
  // Phase 4f W3 — null-default repair. When upstream activity is
  // missing, mark the analyst as no-data via `signals._noData` rather
  // than emitting score:50 (the historical stub the screenshot
  // surfaced). The composite math + UI both consume the flag below.
  const ins: AnalystOutput = insiderActivity
    ? runInsider(insiderActivity)
    : {
        score: 50,
        direction: 'neutral' as Direction,
        confidence: 0,
        rationale: 'insider data unavailable',
        signals: { _noData: true, _reason: 'no_data' },
      };
  const pat: AnalystOutput = patentActivity
    ? runPatents(patentActivity)
    : {
        score: 50,
        direction: 'neutral' as Direction,
        confidence: 0,
        rationale: 'patent data unavailable',
        signals: { _noData: true, _reason: 'no_data' },
      };
  // Political analyst — if BOTH political and contract activity are
  // null, mark as no-data; otherwise let `runPolitical` produce its
  // real signal (it handles partial nulls internally).
  let pol: AnalystOutput;
  if (politicalActivity == null && contractActivity == null) {
    pol = {
      score: 50,
      direction: 'neutral' as Direction,
      confidence: 0,
      rationale: 'political + contract data unavailable',
      signals: { _noData: true, _reason: 'no_data' },
    };
  } else {
    pol = runPolitical(politicalActivity, contractActivity);
  }

  // Macro-regime analyst: just a constant biased nudge from the regime layer
  const macroScore = Math.round(50 + macroBias * 20);
  const macroDir: Direction = macroBias > 0.2 ? 'long' : macroBias < -0.2 ? 'short' : 'neutral';
  const macro: AnalystOutput = {
    score: macroScore,
    direction: macroDir,
    confidence: Math.abs(macroBias),
    rationale: macroDir === 'long' ? 'risk-on tailwind' : macroDir === 'short' ? 'risk-off headwind' : 'neutral macro',
    signals: { bias: macroBias },
  };

  const allAnalysts: Record<string, AnalystOutput> = {
    'technical-analyst': tech,
    'sector-rotation': sec,
    'fundamental-analyst': fun,
    'flow-analyst': flow,
    'news-sentiment': news_,
    'earnings-analyst': earn,
    'macro-regime': macro,
    'insider-analyst': ins,
    'patent-analyst': pat,
    'political-analyst': pol,
  };

  const composed = composeTarget(allAnalysts, ANALYST_WEIGHTS);
  const {
    composite,
    tier,
    direction,
    conflictLevel,
    contributions,
    scoredAnalysts,
    noDataAnalysts,
  } = composed;

  // Top signals: strongest-contributing aligned analysts
  const topSignals: TopSignal[] = contributions
    .filter((c) => (direction === 'long' && c.direction === 'long') || (direction === 'short' && c.direction === 'short'))
    .sort(byEvidenceStrength(direction))
    .slice(0, 3)
    .map((c) => ({ type: signalTypeFor(c.analyst, direction), score: c.score }));

  const rationale = buildRationale(direction, contributions, allAnalysts);

  const latest = bars.at(-1)!;
  const prev = bars.at(-2);
  const priceChangePct = prev ? ((latest.c - prev.c) / prev.c) * 100 : 0;

  const target: Target = {
    ticker,
    composite,
    tier,
    direction,
    price: +latest.c.toFixed(2),
    priceChangePct: +priceChangePct.toFixed(2),
    rationale,
    analystContributions: contributions,
    topSignals,
    conflictLevel,
    scoredAt: new Date().toISOString(),
    scoredAnalysts,
    noDataAnalysts,
    companyName,
    sector: persistedSector,
  };

  return { target, analysts: allAnalysts };
}

// ---------------------------------------------------------------------------
// composeTarget — pure composite-scoring math
// ---------------------------------------------------------------------------
//
// Phase 4s — extracted from runAnalystsForTicker so the composite/tier/
// direction/conflict math is unit-testable without spinning up the data
// providers. Inputs are the per-analyst outputs already produced by the
// runner; outputs are the fields the Target object needs.
//
// The math, in order of operations:
//
//   1. Identify no-data analysts (signals._noData === true) and rescale
//      the base weights via composeWeights so the survivors sum to 1.
//   2. Compute signedNet — the confidence-weighted bullishness deviation
//      from neutral, in [-50, +50]. Every analyst contributes
//      `signed = score - 50`; per `reports/phase-4s/contract.md` (W1)
//      `score` is a 0-100 bullishness scale (50 neutral), so bearish
//      analysts contribute negative and bullish analysts contribute
//      positive, regardless of the `direction` label. The previous
//      sign-from-direction formula flipped bearish analysts positive
//      (the O-I Glass bug).
//   3. Derive `direction` from signedNet — long > +4, short < -4, else
//      neutral.
//   4. Compute conflictLevel — count analysts whose direction
//      contradicts the net direction (confidence ≥ 0.2). ≥3 → severe,
//      2 → moderate, 1 → mild, 0 → none.
//   5. Compute the directional composite (NO Math.abs): `50 + signedNet
//      × 1.5`, dampened toward 50 by a conflict-scaled factor (severe
//      ×0.5, moderate ×0.75, else ×1.0). Clamped to [0, 100].
//   6. Compute the tier from composite (A ≥ 85, B ≥ 70, else C), capped
//      by conflictLevel — severe → max C, moderate → max B. Chad's
//      decision in Phase 4s: dampen the composite AND cap the tier on
//      severe/moderate conflict. A stock with five analysts fighting
//      each other gets an honest number AND an honest grade.
export interface ComposeTargetResult {
  composite: number;
  tier: Tier;
  direction: Direction;
  conflictLevel: ConflictLevel;
  signedNet: number;
  contributions: AnalystContribution[];
  scoredAnalysts: string[];
  noDataAnalysts: string[];
}

export function composeTarget(
  allAnalysts: Record<string, AnalystOutput>,
  baseWeights: Record<string, number>,
): ComposeTargetResult {
  const noDataByAnalyst: Record<string, boolean> = {};
  for (const [name, a] of Object.entries(allAnalysts)) {
    if (a?.signals && (a.signals as { _noData?: boolean })._noData === true) {
      noDataByAnalyst[name] = true;
    }
  }
  const rescale = composeWeights({ noDataByAnalyst, baseWeights });

  const contributions: AnalystContribution[] = Object.entries(allAnalysts).map(([name, a]) => ({
    analyst: name,
    score: a.score,
    direction: a.direction,
    weight: +(rescale.effectiveWeights[name] ?? 0).toFixed(6),
  }));

  let netRaw = 0;
  let confTotal = 0;
  for (const [name, a] of Object.entries(allAnalysts)) {
    const w = rescale.effectiveWeights[name] ?? 0;
    if (w === 0) continue; // skip no-data / zero-weighted
    const signed = a.score - 50; // -50..+50 bullishness deviation
    netRaw += signed * w * a.confidence;
    confTotal += w * a.confidence;
  }
  const signedNet = confTotal > 0 ? netRaw / confTotal : 0;

  const direction: Direction = signedNet > 4 ? 'long' : signedNet < -4 ? 'short' : 'neutral';

  let disagree = 0;
  for (const a of Object.values(allAnalysts)) {
    if (a.confidence < 0.2) continue;
    if (direction === 'long' && a.direction === 'short') disagree++;
    if (direction === 'short' && a.direction === 'long') disagree++;
  }
  const conflictLevel: ConflictLevel =
    disagree >= 3 ? 'severe' :
    disagree === 2 ? 'moderate' :
    disagree === 1 ? 'mild' : 'none';

  const dampenFactor: number =
    conflictLevel === 'severe' ? 0.5 :
    conflictLevel === 'moderate' ? 0.75 :
    1.0;
  const rawComposite = 50 + signedNet * 1.5;
  const composite = Math.round(Math.min(100, Math.max(0, 50 + (rawComposite - 50) * dampenFactor)));

  const baseTier: Tier = composite >= 85 ? 'A' : composite >= 70 ? 'B' : 'C';
  const tierRank: Record<Tier, number> = { A: 3, B: 2, C: 1 };
  const tierCapByConflict: Record<ConflictLevel, Tier> = {
    severe: 'C',
    moderate: 'B',
    mild: 'A',
    none: 'A',
  };
  const cap = tierCapByConflict[conflictLevel];
  const tier: Tier = tierRank[baseTier] <= tierRank[cap] ? baseTier : cap;

  return {
    composite,
    tier,
    direction,
    conflictLevel,
    signedNet,
    contributions,
    scoredAnalysts: rescale.scoredAnalysts,
    noDataAnalysts: rescale.noDataAnalysts,
  };
}

function signalTypeFor(analyst: string, direction: Direction): string {
  const lng = direction === 'long';
  switch (analyst) {
    case 'technical-analyst': return lng ? 'bullish_breakout' : 'bearish_breakdown';
    case 'flow-analyst': return lng ? 'unusual_call_activity' : 'unusual_put_activity';
    case 'news-sentiment': return lng ? 'positive_news_cluster' : 'negative_news_cluster';
    case 'fundamental-analyst': return lng ? 'fundamentals_strong' : 'fundamentals_weak';
    case 'sector-rotation': return lng ? 'sector_leadership' : 'sector_laggard';
    case 'earnings-analyst': return 'earnings_setup';
    case 'macro-regime': return lng ? 'risk_on' : 'risk_off';
    case 'insider-analyst': return lng ? 'insider_buying' : 'insider_selling';
    case 'patent-analyst': return 'patent_momentum';
    case 'political-analyst': return lng ? 'political_tailwind' : 'political_headwind';
    default: return analyst;
  }
}

// Orders aligned contributions by evidence strength. `score` is a 0-100
// bullishness scale (see composeTarget step 2), so the most convincing
// contributor for a long is the HIGHEST score but for a short it's the
// LOWEST — sorting descending for both directions made short candidates
// quote their least convincing analysts. Exported for the regression test.
export function byEvidenceStrength(direction: Direction) {
  return (a: AnalystContribution, b: AnalystContribution): number =>
    direction === 'short' ? a.score - b.score : b.score - a.score;
}

// Exported for the evidence-ordering regression test.
export function buildRationale(
  direction: Direction,
  contributions: AnalystContribution[],
  analysts: Record<string, AnalystOutput>,
): string {
  const aligned = contributions.filter((c) => c.direction === direction).length;
  const leading = contributions
    .filter((c) => c.direction === direction && analysts[c.analyst].confidence > 0.4)
    .sort(byEvidenceStrength(direction))
    .slice(0, 3);
  const reasons = leading.map((c) => analysts[c.analyst].rationale).filter(Boolean).slice(0, 2).join('. ');
  const prefix = direction === 'long' ? `Net long: ${aligned} analysts aligned bullish.`
    : direction === 'short' ? `Net short: ${aligned} analysts aligned bearish.`
    : 'Neutral: mixed signals.';
  return reasons ? `${prefix} ${reasons}` : prefix;
}
