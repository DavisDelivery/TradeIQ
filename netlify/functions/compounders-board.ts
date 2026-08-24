// GET /api/compounders-board?limit=40
//
// COMP-1 — the read side of the Compounders board (quality-led, momentum-
// confirmed; see shared/compounders.ts for why the board exists at all).
//
// Snapshot-first reader (serve-stale, NEVER inline-scan — the M1 pattern the
// quiet-strength board established). The scan reads statements and a year of
// prices for the whole largecap universe, so an inline fallback would not be
// a slower version of this endpoint, it would be a different and much worse
// product than serving yesterday's ranking.
//
// The response ALWAYS carries `banner`. It is lifted from the snapshot when
// one exists and rebuilt from the policy module when one does not, so there
// is no reachable code path — not snapshot-missing, not snapshot-unpublished,
// not stale, not the 500 — on which this endpoint answers without the
// evidence grade attached. That matters more here than on any other board:
// this one has NO measurement behind it, and an unlabelled ranking of famous
// mega-caps reads as a recommendation.

import type { Handler } from '@netlify/functions';
import {
  latestSnapshot,
  isSnapshotFresh,
  snapshotAgeMs,
  listSnapshots,
  getSnapshotById,
  type BoardName,
} from './shared/snapshot-store';
import {
  POLICY_VERSION,
  MIN_DISCOVERY_T,
  discoveryVerdict,
  haircutExcess,
  haircutLabel,
} from './shared/research-policy';
import { logger } from './shared/logger';

// The store's BoardName union is widened by the WRITER's change — the
// background worker is the one that has to type a writeSnapshot call. A read
// endpoint is not the right place to widen a shared type, so the key is
// asserted exactly once, here; the assertion becomes a no-op (and should be
// deleted) as soon as 'compounders' is in the union.
const BOARD = 'compounders' as unknown as BoardName;
const UNIVERSE = 'largecap' as const;

/** Rows served when the caller says nothing. */
const DEFAULT_LIMIT = 40;
/**
 * Hard ceiling on `?limit=`. Matches quiet-strength: the payload is bounded
 * by the endpoint, not by whatever a caller types into the query string.
 */
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

export interface CompoundersBanner {
  /**
   * There is no t-statistic for THIS board. The inputs (profitability,
   * 12-1 momentum) replicate externally; the combination does not inherit
   * their evidence, and grading it 'replicated-external' the way
   * quiet-strength does would be borrowing a measurement we never took.
   */
  grade: 'unmeasured';
  /** Null by construction — there is no backtested figure to haircut. */
  netEdgePp: number | null;
  /** Rendered through the policy helper so it cannot drift from netEdgePp. */
  netEdgeLabel: string;
  /** The mandatory user-facing sentence. */
  headline: string;
  /** Rule-3 verdict. A null t renders "NOT MEASURED (no t-statistic)". */
  discovery: string;
  policyVersion: string;
  /** Citations for the INPUTS, so the payload carries its own provenance. */
  sources: string[];
}

/**
 * Build the banner that MUST ride in the payload.
 *
 * Both figures are DERIVED by putting `null` through the same policy helpers
 * every measured board's numbers go through, rather than written down as
 * "not measured" strings. That is the point: the day someone forward-tests
 * this board, the only way a number can appear here is by passing a real
 * excess return through `haircutExcess`, which means it arrives already
 * halved — the failure mode research-policy rule 2 exists to prevent is a
 * gross number reaching a screen, and a hand-written string is exactly how
 * one would.
 *
 * NOTHING in this text may read as an edge. "Unmeasured" is not "small" and
 * it is not "zero" — the board may well be worse than buy-and-hold, which is
 * what the commissioned review found of all seven boards that WERE measured.
 */
export function buildEvidenceBanner(): CompoundersBanner {
  const netEdgePp = haircutExcess(null);
  const netEdgeLabel = haircutLabel(null);

  return {
    grade: 'unmeasured',
    netEdgePp,
    netEdgeLabel,
    headline:
      `Expected edge over SPY: ${netEdgeLabel}. This board has never been ` +
      'backtested or forward-tested, so there is no t-statistic at all here — ' +
      `let alone one clearing the |t| > ${MIN_DISCOVERY_T} discovery bar — and ` +
      '"unmeasured" means unknown rather than small. It also drops the value ' +
      'axis the house rules recommend, which is a stated departure, not an ' +
      'oversight.',
    discovery: discoveryVerdict(null),
    policyVersion: POLICY_VERSION,
    // Every entry names the INPUT it supports. A bare citation list under an
    // unmeasured board invites the reader to transfer the papers' evidence to
    // the ranking, which is the precise mistake the grade above forbids.
    sources: [
      'quality input — Novy-Marx (2013) gross profits-to-ASSETS. Hou, Xue & Zhang (2020) find the ASSETS denominator survives replication where book-equity does not; note the survivor they and the house review name is the CASH-BASED numerator, and this board ships the accrual version because gross_profit and total_assets are what the statement provider returns — a stated weakening, not a match',
      'momentum input — Jegadeesh & Titman (1993); Geczy & Samonov: 12-1, 212 years of US data, 40 countries',
      'quality input — Asness, Frazzini & Pedersen: QMJ positive in 23 of 24 countries',
      'method — Fisher, Shah & Titman (2016): integrated scoring beats two independently-formed sleeves',
    ],
  };
}

// ---------------------------------------------------------------------------
// Diagnostics for the paths that have nothing to serve
// ---------------------------------------------------------------------------

/**
 * The last run that happened, when none has earned publication.
 *
 * QS-1 POST-MORTEM, and it applies here unchanged. A partial run does not
 * promote `_latest`, so the board endpoint answered "the first scan has not
 * completed yet" on a night the scan HAD completed, on schedule, and had
 * recorded exactly why it produced nothing. The diagnosis sat in `warnings[]`
 * inside a document no surface read. Reporting "not yet" for a run that
 * failed with a stated reason is the difference between a bug found that
 * night and a bug found by someone checking a week later.
 *
 * Two extra reads, only on the path that has nothing to serve.
 */
async function lastAttempt() {
  const [recent] = await listSnapshots(BOARD, UNIVERSE, 1);
  if (!recent) return null;
  const doc = await getSnapshotById(BOARD, UNIVERSE, recent.snapshotId);
  if (!doc) return null;
  return {
    snapshotId: recent.snapshotId,
    generatedAt: doc.generatedAt,
    status: (doc as any).status ?? null,
    scored: (doc as any).scored ?? null,
    universeChecked: doc.universeChecked ?? null,
    // Carried on the failure path too: "0 scored" and "40 scored, all on the
    // ROE proxy" are different diagnoses of the same empty board.
    exactBasisCount: (doc as any).exactBasisCount ?? null,
    momentumStartYm: (doc as any).momentumStartYm ?? null,
    momentumEndYm: (doc as any).momentumEndYm ?? null,
    unscorableCounts: (doc as any).unscorableCounts ?? null,
    excludedCounts: (doc as any).excludedCounts ?? null,
    warnings: doc.warnings ?? [],
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const DISCLOSURE =
  'Compounders ranks quality first — gross profits over assets, whose ASSETS ' +
  'denominator survives replication and which leverage cannot flatter, though it ' +
  'is the accrual rather than the cash-based numerator the evidence actually ' +
  'names — and uses 12-1 momentum ' +
  'only to confirm, integrated into one score rather than two sleeves. It carries ' +
  'NO value axis: that is a deliberate departure from the house quality-value ' +
  'recommendation, and it is why a high-multiple franchise can rank here. The ' +
  'composite is a percentile within the checked universe, not a forecast of ' +
  'return. `exactBasisCount` is how many ranked names used the exact quality ' +
  'ratio rather than the ROE proxy, which a levered balance sheet can inflate. ' +
  'The papers cited in the banner measured those INPUTS; none of them measured ' +
  'this combination, and this combination has not been measured at all.';

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(Math.max(Number(qs.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const log = logger.child({ fn: 'compounders-board' });

  try {
    const snap = await latestSnapshot(BOARD, UNIVERSE);
    if (!snap) {
      const attempt = await lastAttempt();
      log.info('no_published_snapshot', {
        hadAttempt: Boolean(attempt),
        scored: attempt?.scored ?? null,
      });
      return json(200, {
        ok: true,
        universe: UNIVERSE,
        generatedAt: null,
        ageMs: null,
        stale: true,
        // Two genuinely different states, and conflating them is what hid the
        // QS-1 defect: nothing has ever run, versus something ran and was
        // refused publication.
        source: attempt ? 'snapshot-unpublished' : 'snapshot-missing',
        modelVersion: null,
        universeChecked: attempt?.universeChecked ?? null,
        universeSize: null,
        scored: attempt?.scored ?? null,
        excludedCounts: attempt?.excludedCounts ?? null,
        unscorableCounts: attempt?.unscorableCounts ?? null,
        exactBasisCount: attempt?.exactBasisCount ?? null,
        momentumStartYm: attempt?.momentumStartYm ?? null,
        momentumEndYm: attempt?.momentumEndYm ?? null,
        banner: buildEvidenceBanner(),
        lastAttempt: attempt,
        // Surfaced at the top level too, so a reader does not have to know the
        // difference between a published and an unpublished run to see why
        // the board is empty.
        warnings: attempt?.warnings ?? [],
        rows: [],
        note: attempt
          ? `A scan ran at ${attempt.generatedAt} and scored ${attempt.scored ?? 0} of ` +
            `${attempt.universeChecked ?? 0} names, so it was not published. ` +
            'The reasons are listed below.'
          : 'first Compounders scan has not completed yet',
        disclosure: DISCLOSURE,
      });
    }

    const fresh = isSnapshotFresh(snap);
    // The shared contract names the snapshot's ranked array `rows`, while the
    // store's own BoardSnapshot field is `results`. Reading either means a
    // naming difference between writer and store shows up as a lint-level
    // detail rather than as an empty board with a healthy-looking header.
    const stored = (snap as any).rows ?? snap.results;
    const rows = Array.isArray(stored) ? (stored as any[]).slice(0, limit) : [];
    log.info('served', { rows: rows.length, fresh });

    return json(200, {
      ok: true,
      universe: UNIVERSE,
      generatedAt: snap.generatedAt,
      ageMs: snapshotAgeMs(snap),
      stale: !fresh,
      // Stale still serves its rows. The alternative — blanking the board
      // because the scan missed a night — trades a dated ranking for no
      // ranking, and this signal turns over slowly enough that yesterday's is
      // very nearly today's.
      source: fresh ? 'snapshot' : 'snapshot-stale',
      modelVersion: snap.modelVersion,
      universeChecked: snap.universeChecked,
      universeSize: (snap as any).universeSize ?? null,
      scored: (snap as any).scored ?? null,
      excludedCounts: (snap as any).excludedCounts ?? null,
      unscorableCounts: (snap as any).unscorableCounts ?? null,
      // Sits next to `scored` on purpose: "38 of 40 exact" and "2 of 40 exact"
      // are the same board by every other number in this payload, and only
      // one of them is ranked on the quality definition that replicated.
      exactBasisCount: (snap as any).exactBasisCount ?? null,
      // PROVENANCE: the window this board was actually scored over.
      //
      // The worker has always written these into the snapshot and this
      // endpoint dropped them, which reproduces the exact blind spot that
      // started this board's existence: a user looked at Quiet Strength,
      // saw an unchanged ranking for days, and had no way to tell whether the
      // scan was dead or the input window was simply frozen. It was frozen.
      // A momentum leg formed on month-end closes does not move for a whole
      // calendar month either, so the board must say which month it is on.
      momentumStartYm: (snap as any).momentumStartYm ?? null,
      momentumEndYm: (snap as any).momentumEndYm ?? null,
      momentumSkippedYm: (snap as any).momentumSkippedYm ?? null,
      // Never null: the stored banner is preferred so the user sees the one
      // the rows were actually published under, but a snapshot written before
      // this field existed still gets the current policy's banner.
      banner: (snap as any).banner ?? buildEvidenceBanner(),
      warnings: snap.warnings ?? [],
      rows,
      disclosure: DISCLOSURE,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('compounders_board_failed', { err: msg });
    // The banner rides the 500 as well. Quiet-strength's catch returns a bare
    // error, which is survivable there because a failed read renders nothing;
    // here the requirement is unconditional, and a client that renders the
    // banner from whatever the endpoint last returned must not lose it on the
    // one response shape it is most likely to cache and re-render.
    return json(500, {
      ok: false,
      error: msg,
      universe: UNIVERSE,
      source: 'error',
      stale: true,
      banner: buildEvidenceBanner(),
      rows: [],
      warnings: [],
      disclosure: DISCLOSURE,
    });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // A 200 — including the empty snapshot-missing one — is cacheable for
      // two minutes like the other boards. A 500 is not: the CDN would pin a
      // transient Firestore failure in front of a board that is one retry
      // away from working.
      'Cache-Control': statusCode < 400 ? 'public, max-age=120' : 'no-store',
    },
    body: JSON.stringify(body),
  };
}
