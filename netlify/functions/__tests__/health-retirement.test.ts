// FIX-2 — health's board list must track which scans actually exist.
//
// THE BUG THIS EXISTS TO PREVENT, twice over:
//
//   FIX-1 (already documented in health.ts): the board->universe table
//   listed universes the producers never wrote, so boards read as
//   permanently NULL and health was permanently degraded.
//
//   FIX-2 (this file): the table listed boards whose PRODUCERS were removed.
//   #194 retired six boards by moving their scans to functions-retired/, and
//   the 2026-08-07 decision retired prophet. Their snapshots then aged
//   forever and /api/health returned 503 continuously for days. An alarm
//   that cannot go green is not an alarm — a real outage would have been the
//   seventh red among six permanent ones.
//
// Both were the same root cause: a hand-maintained list drifting from
// ground truth. So this test derives ground truth from the filesystem —
// a board is LIVE if a scheduled scan for it exists in netlify/functions/,
// and RETIRED if its scans sit in netlify/functions-retired/ — and fails the
// moment RETIRED_BOARDS disagrees.
//
// The next retirement therefore breaks a test rather than the endpoint.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RETIRED_BOARDS } from '../health';
import { FRESHNESS_BUDGETS_MS } from '../shared/snapshot-store';

const FN_DIR = join(__dirname, '..');
const RETIRED_DIR = join(__dirname, '../../functions-retired');

/** Scheduled scan files, i.e. the ones Netlify actually registers crons for. */
function scheduledScans(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('scan-') && f.endsWith('.ts'))
    .filter((f) => {
      try {
        return /\bschedule\s*\(/.test(readFileSync(join(dir, f), 'utf8'));
      } catch {
        return false;
      }
    });
}

/** Board names follow `scan-<board>[-universe].ts` without exception today. */
const hasScanFor = (board: string, files: string[]) =>
  files.some((f) => f === `scan-${board}.ts` || f.startsWith(`scan-${board}-`));

const LIVE = scheduledScans(FN_DIR);
const RETIRED = scheduledScans(RETIRED_DIR);
const ALL_BOARDS = Object.keys(FRESHNESS_BUDGETS_MS);

describe('the retirement list matches the filesystem', () => {
  it('finds scans on both sides, so a path typo cannot pass this vacuously', () => {
    expect(LIVE.length).toBeGreaterThan(5);
    expect(RETIRED.length).toBeGreaterThan(5);
  });

  it.each([...RETIRED_BOARDS])(
    'retired board %s has no scheduled scan left in netlify/functions/',
    (board) => {
      const strays = LIVE.filter(
        (f) => f === `scan-${board}.ts` || f.startsWith(`scan-${board}-`),
      );
      // A revived board that stayed on the retired list would be exempt from
      // alarming forever — the failure mode inverted, and worse.
      expect(strays, `${board} is retired but still scheduled`).toEqual([]);
    },
  );

  it('every board health can alarm on still has a producer', () => {
    const monitored = ALL_BOARDS.filter((b) => !RETIRED_BOARDS.has(b as any));
    const orphans = monitored.filter((b) => !hasScanFor(b, LIVE));
    // An orphan here is precisely the FIX-2 defect: nothing writes it, so its
    // age grows without bound and health goes permanently red.
    expect(orphans, `monitored but unscanned: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every retired board actually has its scans parked in functions-retired/', () => {
    // Guards the other direction: a board listed as retired whose scans were
    // deleted rather than parked cannot be revived, and the note in the
    // README would be describing files that no longer exist.
    const missing = [...RETIRED_BOARDS].filter((b) => !hasScanFor(b, RETIRED));
    expect(missing, `claimed retired but no parked scan: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('prophet specifically', () => {
  it('is retired, since its 7 crons were firing against a dead board', () => {
    expect(RETIRED_BOARDS.has('prophet' as any)).toBe(true);
  });

  it('has no scheduled prophet scan left, including the portfolio crons', () => {
    const left = LIVE.filter((f) => /prophet|portfolio-backtest/.test(f));
    expect(left).toEqual([]);
  });
});

describe('the live boards are the ones we expect', () => {
  it('lists exactly the boards with a producer', () => {
    const live = ALL_BOARDS.filter((b) => hasScanFor(b, LIVE)).sort();
    expect(live).toEqual(
      ['catalyst', 'crosses', 'earnings', 'insider', 'quiet-strength', 'screens', 'trident'].sort(),
    );
  });
});
