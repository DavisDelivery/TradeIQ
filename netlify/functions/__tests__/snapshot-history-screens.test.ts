// FVZ-6 — snapshot-history must accept SCREEN IDs as the universe for the
// 'screens' board.
//
// Caught on prod, not in review: the screens board keys its snapshots by
// screen id (one cohort per strategy), but this endpoint validated the
// universe against a fixed list of INDEX NAMES. Registering 'screens' in
// VALID_BOARDS was not enough — every screens request 400'd on the universe
// check, so the History tab could never show a screen's captured picks even
// though the nightly worker was writing them correctly.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  getSnapshotById: vi.fn(),
}));

vi.mock('../shared/snapshot-store', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return { ...orig, listSnapshots: h.listSnapshots, getSnapshotById: h.getSnapshotById };
});

import { handler } from '../snapshot-history';

const call = async (qs: Record<string, string>) => {
  const res: any = await handler({ queryStringParameters: qs } as any, {} as any, () => {});
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.listSnapshots.mockResolvedValue([
    { snapshotId: 'high52w-2026-08-03-2350', generatedAt: '2026-08-03T23:50:00Z', resultsCount: 50 },
  ]);
});

describe('screens board universe validation', () => {
  it('accepts a screen id as the universe', async () => {
    const { statusCode, body } = await call({ board: 'screens', universe: 'high52w' });
    expect(statusCode).toBe(200);
    expect(body.snapshots).toHaveLength(1);
    expect(h.listSnapshots).toHaveBeenCalledWith('screens', 'high52w', expect.any(Number));
  });

  it('accepts every registered screen', async () => {
    for (const id of ['piotroski', 'pead', 'minervini', 'short-squeeze', 'tiny-titans']) {
      const { statusCode } = await call({ board: 'screens', universe: id });
      expect(statusCode, `screen ${id}`).toBe(200);
    }
  });

  it('still rejects a bogus screen id, and says which are valid', async () => {
    const { statusCode, body } = await call({ board: 'screens', universe: 'not-a-screen' });
    expect(statusCode).toBe(400);
    expect(body.validScreens).toContain('high52w');
  });

  it('an INDEX name is not a valid screens universe', async () => {
    // screens snapshots are never written under an index key, so accepting
    // one would just 200 with a permanently empty list.
    const { statusCode } = await call({ board: 'screens', universe: 'sp500' });
    expect(statusCode).toBe(400);
  });

  it('other boards keep the index allow-list unchanged', async () => {
    expect((await call({ board: 'trident', universe: 'sp500' })).statusCode).toBe(200);
    expect((await call({ board: 'trident', universe: 'high52w' })).statusCode).toBe(400);
    expect((await call({ board: 'trident', universe: '' })).statusCode).toBe(400);
  });
});
