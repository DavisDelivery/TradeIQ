// Phase 4h W1 — scan checkpoint cursor.
//
// Mirrors `shared/backtest-resume/cursor.ts` but with scan-specific
// fields. The shape is intentionally narrow: the scan worker walks a
// linear universe of tickers and accumulates Target rows; the cursor
// records resume position and a few cumulative counters. Partial
// results live in a subcollection (`scanRuns/{runId}/partial/{batchId}`)
// — accumulating them on the cursor doc would blow Firestore's 1 MiB
// per-doc ceiling on the russell2k universe, the same trap the
// 4e-1-infra mlTraining rows solved with the same subcollection split.
//
// The watchdog (`backtest-resume/watchdog.ts`) and self-reinvoke helper
// (`backtest-resume/reinvoke.ts`) are universe-agnostic — they're
// imported as-is into the scan worker rather than duplicated here.

import type { Firestore } from 'firebase-admin/firestore';

export type ScanStatus = 'running' | 'done' | 'error';

/**
 * Phase 4p W1 — cursor phase. Distinguishes "still walking the universe"
 * from "walk complete, terminal step pending its own dedicated 15-min
 * invocation." The bg-worker's entry branches on phase: a `finalizing`
 * cursor skips the batch loop entirely and runs only the terminal step
 * (read partials → assemble → writeSnapshot → clearScanCursor) with a
 * fresh full budget. The previous design crammed the terminal step into
 * the tail of the last batch-processing invocation and ran out of time;
 * see briefs/phase-4p-brief.md for the diagnostic evidence.
 *
 * Missing field on older cursors means 'scanning' — backwards compatible.
 */
export type ScanPhase = 'scanning' | 'finalizing';

/**
 * Per-run scan cursor. Read by the bg-worker on entry; rewritten at
 * each batch boundary. Cleared on the terminal write so a stray
 * re-invocation observes "no resume needed" and exits cleanly.
 */
export interface ScanCursor {
  /** Universe being scanned — kept on the cursor for observability. */
  universe: string;
  /** Board name (always 'target-board' in Phase 4h). */
  board: string;
  /** Lifecycle state. The terminal write flips to 'done' and clears the cursor. */
  status: ScanStatus;
  /** Phase 4p W1 — see ScanPhase. Optional for backwards compatibility
   *  with in-flight cursors written before this phase shipped; readers
   *  treat `undefined` as 'scanning'. */
  phase?: ScanPhase;
  /** 0-based index of the NEXT ticker to process. */
  nextTickerIndex: number;
  /** Total tickers in the universe at scan start. Immutable across batches. */
  totalTickers: number;
  /** 1-indexed counter; increments on each batch. invocationCount > 1 proves chaining. */
  invocationCount: number;
  /** ISO timestamp of the scan's first invocation. Immutable across batches. */
  startedAt: string;
  /** ISO timestamp of the current invocation's start. Updated each batch. */
  lastInvocationStartedAt: string;
  /** Running count of partial-batch docs written so far. */
  partialBatchCount: number;
  /** Running count of scored Target rows accumulated. (Some tickers
   *  yield no Target — bars.length < 50, etc. — so this can be less
   *  than nextTickerIndex.) */
  scoredCount: number;
  /** Most recent error (if any). Cleared on a successful batch. */
  lastError?: string;
  /** Set if a self-reinvoke fetch failed; orchestrator may need to recover. */
  lastReinvokeError?: string;
  /** Phase 4o W2 — ISO timestamp of the most recent self-reinvoke
   *  dispatch attempt. When `status === 'running'` and this is set, we
   *  KNOW the watchdog tripped and we attempted to chain. If
   *  `invocationCount` doesn't advance past this point, the reinvoke
   *  fetch landed (or didn't) but the next invocation never ran. That
   *  pinpoints the stall to the reinvoke layer rather than the
   *  watchdog or the batch loop. */
  lastReinvokeAt?: string;
  /** Phase 4o W2 — running counter of self-reinvoke dispatches. Compare
   *  to `invocationCount` post-mortem: if reinvokeAttempts === N and
   *  invocationCount === N, the chain stalled at the Nth handoff. */
  reinvokeAttempts?: number;
  /** Phase 4o W1/W3 — total external-API calls attempted across all
   *  batches so far. The terminal batch feeds this to the W3 guard so
   *  a degraded run can't atomic-swap _latest. */
  apiCalls?: number;
  /** Phase 4o W1/W3 — calls whose retries exhausted on 429. */
  apiRateLimited?: number;
  /** Phase 4o W1/W3 — calls that returned non-429 errors. */
  apiErrors?: number;
}

const RUN_COLLECTION = 'scanRuns';
const PARTIAL_SUBCOLLECTION = 'partial';

/**
 * Read the cursor field from a scan run doc. Returns null when:
 *   - The doc doesn't exist (treat as missing run).
 *   - The doc exists but has no `cursor` field, or the field is null
 *     (terminal write has already cleared it; treat as no-op).
 */
export async function readScanCursor(
  db: Firestore,
  runId: string,
): Promise<ScanCursor | null> {
  const snap = await db.collection(RUN_COLLECTION).doc(runId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || data.cursor == null) return null;
  return data.cursor as ScanCursor;
}

/**
 * Merge-write a cursor onto a scan run doc. Existing fields (e.g.
 * `startedAt`, `config`) are preserved.
 */
export async function writeScanCursor(
  db: Firestore,
  runId: string,
  cursor: ScanCursor,
): Promise<void> {
  await db
    .collection(RUN_COLLECTION)
    .doc(runId)
    .set({ cursor, updatedAt: new Date().toISOString() }, { merge: true });
}

/**
 * Null out the cursor on the terminal write. Implemented as merge
 * `cursor: null` rather than FieldValue.delete() — readScanCursor
 * treats null and missing identically, so the simpler write suffices.
 */
export async function clearScanCursor(
  db: Firestore,
  runId: string,
  finalStatus: ScanStatus = 'done',
): Promise<void> {
  await db
    .collection(RUN_COLLECTION)
    .doc(runId)
    .set(
      { cursor: null, status: finalStatus, finishedAt: new Date().toISOString() },
      { merge: true },
    );
}

/**
 * Append a batch of scored rows to the partial-results subcollection.
 * Batches are deterministically numbered by `partialBatchCount` so
 * readback ordering is stable across invocations.
 */
export async function appendPartialBatch<T>(
  db: Firestore,
  runId: string,
  batchIndex: number,
  rows: T[],
): Promise<void> {
  if (rows.length === 0) return;
  const docId = `batch-${String(batchIndex).padStart(6, '0')}`;
  await db
    .collection(RUN_COLLECTION)
    .doc(runId)
    .collection(PARTIAL_SUBCOLLECTION)
    .doc(docId)
    .set({
      batchIndex,
      rowCount: rows.length,
      rows,
      writtenAt: new Date().toISOString(),
    });
}

/**
 * Read back every partial batch in order on the terminal invocation
 * to assemble the full scored result set for `writeSnapshot`.
 */
export async function readAllPartialBatches<T>(
  db: Firestore,
  runId: string,
): Promise<T[]> {
  const snap = await db
    .collection(RUN_COLLECTION)
    .doc(runId)
    .collection(PARTIAL_SUBCOLLECTION)
    .orderBy('batchIndex', 'asc')
    .get();
  const out: T[] = [];
  for (const d of snap.docs) {
    const data = d.data() as { rows?: T[] };
    if (Array.isArray(data.rows)) out.push(...data.rows);
  }
  return out;
}

/**
 * After the terminal snapshot is written + the `_latest` pointer is
 * advanced, the partial-results subcollection is no longer needed.
 * Deletes are batched (Firestore caps at 500 ops per commit). Best-
 * effort — if the cleanup fails the partial docs remain but the scan
 * is otherwise complete; a future scan will simply create a new run
 * with its own partial subcollection.
 */
export async function deletePartialBatches(
  db: Firestore,
  runId: string,
): Promise<{ deleted: number }> {
  const snap = await db
    .collection(RUN_COLLECTION)
    .doc(runId)
    .collection(PARTIAL_SUBCOLLECTION)
    .get();
  if (snap.empty) return { deleted: 0 };
  let deleted = 0;
  const CHUNK = 400;
  for (let i = 0; i < snap.docs.length; i += CHUNK) {
    const slice = snap.docs.slice(i, i + CHUNK);
    const batch = db.batch();
    for (const d of slice) batch.delete(d.ref);
    await batch.commit();
    deleted += slice.length;
  }
  return { deleted };
}

/**
 * Phase 4p W1 — read the cursor's phase with the back-compat default.
 * A cursor written before 4p has no `phase` field; treat it as 'scanning'
 * so the existing batch-loop control flow runs unchanged.
 */
export function getCursorPhase(cursor: ScanCursor): ScanPhase {
  return cursor.phase ?? 'scanning';
}

// Exposed for tests.
export const _internals = { RUN_COLLECTION, PARTIAL_SUBCOLLECTION };
