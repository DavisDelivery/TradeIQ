// GET /api/scan-status?board=<board>&universe=<universe>
//
// Phase 4o W2 — diagnostic surface for the checkpoint-resume scan
// workers. Reads the most recent `scanRuns/{runId}` doc for a given
// board+universe and returns its cursor state: how far through the
// universe the latest run got, how many invocations chained, whether
// it terminated or stalled, and (when present) the W1 rate-limit
// accounting.
//
// Built for one specific question: did the russell2k target-board scan
// chain to its terminal invocation, or did it stall mid-chain (the
// suspected Bug B). The cursor doc is the single source of truth for
// that — it's written at every batch boundary and cleared on the
// terminal write. A non-null cursor with `status: 'running'` and an
// old `lastInvocationStartedAt` is a stalled chain.
//
// No mutation. Read-only diagnostic.

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

// FIX-1 W1 — lynch/catalyst/earnings gained checkpoint-resume workers
// (#96/#97 + the earnings port); their scanRuns docs share the
// `<board>-<universe>-YYYYMMDD-HHmmss` runId shape, so the same
// diagnostic works. 'all' is the earnings store key.
const VALID_BOARDS = new Set(['target-board', 'insider', 'lynch', 'catalyst', 'earnings']);
const VALID_UNIVERSES = new Set(['sp500', 'ndx', 'dow', 'russell2k', 'all']);

interface ScanRunSummary {
  runId: string;
  status?: string;
  cursor: unknown;
  updatedAt?: string;
  finishedAt?: string;
  /** ms between cursor.lastInvocationStartedAt and "now" — > 15 min
   *  means the chain stopped without a terminal write (stall). */
  invocationAgeMs?: number;
  /** ms between cursor.startedAt and "now" — total scan wall-clock so
   *  far. Useful for spotting a chain that exceeds the nightly window. */
  scanAgeMs?: number;
  /** FIX-1 W1 — terminal publish-guard decision ('publish' /
   *  'publish-degraded' / 'skip') when the worker stamped it. */
  publishAction?: string;
  /** Guard reason accompanying a 'skip' / 'publish-degraded'. */
  publishReason?: string | null;
}

/**
 * Phase 4p W3 — accept either `scan=<board>-<universe>` (the orchestrator's
 * preferred shorthand) or the longer `board=...&universe=...` form. Before
 * this fix the endpoint silently dropped the `scan` param and always
 * returned target-board russell2k — that's how the insider scan's freeze
 * went un-diagnosed in 4o. Splitting on the first non-board hyphen is
 * required because "target-board" itself contains a hyphen.
 */
function parseScanParam(scan: string): { board: string; universe: string } | null {
  for (const b of VALID_BOARDS) {
    const prefix = `${b}-`;
    if (scan.startsWith(prefix)) {
      const universe = scan.slice(prefix.length);
      if (!universe) return null;
      return { board: b, universe };
    }
  }
  return null;
}

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};

  let board: string;
  let universe: string;
  if (typeof qs.scan === 'string' && qs.scan.length > 0) {
    const parsed = parseScanParam(qs.scan);
    if (!parsed) {
      return json(400, {
        error: `invalid scan '${qs.scan}'; expected '<board>-<universe>' (e.g. 'insider-russell2k', 'target-board-sp500')`,
      });
    }
    board = parsed.board;
    universe = parsed.universe;
  } else {
    board = qs.board ?? 'target-board';
    universe = qs.universe ?? 'russell2k';
  }
  const limit = Math.min(Math.max(Number(qs.limit) || 5, 1), 20);

  const log = logger.child({ fn: 'scan-status', board, universe });

  if (!VALID_BOARDS.has(board)) {
    return json(400, { error: `invalid board '${board}'; expected one of ${[...VALID_BOARDS].join(', ')}` });
  }
  if (!VALID_UNIVERSES.has(universe)) {
    return json(400, { error: `invalid universe '${universe}'; expected one of ${[...VALID_UNIVERSES].join(', ')}` });
  }

  try {
    const db = getAdminDb();
    // Cursor runIds are formatted `<board>-<universe>-YYYYMMDD-HHmmss`
    // (insider) or `target-board-<universe>-...` (target-board). The
    // ID prefix is the most reliable filter — Firestore's `where`
    // doesn't support startsWith, so we use a range query on the doc ID.
    // Every checkpoint-resume worker names its runs
    // `<board>-<universe>-YYYYMMDD-HHmmss` ('target-board' includes its
    // own hyphen, so the generic template covers it too).
    const idPrefix = `${board}-${universe}-`;
    const upperBound = idPrefix + '';

    const snap = await db
      .collection('scanRuns')
      .orderBy('__name__', 'desc')
      .startAt(upperBound)
      .endAt(idPrefix)
      .limit(limit)
      .get();

    const now = Date.now();
    const runs: ScanRunSummary[] = snap.docs.map((d) => {
      const data = d.data() as any;
      const cursor = data?.cursor;
      const out: ScanRunSummary = {
        runId: d.id,
        status: data?.status,
        cursor: cursor ?? null,
        updatedAt: data?.updatedAt,
        finishedAt: data?.finishedAt,
        // FIX-1 W1 — terminal-step publish-guard decision, stamped by
        // clearScanCursor's `extra` arg. Explains WHY a run ended
        // status:'error' (e.g. "failure rate 60% exceeds skip threshold").
        publishAction: data?.publishAction,
        publishReason: data?.publishReason,
      };
      if (cursor) {
        const last = cursor.lastInvocationStartedAt;
        if (typeof last === 'string') {
          const t = Date.parse(last);
          if (Number.isFinite(t)) out.invocationAgeMs = now - t;
        }
        const start = cursor.startedAt;
        if (typeof start === 'string') {
          const t = Date.parse(start);
          if (Number.isFinite(t)) out.scanAgeMs = now - t;
        }
      }
      return out;
    });

    return json(200, {
      board,
      universe,
      now: new Date(now).toISOString(),
      runs,
      // Convenience: the topmost run, if any.
      latest: runs[0] ?? null,
    });
  } catch (err: any) {
    log.error('scan_status_failed', { err: String(err?.message ?? err) });
    return json(500, { error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown): { statusCode: number; headers: Record<string, string>; body: string } {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
