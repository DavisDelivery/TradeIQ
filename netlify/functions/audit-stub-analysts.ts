// Phase 4f — Stub-analyst audit endpoint (HTTP).
//
//   GET /api/audit-stub-analysts?days=30&board=both&universe=both
//
// Walks recent snapshots for the requested board × universe quadrant(s)
// and emits a per-analyst stats table per the brief's spec. Default
// covers ALL FOUR quadrants:
//   - Target Board × largecap
//   - Target Board × russell2k
//   - Prophet × largecap
//   - Prophet × russell2k
//
// Each quadrant is read concurrently. Per-quadrant snapshot reads are
// also concurrent (batches of 8) to fit the 26s function budget.
//
// Response shape:
//   {
//     ok: true,
//     generatedAt, daysSampled,
//     summary: { totalAnalysts, totalLive, totalStub, totalDegraded, stubsByQuadrant },
//     quadrants: [
//       { board, universe, snapshotsScanned, observationCount, rows: [...] },
//       ...
//     ],
//     markdown: "...full §1 quadrant tables..."
//   }
//
// Also archives the full result to
// `stubAudits/runs/{stamp}` for cron-driven historical record. The
// `?fmt=md` query returns text/markdown directly (useful for the
// follow-up "freeze into audit.md" command).

import type { Handler } from '@netlify/functions';
import {
  listSnapshots,
  getSnapshotById,
  type BoardName,
  type UniverseKey,
} from './shared/snapshot-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';
import {
  buildQuadrantMarkdown,
  buildSummary,
  emptyStats,
  ingestProphetResults,
  ingestTargetResults,
  statsToRow,
  type AuditBoard,
  type AuditUniverse,
  type BoardQuadrantAudit,
  type PerAnalystStats,
} from './shared/stub-audit';

const headers = { 'Content-Type': 'application/json; charset=utf-8' };

interface QuadrantSpec {
  board: AuditBoard;
  universe: AuditUniverse;
}

function quadrantsFor(boardSel: string, universeSel: string): QuadrantSpec[] {
  const boards: AuditBoard[] =
    boardSel === 'target' || boardSel === 'target-board'
      ? ['target-board']
      : boardSel === 'prophet'
        ? ['prophet']
        : ['target-board', 'prophet'];
  const universes: AuditUniverse[] =
    universeSel === 'largecap'
      ? ['largecap']
      : universeSel === 'russell2k'
        ? ['russell2k']
        : ['largecap', 'russell2k'];
  const out: QuadrantSpec[] = [];
  for (const b of boards) for (const u of universes) out.push({ board: b, universe: u });
  return out;
}

async function auditOneQuadrant(
  q: QuadrantSpec,
  days: number,
): Promise<BoardQuadrantAudit> {
  const want = Math.min(days * 4, 200);
  const list = await listSnapshots(
    q.board as BoardName,
    q.universe as UniverseKey,
    want,
  );
  const stats: Record<string, PerAnalystStats> = {};
  let observationCount = 0;

  // Read snapshots in batches of 8 for concurrency.
  const BATCH = 8;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const snaps = await Promise.all(
      batch.map((item) =>
        getSnapshotById(q.board as BoardName, q.universe as UniverseKey, item.snapshotId).catch(
          () => null,
        ),
      ),
    );
    for (const snap of snaps) {
      if (!snap || !Array.isArray(snap.results)) continue;
      if (q.board === 'prophet') {
        observationCount += ingestProphetResults(snap.results as any, stats);
      } else {
        observationCount += ingestTargetResults(snap.results as any, stats);
      }
    }
  }

  const rows = Object.keys(stats)
    .sort()
    .map((name) => statsToRow(name, stats[name]));
  return {
    board: q.board,
    universe: q.universe,
    snapshotsScanned: list.length,
    observationCount,
    rows,
  };
}

function buildFullMarkdown(
  quadrants: BoardQuadrantAudit[],
  daysSampled: number,
): string {
  const lines: string[] = [];
  const summary = buildSummary(quadrants);
  lines.push(`# Phase 4f — Stub-Analyst Audit`);
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Sample window:** last ${daysSampled} days`);
  lines.push('');
  lines.push(
    `Total analysts/layers reviewed: ${summary.totalAnalysts} ` +
      `(across ${quadrants.length} quadrants)`,
  );
  lines.push(`Live: ${summary.totalLive}`);
  lines.push(`Stub: ${summary.totalStub}`);
  lines.push(`Degraded: ${summary.totalDegraded}`);
  lines.push('');
  if (summary.stubsByQuadrant.length > 0) {
    lines.push(`**Stub list:**`);
    for (const s of summary.stubsByQuadrant) {
      lines.push(`- ${s.board} × ${s.universe}: ${s.analyst}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  for (const q of quadrants) {
    lines.push(buildQuadrantMarkdown(q));
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push(`## Next step — root-cause classification (W2)`);
  lines.push('');
  lines.push(
    `For each stub above, follow the taxonomy in ` +
      `\`kickoffs/phase-4f-executor.md\` § 4.2 and write a per-stub ` +
      `diagnosis section into \`reports/phase-4f/audit.md\` § 2 ` +
      `(template at kickoff § 4.3). Then act on each in W3 (repair) ` +
      `or W5 (remove + reweight).`,
  );
  return lines.join('\n');
}

export const handler: Handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'method not allowed' }),
    };
  }
  const qs = event.queryStringParameters ?? {};
  const days = Math.min(Math.max(Number(qs.days ?? 30), 1), 90);
  const board = (qs.board ?? 'both').toString();
  const universe = (qs.universe ?? 'both').toString();
  const fmt = (qs.fmt ?? 'json').toString();
  const log = logger.child({ fn: 'audit-stub-analysts', board, universe, days });

  try {
    const quadrants = quadrantsFor(board, universe);
    if (quadrants.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'no quadrants selected' }),
      };
    }
    const results = await Promise.all(quadrants.map((q) => auditOneQuadrant(q, days)));
    const summary = buildSummary(results);
    const markdown = buildFullMarkdown(results, days);
    const generatedAt = new Date().toISOString();

    // Archive for future reference. Bounded to summary + per-quadrant
    // row tables; uniqueValues sets aren't serializable so we strip them.
    try {
      const auditId = generatedAt.slice(0, 16).replace(/[-:T]/g, '').replace(/\..*$/, '');
      await getAdminDb()
        .collection('stubAudits')
        .doc('runs')
        .collection('runs')
        .doc(auditId)
        .set({
          generatedAt,
          daysSampled: days,
          summary: {
            totalAnalysts: summary.totalAnalysts,
            totalLive: summary.totalLive,
            totalStub: summary.totalStub,
            totalDegraded: summary.totalDegraded,
            stubsByQuadrant: summary.stubsByQuadrant,
          },
          quadrants: results.map((q) => ({
            board: q.board,
            universe: q.universe,
            snapshotsScanned: q.snapshotsScanned,
            observationCount: q.observationCount,
            rows: q.rows,
          })),
          markdown,
        });
    } catch (e: any) {
      log.warn('audit_archive_failed', { err: String(e?.message ?? e) });
    }

    log.info('audit_complete', {
      quadrants: quadrants.length,
      totalAnalysts: summary.totalAnalysts,
      stubs: summary.totalStub,
    });

    if (fmt === 'md') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        body: markdown,
      };
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        generatedAt,
        daysSampled: days,
        summary,
        quadrants: results,
        markdown,
      }),
    };
  } catch (err: any) {
    log.error('audit_failed', { err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
    };
  }
};
