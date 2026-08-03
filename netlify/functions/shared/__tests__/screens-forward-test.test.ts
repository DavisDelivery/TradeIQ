// FVZ-6 — screens entering the forward-test league.
//
// Why this matters more than the usual wiring test: the league is the only
// mechanism that can tell us whether the 13 published strategies are worth
// trading. Two of them are graded 'anecdotal' and one ships with published
// evidence AGAINST it. If the losing screens quietly failed to register,
// the league would silently become a survivor-only comparison and every
// remaining screen would look better than it is — the same shape of bias
// as the delisted-ticker gap, arriving through configuration instead.

import { describe, it, expect } from 'vitest';
import { FORWARD_BOARDS, SCREEN_FORWARD_BOARDS } from '../forward-test';
import { SCREENS, SCREENS_BY_ID } from '../finviz-screens';

describe('screen cohorts', () => {
  it('EVERY screen is registered — including the ones expected to lose', () => {
    const registered = new Set(SCREEN_FORWARD_BOARDS.map((c) => String(c.universe)));
    for (const s of SCREENS) {
      expect(registered.has(s.id), `screen ${s.id} missing from the league`).toBe(true);
    }
    // The three that would most tempt a quiet omission.
    expect(registered.has('short-squeeze')).toBe(true); // graded 'contrary'
    expect(registered.has('minervini')).toBe(true); // anecdotal
    expect(registered.has('qullamaggie')).toBe(true); // anecdotal
  });

  it('cohorts are keyed to the screens board with the screen id as universe', () => {
    for (const c of SCREEN_FORWARD_BOARDS) {
      expect(c.board).toBe('screens');
      expect(SCREENS_BY_ID.has(String(c.universe))).toBe(true);
    }
  });

  it('honours a strategy\'s own published cap (Tiny Titans is a 25-name list)', () => {
    const tiny = SCREEN_FORWARD_BOARDS.find((c) => c.universe === ('tiny-titans' as never))!;
    expect(tiny.take).toBe(25);
  });

  it('caps every cohort at a comparable size so the league is a fair fight', () => {
    for (const c of SCREEN_FORWARD_BOARDS) {
      expect(c.take).toBeGreaterThan(0);
      expect(c.take).toBeLessThanOrEqual(25);
    }
  });

  it('screens join the existing boards rather than replacing them', () => {
    const boards = new Set(FORWARD_BOARDS.map((c) => c.board));
    expect(boards.has('screens')).toBe(true);
    // The pre-existing cohorts must survive — the comparison is screens
    // against OUR boards, not screens alone.
    for (const b of ['prophet', 'fable', 'trident', 'lynch', 'sentiment']) {
      expect(boards.has(b as never), `board ${b} dropped from league`).toBe(true);
    }
  });

  it('no duplicate cohorts (board, universe) — one entry per screen', () => {
    const keys = FORWARD_BOARDS.map((c) => `${c.board}|${String(c.universe)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
