// Catalyst scorer — unifies insider, patent, political (congress+lobbying+
// contracts), and technical setup signals into a single "catalyst conviction"
// score used across the app.
//
// Weights reflect the combination of evidence strength and data freshness:
//   - Insider cluster buys carry ~4% annualized alpha (Cohen et al., 2012)
//     and the data is fresh (Form 4 within 2 business days).
//   - Political footprint has academic backing (Ziobrowski senate alpha,
//     lobbying-to-regulation studies) and is highly actionable for specific
//     sectors — but noisier across the general market.
//   - Patent velocity is a 12-24-month forward-looking fundamental signal;
//     weaker for day-to-day timing but strong for "is this company building
//     a moat" questions.
//   - Technical setups are the TIMING amplifier — they don't create a
//     thesis, they sharpen when to act on one.

import type { InsiderActivity } from './insider-provider';
import type { PatentActivity } from './patent-provider';
import type { PoliticalActivity } from './political-provider';
import type { GovContractActivity } from './govcontracts-provider';
import type { TechnicalSetup } from './technical-setups';
import { scoreInsiderActivity } from './insider-provider';
import { scorePatentActivity } from './patent-provider';
import { scorePoliticalActivity } from './political-provider';
import { scoreGovContractActivity } from './govcontracts-provider';
import { scoreSetups } from './technical-setups';

export interface CatalystScore {
  ticker: string;
  composite: number;
  conviction: 'high' | 'medium' | 'low';
  direction: 'long' | 'short' | 'neutral';
  rationale: string;
  tags: string[];
  components: {
    insider: { score: number; confidence: number; rationale: string };
    patent: { score: number; confidence: number; rationale: string };
    political: { score: number; confidence: number; rationale: string };
    contracts: { score: number; confidence: number; rationale: string };
    setup: { score: number; direction: string };
  };
  hasClusterBuy: boolean;
  hasPatentBurst: boolean;
  hasPoliticalTailwind: boolean;
  hasContractWin: boolean;
  hasStackedSetup: boolean;
  generatedAt: string;
}

export interface CatalystScoreInput {
  ticker: string;
  insider: InsiderActivity;
  patents: PatentActivity;
  political: PoliticalActivity;
  contracts: GovContractActivity;
  setups: TechnicalSetup[];
}

// IMPORTANT — weights rebalanced in v0.7.23 because Quiver's `allpatents`
// dataset is subscription-gated on this account (returns 403). The patent
// component therefore always returns score 50 / confidence 0.1, contributing
// effectively nothing. Old weights summed to 1.0 with patent at 0.15; new
// weights redistribute that 0.15 across the live signals proportionally to
// their original allocation strength:
//   - insider gets +0.07 (already the strongest signal; cluster-buy alpha
//     is the most-replicated finding in this stack)
//   - setup gets +0.05 (it's the timing layer that converts thesis into
//     entries; doubling down on it tightens entry quality)
//   - political gets +0.03 (the second-strongest data-backed signal —
//     congressional senate alpha + lobbying-to-regulation studies)
//   - contracts unchanged at 0.10 (the data is good but signal is sector-
//     concentrated in defense/cloud/biotech and doesn't deserve more weight
//     than insider/setup/political across the general market)
//   - patent stays in the math at 0.0 — keeping it as a structural zero so
//     re-enabling it later (Quiver tier upgrade or EDGAR direct) is one
//     line, not a refactor
const WEIGHTS = {
  insider: 0.42,    // was 0.35 — primary signal
  setup: 0.30,      // was 0.25 — timing amplifier
  political: 0.18,  // was 0.15
  contracts: 0.10,  // unchanged
  patent: 0.00,     // was 0.15, dataset gated
};

export function scoreCatalysts(input: CatalystScoreInput): CatalystScore {
  const { ticker, insider, patents, political, contracts, setups } = input;

  const ins = scoreInsiderActivity(insider);
  const pat = scorePatentActivity(patents);
  const pol = scorePoliticalActivity(political);
  const con = scoreGovContractActivity(contracts);
  const set = scoreSetups(setups);

  const raw =
    (ins.score - 50) * ins.confidence * WEIGHTS.insider +
    (pat.score - 50) * pat.confidence * WEIGHTS.patent +
    (pol.score - 50) * pol.confidence * WEIGHTS.political +
    (con.score - 50) * con.confidence * WEIGHTS.contracts +
    (set.score - 50) * WEIGHTS.setup;

  const composite = Math.round(Math.max(0, Math.min(100, 50 + raw)));

  const hasClusterBuy = insider.clusters.length > 0;
  const hasPatentBurst = patents.velocityChangePct > 30 && patents.totalGrants >= 5;
  const hasPoliticalTailwind =
    (political.bipartisan && political.netTrades > 0) ||
    (political.netTrades >= 3) ||
    (political.lobbyingVelocityPct > 100 && political.totalLobbyingDollars > 500_000);
  const hasContractWin =
    contracts.totalDollars > 100_000_000 ||
    (contracts.velocityChangePct > 100 && contracts.totalDollars > 10_000_000) ||
    ((contracts.largestContract?.amount ?? 0) > 500_000_000);
  const hasStackedSetup = setups.length >= 2;

  const signalCount = [
    hasClusterBuy,
    hasPatentBurst,
    hasPoliticalTailwind,
    hasContractWin,
    hasStackedSetup,
  ].filter(Boolean).length;

  const conviction: 'high' | 'medium' | 'low' =
    signalCount >= 3 ? 'high' : signalCount >= 1 ? 'medium' : 'low';

  // Direction: if insider and political agree, trust them. Otherwise defer
  // to the setup direction unless it contradicts a strong insider signal.
  const insDir = ins.score > 55 ? 'long' : ins.score < 45 ? 'short' : 'neutral';
  const polDir = pol.score > 55 ? 'long' : pol.score < 45 ? 'short' : 'neutral';
  let direction: 'long' | 'short' | 'neutral' = 'neutral';
  if (insDir === polDir && insDir !== 'neutral') direction = insDir;
  else if (insDir === 'long' || polDir === 'long') {
    direction = set.direction === 'short' ? 'neutral' : 'long';
  } else if (insDir === 'short' || polDir === 'short') {
    direction = set.direction === 'long' ? 'neutral' : 'short';
  } else {
    direction = set.direction;
  }

  const tags = [
    ...ins.tags,
    ...pol.tags,
    ...con.tags,
    ...pat.tags,
    ...set.tags,
  ].slice(0, 7);

  const rationaleParts: string[] = [];
  if (hasClusterBuy) rationaleParts.push(ins.rationale);
  if (hasPoliticalTailwind) rationaleParts.push(pol.rationale);
  if (hasContractWin) rationaleParts.push(con.rationale);
  if (hasPatentBurst) rationaleParts.push(pat.rationale);
  if (hasStackedSetup) rationaleParts.push(`${setups.length} setups: ${set.tags.join(', ')}`);
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
      political: { score: pol.score, confidence: pol.confidence, rationale: pol.rationale },
      contracts: { score: con.score, confidence: con.confidence, rationale: con.rationale },
      setup: { score: set.score, direction: set.direction },
    },
    hasClusterBuy,
    hasPatentBurst,
    hasPoliticalTailwind,
    hasContractWin,
    hasStackedSetup,
    generatedAt: new Date().toISOString(),
  };
}
