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

// Weights sum to 1.0 over the analysts that produce real signal.
// Political analyst (Quiver: congress + lobbying + contracts) gets a
// meaningful slice because it captures academic-backed alpha
// (Ziobrowski senate studies) plus sector-specific signals (defense
// contract flow, regulatory-win lobbying) that the other analysts miss.
//
// Phase 4f-finish — macro-regime and patent-analyst are pinned to 0
// (permanent removal) per `reports/phase-4f/audit.md` § 2:
//   - macro-regime: `no_upstream` — the analyst computes
//     `score = 50 + macroBias * 20` but macroBias defaults to 0 and is
//     never set by any caller (the regime-classifier upstream was
//     never wired in). Score is literally constant 50 across all 3600
//     observations in the W1 audit.
//   - patent-analyst: `no_upstream` for russell2k (1 unique value
//     across 3600 obs); kept conservatively at 0 globally since the
//     audit had 0 largecap target snapshots and `composeWeights`
//     absorbs the 6% redistribution cleanly. Phase 4g can re-introduce
//     a per-universe weight if largecap patent signal is recovered.
//
// Live weights (8 analysts): tech 0.15 + sector 0.08 + fund 0.13 +
//   flow 0.10 + news 0.10 + earnings 0.07 + insider 0.14 + political 0.10
//   = 0.87. composeWeights rescales the surviving 8 to sum to 1.0 on
//   the actual scored set per ticker.
const ANALYST_WEIGHTS: Record<string, number> = {
  'technical-analyst': 0.15,
  'sector-rotation': 0.08,
  'fundamental-analyst': 0.13,
  'flow-analyst': 0.10,
  'news-sentiment': 0.10,
  'earnings-analyst': 0.07,
  'macro-regime': 0,        // REMOVED — no_upstream (see audit § 2)
  'insider-analyst': 0.14,
  'patent-analyst': 0,      // REMOVED — no_upstream (see audit § 2)
  'political-analyst': 0.10,
};

export interface TargetForOneOpts {
  ticker: string;
  barCache: BarCache;
  macroBias?: number; // -1 to 1, fed in from regime
}

export async function runAnalystsForTicker(opts: TargetForOneOpts): Promise<{
  target: Target | null;
  analysts: Record<string, AnalystOutput>;
}> {
  const { ticker, barCache, macroBias = 0 } = opts;
  const entry = findEntry(ticker);
  const sector = entry?.sector ?? 'Unknown';
  const bars = barCache[ticker] ?? [];
  const sectorEtf = SECTOR_ETFS[sector];
  const sectorBars = sectorEtf ? barCache[sectorEtf] ?? [] : [];
  const spyBars = barCache[SPY] ?? [];

  if (bars.length < 50) {
    return { target: null, analysts: {} };
  }

  const companyName = entry?.name ?? ticker;
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

  // Phase 4f W5 — Rescale weights to exclude no-data analysts so the
  // displayed contributions reflect the actual composite math. Without
  // this rescale the UI shows e.g. "Insider 50 (14% weight)" for an
  // analyst that contributed nothing (the screenshot bug).
  const noDataByAnalyst: Record<string, boolean> = {};
  for (const [name, a] of Object.entries(allAnalysts)) {
    if (a?.signals && (a.signals as { _noData?: boolean })._noData === true) {
      noDataByAnalyst[name] = true;
    }
  }
  const rescale = composeWeights({
    noDataByAnalyst,
    baseWeights: ANALYST_WEIGHTS,
  });

  // Build contributions (weighted score vector). No-data analysts get
  // an effective weight of 0 so the contribution row is honest about
  // not contributing; the UI badge layer can additionally render a
  // NO_DATA badge based on `_noData` in `signals`.
  const contributions: AnalystContribution[] = Object.entries(allAnalysts).map(([name, a]) => ({
    analyst: name,
    score: a.score,
    direction: a.direction,
    weight: +rescale.effectiveWeights[name].toFixed(6),
  }));

  // Net direction: weighted signed score. Use the rescaled effective
  // weights so removing a no-data analyst correctly redistributes its
  // share to peers rather than dragging the composite toward 50.
  let netRaw = 0;
  let confTotal = 0;
  for (const [name, a] of Object.entries(allAnalysts)) {
    const w = rescale.effectiveWeights[name] ?? 0;
    if (w === 0) continue; // skip no-data
    const signed = a.direction === 'long' ? a.score - 50 : a.direction === 'short' ? -(a.score - 50) : 0;
    netRaw += signed * w * a.confidence;
    confTotal += w * a.confidence;
  }
  const signedNet = confTotal > 0 ? netRaw / confTotal : 0; // -50 to +50

  const composite = Math.round(Math.min(100, Math.max(0, 50 + Math.abs(signedNet) * 1.5)));
  const direction: Direction = signedNet > 4 ? 'long' : signedNet < -4 ? 'short' : 'neutral';
  const tier: Tier = composite >= 85 ? 'A' : composite >= 70 ? 'B' : 'C';

  // Conflict detection: how many analysts disagree with net direction?
  let disagree = 0;
  for (const a of Object.values(allAnalysts)) {
    if (a.confidence < 0.2) continue;
    if (direction === 'long' && a.direction === 'short') disagree++;
    if (direction === 'short' && a.direction === 'long') disagree++;
  }
  const conflictLevel: ConflictLevel = disagree >= 3 ? 'severe' : disagree === 2 ? 'moderate' : disagree === 1 ? 'mild' : 'none';

  // Top signals: highest-contributing analysts
  const topSignals: TopSignal[] = contributions
    .filter((c) => (direction === 'long' && c.direction === 'long') || (direction === 'short' && c.direction === 'short'))
    .sort((a, b) => b.score - a.score)
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
    scoredAnalysts: rescale.scoredAnalysts,
    noDataAnalysts: rescale.noDataAnalysts,
  };

  return { target, analysts: allAnalysts };
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

function buildRationale(
  direction: Direction,
  contributions: AnalystContribution[],
  analysts: Record<string, AnalystOutput>,
): string {
  const aligned = contributions.filter((c) => c.direction === direction).length;
  const leading = contributions
    .filter((c) => c.direction === direction && analysts[c.analyst].confidence > 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const reasons = leading.map((c) => analysts[c.analyst].rationale).filter(Boolean).slice(0, 2).join('. ');
  const prefix = direction === 'long' ? `Net long: ${aligned} analysts aligned bullish.`
    : direction === 'short' ? `Net short: ${aligned} analysts aligned bearish.`
    : 'Neutral: mixed signals.';
  return reasons ? `${prefix} ${reasons}` : prefix;
}
