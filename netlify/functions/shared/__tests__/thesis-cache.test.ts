// Phase 6 PR-H — thesis-cache (Firestore) tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCachedThesis,
  setCachedThesis,
  __setThesisDbForTesting,
} from '../thesis-cache';

function makeFakeDb() {
  const store = new Map<string, unknown>();
  const docRef = (id: string) => ({
    id,
    async get() { const v = store.get(id); return { exists: v !== undefined, data: () => v }; },
    async set(payload: unknown) { store.set(id, payload); },
  });
  return {
    collection: () => ({ doc: docRef }),
    __store: store,
  };
}

let fakeDb: ReturnType<typeof makeFakeDb>;
beforeEach(() => {
  fakeDb = makeFakeDb();
  __setThesisDbForTesting(fakeDb as never);
});

describe('thesis-cache', () => {
  it('returns null on miss', async () => {
    const r = await getCachedThesis('AAPL', '2026-05-30');
    expect(r).toBeNull();
  });

  it('round-trips set → get', async () => {
    await setCachedThesis('aapl', '2026-05-30', 'GARP thesis with PEG 0.5.', 'claude-opus-4-8');
    const r = await getCachedThesis('AAPL', '2026-05-30');
    expect(r).not.toBeNull();
    expect(r?.ticker).toBe('AAPL');
    expect(r?.snapshotDate).toBe('2026-05-30');
    expect(r?.text).toBe('GARP thesis with PEG 0.5.');
    expect(r?.model).toBe('claude-opus-4-8');
  });

  it('keys by (ticker, snapshotDate) — a different date is a separate entry', async () => {
    await setCachedThesis('AAPL', '2026-05-30', 'A', 'claude-opus-4-8');
    await setCachedThesis('AAPL', '2026-05-31', 'B', 'claude-opus-4-8');
    const a = await getCachedThesis('AAPL', '2026-05-30');
    const b = await getCachedThesis('AAPL', '2026-05-31');
    expect(a?.text).toBe('A');
    expect(b?.text).toBe('B');
  });

  it('swallows write errors (best-effort cache)', async () => {
    __setThesisDbForTesting(null);
    // No DB injected and no real Firestore in tests → would throw if not swallowed.
    await expect(setCachedThesis('AAPL', '2026-05-30', 'x', 'm')).resolves.toBeUndefined();
  });

  it('swallows read errors gracefully (returns null)', async () => {
    __setThesisDbForTesting(null);
    const r = await getCachedThesis('AAPL', '2026-05-30');
    expect(r).toBeNull();
  });
});
