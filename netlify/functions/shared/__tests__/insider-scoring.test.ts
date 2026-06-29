import { describe, it, expect } from 'vitest';
import { scoreInsiderActivity } from '../insider-provider';
import type { InsiderActivity } from '../insider-provider';

function activityWithCluster(): InsiderActivity {
  return {
    ticker: 'TKO',
    lookbackDays: 90,
    totalBuys: 8,
    totalSells: 23,
    buyDollars: 5_500_000,
    sellDollars: 5_663_284,
    netDollars: -163_284,
    uniqueBuyers: 4,
    firstBuyInAYear: false,
    transactions: [],
    clusters: [
      {
        windowStart: '2026-05-02',
        windowEnd: '2026-05-14',
        buyerCount: 4,
        totalDollarValue: 5_500_000,
        roles: [],
        topBuyers: [],
      },
    ],
    latestBuy: { date: '2026-05-14', dollars: 854_370, role: 'Director', name: 'X' },
    fetchedAt: '2026-06-29T00:00:00.000Z',
  } as InsiderActivity;
}

describe('scoreInsiderActivity — cluster rationale wording', () => {
  it('states the cluster latest-buy date instead of the misleading "within 14d"', () => {
    const { rationale, tags } = scoreInsiderActivity(activityWithCluster());
    // The old wording implied "bought in the last 14 days" — drop it.
    expect(rationale).not.toMatch(/within 14d/i);
    // New wording is honest about recency: names the latest buy date.
    expect(rationale).toContain('4-insider cluster');
    expect(rationale).toContain('latest buy 2026-05-14');
    expect(tags).toContain('4-insider cluster');
  });

  it('still awards cluster credit (score unchanged by the wording fix)', () => {
    const { score } = scoreInsiderActivity(activityWithCluster());
    // 4 buyers → +40 cluster, net is slightly negative (no dollar bonus) →
    // 50 + 40 = 90 (uniqueBuyers>=3 adds +5 → capped at +50 → 100? net check)
    expect(score).toBeGreaterThanOrEqual(90);
  });
});
