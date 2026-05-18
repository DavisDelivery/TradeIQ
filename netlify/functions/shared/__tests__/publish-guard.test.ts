// Phase 4o W3 — degraded-publish guard policy.
//
// Pure function — no Firestore mock needed. The guard's job is to refuse
// to atomic-swap _latest over a previous good snapshot when the run
// looks broken. Calibration goal: clearly-broken runs (russell2k Bug A
// shape) skip; ordinary low-yield runs publish; moderately-degraded
// runs publish-degraded.

import { describe, it, expect } from 'vitest';
import {
  assessSnapshotPublish,
  PUBLISH_GUARD_DEGRADED_ERROR_RATE,
  PUBLISH_GUARD_SKIP_ERROR_RATE,
  PUBLISH_GUARD_EMPTY_UNIVERSE_MIN,
} from '../snapshot-store';

describe('assessSnapshotPublish — Phase 4o W3 guard', () => {
  it('publishes a healthy result with no flags', () => {
    const r = assessSnapshotPublish({
      resultCount: 250,
      universeChecked: 2037,
      totalCalls: 2037,
      rateLimitedCalls: 0,
      errorCalls: 0,
    });
    expect(r.action).toBe('publish');
  });

  it('SKIPS a 0-row result over a large universe — the russell2k Bug A pattern', () => {
    const r = assessSnapshotPublish({
      resultCount: 0,
      universeChecked: 2037,
      totalCalls: 2037,
      rateLimitedCalls: 1500,
      errorCalls: 0,
    });
    expect(r.action).toBe('skip');
    expect(r.reason).toContain('2037-ticker universe');
  });

  it('SKIPS even with 0 rateLimited calls if the universe is large and yield is 0', () => {
    // Defense in depth: even if the run looked clean to the per-call
    // accounting (totalCalls === universeChecked, all 200s), 0 rows
    // across thousands is suspicious enough to refuse the swap.
    const r = assessSnapshotPublish({
      resultCount: 0,
      universeChecked: 500,
      totalCalls: 500,
      rateLimitedCalls: 0,
      errorCalls: 0,
    });
    expect(r.action).toBe('skip');
  });

  it('publishes a 0-row result on a SMALL universe (legitimate "no insider activity")', () => {
    // A 50-ticker live scan with no activity in window is fine.
    const r = assessSnapshotPublish({
      resultCount: 0,
      universeChecked: 50,
      totalCalls: 50,
      rateLimitedCalls: 0,
      errorCalls: 0,
    });
    expect(r.action).toBe('publish');
  });

  it('SKIPS when the call-failure rate exceeds the skip threshold', () => {
    const r = assessSnapshotPublish({
      resultCount: 20, // even with some rows, too many failures = unreliable
      universeChecked: 100,
      totalCalls: 100,
      rateLimitedCalls: 60,
      errorCalls: 0,
    });
    expect(r.action).toBe('skip');
    expect(r.reason).toMatch(/60\/100/);
  });

  it('SKIPS a 0-row result when ANY rate-limiting was observed (even sub-threshold)', () => {
    // Smaller universe (under EMPTY_UNIVERSE_MIN), so the empty-floor doesn't fire on size alone.
    const r = assessSnapshotPublish({
      resultCount: 0,
      universeChecked: 80,
      totalCalls: 80,
      rateLimitedCalls: 3,
      errorCalls: 0,
    });
    expect(r.action).toBe('skip');
    expect(r.reason).toMatch(/rate-limited/);
  });

  it('publishes DEGRADED when failure rate exceeds the degraded threshold but stays under skip', () => {
    // 15% failure → degraded.
    const r = assessSnapshotPublish({
      resultCount: 200,
      universeChecked: 1000,
      totalCalls: 1000,
      rateLimitedCalls: 150,
      errorCalls: 0,
    });
    expect(r.action).toBe('publish-degraded');
    expect(r.reason).toMatch(/150\/1000/);
  });

  it('publishes normally with low yield + zero failures (small/ndx insider scan)', () => {
    // ndx returns ~45 rows from 70 tickers in a typical week — not degraded.
    const r = assessSnapshotPublish({
      resultCount: 45,
      universeChecked: 70,
      totalCalls: 70,
      rateLimitedCalls: 0,
      errorCalls: 0,
    });
    expect(r.action).toBe('publish');
  });

  it('exposes named thresholds for callers', () => {
    expect(PUBLISH_GUARD_SKIP_ERROR_RATE).toBeGreaterThan(PUBLISH_GUARD_DEGRADED_ERROR_RATE);
    expect(PUBLISH_GUARD_EMPTY_UNIVERSE_MIN).toBeGreaterThan(0);
  });

  it('tolerates missing optional fields (no totalCalls, no rateLimited)', () => {
    const r = assessSnapshotPublish({
      resultCount: 5,
      universeChecked: 50,
    });
    expect(r.action).toBe('publish');
  });

  it('rate-limited and error counts both contribute to the failure rate', () => {
    // 30% rate-limited + 30% error = 60% failure → skip.
    const r = assessSnapshotPublish({
      resultCount: 5,
      universeChecked: 100,
      totalCalls: 100,
      rateLimitedCalls: 30,
      errorCalls: 30,
    });
    expect(r.action).toBe('skip');
  });
});
