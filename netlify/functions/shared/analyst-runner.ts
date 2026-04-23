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

// Weights sum to 1.0. Political analyst (Quiver-only: congress + lobbying +
// contracts) gets a meaningful slice because it captures academic-backed
// alpha (Ziobrowski senate studies) plus sector-specific signals (defense
// contract flow, regulatory-win lobbying) that the other analysts miss.
const ANALYST_WEIGHTS: Record<string, number> = {
  'technical-analyst': 0.15,
  'sector-rotation': 0.08,
  'fundamental-analyst': 0.13,
  'flow-analyst': 0.10,
  'news-sentiment': 0.10,
  'earnings-analyst': 0.07,
  'macro-regime': 0.07,
  'insider-analyst': 0.14,
  'patent-analyst': 0.06,
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
  const ins = insiderActivity ? runInsider(insiderActivity) : {
    score: 50, direction: 'neutral' as Direction, confidence: 0,
    rationale: 'insider data unavailable', signals: {},
  };
  const pat = patentActivity ? runPatents(patentActivity) : {
    score: 50, direction: 'neutral' as Direction, confidence: 0,
    rationale: 'patent data unavailable', signals: {},
  };
  const pol = runPolitical(politicalActivity, contractActivity);

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

  // Build contributions (weighted score vector)
  const contributions: AnalystContribution[] = Object.entries(allAnalysts).map(([name, a]) => ({
    analyst: name,
    score: a.score,
    direction: a.direction,
    weight: ANALYST_WEIGHTS[name] ?? 0.1,
  }));

  // Net direction: weighted signed score
  let netRaw = 0;
  let confTotal = 0;
  for (const [name, a] of Object.entries(allAnalysts)) {
    const w = ANALYST_WEIGHTS[name] ?? 0.1;
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
