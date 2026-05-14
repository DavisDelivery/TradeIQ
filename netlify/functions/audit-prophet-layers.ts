// Phase 4e-1 follow-up — synchronous audit endpoint.
//
// Wraps the logic from scripts/audit-prophet-layers.ts as a Netlify
// function so Chad (or any operator) can populate the W0 layer audit
// without a local shell. Uses production env's `FIREBASE_SERVICE_ACCOUNT`
// automatically — no local creds needed.
//
//   GET /api/audit-prophet-layers?days=30&universe=largecap
//
// Response shape:
//   {
//     ok: true,
//     generatedAt, universe, daysSampled, snapshotsScanned, pickCount,
//     layers: [
//       { layer, count, mean, stdev, pctExactly50, pctNull, pctFailing, verdict },
//       ...
//     ],
//     stubLayers: string[],
//     markdown: string  // ready-to-paste § 0 of backtest-validation.md
//   }
//
// Also writes the result to Firestore at
// `prophetPortfolio/audits/{YYYY-MM-DD-HHmm}` for archive + future
// 4f W1 reference.

import type { Handler } from '@netlify/functions';
import {
  listSnapshots,
  getSnapshotById,
  type UniverseKey,
} from './shared/snapshot-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const LAYERS = [
  'structure',
  'momentum',
  'volume',
  'volatility',
  'relativeStrength',
  'fundamental',
  'catalyst',
] as const;

interface PerLayerStats {
  count: number;
  sum: number;
  sumSq: number;
  exactly50: number;
  nullCount: number;
  failCount: number;
}

function emptyStats(): PerLayerStats {
  return { count: 0, sum: 0, sumSq: 0, exactly50: 0, nullCount: 0, failCount: 0 };
}

function mean(s: PerLayerStats): number {
  return s.count > 0 ? s.sum / s.count : 0;
}

function stdev(s: PerLayerStats): number {
  if (s.count < 2) return 0;
  const m = mean(s);
  const v = s.sumSq / s.count - m * m;
  return v > 0 ? Math.sqrt(v) : 0;
}

function pct(n: number, d: number): number {
  return d > 0 ? +((n / d) * 100).toFixed(2) : 0;
}

function isLive(s: PerLayerStats): 'live' | 'stub' {
  return stdev(s) > 5 && pct(s.exactly50, s.count) <= 25 ? 'live' : 'stub';
}

interface LayerRow {
  layer: string;
  count: number;
  mean: number;
  stdev: number;
  pctExactly50: number;
  pctNull: number;
  pctFailing: number;
  verdict: 'live' | 'stub';
}

const headers = { 'Content-Type': 'application/json; charset=utf-8' };

function buildMarkdown(
  universe: string,
  rows: LayerRow[],
  snapshotsScanned: number,
  pickCount: number,
  stubs: string[],
): string {
  const lines: string[] = [];
  lines.push(`## 0. Layer activity audit — universe=${universe}`);
  lines.push('');
  lines.push(`Snapshots scanned: ${snapshotsScanned}`);
  lines.push(`Total (asOfDate, ticker) rows: ${pickCount}`);
  lines.push('');
  lines.push(`| Layer            |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Verdict |`);
  lines.push(`|------------------|---------:|---------:|-------------:|--------:|-------------:|---------|`);
  for (const r of rows) {
    lines.push(
      `| ${r.layer.padEnd(16)} | ${r.mean.toFixed(2).padStart(8)} | ${r.stdev.toFixed(2).padStart(8)} | ${r.pctExactly50.toFixed(2).padStart(12)} | ${r.pctNull.toFixed(2).padStart(7)} | ${r.pctFailing.toFixed(2).padStart(12)} | ${r.verdict} |`,
    );
  }
  lines.push('');
  if (stubs.length === 0) {
    lines.push(`**All 7 layers active.** Backtest can run Scenario A only — Scenario B not required.`);
  } else {
    lines.push(`**Stub-returning layers (${stubs.length}/7): ${stubs.join(', ')}.** Backtest must run BOTH Scenario A (as-is) AND Scenario B (active-only with stub weights redistributed proportionally) per brief § W0 step 7.`);
  }
  return lines.join('\n');
}

export const handler: Handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method not allowed' }) };
  }
  const qs = event.queryStringParameters ?? {};
  const days = Math.min(Math.max(Number(qs.days ?? 30), 1), 90);
  const universe = (qs.universe as UniverseKey) ?? 'largecap';
  const log = logger.child({ fn: 'audit-prophet-layers', universe, days });

  try {
    // 4 snapshots/day cadence; cap reads for the 26s budget.
    const want = Math.min(days * 4, 200);
    const list = await listSnapshots('prophet', universe, want);
    if (list.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          ok: false,
          error: `no Prophet snapshots found for universe=${universe}`,
        }),
      };
    }

    const stats: Record<string, PerLayerStats> = Object.fromEntries(
      LAYERS.map((l) => [l, emptyStats()]),
    );
    let pickCount = 0;

    // Concurrent reads to fit the 26s budget — snapshots are independent.
    const BATCH = 8;
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      const snaps = await Promise.all(
        batch.map((item) =>
          getSnapshotById('prophet', universe, item.snapshotId).catch(() => null),
        ),
      );
      for (const snap of snaps) {
        if (!snap || !Array.isArray(snap.results)) continue;
        for (const p of snap.results as Array<{ layers?: Record<string, { score?: number | null; pass?: boolean }> }>) {
          if (!p?.layers) continue;
          pickCount++;
          for (const ln of LAYERS) {
            const layer = p.layers[ln];
            if (!layer) continue;
            const s = stats[ln];
            const score = typeof layer.score === 'number' ? layer.score : null;
            if (score == null) {
              s.nullCount++;
              continue;
            }
            s.count++;
            s.sum += score;
            s.sumSq += score * score;
            if (score === 50) s.exactly50++;
            if (layer.pass !== true) s.failCount++;
          }
        }
      }
    }

    const rows: LayerRow[] = LAYERS.map((ln) => {
      const s = stats[ln];
      const denom = s.count + s.nullCount;
      return {
        layer: ln,
        count: s.count,
        mean: +mean(s).toFixed(2),
        stdev: +stdev(s).toFixed(2),
        pctExactly50: pct(s.exactly50, s.count),
        pctNull: pct(s.nullCount, Math.max(1, denom)),
        pctFailing: pct(s.failCount, s.count),
        verdict: isLive(s),
      };
    });
    const stubs = rows.filter((r) => r.verdict === 'stub').map((r) => r.layer);
    const markdown = buildMarkdown(universe, rows, list.length, pickCount, stubs);
    const generatedAt = new Date().toISOString();

    // Archive for future reference (e.g., 4f W1 reads this).
    try {
      const auditId = generatedAt.slice(0, 16).replace(/[-:T]/g, '').replace(/\..*$/, '');
      await getAdminDb()
        .collection('prophetPortfolio')
        .doc('audits')
        .collection('runs')
        .doc(auditId)
        .set({
          generatedAt,
          universe,
          daysSampled: days,
          snapshotsScanned: list.length,
          pickCount,
          layers: rows,
          stubLayers: stubs,
          markdown,
        });
    } catch (e: any) {
      log.warn('audit_archive_failed', { err: String(e?.message ?? e) });
    }

    log.info('audit_complete', {
      universe,
      snapshotsScanned: list.length,
      pickCount,
      stubs: stubs.length,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        generatedAt,
        universe,
        daysSampled: days,
        snapshotsScanned: list.length,
        pickCount,
        layers: rows,
        stubLayers: stubs,
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
