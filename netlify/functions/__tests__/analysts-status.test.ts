// Wave 2B — drift guard for /api/analysts-status.
//
// The endpoint's registry had drifted from the runner's weight table
// (macro-regime reported 0.07 and patent-analyst 0.06 long after both were
// pinned to 0, totalWeight 1.00 vs real 0.87). Weights are now derived at
// request time from shared/analyst-weights.ts; this test pins the contract
// so a re-hardcode (or a registry entry going missing) fails CI.

import { describe, expect, it } from 'vitest';
import { handler } from '../analysts-status';
import { ANALYST_WEIGHTS } from '../shared/analyst-weights';

async function getBody() {
  const res = (await handler({} as never, {} as never)) as { statusCode: number; body: string };
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as {
    analysts: Array<{ name: string; weight: number }>;
    summary: { totalWeight: number };
  };
}

describe('analysts-status — registry matches analyst-runner weights', () => {
  it('reports exactly the ANALYST_WEIGHTS table (same names, same values)', async () => {
    const body = await getBody();
    const reported = Object.fromEntries(body.analysts.map((a) => [a.name, a.weight]));
    expect(reported).toEqual(ANALYST_WEIGHTS);
  });

  it('removed analysts (macro-regime, patent-analyst) report weight 0', async () => {
    const body = await getBody();
    const byName = Object.fromEntries(body.analysts.map((a) => [a.name, a.weight]));
    expect(byName['macro-regime']).toBe(0);
    expect(byName['patent-analyst']).toBe(0);
  });

  it('totalWeight reflects the real live total (0.87), not the pre-drift 1.00', async () => {
    const body = await getBody();
    const expected = +Object.values(ANALYST_WEIGHTS).reduce((s, x) => s + x, 0).toFixed(2);
    expect(body.summary.totalWeight).toBe(expected);
    expect(body.summary.totalWeight).toBe(0.87);
  });
});
