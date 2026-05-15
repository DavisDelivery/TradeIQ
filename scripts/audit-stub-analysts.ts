#!/usr/bin/env node
// Phase 4f — Two-board stub-analyst audit CLI.
//
// Samples N days of snapshots for both boards × both universes (4
// quadrants total), classifies each analyst/layer as Live / Stub /
// Degraded per the brief's thresholds, and emits a Markdown report
// ready to drop into `reports/phase-4f/audit.md`.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="$(cat ~/sa.json)" \
//     npx tsx scripts/audit-stub-analysts.ts --days 90 \
//     > reports/phase-4f/audit.md
//
// Exits 2 if FIREBASE_SERVICE_ACCOUNT is unset. Exits 0 if the audit
// runs cleanly even when some quadrants have zero snapshots (e.g.
// russell2k coverage gaps).

import {
  listSnapshots,
  getSnapshotById,
  type BoardName,
  type UniverseKey,
} from '../netlify/functions/shared/snapshot-store';
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
} from '../netlify/functions/shared/stub-audit';

interface CliArgs {
  days: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { days: 90 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i + 1]) {
      out.days = Number(argv[i + 1]);
      i++;
    }
  }
  return out;
}

async function auditQuadrant(
  board: AuditBoard,
  universe: AuditUniverse,
  days: number,
): Promise<BoardQuadrantAudit> {
  const want = Math.min(days * 4, 1000);
  const list = await listSnapshots(board as BoardName, universe as UniverseKey, want);
  const stats: Record<string, PerAnalystStats> = {};
  let observationCount = 0;
  for (const item of list) {
    const snap = await getSnapshotById(
      board as BoardName,
      universe as UniverseKey,
      item.snapshotId,
    ).catch(() => null);
    if (!snap || !Array.isArray(snap.results)) continue;
    if (board === 'prophet') {
      observationCount += ingestProphetResults(snap.results as any, stats);
    } else {
      observationCount += ingestTargetResults(snap.results as any, stats);
    }
  }
  const rows = Object.keys(stats)
    .sort()
    .map((name) => statsToRow(name, stats[name]));
  return {
    board,
    universe,
    snapshotsScanned: list.length,
    observationCount,
    rows,
  };
}

async function main(): Promise<void> {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    process.stderr.write(
      'FIREBASE_SERVICE_ACCOUNT not set — cannot audit live Firestore.\n' +
        'Set the env var to your tradeiq-alpha SA JSON and re-run, OR hit\n' +
        '/api/audit-stub-analysts on the deployed site (no creds needed).\n',
    );
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  const quadrants: Array<{ board: AuditBoard; universe: AuditUniverse }> = [
    { board: 'target-board', universe: 'largecap' },
    { board: 'target-board', universe: 'russell2k' },
    { board: 'prophet', universe: 'largecap' },
    { board: 'prophet', universe: 'russell2k' },
  ];
  const results: BoardQuadrantAudit[] = [];
  for (const q of quadrants) {
    process.stderr.write(`auditing ${q.board} × ${q.universe}…\n`);
    results.push(await auditQuadrant(q.board, q.universe, args.days));
  }
  const summary = buildSummary(results);

  // Emit a Markdown audit doc to stdout.
  process.stdout.write(`# Phase 4f — Stub-Analyst Audit\n\n`);
  process.stdout.write(`**Generated:** ${new Date().toISOString()}\n`);
  process.stdout.write(`**Sample window:** last ${args.days} days\n\n`);
  process.stdout.write(
    `Total analysts/layers reviewed: ${summary.totalAnalysts} ` +
      `(across ${results.length} quadrants)\n`,
  );
  process.stdout.write(`Live: ${summary.totalLive}\n`);
  process.stdout.write(`Stub: ${summary.totalStub}\n`);
  process.stdout.write(`Degraded: ${summary.totalDegraded}\n\n`);
  if (summary.stubsByQuadrant.length > 0) {
    process.stdout.write(`**Stub list:**\n`);
    for (const s of summary.stubsByQuadrant) {
      process.stdout.write(`- ${s.board} × ${s.universe}: ${s.analyst}\n`);
    }
    process.stdout.write(`\n`);
  }
  process.stdout.write(`---\n\n`);
  for (const q of results) {
    process.stdout.write(buildQuadrantMarkdown(q));
    process.stdout.write(`\n\n`);
  }
}

// Suppress unused warning for emptyStats — it's exported by shared
// stub-audit and used implicitly by ingest helpers; this import
// keeps the dependency surface explicit at the CLI layer.
void emptyStats;

main().catch((err) => {
  process.stderr.write(`audit failed: ${String(err?.message ?? err)}\n`);
  process.exit(1);
});
