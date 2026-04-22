// Patent analyst — wraps patent-provider into the standard AnalystOutput
// shape. Patent signals are always bullish-biased (you don't short a company
// for NOT filing patents), so neutral-or-long is the only outcome.

import type { PatentActivity } from '../shared/patent-provider';
import { scorePatentActivity } from '../shared/patent-provider';
import type { AnalystOutput, Direction } from '../shared/types';

export function runPatents(activity: PatentActivity): AnalystOutput {
  const s = scorePatentActivity(activity);
  const direction: Direction = s.score > 60 ? 'long' : 'neutral';

  return {
    score: s.score,
    direction,
    confidence: s.confidence,
    rationale: s.rationale,
    signals: {
      totalGrants: activity.totalGrants,
      grantsLast30d: activity.grantsLast30d,
      grantsLast90d: activity.grantsLast90d,
      velocityChangePct: activity.velocityChangePct,
      highValueGrants: activity.highValueGrants,
      topCpcGroup: activity.topCpcGroups[0]?.group,
    },
  };
}
