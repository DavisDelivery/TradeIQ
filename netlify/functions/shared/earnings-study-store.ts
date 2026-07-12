// FIX-2 W2 — Firestore persistence for the earnings edge study.
//
// Deliberately a SEPARATE collection (`earningsEdgeStudies`) from
// backtestRuns: a study is a base-rate measurement artifact, not a
// portfolio backtest, and the two have different lifecycles + TTLs. The
// event rows stream to a per-study `events` subcollection (chunked) so a
// 500-name universe × ~28 prints (~14k events) never inflates the top
// doc past Firestore's 1 MiB ceiling — same lesson as backtest phase-4u.

import { getAdminDb } from './firebase-admin';
import type { EarningsStudyResult, StudyEvent } from './earnings-study';

export const STUDY_COLLECTION = 'earningsEdgeStudies';

/** Studies older than this are stale; the trigger re-runs rather than serve. */
export const STUDY_TTL_MS = 24 * 60 * 60 * 1000; // daily

export type StudyStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface StudyDoc {
  studyId: string;
  universe: string;
  years: number;
  windowStart: string;
  windowEnd: string;
  status: StudyStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  /** The assembled study — present only on status 'complete'. */
  result?: EarningsStudyResult;
  /** Resume cursor (per-ticker). Null/absent on fresh + terminal. */
  cursor?: StudyCursor | null;
}

export interface StudyCursor {
  nextTickerIndex: number;
  totalTickers: number;
  eventCount: number;
  invocationCount: number;
  lastInvocationStartedAt: string;
  lastReinvokeAt?: string;
  lastReinvokeError?: string;
}

function db() {
  return getAdminDb();
}

// Bump when the event/aggregation schema changes so a new run allocates a
// FRESH doc + events subcollection instead of resuming a contaminated one.
// v2: liveness-on-updatedAt + clear-events-on-fresh-start + finalize dedupe.
export const STUDY_SCHEMA_VERSION = 'v2';

/** Deterministic-per-day id so a same-day re-fire single-flights cleanly. */
export function studyIdFor(universe: string, years: number, dayIso: string): string {
  return `es_${universe}_${years}y_${STUDY_SCHEMA_VERSION}_${dayIso.replace(/-/g, '')}`;
}

export async function readStudy(studyId: string): Promise<StudyDoc | null> {
  const snap = await db().collection(STUDY_COLLECTION).doc(studyId).get();
  return snap.exists ? (snap.data() as StudyDoc) : null;
}

/**
 * Return a study for (universe, years) that is COMPLETE and fresh (within
 * TTL of `nowMs`). Never returns an empty/failed study — the caller
 * re-runs. This is the "never serve/cache empty" guard the earnings-radar
 * cache-poisoning incident (PR #103) taught us to make explicit.
 */
export async function findFreshCompleteStudy(
  universe: string,
  years: number,
  nowMs: number,
): Promise<StudyDoc | null> {
  const snap = await db()
    .collection(STUDY_COLLECTION)
    .where('universe', '==', universe)
    .where('years', '==', years)
    .where('status', '==', 'complete')
    .limit(10)
    .get();
  let best: StudyDoc | null = null;
  snap.forEach((doc) => {
    const d = doc.data() as StudyDoc;
    if (!d.result || d.result.eventCount === 0) return; // never serve empty
    const completedMs = Date.parse(d.completedAt ?? d.updatedAt ?? '');
    if (!Number.isFinite(completedMs) || nowMs - completedMs > STUDY_TTL_MS) return;
    if (!best || completedMs > Date.parse(best.completedAt ?? best.updatedAt ?? '')) {
      best = d;
    }
  });
  return best;
}

/**
 * A run is presumed DEAD (re-fireable) if its cursor hasn't advanced in
 * this long. Liveness is measured on `updatedAt` — which every batch's
 * cursor write bumps — NOT `startedAt`. Using startedAt was a real bug:
 * a legitimate sp500 study runs 30-40 min, so a startedAt+30min window
 * declared a still-live chain "dead" and a poll re-dispatched it, racing
 * a second chain onto the same studyId. A batch can be mid-flight for up
 * to the 13-min budget without writing, so 20 min covers a live batch
 * with margin while still reaping a genuinely stalled chain.
 */
export const STUDY_STALL_MS = 20 * 60 * 1000;

/**
 * A pending/running study for this pair whose cursor advanced within the
 * stall window — i.e. a genuinely live chain the caller must NOT re-fire.
 * Returns null when the only matches are stalled (so the caller re-runs).
 */
export async function findInFlightStudy(
  universe: string,
  years: number,
  nowMs: number,
): Promise<StudyDoc | null> {
  const snap = await db()
    .collection(STUDY_COLLECTION)
    .where('universe', '==', universe)
    .where('years', '==', years)
    .where('status', 'in', ['pending', 'running'])
    .limit(10)
    .get();
  let found: StudyDoc | null = null;
  snap.forEach((doc) => {
    const d = doc.data() as StudyDoc;
    // Liveness on updatedAt (cursor advances bump it); fall back to
    // startedAt for a just-created doc that hasn't batched yet.
    const liveMs = Date.parse(d.updatedAt ?? d.startedAt ?? '');
    if (Number.isFinite(liveMs) && nowMs - liveMs < STUDY_STALL_MS) {
      found = d;
    }
  });
  return found;
}

/**
 * A pending/running study for this pair whose cursor has REAL progress
 * (nextTickerIndex > 0) but is NOT currently live (the caller only reaches
 * here after findInFlightStudy returned null). This is the resume target:
 * a chain whose self-reinvoke was dropped (the FIX-1 reinvoke fragility)
 * left partial work on the cursor — re-dispatching it continues from
 * nextTickerIndex instead of throwing the progress away and restarting at
 * zero. Picks the most-recently-updated such doc.
 */
export async function findStalledResumableStudy(
  universe: string,
  years: number,
): Promise<StudyDoc | null> {
  const snap = await db()
    .collection(STUDY_COLLECTION)
    .where('universe', '==', universe)
    .where('years', '==', years)
    .where('status', 'in', ['pending', 'running'])
    .limit(10)
    .get();
  let best: StudyDoc | null = null;
  snap.forEach((doc) => {
    const d = doc.data() as StudyDoc;
    if (!d.cursor || (d.cursor.nextTickerIndex ?? 0) <= 0) return; // no real progress
    if (!best || Date.parse(d.updatedAt ?? '') > Date.parse(best.updatedAt ?? '')) {
      best = d;
    }
  });
  return best;
}

export async function persistStudyPending(doc: StudyDoc): Promise<void> {
  await db().collection(STUDY_COLLECTION).doc(doc.studyId).set(doc, { merge: true });
}

export async function persistStudyStatus(
  studyId: string,
  patch: Partial<StudyDoc>,
): Promise<void> {
  await db()
    .collection(STUDY_COLLECTION)
    .doc(studyId)
    .set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
}

export async function writeStudyCursor(
  studyId: string,
  cursor: StudyCursor | null,
): Promise<void> {
  await persistStudyStatus(studyId, { cursor });
}

export async function persistStudyComplete(
  studyId: string,
  result: EarningsStudyResult,
): Promise<void> {
  const now = new Date().toISOString();
  await db().collection(STUDY_COLLECTION).doc(studyId).set(
    {
      status: 'complete',
      result,
      cursor: null,
      completedAt: now,
      updatedAt: now,
    },
    { merge: true },
  );
}

export async function persistStudyFailed(studyId: string, error: string): Promise<void> {
  await persistStudyStatus(studyId, { status: 'failed', error, cursor: null });
}

// --- Event subcollection (chunked, insertion-ordered) --------------------

export async function appendStudyEvents(
  studyId: string,
  events: StudyEvent[],
  startIdx: number,
): Promise<void> {
  if (events.length === 0) return;
  const col = db().collection(STUDY_COLLECTION).doc(studyId).collection('events');
  const CHUNK = 400;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    const batch = db().batch();
    slice.forEach((e, j) => {
      const id = String(startIdx + i + j).padStart(8, '0');
      batch.set(col.doc(id), e as unknown as Record<string, unknown>);
    });
    await batch.commit();
  }
}

export async function readAllStudyEvents(studyId: string): Promise<StudyEvent[]> {
  const col = db().collection(STUDY_COLLECTION).doc(studyId).collection('events');
  const snap = await col.get();
  const out: StudyEvent[] = [];
  snap.forEach((doc) => out.push(doc.data() as StudyEvent));
  return out;
}

/**
 * Delete every event doc under a study. Called on a FRESH (non-resume)
 * background start so a re-dispatched run can't accumulate on top of a
 * prior run's events (the index-keyed append would otherwise interleave
 * two chains). Idempotent; safe on an empty subcollection.
 */
export async function clearStudyEvents(studyId: string): Promise<void> {
  const col = db().collection(STUDY_COLLECTION).doc(studyId).collection('events');
  const snap = await col.get();
  const docs = snap.docs;
  const CHUNK = 400;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db().batch();
    docs.slice(i, i + CHUNK).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}
