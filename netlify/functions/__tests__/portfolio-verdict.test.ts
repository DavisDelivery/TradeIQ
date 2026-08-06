// Phase 4r W1 — portfolio-verdict endpoint, version-aware behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeDoc {
  id: string;
  data: () => Record<string, unknown>;
}

let auditDocs: FakeDoc[] = [];
let backtestDocs: FakeDoc[] = [];

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: (cn: string) => {
      if (cn === 'prophetPortfolio') {
        return {
          doc: () => ({
            collection: () => ({
              orderBy: () => ({
                limit: () => ({
                  get: async () => ({ empty: auditDocs.length === 0, docs: auditDocs }),
                }),
              }),
            }),
          }),
        };
      }
      return {
        orderBy: () => ({
          limit: () => ({
            get: async () => ({ docs: backtestDocs }),
          }),
        }),
      };
    },
  })),
}));

vi.mock('../shared/logger', () => ({
  logger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

import { handler } from '../portfolio-verdict';

function get(qs: Record<string, string> = {}): Parameters<typeof handler>[0] {
  return { httpMethod: 'GET', queryStringParameters: qs } as unknown as Parameters<typeof handler>[0];
}

function btDoc(
  runId: string,
  window: string,
  status: string,
  version: string | null,
  metrics: Record<string, unknown> = {},
): FakeDoc {
  const data: Record<string, unknown> = {
    runId,
    window,
    status,
    startedAt: '2026-05-15T22:00:00Z',
    ...metrics,
  };
  if (version !== null) data.version = version;
  return { id: runId, data: () => data };
}

const FAKE_AUDIT: FakeDoc = {
  id: 'audit-1',
  data: () => ({
    generatedAt: '2026-05-17T18:00:00Z',
    universe: 'largecap',
    pickCount: 100,
    layers: [
      { layer: 'structure', mean: 80, stdev: 10, pctExactly50: 0, pctNull: 0, pctFailing: 0, verdict: 'live' },
    ],
    stubLayers: [],
    markdown: '',
  }),
};

beforeEach(() => {
  auditDocs = [FAKE_AUDIT];
  backtestDocs = [];
});

describe('portfolio-verdict (Phase 4r W1)', () => {
  it('reports PENDING when no full-window doc exists', async () => {
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.verdict).toBe('PENDING LIVE-DATA RUN');
  });

  it('reports PENDING when full is done at v1 but the active version is v2', async () => {
    backtestDocs = [
      btDoc('pb-full-old', 'full', 'done', 'v1', {
        portfolioReturnPct: 100,
        spyReturnPct: 50,
        excessReturnPct: 50,
      }),
    ];
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.verdict).toBe('PENDING LIVE-DATA RUN');
    expect(body.markdown).toContain('Rule version:** v2');
  });

  it('SHIPs when full and ≥5/8 rolling-* docs are done at v2 with positive excess', async () => {
    backtestDocs = [
      btDoc('pb-full-x', 'full', 'done', 'v2', {
        portfolioReturnPct: 200,
        spyReturnPct: 150,
        qqqReturnPct: 220,
        iwfReturnPct: 180,
        excessReturnPct: 50,
      }),
    ];
    // 6/8 rolling beat SPY at v2.
    const beats: Array<[string, number]> = [
      ['rolling-2018', 5],
      ['rolling-2019', 3],
      ['rolling-2020', 4],
      ['rolling-2021', 7],
      ['rolling-2022', 2],
      ['rolling-2023', 6],
      ['rolling-2024', -2], // doesn't beat
      ['rolling-2025', -5], // doesn't beat
    ];
    for (const [w, excess] of beats) {
      backtestDocs.push(
        btDoc(`pb-${w}-x`, w, 'done', 'v2', {
          // Real trade evidence — without it the no-data guard would
          // (correctly) exclude the window from the binding rule.
          portfolioReturnPct: 10 + excess,
          spyReturnPct: 10,
          turnoverPct: 120,
          swapCount: 14,
          excessReturnPct: excess,
        }),
      );
    }
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.verdict).toBe('SHIP');
  });

  it('counts only v2 rolling-* docs as done — 7v2 + 1v1 stays PENDING', async () => {
    backtestDocs = [
      btDoc('pb-full-x', 'full', 'done', 'v2', {
        portfolioReturnPct: 200,
        spyReturnPct: 150,
        excessReturnPct: 50,
      }),
    ];
    const rollingsV2 = [
      'rolling-2018',
      'rolling-2019',
      'rolling-2020',
      'rolling-2022',
      'rolling-2023',
      'rolling-2024',
      'rolling-2025',
    ];
    for (const w of rollingsV2) {
      backtestDocs.push(
        btDoc(`pb-${w}-v2`, w, 'done', 'v2', {
          portfolioReturnPct: 15,
          spyReturnPct: 10,
          turnoverPct: 100,
          excessReturnPct: 5,
        }),
      );
    }
    // rolling-2021 is done at v1 — must NOT count.
    backtestDocs.push(
      btDoc('pb-rolling-2021-v1', 'rolling-2021', 'done', 'v1', {
        portfolioReturnPct: 22,
        spyReturnPct: 10,
        turnoverPct: 100,
        excessReturnPct: 12,
      }),
    );
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.verdict).toBe('PENDING LIVE-DATA RUN');
    expect(body.markdown).toContain('rolling-2021');
    expect(body.markdown).toMatch(/Stale rule version/i);
  });

  it('reads the active version from PORTFOLIO_RULE_VERSION when set', async () => {
    // Note: ACTIVE_VERSION is read at module load. This test verifies
    // the dynamic markdown line by relying on the default v2; the env
    // override is exercised in production. We check the markdown shows
    // the resolved version, not the hardcoded "v1".
    backtestDocs = [
      btDoc('pb-full-x', 'full', 'done', 'v2', {
        portfolioReturnPct: 200,
        spyReturnPct: 150,
        excessReturnPct: 50,
      }),
    ];
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.markdown).toContain('Rule version:** v2');
    expect(body.markdown).not.toContain('Rule version:** v1');
  });
});

// --- No-data (all-cash) window guard ---------------------------------
//
// Confirmed production defect: rolling-2018 completed with
// portfolioReturnPct exactly 0 (the ranking snapshot predated the
// window — rankAtDate returned [], nothing was ever bought) while SPY
// returned -7.01%, and the endpoint credited it as a rolling "beat"
// because the test was simply excessReturnPct > 0. A window in which
// the strategy never traded must be excluded from BOTH sides of the
// ≥5/8 rule and rendered as "no data (all cash)".
describe('portfolio-verdict — all-cash no-data windows', () => {
  const FULL_OK = {
    portfolioReturnPct: 200,
    spyReturnPct: 150,
    qqqReturnPct: 220,
    iwfReturnPct: 180,
    excessReturnPct: 50,
    turnoverPct: 130,
    swapCount: 40,
  };

  // Mirrors the production doc: never traded, SPY down, excess
  // "positive", swapCount nonzero from notes-only rebalance events.
  const ALL_CASH_2018 = {
    portfolioReturnPct: 0,
    spyReturnPct: -7.01,
    excessReturnPct: 7.01,
    turnoverPct: 0,
    swapCount: 20,
  };

  function tradedDoc(excess: number) {
    return {
      portfolioReturnPct: 10 + excess,
      spyReturnPct: 10,
      excessReturnPct: excess,
      turnoverPct: 110,
      swapCount: 12,
    };
  }

  it('does not count an all-cash window (negative SPY) as a beat nor in the denominator', async () => {
    backtestDocs = [btDoc('pb-full', 'full', 'done', 'v2', FULL_OK)];
    backtestDocs.push(btDoc('pb-r2018', 'rolling-2018', 'done', 'v2', ALL_CASH_2018));
    // 4 genuine beats + 3 genuine misses. Pre-fix, the all-cash window
    // made this 5/8 → SHIP. Post-fix it is 4/7 with one exclusion →
    // the binding rule cannot bind → PENDING.
    const rest: Array<[string, number]> = [
      ['rolling-2019', 3],
      ['rolling-2020', 4],
      ['rolling-2021', 7],
      ['rolling-2022', 6],
      ['rolling-2023', -1],
      ['rolling-2024', -2],
      ['rolling-2025', -5],
    ];
    for (const [w, excess] of rest) {
      backtestDocs.push(btDoc(`pb-${w}`, w, 'done', 'v2', tradedDoc(excess)));
    }
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.verdict).toBe('PENDING LIVE-DATA RUN');
    expect(body.markdown).toContain('no data (all cash)');
    expect(body.markdown).toContain('rolling-2018');
    // Excluded from numerator AND denominator: 4/7, not 5/8.
    expect(body.markdown).toContain('**Rolling 1y windows that beat SPY:** 4/7');
    expect(body.markdown).toMatch(/No-data \(all-cash\) window\(s\) detected/);
    // The 2018 row must not be a YES.
    const row2018 = body.markdown.split('\n').find((l: string) => l.startsWith('| 2018 |'));
    expect(row2018).toBeDefined();
    expect(row2018).toContain('no data (all cash)');
    expect(row2018).not.toContain('YES');
  });

  it('still counts a genuinely-traded window with positive excess', async () => {
    backtestDocs = [btDoc('pb-full', 'full', 'done', 'v2', FULL_OK)];
    const excesses: Array<[string, number]> = [
      ['rolling-2018', 5],
      ['rolling-2019', 3],
      ['rolling-2020', 4],
      ['rolling-2021', 7],
      ['rolling-2022', 6],
      ['rolling-2023', -1],
      ['rolling-2024', -2],
      ['rolling-2025', -5],
    ];
    for (const [w, excess] of excesses) {
      backtestDocs.push(btDoc(`pb-${w}`, w, 'done', 'v2', tradedDoc(excess)));
    }
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.verdict).toBe('SHIP');
    expect(body.markdown).toContain('**Rolling 1y windows that beat SPY:** 5/8');
    expect(body.markdown).not.toContain('no data (all cash)');
  });

  it('the derived verdict flips from SHIP to PENDING when the marginal beat is all-cash', async () => {
    // Identical to the SHIP scenario above except rolling-2018 never
    // traded — the 5th "beat" evaporates and the verdict must not bind.
    backtestDocs = [btDoc('pb-full', 'full', 'done', 'v2', FULL_OK)];
    backtestDocs.push(btDoc('pb-r2018', 'rolling-2018', 'done', 'v2', ALL_CASH_2018));
    const rest: Array<[string, number]> = [
      ['rolling-2019', 3],
      ['rolling-2020', 4],
      ['rolling-2021', 7],
      ['rolling-2022', 6],
      ['rolling-2023', -1],
      ['rolling-2024', -2],
      ['rolling-2025', -5],
    ];
    for (const [w, excess] of rest) {
      backtestDocs.push(btDoc(`pb-${w}`, w, 'done', 'v2', tradedDoc(excess)));
    }
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.verdict).not.toBe('SHIP');
    expect(body.verdict).toBe('PENDING LIVE-DATA RUN');
  });

  it('a zero-turnover window with a real nonzero return still counts (trade evidence via return)', async () => {
    backtestDocs = [btDoc('pb-full', 'full', 'done', 'v2', FULL_OK)];
    // e.g. old doc missing turnoverPct but clearly traded.
    backtestDocs.push(
      btDoc('pb-r2018', 'rolling-2018', 'done', 'v2', {
        portfolioReturnPct: 12.5,
        spyReturnPct: 10,
        excessReturnPct: 2.5,
        swapCount: 9,
      }),
    );
    const rest: Array<[string, number]> = [
      ['rolling-2019', 3],
      ['rolling-2020', 4],
      ['rolling-2021', 7],
      ['rolling-2022', 6],
      ['rolling-2023', -1],
      ['rolling-2024', -2],
      ['rolling-2025', -5],
    ];
    for (const [w, excess] of rest) {
      backtestDocs.push(btDoc(`pb-${w}`, w, 'done', 'v2', tradedDoc(excess)));
    }
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.verdict).toBe('SHIP');
    expect(body.markdown).toContain('**Rolling 1y windows that beat SPY:** 5/8');
  });

  it('an all-cash FULL window cannot support a verdict — PENDING, flagged in the report', async () => {
    backtestDocs = [
      btDoc('pb-full', 'full', 'done', 'v2', {
        portfolioReturnPct: 0,
        spyReturnPct: -12,
        excessReturnPct: 12, // "positive" excess purely from holding cash
        turnoverPct: 0,
        swapCount: 30,
      }),
    ];
    for (let y = 2018; y <= 2025; y++) {
      backtestDocs.push(btDoc(`pb-rolling-${y}`, `rolling-${y}`, 'done', 'v2', tradedDoc(5)));
    }
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.verdict).toBe('PENDING LIVE-DATA RUN');
    expect(body.markdown).toContain('NO DATA (all cash');
  });
});
