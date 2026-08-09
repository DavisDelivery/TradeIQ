// QS-1 — the registration contract.
//
// Adding a board touches five registries and only TWO of them are
// compile-enforced (FRESHNESS_BUDGETS_MS and health's BOARD_UNIVERSES are
// exhaustive Records; the rest fail silently at runtime). The screens
// rollout is the precedent: the board was registered, the worker wrote picks
// correctly, and every History request 400'd in production for weeks
// because one plain array was never updated.
//
// These tests are the missing compile error.

import { describe, it, expect } from 'vitest';
import { FORWARD_BOARDS } from '../forward-test';
import { FRESHNESS_BUDGETS_MS, dailyScanSlotFor } from '../snapshot-store';
import { CRON } from '../../scan-quiet-strength';

const BOARD = 'quiet-strength';
const UNIVERSE = 'all';

describe('quiet-strength is registered everywhere it must be', () => {
  it('has a forward-league cohort', () => {
    const cfg = FORWARD_BOARDS.find((b) => b.board === BOARD);
    expect(cfg, 'quiet-strength missing from FORWARD_BOARDS').toBeTruthy();
    expect(cfg!.universe).toBe(UNIVERSE);
    expect(cfg!.take).toBe(20);
  });

  it('has a freshness budget', () => {
    expect(FRESHNESS_BUDGETS_MS[BOARD]).toBe(26 * 60 * 60_000);
  });

  it('has a daily-close slot, so it does not flag stale every weekend', () => {
    // Omitting this is the 2026-08-03 audit bug: four boards showed stale
    // banners all weekend while their Friday snapshots were as fresh as the
    // schedule allows.
    const slot = dailyScanSlotFor(BOARD, UNIVERSE);
    expect(slot, 'quiet-strength missing from DAILY_CLOSE_SLOTS').toBeTruthy();
    expect(slot).toEqual({ hourUtc: 22, minuteUtc: 40 });
  });

  it('declares a slot that matches its actual cron', () => {
    // A slot that disagrees with the cron makes freshness LIE in the other
    // direction — the board is judged against a scan time it never runs at.
    const [minute, hour] = CRON.split(' ');
    const slot = dailyScanSlotFor(BOARD, UNIVERSE)!;
    expect(Number(hour)).toBe(slot.hourUtc);
    expect(Number(minute)).toBe(slot.minuteUtc);
  });
});

describe('the league cohort is well-formed', () => {
  it('keeps (board|universe) unique across every cohort', () => {
    const keys = FORWARD_BOARDS.map((b) => `${b.board}|${b.universe}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('did not disturb the existing cohorts', () => {
    for (const b of ['target-board', 'prophet', 'catalyst', 'insider', 'earnings', 'screens']) {
      expect(FORWARD_BOARDS.some((c) => c.board === b), `${b} cohort lost`).toBe(true);
    }
  });
});

describe('the scan slot cannot collide with the nightly league run', () => {
  // forward-test-nightly fires at 00:20 UTC and captures whatever _latest
  // holds. A scan at or after that time is captured a day late, forever.
  const LEAGUE_MINUTES = 0 * 60 + 20;
  const OCCUPIED: Record<string, number> = {
    crosses: 21 * 60 + 10,
    insider: 21 * 60 + 30,
    'prophet/lynch': 22 * 60,
    trident: 22 * 60 + 15,
    'target-board': 23 * 60,
    fable: 23 * 60 + 30,
    'earnings/screens': 23 * 60 + 50,
  };

  const [minute, hour] = CRON.split(' ').map(Number);
  const mins = hour * 60 + minute;

  it('runs after the close and before the league', () => {
    expect(mins).toBeGreaterThan(21 * 60);
    expect(mins).toBeLessThan(24 * 60);
    expect(mins % (24 * 60)).not.toBe(LEAGUE_MINUTES);
  });

  it('does not land on another board\'s slot', () => {
    for (const [name, at] of Object.entries(OCCUPIED)) {
      expect(mins, `collides with ${name}`).not.toBe(at);
    }
  });

  it('runs on weekdays only', () => {
    expect(CRON.split(' ')[4]).toBe('1-5');
  });
});
