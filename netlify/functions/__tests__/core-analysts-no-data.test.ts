// Phase 4f-finish W3 — verify the core analyst handlers correctly
// surface `signals._noData = true` when their upstream input is empty
// or insufficient. Without this flag the composite math
// (`composeWeights`) cannot rescale weights away from analysts that
// had nothing to score, and the score 50 they emit (a midpoint
// fallback) drags the composite toward neutrality.
//
// PR #27 fixed the screenshot-flagged analysts at the analyst-runner
// wrapper level (insider/patent/political). This PR extends the same
// honesty to the remaining four core handlers (`runEarnings`,
// `runNewsSentiment`, `runFundamental`, `runFlow`).

import { describe, it, expect } from 'vitest';
import {
  runFundamental,
  runFlow,
  runEarnings,
  runNewsSentiment,
} from '../analysts/core';
import type {
  Bar,
  FundamentalsSnapshot,
  NewsItem,
  UpcomingEarning,
  EarningsSurprise,
} from '../shared/data-provider';

const FAR_FUTURE_DATE = (() => {
  // 60 days from now — outside any of the earnings-timing thresholds
  // (≤5, ≤10, ≤21 days), so the upcoming branch should NOT contribute.
  const d = new Date(Date.now() + 60 * 86400000);
  return d.toISOString().slice(0, 10);
})();

const NEAR_FUTURE_DATE = (() => {
  // 4 days from now — fires the ≤5 day de-rate branch.
  const d = new Date(Date.now() + 4 * 86400000);
  return d.toISOString().slice(0, 10);
})();

function syntheticBars(n: number): Bar[] {
  const bars: Bar[] = [];
  const start = Date.UTC(2024, 0, 2);
  for (let i = 0; i < n; i++) {
    const c = 100 + Math.sin(i / 5) * 5 + i * 0.1;
    bars.push({
      t: start + i * 86_400_000,
      o: c - 0.5,
      h: c + 0.7,
      l: c - 0.7,
      c,
      v: 1_000_000 + i * 1000,
    });
  }
  return bars;
}

describe('runFundamental — _noData repair (Phase 4f-finish)', () => {
  it('marks _noData when input is null', () => {
    const out = runFundamental(null);
    expect(out.score).toBe(50);
    expect(out.signals._noData).toBe(true);
    expect(out.signals._reason).toBe('no_data');
    expect(out.confidence).toBe(0);
  });

  it('does NOT mark _noData when fundamentals are present', () => {
    const f: FundamentalsSnapshot = {
      ticker: 'AAPL',
      revenueGrowthYoY: 0.12,
      epsGrowthYoY: 0.18,
      operatingMargin: 0.28,
    };
    const out = runFundamental(f);
    expect(out.signals._noData).toBeUndefined();
    expect(out.score).toBeGreaterThan(50);
  });
});

describe('runFlow — _noData repair (Phase 4f-finish)', () => {
  it('marks _noData when bars.length < 30', () => {
    const out = runFlow(syntheticBars(10));
    expect(out.score).toBe(50);
    expect(out.signals._noData).toBe(true);
    expect(out.signals._reason).toBe('insufficient_bars');
  });

  it('does NOT mark _noData when enough bars are available', () => {
    const out = runFlow(syntheticBars(50));
    expect(out.signals._noData).toBeUndefined();
  });
});

describe('runEarnings — _noData repair (Phase 4f-finish)', () => {
  it('marks _noData when no upcoming AND no usable history', () => {
    const out = runEarnings(null, []);
    expect(out.score).toBe(50);
    expect(out.signals._noData).toBe(true);
    expect(out.signals._reason).toBe('no_actionable_data');
    expect(out.confidence).toBe(0);
  });

  it('marks _noData when upcoming is too far out AND history is empty', () => {
    const upcoming: UpcomingEarning = {
      ticker: 'XYZ',
      date: FAR_FUTURE_DATE,
    };
    const out = runEarnings(upcoming, []);
    expect(out.signals._noData).toBe(true);
    expect(out.signals.daysUntilEarnings).toBeGreaterThan(21);
  });

  it('does NOT mark _noData when upcoming earnings fall within 21d', () => {
    const upcoming: UpcomingEarning = {
      ticker: 'XYZ',
      date: NEAR_FUTURE_DATE,
    };
    const out = runEarnings(upcoming, []);
    expect(out.signals._noData).toBeUndefined();
    // Within ≤5 days, raw -= 30 → score < 50
    expect(out.score).toBeLessThan(50);
  });

  it('does NOT mark _noData when history is rich enough to contribute', () => {
    const history: EarningsSurprise[] = [
      { date: '2024-01-15', epsActual: 1.20, epsEstimate: 1.10 },
      { date: '2023-10-15', epsActual: 1.05, epsEstimate: 1.00 },
      { date: '2023-07-15', epsActual: 0.98, epsEstimate: 0.95 },
      { date: '2023-04-15', epsActual: 1.10, epsEstimate: 1.00 },
    ];
    const out = runEarnings(null, history);
    expect(out.signals._noData).toBeUndefined();
    expect(out.score).toBeGreaterThan(50);  // 4/4 beats → raw += 20
  });

  it('marks _noData when history has < 2 entries AND no upcoming', () => {
    const history: EarningsSurprise[] = [
      { date: '2024-01-15', epsActual: 1.20, epsEstimate: 1.10 },
    ];
    const out = runEarnings(null, history);
    expect(out.signals._noData).toBe(true);
  });
});

describe('runNewsSentiment — _noData repair (Phase 4f-finish)', () => {
  it('marks _noData when news array is empty', () => {
    const out = runNewsSentiment([]);
    expect(out.score).toBe(50);
    expect(out.signals._noData).toBe(true);
    expect(out.signals._reason).toBe('no_data');
    expect(out.signals.newsCount).toBe(0);
    expect(out.confidence).toBe(0);
  });

  it('does NOT mark _noData when news is present', () => {
    const news: NewsItem[] = [
      {
        id: '1',
        title: 'Company beats earnings, raises guidance',
        publishedUtc: new Date().toISOString(),
        url: 'https://example.com',
        tickers: ['XYZ'],
      },
    ];
    const out = runNewsSentiment(news);
    expect(out.signals._noData).toBeUndefined();
  });
});
