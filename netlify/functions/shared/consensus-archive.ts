// QS-2 / P1-S3 (2026-08-09) — the consensus archive.
//
// This module ships NO SCREEN. It exists to start a clock.
//
// Hou/Xue/Zhang's replication found analyst estimate revisions (RE) among the
// few anomalies that survive with t = 3.18 at a 1-month horizon. We cannot
// test that here, because testing it needs a POINT-IN-TIME record of what
// consensus said on each past day, and vendors serve today's consensus with
// today's revisions already folded in. Backfilling from a vendor would
// produce a series that quietly knows the future.
//
// So the only way to get there is to start recording now and wait. Roughly
// 12 months of daily cross-sections makes a revision screen testable. Every
// day this is not running is a day added to that wait, which is why it ships
// ahead of the board it will eventually support.
//
// TWO RULES THAT MAKE THE RECORD WORTH HAVING:
//
//   1. WRITE ONCE. The first write for a date is permanent — `create()`, not
//      `set()`. A record that can be rewritten after returns are known is
//      not evidence, and there is no way to prove afterwards that it wasn't.
//
//   2. RECORD THE OBSERVATION DATE, NOT THE VENDOR'S. We stamp the date WE
//      saw the value. A vendor "as of" field is the vendor's claim about
//      when consensus changed, and it is exactly the field that gets revised.

import type { FinvizRow } from './finviz';

export const CONSENSUS_COLLECTION = 'consensusArchive';
export const ARCHIVE_SCHEMA_VERSION = 1;

/** One ticker's consensus observation. Deliberately narrow. */
export interface ConsensusPoint {
  ticker: string;
  /** Consensus price target. */
  tp: number | null;
  /** Analyst recommendation, 1.0 strong buy … 5.0 strong sell. */
  rec: number | null;
  /** Consensus EPS growth, this fiscal year, percent. */
  egY: number | null;
  /** Consensus EPS growth, next fiscal year, percent. */
  egN: number | null;
  /** Consensus EPS growth, next 5 years, percent. */
  eg5: number | null;
  /** Close on the observation date — needed to turn a TP into an implied return. */
  px: number | null;
}

export interface ConsensusSnapshot {
  /** YYYY-MM-DD, the date WE observed. */
  date: string;
  schemaVersion: number;
  observedAt: string;
  count: number;
  points: ConsensusPoint[];
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Project a Finviz universe export down to the consensus fields.
 *
 * A row with NOTHING to say about consensus is dropped rather than stored as
 * five nulls. The archive's job is to make "consensus moved" measurable, and
 * a row of nulls is indistinguishable from a row that was never covered —
 * storing it would inflate the denominator of any future coverage statistic
 * with names no analyst ever followed.
 */
export function buildConsensusSnapshot(
  rows: FinvizRow[],
  date: string,
  observedAt: string,
): ConsensusSnapshot {
  const seen = new Set<string>();
  const points: ConsensusPoint[] = [];

  for (const r of rows) {
    const ticker = r?.ticker?.toUpperCase();
    if (!ticker || seen.has(ticker)) continue;

    const p: ConsensusPoint = {
      ticker,
      tp: num(r.targetPrice),
      rec: num(r.analystRecom),
      egY: num(r.epsGrowthThisYearPct),
      egN: num(r.epsGrowthNextYearPct),
      eg5: num(r.epsGrowthNext5YPct),
      px: num(r.price),
    };
    if (p.tp === null && p.rec === null && p.egY === null && p.egN === null && p.eg5 === null) {
      continue;
    }
    seen.add(ticker);
    points.push(p);
  }

  points.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { date, schemaVersion: ARCHIVE_SCHEMA_VERSION, observedAt, count: points.length, points };
}

// ---------------------------------------------------------------------------
// Revision math
// ---------------------------------------------------------------------------

export interface ConsensusRevision {
  ticker: string;
  /** Change in consensus EPS growth for the next fiscal year, pp. */
  dEgN: number | null;
  /** Change in the recommendation. NEGATIVE is an UPGRADE (1 = strong buy). */
  dRec: number | null;
  /** Change in price target, percent of the earlier target. */
  dTpPct: number | null;
  /** Implied upside on the LATER date: (tp − px) / px, percent. */
  impliedUpsidePct: number | null;
}

/**
 * Diff two archived cross-sections.
 *
 * SIGN CONVENTION IS A TRAP AND IS THEREFORE EXPLICIT. Finviz's recommendation
 * runs 1 = strong buy … 5 = strong sell, so an UPGRADE makes the number go
 * DOWN and `dRec` is NEGATIVE for good news. Every other field here is
 * positive-is-good. Anything ranking on `dRec` must flip it, and the tests
 * pin the direction so a future reader cannot get this wrong silently.
 */
export function revisionsBetween(
  earlier: ConsensusSnapshot,
  later: ConsensusSnapshot,
): ConsensusRevision[] {
  const prev = new Map(earlier.points.map((p) => [p.ticker, p]));
  const out: ConsensusRevision[] = [];

  for (const now of later.points) {
    const was = prev.get(now.ticker);
    if (!was) continue; // no prior observation is not a revision of zero

    const dTpPct =
      was.tp !== null && now.tp !== null && was.tp > 0
        ? ((now.tp - was.tp) / was.tp) * 100
        : null;

    out.push({
      ticker: now.ticker,
      dEgN: was.egN !== null && now.egN !== null ? now.egN - was.egN : null,
      dRec: was.rec !== null && now.rec !== null ? now.rec - was.rec : null,
      dTpPct,
      impliedUpsidePct:
        now.tp !== null && now.px !== null && now.px > 0
          ? ((now.tp - now.px) / now.px) * 100
          : null,
    });
  }
  return out;
}

/** True when the archive has enough span for a 1-month revision study. */
export function archiveReadiness(
  dates: string[],
  requiredDays = 365,
): { first: string | null; last: string | null; spanDays: number; ready: boolean } {
  if (!dates.length) return { first: null, last: null, spanDays: 0, ready: false };
  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const spanDays = Math.round(
    (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000,
  );
  return { first, last, spanDays, ready: spanDays >= requiredDays };
}
