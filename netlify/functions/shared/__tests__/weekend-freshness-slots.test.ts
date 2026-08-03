// Weekend freshness for the boards missing from DAILY_CLOSE_SLOTS
// (staleness audit 2026-08-03).
//
// Measured on prod, Monday 13:53 UTC: insider (registered in the slot
// registry) served `snapshot` fresh at 63.0h, while trident — same cadence,
// same weekend — served `snapshot-stale` at 63.6h purely because it had no
// slot entry. Every Saturday through Monday-daytime the app showed stale
// banners on Trident, Crosses, FABLE and Sentiment over data exactly as
// fresh as their Mon–Fri schedules allow. These tests pin the corrected
// behaviour AND the case that must still flag: a genuinely missed weekday
// scan.

import { describe, it, expect } from 'vitest';
import {
  isSnapshotFresh,
  FRESHNESS_BUDGETS_MS,
  type BoardName,
  type BoardSnapshot,
} from '../snapshot-store';

// 2026-07-31 was a Friday; 2026-08-02 a Sunday; 2026-08-03 a Monday.
const snap = (board: BoardName, universe: string, generatedAt: string): BoardSnapshot =>
  ({
    modelVersion: 't',
    generatedAt,
    scanDurationMs: 1000,
    universeChecked: 100,
    results: [],
    freshnessBudgetMs: FRESHNESS_BUDGETS_MS[board],
    board,
    universe,
  }) as unknown as BoardSnapshot;

const at = (iso: string) => new Date(iso).getTime();

describe('weekend slot-aware freshness — previously missing boards', () => {
  it('trident: Friday-22:18 snapshot is FRESH on Sunday and Monday daytime', () => {
    const s = snap('trident', 'sp500', '2026-07-31T22:18:00Z');
    expect(isSnapshotFresh(s, at('2026-08-02T15:00:00Z'))).toBe(true); // Sunday
    expect(isSnapshotFresh(s, at('2026-08-03T13:53:00Z'))).toBe(true); // Monday pre-scan
  });

  it('crosses: Friday-21:11 snapshot is FRESH across the weekend', () => {
    const s = snap('crosses', 'sp500', '2026-07-31T21:11:00Z');
    expect(isSnapshotFresh(s, at('2026-08-03T13:00:00Z'))).toBe(true);
  });

  it('fable: Friday-23:31 snapshot is FRESH across the weekend', () => {
    const s = snap('fable', 'sp500', '2026-07-31T23:31:00Z');
    expect(isSnapshotFresh(s, at('2026-08-03T13:00:00Z'))).toBe(true);
  });

  it('sentiment: Friday-12:31 snapshot is FRESH on Sunday despite its 12h budget', () => {
    const s = snap('sentiment', 'sp500', '2026-07-31T12:31:00Z');
    expect(isSnapshotFresh(s, at('2026-08-02T15:00:00Z'))).toBe(true);
  });

  it('still flags a genuinely MISSED weekday scan — Friday snapshot on Tuesday', () => {
    // Monday's scan should have run by Tuesday daytime; serving Friday data
    // un-flagged then would hide a real outage. The registry must not turn
    // schedule-awareness into staleness amnesty.
    const s = snap('trident', 'sp500', '2026-07-31T22:18:00Z');
    expect(isSnapshotFresh(s, at('2026-08-04T13:00:00Z'))).toBe(false);
  });

  it('still flags a missed Monday sentiment scan by Monday evening', () => {
    const s = snap('sentiment', 'sp500', '2026-07-31T12:31:00Z');
    // Monday 18:00 UTC — Monday's 12:20 slot has long passed unserved.
    expect(isSnapshotFresh(s, at('2026-08-03T18:00:00Z'))).toBe(false);
  });
});
