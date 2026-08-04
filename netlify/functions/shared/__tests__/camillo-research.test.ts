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

describe('system prompt: the crowding leg', () => {
  it('tells the model a positive z argues AGAINST an undiscovered setup', () => {
    expect(SYSTEM_PROMPT).toMatch(/argues against an undiscovered setup/i);
  });

  it('tells the model that absence is missing data, not an absent crowd', () => {
    expect(SYSTEM_PROMPT).toMatch(/never that the crowd is absent/i);
  });
});
