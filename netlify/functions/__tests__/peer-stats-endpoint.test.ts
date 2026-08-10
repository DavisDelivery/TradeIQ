// PROFILE-1 W3.2 — /api/peer-stats, the refusal paths.
//
// Two refusals that must not be flattened into each other:
//
//   no-pool      the metric is fine, our cross-section does not carry it
//   not-rankable the metric is carried, and ranking it would sort by size
//
// Both are 200s with a policy attached, because a drawer that opens to an
// error teaches the reader the row is broken when in fact the answer is
// "here is what this is, and here is why there is no percentile".

import { describe, it, expect } from 'vitest';
import { handler } from '../peer-stats';
import { NOT_RANKABLE, NO_PEER_POOL } from '../shared/peer-stats';

const call = async (qs: Record<string, string>) =>
  (await (handler as any)({ queryStringParameters: qs }, {} as any, () => {})) as {
    statusCode: number; body: string; headers: Record<string, string>;
  };

const parse = async (qs: Record<string, string>) => {
  const res = await call(qs);
  return { res, body: JSON.parse(res.body) };
};

describe('argument handling', () => {
  it('rejects a missing ticker and a missing metric', async () => {
    expect((await call({ metric: 'pe' })).statusCode).toBe(400);
    expect((await call({ ticker: 'AAPL' })).statusCode).toBe(400);
  });

  it('rejects a metric with no policy rather than inventing one', async () => {
    const { res, body } = await parse({ ticker: 'AAPL', metric: 'vibes' });
    expect(res.statusCode).toBe(400);
    expect(body.error).toMatch(/unknown metric/);
  });
});

describe('not-rankable is an answer, with the definition attached', () => {
  for (const metric of [...NOT_RANKABLE]) {
    it(`${metric} refuses the rank and still explains itself`, async () => {
      const { res, body } = await parse({ ticker: 'AAPL', metric });
      expect(res.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.stat).toBeNull();
      expect(body.reason).toBe('not-rankable');
      expect(body.note).toMatch(/size/);
      // The half that makes the tap worth it.
      expect(body.policy?.meaning?.length).toBeGreaterThan(30);
      expect(body.policy?.label).toBeTruthy();
    });
  }
});

describe('no-pool is a different answer from not-rankable', () => {
  for (const metric of [...NO_PEER_POOL].filter((m) => m !== 'fcfYield')) {
    it(`${metric} reports no-pool, not not-rankable`, async () => {
      const { body } = await parse({ ticker: 'AAPL', metric });
      expect(body.reason).toBe('no-pool');
      expect(body.policy?.meaning).toBeTruthy();
    });
  }

  it('the two notes do not say the same thing', async () => {
    const notRankable = (await parse({ ticker: 'AAPL', metric: 'freeCashFlow' })).body;
    const noPool = (await parse({ ticker: 'AAPL', metric: 'evEbitda' })).body;
    expect(notRankable.note).not.toBe(noPool.note);
  });
});

describe('caching', () => {
  it('caches a refusal, since it is a stable answer rather than a failure', async () => {
    const { res } = await parse({ ticker: 'AAPL', metric: 'eps' });
    expect(res.headers['Cache-Control']).toMatch(/max-age/);
  });

  it('never caches a 4xx', async () => {
    const res = await call({ ticker: 'AAPL', metric: 'vibes' });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});
