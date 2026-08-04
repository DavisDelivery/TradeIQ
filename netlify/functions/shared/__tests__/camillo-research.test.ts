// CAMILLO RESEARCH — the guards that keep an LLM read from becoming a claim.
//
// This repo's standing convention is that narrative confidence never
// outranks measured edge. An endpoint that lets a model write a fluent
// thesis about a stock is the sharpest test of that rule, so the contract
// is enforced in code:
//
//   - a malformed answer THROWS instead of rendering
//   - an unknown verdict THROWS (the enum cannot be widened by the model)
//   - an EMPTY `unverified` list THROWS — on evidence this thin, claiming
//     everything was verified is the overconfidence we are guarding against
//   - the prompt states the attention leg measured NO_EDGE

import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, parseRead, renderEvidence, type CamilloEvidence } from '../camillo-research';

const GOOD = {
  product: 'Sells casual footwear under two brands.',
  trend: 'Sales growth of 22% QoQ is the only real demand signal here.',
  materiality: 'Cannot be judged — no segment revenue in the evidence.',
  discovery: 'Institutional ownership at 45% leaves room.',
  readVerdict: 'WORTH_DIGGING',
  whyVerdict: 'Real growth, not yet crowded, but materiality is unknown.',
  falsifier: 'Next quarter sales growth decelerating below 5%.',
  nextChecks: ['Read the 10-K segment note', 'Check whether the brand is a top-3 revenue line'],
  unverified: ['segment revenue', 'whether any trend actually exists'],
};

const EVIDENCE: CamilloEvidence = {
  ticker: 'CROX',
  companyName: 'Crocs Inc',
  asOf: '2026-08-03',
  fundamentals: {
    ticker: 'CROX', sector: 'Consumer Cyclical',
    floatM: 47.7, marketCapM: 6360, instOwnPct: 45, insiderOwnPct: 8, insiderTransPct: -1.2,
    shortFloatPct: 8.4, salesGrowthQoQPct: 22, epsGrowthQoQPct: 15, price: 128, high52wDistPct: -12,
    avgVolume: 2440,
  } as any,
  attention: { article: 'Crocs', yoyPct: 41, momPct: 12, recentDailyMean: 1200 },
  googleTrends: {
    available: true, keyword: 'Crocs Inc', timeframe: 'today 12-m', geo: 'US',
    transport: 'serpapi' as const, points: [], recentVsBase: 8.4, reason: null, caveat: 'x',
  },
  offExchange: {
    ticker: 'CROX', available: true, asOf: '2026-08-03', days: 1209,
    volumeZ: 0.3, recentDailyVolume: 458685, dpiRecent: 0.698, dpiBase: 0.584,
    reason: null, caveat: 'no weight in any score',
  },
  mentions: {
    ticker: 'CROX', state: 'TRACKED', mentions: 1, mentions24hAgo: null, rank: 399,
    universeSize: 757, floor: 1, date: '2026-08-04', reason: null, caveat: 'no weight',
  },
  appRating: {
    available: true, appId: 1097106160, appName: 'Crocs', seller: 'Crocs Inc',
    rating: 4.73, ratingCount: 46441, ratingCurrentVersion: 4.73, ratingCountCurrentVersion: 46441,
    currentVersionReleaseDate: '2026-06-22', matchConfidence: 'HIGH', matchedOn: 'Crocs Inc',
    reason: null, caveat: 'no weight',
  },
  reviews: {
    available: true, appId: 1097106160, count: 100, spanDays: 72, truncated: false,
    recentPerDay: 1.29, priorPerDay: 1, velocityPct: 29, recentRating: 1.72, priorRating: 1.96,
    versionsInWindow: 2, newestReview: '2026-07-31', oldestReview: '2026-05-20',
    reason: null, caveat: 'no weight',
  },
  insiders: [{ date: '2026-08-01', owner: 'A Director', relationship: 'Director', transaction: 'Buy', valueUsd: 591000 }],
  news: [{ date: '2026-07-30', title: 'Crocs raises full-year guidance' }],
  nextEarnings: '2026-10-28',
  gaps: [],
};

describe('parseRead', () => {
  it('accepts a well-formed read', () => {
    expect(parseRead(JSON.stringify(GOOD)).readVerdict).toBe('WORTH_DIGGING');
  });

  it('tolerates a markdown fence', () => {
    expect(parseRead('```json\n' + JSON.stringify(GOOD) + '\n```').product).toBe(GOOD.product);
  });

  it('REJECTS an empty unverified list as overconfident', () => {
    expect(() => parseRead(JSON.stringify({ ...GOOD, unverified: [] })))
      .toThrow(/overconfident/i);
  });

  it('rejects a verdict outside the enum — the model cannot widen it', () => {
    expect(() => parseRead(JSON.stringify({ ...GOOD, readVerdict: 'STRONG_BUY' })))
      .toThrow(/unknown readVerdict/i);
  });

  it('rejects a missing narrative field rather than rendering a partial read', () => {
    for (const k of ['product', 'trend', 'materiality', 'discovery', 'falsifier']) {
      expect(() => parseRead(JSON.stringify({ ...GOOD, [k]: '' })), k).toThrow(new RegExp(k));
    }
  });

  it('rejects non-JSON', () => {
    expect(() => parseRead('Here is my analysis of CROX...')).toThrow(/did not return JSON/);
  });
});

describe('renderEvidence', () => {
  const block = renderEvidence(EVIDENCE);

  it('labels every section with its source', () => {
    expect(block).toMatch(/source: Finviz Elite/);
    expect(block).toMatch(/source: Wikipedia daily pageviews/);
    expect(block).toMatch(/SEC Form 4/);
  });

  it('carries the NO_EDGE warning next to the attention numbers', () => {
    expect(block).toMatch(/NO PREDICTIVE EDGE/);
  });

  it('says "unknown" for missing fields rather than printing a zero', () => {
    const thin = renderEvidence({ ...EVIDENCE, fundamentals: null, attention: null, insiders: [], news: [] });
    expect(thin).toMatch(/not in the screener snapshot/);
    expect(thin).toMatch(/no attention data resolved/);
    expect(thin).not.toMatch(/0\.0%/);
  });

  it('shows the gaps so the model can see what was missing', () => {
    const g = renderEvidence({ ...EVIDENCE, gaps: ['news: upstream 503'] });
    expect(g).toMatch(/GAPS/);
    expect(g).toMatch(/upstream 503/);
  });
});

describe('system prompt', () => {
  it('forbids scores, targets and ranks', () => {
    expect(SYSTEM_PROMPT).toMatch(/Never output a score/i);
  });

  it('states the attention leg measured no edge', () => {
    expect(SYSTEM_PROMPT).toMatch(/NO predictive edge/i);
  });

  it('asks the materiality question with the Barbie counterexample', () => {
    expect(SYSTEM_PROMPT).toMatch(/MATERIALITY/);
    expect(SYSTEM_PROMPT).toMatch(/2\.3%/);
  });

  it('requires unverified in the output contract', () => {
    expect(SYSTEM_PROMPT).toMatch(/"unverified"/);
    expect(SYSTEM_PROMPT).toMatch(/REQUIRED, never empty/);
  });
});

describe('google trends: present, displayed, unweighted', () => {
  it('renders with an explicit no-weight caution', () => {
    const b = renderEvidence(EVIDENCE);
    expect(b).toMatch(/GOOGLE TRENDS/);
    expect(b).toMatch(/UNWEIGHTED, CONTEXT ONLY/);
    expect(b).toMatch(/NOT comparable/);
    expect(b).toMatch(/carries NO weight/);
  });

  it('says WHY it is missing rather than omitting the section', () => {
    const b = renderEvidence({ ...EVIDENCE, googleTrends: null });
    expect(b).toMatch(/GOOGLE TRENDS/);
    expect(b).toMatch(/unavailable/);
  });
});

// Off-exchange volume is the retail-crowding leg — the only social-adjacent
// Quiver dataset on this plan (WSB and twitter both 403, probed 2026-08-04).
// These tests pin the three ways it could be rendered dishonestly.
describe('off-exchange: the crowding leg', () => {
  const block = renderEvidence(EVIDENCE);

  it('renders under its own source label, unweighted', () => {
    expect(block).toMatch(/INVESTOR CROWDING/);
    expect(block).toMatch(/Quiver off-exchange/);
    expect(block).toMatch(/UNWEIGHTED/);
  });

  it('states the sign convention — a positive z is a WARNING, not a buy', () => {
    // The whole point of the leg in this frame. If a refactor drops this
    // line the model will read "retail is piling in" as bullish.
    expect(block).toMatch(/DISCOVERY warning, not a buy signal/);
  });

  it('warns that DPI is not comparable between companies', () => {
    expect(block).toMatch(/not\s+comparable between companies/);
  });

  it('prints "not enough history" instead of a zero z-score', () => {
    const thin = renderEvidence({
      ...EVIDENCE,
      offExchange: { ...EVIDENCE.offExchange!, volumeZ: null, days: 12 },
    });
    expect(thin).toMatch(/not enough history/);
    expect(thin).not.toMatch(/\+0 sd/);
  });

  it('says WSB is unavailable when the leg is missing, so absence is not read as calm', () => {
    const b = renderEvidence({ ...EVIDENCE, offExchange: null });
    expect(b).toMatch(/INVESTOR CROWDING/);
    expect(b).toMatch(/WallStreetBets and Twitter mention counts are NOT available/);
    expect(b).toMatch(/Do not assume anything about retail crowding/);
  });

  it('reports a gated fetch as unavailable, never as zero crowding', () => {
    const b = renderEvidence({
      ...EVIDENCE,
      offExchange: {
        ticker: 'CROX', available: false, asOf: null, days: 0, volumeZ: null,
        recentDailyVolume: null, dpiRecent: null, dpiBase: null,
        reason: 'Quiver off-exchange request failed (gate, rate limit or network)',
        caveat: 'no weight in any score',
      },
    });
    expect(b).toMatch(/unavailable: Quiver off-exchange request failed/);
  });
});

// The WSB leg Quiver would not sell. The rendering hazard is the opposite of
// the usual one: here a MISSING ticker is a real finding, so it must not be
// printed as though the lookup failed.
describe('retail chatter: quiet is a finding, not a gap', () => {
  it('renders a tracked name with its rank and universe size', () => {
    const b = renderEvidence(EVIDENCE);
    expect(b).toMatch(/RETAIL CHATTER/);
    expect(b).toMatch(/rank 399 of 757 tracked/);
    expect(b).toMatch(/UNWEIGHTED/);
  });

  it('states the saturation direction for a tracked name', () => {
    expect(renderEvidence(EVIDENCE)).toMatch(/reason to be MORE sceptical/);
  });

  it('renders BELOW_FLOOR as an observation, never as missing data', () => {
    const b = renderEvidence({
      ...EVIDENCE,
      mentions: { ...EVIDENCE.mentions!, state: 'BELOW_FLOOR', mentions: null, rank: null, reason: 'not tracked' },
    });
    expect(b).toMatch(/NOT among the 757 tracked tickers/);
    expect(b).toMatch(/real observation, not missing data/);
    expect(b).toMatch(/EXPECTED state/);
    // The trap: quiet must not be sold as bullish confirmation.
    expect(b).toMatch(/rather than as evidence for it/);
  });

  it('distinguishes UNAVAILABLE from quiet', () => {
    const b = renderEvidence({
      ...EVIDENCE,
      mentions: { ...EVIDENCE.mentions!, state: 'UNAVAILABLE', mentions: null, reason: 'HTTP 503' },
    });
    expect(b).toMatch(/unavailable: HTTP 503/);
    expect(b).not.toMatch(/NOT among/);
  });

  it('tells the model quiet is consistent-with, not evidence-for', () => {
    expect(SYSTEM_PROMPT).toMatch(/consistent with the thesis, never evidence for it/i);
  });
});

describe('app ratings: behaviour, not curiosity', () => {
  it('renders the app with its match confidence and the cumulative warning', () => {
    const b = renderEvidence(EVIDENCE);
    expect(b).toMatch(/APP-STORE RATINGS/);
    expect(b).toMatch(/Crocs/);
    expect(b).toMatch(/LIFETIME cumulative/);
    expect(b).toMatch(/only ever rises/);
  });

  it('warns loudly on a weak name match', () => {
    const b = renderEvidence({
      ...EVIDENCE,
      appRating: { ...EVIDENCE.appRating!, matchConfidence: 'LOW', appName: 'Skiing Yeti Mountain' },
    });
    expect(b).toMatch(/may belong to a different company/);
  });

  it('says a missing app is NOT a negative signal', () => {
    const b = renderEvidence({ ...EVIDENCE, appRating: null });
    expect(b).toMatch(/no consumer app is normal and is NOT a negative signal/);
  });
});

// The only genuine consumer-demand FLOW in the pack. Two traps get pinned
// here because both would read as a dramatic finding if rendered plainly.
describe('review velocity: the only flow', () => {
  it('renders the rate and the change', () => {
    const b = renderEvidence(EVIDENCE);
    expect(b).toMatch(/REVIEW VELOCITY/);
    expect(b).toMatch(/1\.29 reviews\/day/);
    expect(b).toMatch(/\+29%/);
  });

  it('warns the stars are NOT comparable to the lifetime rating', () => {
    // Wingstop: 4.91 lifetime vs 1.72 recent. Comparing them would look like
    // a product catastrophe; it is a sampling difference.
    expect(renderEvidence(EVIDENCE)).toMatch(/NOT comparable to the lifetime rating/);
  });

  it('flags that multiple versions may be driving the rate', () => {
    expect(renderEvidence(EVIDENCE)).toMatch(/a release may have prompted the reviews/);
  });

  it('says a missing prior window is NOT a decline', () => {
    // Dutch Bros produced exactly this: 200 reviews in 34 days.
    const b = renderEvidence({
      ...EVIDENCE,
      reviews: { ...EVIDENCE.reviews!, truncated: true, priorPerDay: null, velocityPct: null, reason: 'feed covered only 34 days' },
    });
    expect(b).toMatch(/NOT OBSERVED/);
    expect(b).toMatch(/Do NOT read the absence of a comparison as a decline/);
    expect(b).toMatch(/generating reviews FAST/);
  });

  it('says so plainly when there is no matched app', () => {
    const b = renderEvidence({ ...EVIDENCE, reviews: null });
    expect(b).toMatch(/REVIEW VELOCITY/);
    expect(b).toMatch(/unavailable/);
  });

  it('tells the model to discount a multi-version window', () => {
    expect(SYSTEM_PROMPT).toMatch(/discount it when more than one app version/i);
  });
});

describe('system prompt: the crowding leg', () => {
  it('tells the model a positive z argues AGAINST an undiscovered setup', () => {
    expect(SYSTEM_PROMPT).toMatch(/argues against an undiscovered setup/i);
  });

  it('tells the model that absence is missing data, not an absent crowd', () => {
    expect(SYSTEM_PROMPT).toMatch(/never that the crowd is absent/i);
  });
});
