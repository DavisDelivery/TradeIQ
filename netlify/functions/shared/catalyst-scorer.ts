// Catalyst scorer — unifies insider activity, patent momentum, and technical
// setup detection into a single "catalyst conviction" score that every view
// in the app can use.
//
// The central idea: insiders and patents are CATALYSTS (fundamental signals
// that the stock should move) and technical setups are TIMING (when to act).
// A catalyst without a setup is an investment; a setup without a catalyst is
// a trade; both together is the high-conviction sweet spot.
//
// Weights reflect predictive power from published research:
//   Insider cluster buys ~ 4% annualized alpha (Cohen et al., 2012)
//   Patent count alone ~ weak, but patent VELOCITY in high-value CPC codes
//     correlates with 2-year forward returns (Hirshleifer et al., 2013)
//   Technical setups ~ high hit rate on the entry but no long-term edge
//     standalone; they're amplifiers of the fundamental signal.

import type { InsiderActivity } from './insider-provider';
import type { PatentActivity } from './patent-provider';
import type { TechnicalSetup } from './technical-setups';
import { scoreInsiderActivity } from './insider-provider';
import { scorePatentActivity } from './patent-provider';
import { scoreSetups } from './technical-setups';

export interface CatalystScore {
  ticker: string;
  composite: number;          // 0-100
  conviction: 'high' | 'medium' | 'low';
  direction: 'long' | 'short' | 'neutral';
  rationale: string;
  tags: string[];             // flat list of badge labels for UI
  components: {
    insider: { score: number; confidence: number; rationale: string };
    patent: { score: number; confidence: number; rationale: string };
    setup: { score: number; direction: string };
  };
  hasClusterBuy: boolean;
  hasPatentBurst: boolean;
  hasStackedSetup: boolean;   // 2+ technical setups active simultaneously
  generatedAt: string;
}

export interface CatalystScoreInput {
  ticker: string;
  insider: InsiderActivity;
  patents: PatentActivity;
  setups: TechnicalSetup[];
}

const WEIGHTS = {
  insider: 0.45,
  patent: 0.25,
  setup: 0.30,
};

export function scoreCatalysts(input: CatalystScoreInput): CatalystScore {
  const { ticker, insider, patents, setups } = input;

  const ins = scoreInsiderActivity(insider);
  const pat = scorePatentActivity(patents);
  const set = scoreSetups(setups);

  // Weighted composite — convert each 0-100 to deviation from 50, weight, sum.
  const insDev = (ins.score - 50) * ins.confidence;
  const patDev = (pat.score - 50) * pat.confidence;
  const setDev = set.score - 50; // setups don't carry a confidence score; strength is in the setup itself

  const raw =
    insDev * WEIGHTS.insider +
    patDev * WEIGHTS.patent +
    setDev * WEIGHTS.setup;

  const composite = Math.round(Math.max(0, Math.min(100, 50 + raw)));

  const hasClusterBuy = insider.clusters.length > 0;
  const hasPatentBurst = patents.velocityChangePct > 30 && patents.totalGrants >= 5;
  const hasStackedSetup = setups.length >= 2;

  // Conviction tier — a catalyst-heavy ticker with a setup is high conviction;
  // only one signal is medium; nothing aligned is low.
  const signalCount = [hasClusterBuy, hasPatentBurst, hasStackedSetup].filter(Boolean).length;
  const conviction: 'high' | 'medium' | 'low' =
    signalCount >= 2 ? 'high' : signalCount === 1 ? 'medium' : 'low';

  // Direction comes from insider + setup agreement. Patents are directionless
  // (always bullish if positive). If insider and setup disagree, go neutral.
  let direction: 'long' | 'short' | 'neutral' = 'neutral';
  const insDirection = ins.score > 55 ? 'long' : ins.score < 45 ? 'short' : 'neutral';
  if (insDirection === 'long' && (set.direction === 'long' || set.direction === 'neutral')) direction = 'long';
  else if (insDirection === 'short' && (set.direction === 'short' || set.direction === 'neutral')) direction = 'short';
  else if (insDirection === 'neutral') direction = set.direction;
  else direction = 'neutral'; // insider and setup disagree

  const tags = [
    ...ins.tags,
    ...pat.tags,
    ...set.tags,
  ].slice(0, 6);

  const rationaleParts: string[] = [];
  if (hasClusterBuy) rationaleParts.push(ins.rationale);
  if (hasPatentBurst) rationaleParts.push(pat.rationale);
  if (hasStackedSetup) rationaleParts.push(`${setups.length} technical setups: ${set.tags.join(', ')}`);
  else if (setups.length === 1) rationaleParts.push(set.tags[0]);

  return {
    ticker,
    composite,
    conviction,
    direction,
    rationale: rationaleParts.join(' · ') || 'no major catalysts active',
    tags,
    components: {
      insider: { score: ins.score, confidence: ins.confidence, rationale: ins.rationale },
      patent: { score: pat.score, confidence: pat.confidence, rationale: pat.rationale },
      setup: { score: set.score, direction: set.direction },
    },
    hasClusterBuy,
    hasPatentBurst,
    hasStackedSetup,
    generatedAt: new Date().toISOString(),
  };
}
