#!/usr/bin/env node
// Phase 4e-1 — W0 layer-activity audit.
//
// Sample N days of Prophet largecap snapshots, then for each of the 7
// layers (structure, momentum, volume, volatility, relativeStrength,
// fundamental, catalyst) compute:
//   - mean(score), stdev(score)
//   - % of (asOfDate, ticker) rows where score === 50 exactly
//   - % where pass === false
//
// A layer is "live" if stdev > 5 AND ≤25% of rows are exactly 50; else
// "stub-returning."
//
// Output goes to stdout as a Markdown table that drops directly into
// reports/phase-4e-1/backtest-validation.md § 0.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="$(cat ~/sa.json)" \
//     npx tsx scripts/audit-prophet-layers.ts --days 90
//
// Exits with code 2 if FIREBASE_SERVICE_ACCOUNT is unset.

import { listSnapshots, getSnapshotById } from '../netlify/functions/shared/snapshot-store';

const LAYERS = [
  'structure',
  'momentum',
  'volume',
  'volatility',
  'relativeStrength',
  'fundamental',
  'catalyst',
] as const;

type LayerName = typeof LAYERS[number];

interface PerLayerStats {
  count: number;
  sum: number;
  sumSq: number;
  exactly50: number;
  failCount: number;
}

function emptyStats(): PerLayerStats {
  return { count: 0, sum: 0, sumSq: 0, exactly50: 0, failCount: 0 };
}

function mean(s: PerLayerStats): number {
  return s.count > 0 ? s.sum / s.count : 0;
}

function stdev(s: PerLayerStats): number {
  if (s.count < 2) return 0;
  const m = mean(s);
  const variance = s.sumSq / s.count - m * m;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

function pct(n: number, d: number): number {
  return d > 0 ? +((n / d) * 100).toFixed(2) : 0;
}

function isLive(s: PerLayerStats): 'live' | 'stub' {
  const std = stdev(s);
  const exactlyPct = pct(s.exactly50, s.count);
  return std > 5 && exactlyPct <= 25 ? 'live' : 'stub';
}

interface CliArgs {
  days: number;
  universe: 'largecap' | 'russell2k';
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { days: 90, universe: 'largecap' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--days' && next) {
      out.days = Number(next);
      i++;
    } else if (arg === '--universe' && next) {
      out.universe = next as CliArgs['universe'];
      i++;
    }
  }
  return out;
}

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error('FIREBASE_SERVICE_ACCOUNT not set — cannot audit live Firestore.');
    console.error('Set the env var to your tradeiq-alpha SA JSON and re-run.');
    process.exit(2);
  }

  const args = parseArgs(process.argv.slice(2));
  // List snapshots — listSnapshots paginates by recency. Days is roughly
  // four-snapshots-per-day; we cap at 1000 to keep memory bounded.
  const want = Math.min(args.days * 4, 1000);
  const list = await listSnapshots('prophet', args.universe, want);
  if (list.length === 0) {
    console.error(`No Prophet snapshots found for universe=${args.universe}`);
    process.exit(2);
  }

  const stats: Record<LayerName, PerLayerStats> = Object.fromEntries(
    LAYERS.map((l) => [l, emptyStats()]),
  ) as any;

  let snapshotsScanned = 0;
  let pickCount = 0;
  for (const item of list) {
    const snap = await getSnapshotById('prophet', args.universe, item.snapshotId);
    if (!snap || !Array.isArray(snap.results)) continue;
    snapshotsScanned++;
    for (const p of snap.results as any[]) {
      if (!p?.layers) continue;
      pickCount++;
      for (const ln of LAYERS) {
        const layer = p.layers[ln];
        if (!layer) continue;
        const score = typeof layer.score === 'number' ? layer.score : null;
        const pass = layer.pass === true;
        if (score == null) continue;
        const s = stats[ln];
        s.count++;
        s.sum += score;
        s.sumSq += score * score;
        if (score === 50) s.exactly50++;
        if (!pass) s.failCount++;
      }
    }
  }

  // Markdown output.
  console.log(`# Prophet layer-activity audit — universe=${args.universe}`);
  console.log(``);
  console.log(`Snapshots scanned: ${snapshotsScanned}`);
  console.log(`Total (asOfDate, ticker) rows: ${pickCount}`);
  console.log(``);
  console.log(`| Layer            |     Mean |    StDev | % exactly 50 | % pass=false | Verdict |`);
  console.log(`|------------------|---------:|---------:|-------------:|-------------:|---------|`);
  for (const ln of LAYERS) {
    const s = stats[ln];
    const verdict = isLive(s);
    const m = mean(s).toFixed(2).padStart(8);
    const sd = stdev(s).toFixed(2).padStart(8);
    const ex = pct(s.exactly50, s.count).toFixed(2).padStart(12);
    const fa = pct(s.failCount, s.count).toFixed(2).padStart(12);
    console.log(`| ${ln.padEnd(16)} | ${m} | ${sd} | ${ex} | ${fa} | ${verdict} |`);
  }

  const stubs = LAYERS.filter((l) => isLive(stats[l]) === 'stub');
  console.log(``);
  if (stubs.length === 0) {
    console.log(`**All 7 layers active.** Backtest can run Scenario A only — Scenario B not required.`);
  } else {
    console.log(`**Stub-returning layers (${stubs.length}/7): ${stubs.join(', ')}.** Backtest must run BOTH Scenario A (as-is) AND Scenario B (active-only with stub weights redistributed proportionally) per brief § W0 step 7.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
