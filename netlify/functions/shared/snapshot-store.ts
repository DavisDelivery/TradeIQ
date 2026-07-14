// Snapshot store — Firestore-backed read/write for board scan results.
//
// Background scheduled functions write the FULL ranked result set here; live
// API endpoints read the latest snapshot and return it directly. This is what
// decouples scan duration (15+ min) from request duration (≤26s).
//
// Layout:
//   boardSnapshots/{board}/runs/{snapshotId}            ← versioned snapshots
//   boardSnapshots/{board}/_latest/{universe}            ← pointer to most recent
//
// snapshotId format: '{universe}-{YYYY-MM-DD-HHmm}' UTC (e.g. 'russell2k-2026-05-07-1430').
//
// CRITICAL: snapshots store the FULL raw result list — never trim before
// writing. Live endpoints can paginate / filter / slice for the response, but
// the stored snapshot is forever the unfiltered output of the analyst battery.
// Phase 4 backtest and Phase 5 calibration depend on this.
//
// The lone exception is the Phase 4p W2 size-safety trim — it fires only
// when the assembled doc would breach Firestore's 1 MiB per-document
// ceiling, keeps the top-N by the producer's sort order, and stamps
// `truncated: true` + `originalResultCount` so any consumer knows it is
// reading a capped snapshot. Without it, a too-large doc throws on
// write and the run freezes `status: running` forever — see
// briefs/phase-4p-brief.md for the exact failure mode.

import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from './firebase-admin';
import { isMarketClosed } from './us-market-holidays';

export type BoardName =
  | 'target-board'
  | 'prophet'
  | 'catalyst'
  | 'insider'
  | 'williams'
  | 'lynch'
  | 'earnings'
  | 'fable'
  | 'crosses';

export type UniverseKey =
  | 'sp500'
  | 'ndx'
  | 'dow'
  | 'russell2k'
  | 'all'
  | 'core'
  | 'largecap';

export interface BoardSnapshot {
  /** Stamped from MODEL_VERSION at write time. */
  modelVersion: string;
  /** ISO 8601 UTC timestamp. */
  generatedAt: string;
  /** Wall-clock duration of the scan that produced this snapshot. */
  scanDurationMs: number;
  /** Wave 4A (M8) — how many tickers the scan ACTUALLY scored. For most
   *  boards this equals the universe size; for the Russell sieve it is
   *  Stage 1's scored count, which can be smaller when Stage 1 hits its
   *  budget. Pre-Wave-4A docs stored the universe size here
   *  unconditionally — read coverage as `universeChecked / (universeSize
   *  ?? universeChecked)`. */
  universeChecked: number;
  /** Wave 4A (M8) — total universe size at scan start (entries fed in).
   *  Optional: older docs lack it; consumers fall back to
   *  `universeChecked`. */
  universeSize?: number;
  /** Full raw result set in board-specific shape — never trimmed. */
  results: unknown[];
  /** ms after generatedAt during which this snapshot is considered fresh. */
  freshnessBudgetMs: number;
  /** Optional warnings the scan emitted (rate-limit hits, partial failures). */
  warnings?: string[];
  /** Phase 4o W3 — the scan completed with elevated error/rate-limit
   *  signals. Read endpoints surface this so the UI can render a
   *  "degraded" badge instead of an apparently-clean snapshot. */
  degraded?: boolean;
  /** Phase 4o W3 — when degraded=true, this carries the W3 guard's
   *  human-readable reason (e.g. "8/100 finnhub calls rate-limited"). */
  degradedReason?: string;
  /** Phase 6 PR-H — scan completion status. `complete` (default) means
   *  the scan finished within budget; `partial` means it ran out of
   *  budget. Partial snapshots are written to the `runs/` history for
   *  diagnostic visibility but do NOT promote into `_latest/` — the
   *  prior good complete snapshot remains canonical. The write helper
   *  enforces this discipline. */
  status?: 'complete' | 'partial';
  /** 4c-2: sieve metadata for Russell snapshots produced by the 3-stage sieve. */
  sieve?: {
    stage1: { scored: number; survived: number; thresholdScore: number | null; budgetMs: number; partial: boolean };
    stage2: { scored: number; survived: number; thresholdScore: number | null; budgetMs: number; partial: boolean };
    stage3: { scored: number; survived: number; budgetMs: number; partial: boolean };
  };
  /** Phase 4p W2 — true when the persisted `results` was trimmed by the
   *  size-safety helper to fit Firestore's 1 MiB per-doc ceiling. */
  truncated?: boolean;
  /** Phase 4p W2 — present when `truncated`, the original assembled row
   *  count before the safety trim. The board's served top-N is far smaller
   *  than this in any case; this is purely for diagnostic + audit visibility. */
  originalResultCount?: number;
}

// Per-board freshness budgets. Intraday signals (price action, breadth) get
// a tight 30-min budget; daily fundamentals/insider get 24h.
//
// Phase 4h: target-board widened from 30 min → 26 hours. Russell2k +
// sp500 now scan nightly only (7pm ET = 23:00 UTC). A 30-min budget
// would mark the snapshot stale by ~7:30pm ET — every read for the
// next 23.5 hours would fall into the inline-live-scan path and
// produce the 25-second hang. 26h gives a safe margin past 7pm next
// day and keeps the snapshot "fresh" for the entire inter-scan gap.
// Phase 6 PR-H follow-up: prophet widened from 30 min → 26 hours for the
// same reason. PR-H moved the largecap scan to a once-daily after-close
// run (22:00 UTC weekdays); a 30-min budget marked that snapshot stale ~23h
// of the day, so every largecap read fell into the live `fallback-partial`
// scan — slow (~30s on the 508-name universe, riding the 26s ceiling) and
// returning a handful of partial picks instead of the full warm snapshot.
// 26h keeps the daily snapshot fresh to the next scan. Russell still scans
// every 30 min in market hours, so this only relaxes its overnight window.
export const FRESHNESS_BUDGETS_MS: Record<BoardName, number> = {
  'target-board': 26 * 60 * 60_000,
  prophet: 26 * 60 * 60_000,
  // catalyst + williams scan every 30 min in market hours but NOT off-hours;
  // a 30-min budget marked them stale overnight/weekends → every read fell
  // into a live `fallback-partial` scan that only reaches a fraction of the
  // 1928-name Russell universe (~200) before its budget. 26h serves the last
  // full market-hours snapshot off-hours instead (same fix as target/prophet).
  catalyst: 26 * 60 * 60_000,
  williams: 26 * 60 * 60_000,
  earnings: 12 * 60 * 60_000,
  insider: 24 * 60 * 60_000,
  lynch: 24 * 60 * 60_000,
  fable: 26 * 60 * 60_000,
  // crosses scan nightly after the close; 26h budget matches the other
  // daily boards so weekends serve Friday's snapshot un-flagged.
  crosses: 26 * 60 * 60_000,
};

// ====================================================================
// Phase 4o W3 — degraded-publish guard
// ====================================================================
//
// The russell2k insider Bug A had its true bite NOT in the rate-limit
// (W1 fixes that) but in the *publish*: a scan that had been silently
// ratelimit-massacred still atomic-swapped its empty result over the
// previous good snapshot. Empty was served as clean. W3 closes that:
// before the terminal writeSnapshot swaps _latest, assess the assembled
// result + the run's accumulated call stats and decide whether the run
// is healthy enough to publish.
//
// The decision is pure — no Firestore in here — so it's trivially
// testable. The caller (the bg-worker's terminal batch) feeds it the
// row count + universe size + call accounting, gets back a policy
// decision: publish / publish-degraded / skip.
//
// Floors are tuned to be sane: the russell2k Bug A pattern (0 rows
// across a 2,000-name universe) clearly trips "skip"; an ordinary low
// yield (8 rows from sp500's 503 names) is fine because most companies
// don't have insider activity in a 180d window. The threshold for
// "skip" is intentionally narrow — we never refuse to publish for low
// yield alone; we only refuse for 0 rows + meaningful universe size,
// or for an error rate so high the data is fundamentally incomplete.

export type PublishAction = 'publish' | 'publish-degraded' | 'skip';

export interface PublishGuardInput {
  /** Assembled row count for this run. */
  resultCount: number;
  /** Universe size at scan start (denominator for "no rows found anywhere"). */
  universeChecked: number;
  /** Phase 4o W1 — count of external-API calls whose retries exhausted on 429. */
  rateLimitedCalls?: number;
  /** Count of external-API calls that returned a non-429 error. */
  errorCalls?: number;
  /** Total external-API calls attempted. Denominator for the error-rate guard. */
  totalCalls?: number;
}

export interface PublishGuardDecision {
  action: PublishAction;
  /** Human-readable reason. Always set for non-'publish' decisions; may
   *  be set for 'publish' if the caller wants to record context. */
  reason?: string;
}

/**
 * Floor for the "0 rows" guard. Universes smaller than this can legitimately
 * return 0 rows (no insider activity in the window), so the empty-result
 * guard only fires for larger universes. Calibrated so sp500/ndx/dow are
 * NOT subject to the empty guard alone — they're protected by the error-rate
 * arm. The russell2k universe (~2,037) trivially clears this.
 */
export const PUBLISH_GUARD_EMPTY_UNIVERSE_MIN = 100;

/** Skip the swap if more than this fraction of API calls failed. */
export const PUBLISH_GUARD_SKIP_ERROR_RATE = 0.5;

/** Mark the snapshot degraded if more than this fraction failed (but less than the skip threshold). */
export const PUBLISH_GUARD_DEGRADED_ERROR_RATE = 0.1;

/**
 * Decide whether to publish the assembled scan result, publish it marked
 * `degraded`, or skip the swap and keep the previous good snapshot.
 *
 * Decision order:
 *   1. resultCount === 0 AND universeChecked >= PUBLISH_GUARD_EMPTY_UNIVERSE_MIN
 *      → skip. This is the russell2k Bug A pattern — a 2,037-name scan
 *      that returns 0 rows is almost certainly rate-limited into oblivion,
 *      not a legitimate "no insider activity anywhere" finding.
 *   2. totalCalls > 0 AND (rateLimited + errors) / totalCalls >= SKIP_ERROR_RATE
 *      → skip. Data is fundamentally incomplete.
 *   3. resultCount === 0 AND ANY rateLimited > 0 → skip. We can't trust
 *      a 0-row result the moment rate-limiting was on the table at all.
 *   4. totalCalls > 0 AND (rateLimited + errors) / totalCalls >= DEGRADED_ERROR_RATE
 *      → publish-degraded. The data is mostly there but the reader should
 *      know not to bet the farm on it.
 *   5. Otherwise → publish.
 */
export function assessSnapshotPublish(input: PublishGuardInput): PublishGuardDecision {
  const totalCalls = input.totalCalls ?? 0;
  const rateLimited = input.rateLimitedCalls ?? 0;
  const errors = input.errorCalls ?? 0;
  const failures = rateLimited + errors;
  const failureRate = totalCalls > 0 ? failures / totalCalls : 0;

  if (
    input.resultCount === 0 &&
    input.universeChecked >= PUBLISH_GUARD_EMPTY_UNIVERSE_MIN
  ) {
    return {
      action: 'skip',
      reason: `empty result over ${input.universeChecked}-ticker universe; refusing to swap _latest`,
    };
  }

  if (totalCalls > 0 && failureRate >= PUBLISH_GUARD_SKIP_ERROR_RATE) {
    return {
      action: 'skip',
      reason: `failure rate ${failures}/${totalCalls} (${(failureRate * 100).toFixed(0)}%) exceeds skip threshold`,
    };
  }

  if (input.resultCount === 0 && rateLimited > 0) {
    return {
      action: 'skip',
      reason: `empty result with ${rateLimited} rate-limited calls; refusing to publish a hollow snapshot`,
    };
  }

  if (totalCalls > 0 && failureRate >= PUBLISH_GUARD_DEGRADED_ERROR_RATE) {
    return {
      action: 'publish-degraded',
      reason: `degraded: ${failures}/${totalCalls} calls failed (${(failureRate * 100).toFixed(0)}%)`,
    };
  }

  return { action: 'publish' };
}

// ====================================================================
// Phase 4p W2 — snapshot-doc size safety
// ====================================================================
//
// Firestore caps a single document at 1 MiB (1,048,576 bytes), and a
// rejected write throws — which on the russell2k workers historically
// translated to a frozen `status: running` cursor and no snapshot ever
// landing. (W1 makes the terminal write get its own platform budget;
// W2 makes sure the write itself is safe.)
//
// `trimResultsForDocLimit` is a pure helper: it estimates the assembled
// JSON size of the `results` array and, only if it crosses the safety
// ceiling, trims by keeping the leading rows in the producer's sort
// order. The worker stamps `truncated: true` + `originalResultCount`
// on the persisted snapshot so consumers (HistoryView, the backtest
// reader, the live board APIs) can detect a capped snapshot.
//
// Default ceiling 800_000 bytes — leaves comfortable margin for the
// snapshot's wrapper fields (modelVersion, warnings, sieve metadata,
// the Firestore Timestamp marshalled into writtenAt, etc.).

export const SNAPSHOT_DOC_SAFE_BYTES = Number(
  process.env.SCAN_MAX_SNAPSHOT_DOC_BYTES ?? 800_000,
);

export interface TrimResultsOutcome<T> {
  /** Possibly-trimmed results; identical reference to input when no trim was needed. */
  results: T[];
  /** True iff the trim actually fired. */
  truncated: boolean;
  /** Original input length. */
  originalCount: number;
  /** Persisted length. Equal to originalCount when not truncated. */
  storedCount: number;
  /** Best-effort serialized byte estimate for the kept slice. */
  estimatedBytes: number;
}

/**
 * Estimate the serialized JSON size of `results`. If it exceeds
 * `maxBytes`, drop trailing rows (the producer is expected to have sorted
 * results in display-priority order) until the kept slice fits.
 *
 * The estimate uses `JSON.stringify` per row + the joining commas +
 * brackets — close to Firestore's real on-the-wire size; we don't try
 * to model the protobuf overhead exactly because the 800 KB default
 * leaves enough headroom.
 *
 * Pure — no Firestore, fully unit-testable. Used by both russell2k
 * terminal steps; sp500/ndx/dow snapshots are well below the ceiling
 * and pass through without trimming.
 */
export function trimResultsForDocLimit<T>(
  results: T[],
  maxBytes: number = SNAPSHOT_DOC_SAFE_BYTES,
): TrimResultsOutcome<T> {
  if (results.length === 0) {
    return { results, truncated: false, originalCount: 0, storedCount: 0, estimatedBytes: 2 };
  }

  // Serialize the whole array once: cheap relative to the actual write
  // and avoids per-row overhead double-counting.
  const fullJson = JSON.stringify(results);
  const fullBytes = Buffer.byteLength(fullJson, 'utf8');
  if (fullBytes <= maxBytes) {
    return {
      results,
      truncated: false,
      originalCount: results.length,
      storedCount: results.length,
      estimatedBytes: fullBytes,
    };
  }

  // Need to trim. Walk forward, accumulating bytes, until the next row
  // would push us over. Two bytes reserved for the `[]` wrapper, one
  // per comma between rows.
  let acc = 2; // '[' + ']'
  let kept = 0;
  for (let i = 0; i < results.length; i++) {
    const rowJson = JSON.stringify(results[i]);
    const rowBytes = Buffer.byteLength(rowJson, 'utf8');
    const sepBytes = i === 0 ? 0 : 1; // ','
    if (acc + sepBytes + rowBytes > maxBytes) break;
    acc += sepBytes + rowBytes;
    kept += 1;
  }

  return {
    results: results.slice(0, kept),
    truncated: true,
    originalCount: results.length,
    storedCount: kept,
    estimatedBytes: acc,
  };
}

function snapshotIdFor(universe: UniverseKey, when: Date = new Date()): string {
  // YYYY-MM-DD-HHmm in UTC.
  const yyyy = when.getUTCFullYear();
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(when.getUTCDate()).padStart(2, '0');
  const hh = String(when.getUTCHours()).padStart(2, '0');
  const min = String(when.getUTCMinutes()).padStart(2, '0');
  return `${universe}-${yyyy}-${mm}-${dd}-${hh}${min}`;
}

/**
 * Persist a fresh snapshot for a board+universe and update the latest
 * pointer atomically. Old snapshots are kept (Phase 4 backtest reads them).
 */
export async function writeSnapshot(
  board: BoardName,
  universe: UniverseKey,
  snapshot: BoardSnapshot,
): Promise<{ snapshotId: string; promotedToLatest: boolean }> {
  const db = getAdminDb();
  const snapshotId = snapshotIdFor(universe, new Date(snapshot.generatedAt));

  // Phase 6 PR-H follow-up — centralized size-safety trim. Firestore rejects
  // any document over 1 MiB and the whole write throws (the insider sp500
  // scan over the 503-name universe assembled a 2.97 MB doc and failed).
  // Previously only the russell2k workers called trimResultsForDocLimit;
  // applying it here protects EVERY board+universe as the universe grows.
  // Idempotent — a caller that already trimmed passes through unchanged.
  const trim = trimResultsForDocLimit(snapshot.results);
  const safeSnapshot: BoardSnapshot = trim.truncated
    ? { ...snapshot, results: trim.results, truncated: true, originalResultCount: trim.originalCount }
    : snapshot;

  // Phase 6 PR-H — partial-safe write. A snapshot with status:'partial'
  // (scan ran out of budget, results incomplete) is persisted to runs/
  // for diagnostics but does NOT promote into _latest/ — the prior good
  // complete snapshot stays canonical. Without this guard, the brief's
  // hard-stop "NEVER overwrite a good complete snapshot with a failed/
  // empty one" would be violable by a single bad scheduled run.
  const isPartial = safeSnapshot.status === 'partial';

  const runDoc = db.collection('boardSnapshots').doc(board).collection('runs').doc(snapshotId);
  const latestDoc = db
    .collection('boardSnapshots')
    .doc(board)
    .collection('_latest')
    .doc(universe);

  // Wave 2D (M4) — promotion-race guard. Scans overlap in production
  // (russell crons fire every 30 min while a sieve run takes ~15 min;
  // the manual largecap trigger can overlap the 22:00 cron). A blind
  // pointer set would let a scan that STARTED earlier but FINISHED later
  // move _latest backwards onto older data. So inside the transaction we
  // read the current pointer and only promote when this snapshot's
  // generatedAt is strictly newer than the one already promoted.
  let promotedToLatest = false;
  await db.runTransaction(async (tx) => {
    let canPromote = !isPartial;
    if (canPromote) {
      const current = await tx.get(latestDoc);
      const currentGeneratedAt = current.exists
        ? (current.data() as { generatedAt?: string } | undefined)?.generatedAt
        : undefined;
      if (
        typeof currentGeneratedAt === 'string' &&
        new Date(safeSnapshot.generatedAt).getTime() <= new Date(currentGeneratedAt).getTime()
      ) {
        canPromote = false;
      }
    }
    tx.set(runDoc, {
      ...safeSnapshot,
      universe,
      board,
      writtenAt: Timestamp.now(),
    });
    if (canPromote) {
      tx.set(latestDoc, {
        snapshotId,
        generatedAt: safeSnapshot.generatedAt,
        modelVersion: safeSnapshot.modelVersion,
        universeChecked: safeSnapshot.universeChecked,
        resultsCount: safeSnapshot.results.length,
        writtenAt: Timestamp.now(),
      });
    }
    promotedToLatest = canPromote;
  });

  return { snapshotId, promotedToLatest };
}

/**
 * Read the most recent snapshot for board+universe. Null if none exists.
 */
export async function latestSnapshot(
  board: BoardName,
  universe: UniverseKey,
): Promise<BoardSnapshot | null> {
  const db = getAdminDb();
  const latestDoc = await db
    .collection('boardSnapshots')
    .doc(board)
    .collection('_latest')
    .doc(universe)
    .get();
  if (!latestDoc.exists) return null;
  const { snapshotId } = latestDoc.data() as { snapshotId: string };
  if (!snapshotId) return null;

  const runDoc = await db
    .collection('boardSnapshots')
    .doc(board)
    .collection('runs')
    .doc(snapshotId)
    .get();
  if (!runDoc.exists) return null;
  const data = runDoc.data() as BoardSnapshot;
  return data;
}

export function snapshotAgeMs(snapshot: BoardSnapshot, now: number = Date.now()): number {
  return now - new Date(snapshot.generatedAt).getTime();
}

// ====================================================================
// Wave 4A (M2) — schedule-aware freshness
// ====================================================================
//
// A constant age budget cannot model the scan calendar. The daily
// after-close boards scan once per WEEKDAY (skipping NYSE holidays), so
// the Friday-close → Monday-close gap is ~74h and a holiday Monday
// pushes it to ~98h — with a 26h constant, every weekend the snapshot
// is "stale" by construction, and the constants kept getting widened
// (#67/#70/#71 history) to paper over it. The schedule-aware predicate
// replaces that arms race for daily boards:
//
//   fresh ⇔ generatedAt >= the last EXPECTED successful scan slot
//
// where "expected slot" walks back from `now` to the most recent
// weekday slot whose date is not an NYSE holiday
// (us-market-holidays.ts), and a slot only becomes expected once a
// settle-grace window (2h — a scan takes ~15 min; generous margin for
// checkpoint-chained workers) has elapsed, so the predicate never
// demands a snapshot from a scan that is still in flight.
//
// CLASSIFICATION (read from the cron expressions in the scan files):
//
// Daily after-close (schedule-aware slot below):
//   prophet/largecap   `0 22 * * 1-5`   scan-prophet-largecap.ts (holiday-guarded dispatcher)
//   insider/*          `30-45 21 * * 1-5` scan-insider-{sp500,ndx,dow,russell2k}.ts → slot 21:30 (earliest)
//   lynch/*            `0 22 * * 1-5`   scan-lynch-*.ts
//   earnings/*         `30 11,21 * * 1-5` scan-earnings.ts — twice daily; the LAST
//                      (after-close) slot 21:30 is the one the predicate models, so a
//                      Friday-evening snapshot stays fresh across the weekend.
//
// Intraday / budget-based (constant budget kept as the freshness rule):
//   prophet/russell2k, prophet/all  `0,30 13-21 * * 1-5`  scan-prophet-{russell,all}.ts
//   catalyst/*                      `0,30 13-21 * * 1-5`  scan-catalyst-*.ts
//   williams/*                      `0,30 13-21 * * 1-5`  scan-williams-*.ts
//   target-board/dow, /ndx          `0,30 13-21 * * 1-5`  scan-target-board-{dow,ndx}.ts
//   target-board/sp500, /russell2k  `0 23 * * *` (fires 7 days/week, so the 26h
//                                   budget never gaps across weekends)
//
// The per-board budget constants remain in force as a FALLBACK FLOOR for
// every board: any snapshot younger than its budget is fresh regardless
// of the calendar (this is what keeps the intraday boards' semantics
// unchanged, and what keeps manual/off-slot scans fresh on daily boards).

/** A scan must land within this window after its slot before the slot
 *  counts as "expected" (scan ~15 min + EOD-settle margin). */
export const SCAN_SETTLE_GRACE_MS = 2 * 60 * 60_000;

export interface DailyScanSlot {
  hourUtc: number;
  minuteUtc: number;
}

/** Default daily after-close slot (the 22:00 UTC scan calendar). */
export const DEFAULT_DAILY_SCAN_SLOT: DailyScanSlot = { hourUtc: 22, minuteUtc: 0 };

const DAILY_CLOSE_SLOTS: Partial<
  Record<BoardName, { slot: DailyScanSlot; universes?: UniverseKey[] }>
> = {
  // Only largecap scans daily; russell2k/all run the intraday sieve crons.
  prophet: { slot: { hourUtc: 22, minuteUtc: 0 }, universes: ['largecap'] },
  // Insider slots are staggered per-universe (russell2k 21:30 … sp500
  // 22:45 after FIX-1); 21:30 (the earliest) stays the conservative
  // schedule-aware bound for the whole board.
  insider: { slot: { hourUtc: 21, minuteUtc: 30 } },
  lynch: { slot: { hourUtc: 22, minuteUtc: 0 } },
  // FIX-1 W1 — evening earnings scan moved 21:30 → 23:50 UTC, out of
  // the Finnhub-contention window (see scan-earnings.ts). The evening
  // slot is the schedule-aware freshness bound; the 11:50 morning run
  // is covered by the 12h budget floor.
  earnings: { slot: { hourUtc: 23, minuteUtc: 50 } },
};

/**
 * The daily after-close slot for (board, universe), or null when the
 * board/universe is intraday (budget-based freshness only). A daily
 * board whose snapshot doesn't carry its universe is treated as daily
 * only when the board's cadence is daily for ALL universes.
 */
export function dailyScanSlotFor(
  board?: BoardName,
  universe?: UniverseKey,
): DailyScanSlot | null {
  if (!board) return null;
  const entry = DAILY_CLOSE_SLOTS[board];
  if (!entry) return null;
  if (entry.universes) {
    if (!universe || !entry.universes.includes(universe)) return null;
  }
  return entry.slot;
}

/**
 * Walk back from `now` to the most recent EXPECTED scan slot: a
 * weekday-`slot`-UTC time whose date is not an NYSE holiday, and which
 * is at least `graceMs` in the past (a younger slot's scan may still be
 * in flight, so it isn't expected yet). Returns null if no expected
 * slot exists within the 30-day lookback (defensive bound — callers
 * fall back to budget-based freshness).
 */
export function lastExpectedScanSlot(
  now: Date | number,
  slot: DailyScanSlot = DEFAULT_DAILY_SCAN_SLOT,
  graceMs: number = SCAN_SETTLE_GRACE_MS,
): Date | null {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const sameDaySlot = new Date(nowMs);
  sameDaySlot.setUTCHours(slot.hourUtc, slot.minuteUtc, 0, 0);
  // Pure UTC arithmetic — no DST. 30-day bound comfortably covers any
  // weekend + holiday cluster.
  for (let daysBack = 0; daysBack < 30; daysBack++) {
    const candidate = new Date(sameDaySlot.getTime() - daysBack * 86_400_000);
    if (candidate.getTime() + graceMs > nowMs) continue; // not yet expected
    if (isMarketClosed(candidate)) continue; // weekend/holiday — no scan scheduled
    return candidate;
  }
  return null;
}

export function isSnapshotFresh(snapshot: BoardSnapshot, now: number = Date.now()): boolean {
  // Prefer the CURRENT per-board freshness budget over the value baked into
  // the snapshot doc at write time. Without this, a freshness-budget change
  // (e.g. widening williams/catalyst 30min → 26h) only takes effect once
  // every snapshot is rewritten — so an existing snapshot keeps falling into
  // the live `fallback-partial` path until the next scheduled scan (which on
  // a weekend is days away). The stored value is the fallback for any
  // snapshot that doesn't carry its board (older docs / tests).
  const stamped = snapshot as BoardSnapshot & { board?: BoardName; universe?: UniverseKey };
  const budget =
    (stamped.board && FRESHNESS_BUDGETS_MS[stamped.board]) ?? snapshot.freshnessBudgetMs;
  // Budget floor — any snapshot younger than its board budget is fresh.
  if (snapshotAgeMs(snapshot, now) < budget) return true;

  // Wave 4A (M2) — schedule-aware predicate for the daily after-close
  // boards: fresh ⇔ generatedAt >= the last expected scan slot. This is
  // what keeps a Friday-22:05 snapshot fresh on Sunday and across a
  // holiday Monday, while still flagging it stale on a normal Tuesday
  // after a missed Monday scan. Intraday boards (no slot) keep pure
  // budget-based freshness.
  const slot = dailyScanSlotFor(stamped.board, stamped.universe);
  if (!slot) return false;
  const expected = lastExpectedScanSlot(now, slot);
  if (!expected) return false;
  return new Date(snapshot.generatedAt).getTime() >= expected.getTime();
}

/**
 * Wave 4A — keep-daily-close retention policy. The Prophet russell/all
 * workers write a snapshot every 30 min in market hours (up to ~36/day
 * at up to 800KB each) and nothing ever pruned them — runs/ grew
 * unbounded. But the daily after-close snapshots are the backtest
 * substrate (snapshotBeforeDate / PIT reads depend on history), so a
 * simple keep-N would eventually eat it. This mode keeps recent history
 * verbatim and degrades old history to one snapshot per day:
 *
 *   - docs newer than `horizonDays` (default 30): untouched;
 *   - docs older: keep ONE per UTC calendar day — the day's last
 *     (highest generatedAt) non-partial snapshot, falling back to the
 *     day's last doc when the day produced only partials — and delete
 *     the rest (the intraday extras).
 *
 * Pre-horizon PIT reads (snapshotBeforeDate) therefore resolve to the
 * kept daily-close snapshot for that calendar day. Preferring the
 * non-partial doc keeps the M3 status filter satisfiable: deleting a
 * day's only complete snapshot while keeping a later partial would
 * silently shift backtests onto the previous day.
 */
export interface PruneKeepDailyCloseOpts {
  mode: 'keep-daily-close';
  /** Days of full intraday history to keep verbatim (default 30). */
  horizonDays?: number;
  /** Test seam — "now" in epoch ms. */
  now?: number;
}

/**
 * Phase 4h W1 — retention. After a successful scan publishes a fresh
 * snapshot, prune the universe's `runs/` history. Two policies:
 *
 *   - `keep` as a number (default 30): keep the most recent N docs,
 *     delete the rest (the original Phase 4h behavior — insider/target
 *     boards, which have no backtest dependency on deep history);
 *   - `keep` as `{ mode: 'keep-daily-close', ... }`: Wave 4A policy for
 *     the Prophet runs/ history — see PruneKeepDailyCloseOpts above.
 *
 * The `_latest` pointer is untouched — it's a per-universe doc in
 * `_latest/`, not in `runs/`.
 *
 * Deletes are batched in chunks of 100 (well under Firestore's 500-op
 * batch ceiling) so a one-time backlog of hundreds of stale docs is
 * tractable. Best-effort: if a batch fails the next scan will retry.
 */
export async function pruneOldSnapshots(
  board: BoardName,
  universe: UniverseKey,
  keep: number | PruneKeepDailyCloseOpts = 30,
): Promise<{ deleted: number; kept: number }> {
  const db = getAdminDb();
  const all = await db
    .collection('boardSnapshots')
    .doc(board)
    .collection('runs')
    .where('universe', '==', universe)
    .orderBy('generatedAt', 'desc')
    .get();

  let toDelete: FirebaseFirestore.QueryDocumentSnapshot[];
  let kept: number;

  if (typeof keep === 'number') {
    if (all.size <= keep) return { deleted: 0, kept: all.size };
    toDelete = all.docs.slice(keep);
    kept = keep;
  } else {
    const horizonDays = keep.horizonDays ?? 30;
    const now = keep.now ?? Date.now();
    const cutoffIso = new Date(now - horizonDays * 86_400_000).toISOString();

    // Docs arrive newest-first. Group pre-horizon docs by UTC calendar
    // day; per day keep the first (= latest) non-partial doc — or, if
    // the day has only partials, its first doc — and mark the rest.
    toDelete = [];
    const keeperByDay = new Map<string, { isPartial: boolean; doc: FirebaseFirestore.QueryDocumentSnapshot }>();
    for (const doc of all.docs) {
      const data = doc.data() as { generatedAt?: string; status?: string };
      const generatedAt = data.generatedAt;
      if (typeof generatedAt !== 'string' || generatedAt >= cutoffIso) continue; // within horizon — untouched
      const day = generatedAt.slice(0, 10);
      const isPartial = data.status === 'partial';
      const current = keeperByDay.get(day);
      if (!current) {
        keeperByDay.set(day, { isPartial, doc });
      } else if (current.isPartial && !isPartial) {
        // Found the day's latest non-partial; demote the partial keeper.
        toDelete.push(current.doc);
        keeperByDay.set(day, { isPartial, doc });
      } else {
        toDelete.push(doc);
      }
    }
    kept = all.size - toDelete.length;
    if (toDelete.length === 0) return { deleted: 0, kept };
  }

  let deleted = 0;
  const CHUNK = 100;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const slice = toDelete.slice(i, i + CHUNK);
    const batch = db.batch();
    for (const d of slice) batch.delete(d.ref);
    await batch.commit();
    deleted += slice.length;
  }
  return { deleted, kept };
}

/**
 * Lightweight age summary used by /api/health to expose per-board freshness.
 */
export async function snapshotAgesForBoard(
  board: BoardName,
  universes: UniverseKey[],
): Promise<Record<string, { ageMs: number; generatedAt: string } | null>> {
  const db = getAdminDb();
  const out: Record<string, { ageMs: number; generatedAt: string } | null> = {};
  await Promise.all(
    universes.map(async (u) => {
      const doc = await db
        .collection('boardSnapshots')
        .doc(board)
        .collection('_latest')
        .doc(u)
        .get();
      if (!doc.exists) {
        out[u] = null;
        return;
      }
      const { generatedAt } = doc.data() as { generatedAt: string };
      if (!generatedAt) {
        out[u] = null;
        return;
      }
      out[u] = {
        generatedAt,
        ageMs: Date.now() - new Date(generatedAt).getTime(),
      };
    }),
  );
  return out;
}

// ====================================================================
// History / replay (HistoryView reads through these)
// ====================================================================

export interface SnapshotListItem {
  snapshotId: string;
  generatedAt: string;
  modelVersion: string;
  resultsCount: number;
  universeChecked: number;
}

/**
 * List snapshot IDs for a board+universe, newest first. `limit` caps the
 * number of returned items (default 60, ~2 weeks at 4-snapshot-per-day cadence).
 *
 * Note: snapshot IDs encode the date (YYYY-MM-DD-HHmm), so the firestore-side
 * orderBy on document name is equivalent to orderBy generatedAt.
 */
export async function listSnapshots(
  board: BoardName,
  universe: UniverseKey,
  limit: number = 60,
): Promise<SnapshotListItem[]> {
  const db = getAdminDb();
  const snap = await db
    .collection('boardSnapshots')
    .doc(board)
    .collection('runs')
    .where('universe', '==', universe)
    .orderBy('generatedAt', 'desc')
    .limit(limit)
    .get();

  return snap.docs.map((d) => {
    const data = d.data();
    return {
      snapshotId: d.id,
      generatedAt: data.generatedAt,
      modelVersion: data.modelVersion,
      resultsCount: Array.isArray(data.results) ? data.results.length : 0,
      universeChecked: data.universeChecked ?? 0,
    };
  });
}

/**
 * Read a specific historical snapshot by its ID. Used by HistoryView for
 * replay. Null if the ID doesn't exist for this board+universe.
 */
export async function getSnapshotById(
  board: BoardName,
  universe: UniverseKey,
  snapshotId: string,
): Promise<BoardSnapshot | null> {
  const db = getAdminDb();
  const doc = await db
    .collection('boardSnapshots')
    .doc(board)
    .collection('runs')
    .doc(snapshotId)
    .get();
  if (!doc.exists) return null;
  const data = doc.data() as BoardSnapshot & { universe?: UniverseKey };
  // Guard against accidental cross-universe pulls (snapshotId could collide if
  // two universes wrote the same minute, though our IDs include universe).
  if (data.universe && data.universe !== universe) return null;
  return data;
}

// ====================================================================
// Point-in-time fallback helpers (Phase 3)
// ====================================================================
//
// When a vendor's API doesn't natively support an "as-of" parameter
// (e.g., Finnhub recommendations carry no per-rating timestamp), we
// fall back to "what we read on the most recent snapshot prior to
// asOfDate." These helpers expose that lookup as a typed read.
//
// Phase 4 backtest reads through these — they are the bridge between
// the live vendor surfaces and the historical record stored in
// boardSnapshots/{board}/runs/.

/**
 * Find the most recent snapshot for (board, universe) generated on or
 * before `asOfDate` (end-of-day UTC, inclusive). Returns null if no
 * such snapshot exists in the store.
 *
 * Used by providers whose vendors don't natively support PIT, so we
 * fall back to "what we read on the most recent prior date."
 *
 * Implementation note: snapshot IDs encode the date as
 * `{universe}-{YYYY-MM-DD-HHmm}`. The Firestore-side orderBy on
 * generatedAt + a `<=` filter is the most reliable path.
 *
 * PIT-cacheable: keyed by (board, universe, asOfDate).
 */
export async function snapshotBeforeDate(
  board: BoardName,
  universe: UniverseKey,
  asOfDate: string,
): Promise<BoardSnapshot | null> {
  const db = getAdminDb();
  // End-of-day UTC ceiling — anything generated up to and including
  // 23:59:59.999 on asOfDate counts as "on or before."
  const cutoffIso = `${asOfDate}T23:59:59.999Z`;
  const base = db
    .collection('boardSnapshots')
    .doc(board)
    .collection('runs')
    .where('universe', '==', universe)
    .where('generatedAt', '<=', cutoffIso)
    .orderBy('generatedAt', 'desc');

  // Wave 2D (M3) — status filter. Partial snapshots are deliberately
  // written to runs/ for diagnostics and NEVER promoted to _latest (the
  // writeSnapshot guard). PIT reads and the backtest ranking signal must
  // honor the same canon: skip status:'partial' docs and return the most
  // recent non-partial snapshot ≤ asOfDate. Degraded snapshots stay
  // eligible — the promotion guard publishes those (status:'complete',
  // degraded:true), so they ARE canonical.
  //
  // Walked in pages rather than a where('status','!=',…) clause because
  // Firestore disallows an inequality on status alongside the
  // generatedAt range + orderBy. Page size 10 covers the common case
  // (zero or few partials) in one read.
  const PAGE = 10;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    const query: FirebaseFirestore.Query = cursor
      ? base.startAfter(cursor).limit(PAGE)
      : base.limit(PAGE);
    const snap: FirebaseFirestore.QuerySnapshot = await query.get();
    if (snap.empty) return null;
    for (const doc of snap.docs) {
      const data = doc.data() as BoardSnapshot;
      if (data.status !== 'partial') return data;
    }
    if (snap.docs.length < PAGE) return null;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/**
 * Convenience wrapper: given a per-ticker field name, find the value of
 * that field for `ticker` in the latest snapshot ≤ asOfDate. Returns
 * null if no snapshot exists or the ticker is missing from it.
 *
 * Snapshots store results as `unknown[]` — callers know the shape per
 * board (e.g., catalyst rows have `recommendation`). We type the return
 * with a generic so callers can cast at the call site.
 *
 * PIT-cacheable: keyed by (board, universe, ticker, field, asOfDate).
 */
export async function fieldAtDate<T>(
  board: BoardName,
  universe: UniverseKey,
  ticker: string,
  field: string,
  asOfDate: string,
): Promise<T | null> {
  const snap = await snapshotBeforeDate(board, universe, asOfDate);
  if (!snap) return null;
  const row = (snap.results as any[]).find(
    (r) => r && typeof r === 'object' && r.ticker === ticker,
  );
  if (!row) return null;
  const val = row[field];
  return val === undefined ? null : (val as T);
}
