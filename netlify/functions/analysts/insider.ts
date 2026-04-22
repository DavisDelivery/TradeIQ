// Insider analyst — wraps insider-provider into the AnalystOutput shape
// used by the runner. This is what makes the target board automatically
// surface tickers with cluster insider buying.

import type { InsiderActivity } from '../shared/insider-provider';
import { scoreInsiderActivity } from '../shared/insider-provider';
import type { AnalystOutput, Direction } from '../shared/types';

export function runInsider(activity: InsiderActivity): AnalystOutput {
  const s = scoreInsiderActivity(activity);
  const direction: Direction =
    s.score > 60 ? 'long' : s.score < 40 ? 'short' : 'neutral';

  return {
    score: s.score,
    direction,
    confidence: s.confidence,
    rationale: s.rationale,
    signals: {
      totalBuys: activity.totalBuys,
      totalSells: activity.totalSells,
      netDollars: Math.round(activity.netDollars),
      uniqueBuyers: activity.uniqueBuyers,
      clusterCount: activity.clusters.length,
      biggestCluster: activity.clusters[0]?.buyerCount ?? 0,
      firstBuyInAYear: activity.firstBuyInAYear,
      latestBuyDate: activity.latestBuy?.date,
      latestBuyDollars: activity.latestBuy?.dollars,
      latestBuyRole: activity.latestBuy?.role,
    },
  };
}
