import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory vector_events with a minimal query double supporting the two
// single-field equality filters the feed uses: where('agreement','==',true)
// and where('type','==',E2|E3).
const events: any[] = [];
function makeQuery(pred: (e: any) => boolean) {
  return {
    limit: (_n: number) => ({
      get: async () => ({ docs: events.filter(pred).map((e) => ({ id: e.id, data: () => e })) }),
    }),
  };
}
vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (_c: string) => ({
      where: (field: string, _op: string, val: any) => makeQuery((e) => e[field] === val),
    }),
  }),
}));

import { handler } from '../vector-feed';

const get = (qs: Record<string, string> = {}) =>
  handler({ httpMethod: 'GET', queryStringParameters: qs } as any, {} as any, () => {}) as any;

beforeEach(() => {
  events.length = 0;
  events.push(
    { id: 'E1_OLD_AGREE', type: 'E1', ticker: 'OLD', date: '2020-01-01', agreement: true, sizeBucket: 'LARGE' },
    { id: 'E1_RECENT_NOAGREE', type: 'E1', ticker: 'NEW', date: '2024-12-31', agreement: false, sizeBucket: 'LARGE' },
    { id: 'E1_MID_AGREE', type: 'E1', ticker: 'MID', date: '2024-06-01', agreement: true, sizeBucket: 'MID' },
    { id: 'E2_INS', type: 'E2', ticker: 'INS', date: '2024-11-01', sizeBucket: 'SMALL' },
  );
});

describe('vector-feed display gate (post-fix)', () => {
  it('surfaces agreement E1 events even when they are old — sorted newest-first', async () => {
    const res = await get();
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    const ids = body.events.map((e: any) => e.id);
    // The recent non-agreement E1 is excluded; the two agreement E1s + E2 show,
    // newest date first.
    expect(ids).toEqual(['E2_INS', 'E1_MID_AGREE', 'E1_OLD_AGREE']);
    expect(ids).not.toContain('E1_RECENT_NOAGREE');
  });

  it('type=E1 returns only agreement E1 rows', async () => {
    const res = await get({ type: 'E1' });
    const ids = JSON.parse(res.body).events.map((e: any) => e.id);
    expect(ids).toEqual(['E1_MID_AGREE', 'E1_OLD_AGREE']);
  });

  it('type=E2 returns only E2 rows', async () => {
    const res = await get({ type: 'E2' });
    const ids = JSON.parse(res.body).events.map((e: any) => e.id);
    expect(ids).toEqual(['E2_INS']);
  });

  it('respects the limit', async () => {
    const res = await get({ limit: '1' });
    expect(JSON.parse(res.body).events).toHaveLength(1);
    expect(JSON.parse(res.body).events[0].id).toBe('E2_INS'); // newest
  });
});
