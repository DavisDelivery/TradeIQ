// Political analyst — the Quiver-only differentiated signal.
//
// Blends three data streams into a single "political tailwind" score for
// a ticker: congressional trades, corporate lobbying spend, and federal
// contract awards. Each one alone is noisy; the stack is where the signal
// lives.
//
// Example configurations this is designed to catch:
//   - Defense ticker where DoD contracts are accelerating AND defense-
//     committee senators are disclosing buys = very loud tailwind.
//   - Health-tech where lobbying spend surged a quarter ahead of a Medicare
//     rule change = regulatory-win setup.
//   - Mega-cap cloud provider landing a major IDIQ cloud contract = direct
//     revenue visibility before the earnings print.

import type { AnalystOutput, Direction } from '../shared/types';
import type { PoliticalActivity } from '../shared/political-provider';
import type { GovContractActivity } from '../shared/govcontracts-provider';
import { scorePoliticalActivity } from '../shared/political-provider';
import { scoreGovContractActivity } from '../shared/govcontracts-provider';

export function runPolitical(
  political: PoliticalActivity | null,
  contracts: GovContractActivity | null,
): AnalystOutput {
  const pol = political ? scorePoliticalActivity(political) : {
    score: 50, confidence: 0, rationale: 'no political data', tags: [],
  };
  const con = contracts ? scoreGovContractActivity(contracts) : {
    score: 50, confidence: 0, rationale: 'no contract data', tags: [],
  };

  // Combined — 60% political (congress trades + lobbying), 40% contracts.
  // Congress trades carry academic alpha evidence; contracts are more
  // situationally important (matter a lot for defense names, nothing for
  // most consumer tickers).
  const combinedDev =
    (pol.score - 50) * pol.confidence * 0.6 +
    (con.score - 50) * con.confidence * 0.4;
  const score = Math.round(Math.max(0, Math.min(100, 50 + combinedDev * 2)));
  const confidence = Math.min(1, pol.confidence * 0.6 + con.confidence * 0.4);
  const direction: Direction = score > 60 ? 'long' : score < 40 ? 'short' : 'neutral';

  const rationaleParts: string[] = [];
  if (pol.rationale && pol.rationale !== 'no political activity' && pol.rationale !== 'no political data') {
    rationaleParts.push(pol.rationale);
  }
  if (con.rationale && con.rationale !== 'no recent federal contracts' && con.rationale !== 'no contract data') {
    rationaleParts.push(con.rationale);
  }

  return {
    score,
    direction,
    confidence,
    rationale: rationaleParts.join(' · ') || 'minor political footprint',
    signals: {
      congressNetTrades: political?.netTrades ?? 0,
      congressUniquePoliticians: political?.uniquePoliticians ?? 0,
      bipartisan: political?.bipartisan ?? false,
      lobbyingDollars: political?.totalLobbyingDollars ?? 0,
      lobbyingVelocityPct: political?.lobbyingVelocityPct ?? 0,
      contractDollars: contracts?.totalDollars ?? 0,
      contractVelocityPct: contracts?.velocityChangePct ?? 0,
      largestContract: contracts?.largestContract?.amount ?? 0,
    },
  };
}
