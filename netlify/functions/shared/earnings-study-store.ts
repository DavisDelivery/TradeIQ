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

/** Deterministic-per-day id so a same-day re-fire single-flights cleanly. */
export function studyIdFor(universe: string, years: number, dayIso: string): string {
  return `es_${universe}_${years}y_${dayIso.replace(/-/g, '')}`;
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

/** Any pending/running study for this pair started within the TTL window. */
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
    const startedMs = Date.parse(d.startedAt ?? '');
    // A study stuck >30min is presumed dead; don't let it block a re-fire.
    if (Number.isFinite(startedMs) && nowMs - startedMs < 30 * 60 * 1000) {
      found = d;
    }
  });
  return found;
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
