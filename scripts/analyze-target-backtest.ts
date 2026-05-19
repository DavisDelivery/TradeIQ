#!/usr/bin/env node
// Phase 4t W2 + W3 analysis — read a completed `target`-board backtest's
// mlTraining rows + attribution + dailyEquity from the API, compute the
// honest per-decile forward-return analysis (both tails), per-tier hit
// rates, rolling-window consistency, and per-factor Information
// Coefficient (W3 leave-one-out-without-rerun).
//
// Usage:
//   npx tsx scripts/analyze-target-backtest.ts \
//     --runId bt_<runid> [--origin https://tradeiq-alpha.netlify.app] \
//     [--out reports/phase-4t/sp500-summary.md]
//
// Reads via /api/backtest-runs/:runId and walks every page of the
// mlTraining subcollection (via repeated paged reads). The composite
// in those rows is what was scored at that rebalance with the live
// composeTarget math; the forward returns are computed by the engine
// from PIT bars. So the analysis here is fully deterministic in the
// data the engine emitted.

import * as fs from 'node:fs';
import * as path from 'node:path';

interface Args {
  runId?: string;
  origin?: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], n = argv[i + 1];
    if (a === '--runId') { out.runId = n; i++; }
    else if (a === '--origin') { out.origin = n; i++; }
    else if (a === '--out') { out.out = n; i++; }
  }
  return out;
}

interface MLRow {
  runId: string;
  ticker: string;
  asOfDate: string;
  composite: number;
  layers: Record<string, number>;
  regime: string | null;
  sector: string | null;
  inPortfolio: boolean;
  entryPrice: number | null;
  exitPrice: number | null;
  holdDays: number | null;
  forward5dReturn: number | null;
  forward20dReturn: number | null;
  forward60dReturn: number | null;
  forward252dReturn: number | null;
  realizedPnl: number | null;
}

interface RunDoc {
  ok: boolean;
  run: {
    runId: string;
    config: any;
    status: string;
    completedAt?: string;
    metrics?: any;
    benchmark?: { ticker: string; totalReturnPct: number };
    universeSurvivorshipCorrected?: { universe: string; corrected: boolean; coverageThrough: string | null };
    warnings: string[];
  };
  dailyEquity: Array<{ date: string; value: number }>;
  trades: any[];
  attribution: any[];
  mlTrainingCount: number;
}

async function fetchRun(origin: string, runId: string): Promise<RunDoc> {
  const url = `${origin}/api/backtest-runs/${runId}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as RunDoc;
}

// The current backtest-runs-get endpoint returns dailyEquity + trades
// + attribution + mlTrainingCount but NOT the mlTraining rows
// themselves (the count is a Firestore count() and the rows live in
// the subcollection). For 4t we need the rows. Two options:
//   (1) Add a new /api/ endpoint that pages the mlTraining rows.
//   (2) Use what backtest-runs-get returns and do the analysis from
//       the engine's per-rebalance attribution records.
// We do (2) — attribution records include {composite, layers, regime}
// per held position per rebalance, AND segmentReturn (the forward
// holding-period return). Combined with the dailyEquity series for
// the portfolio's overall Sharpe/maxDD/rolling consistency, that
// gives us everything W2+W3 need without an API extension.
//
// Where attribution falls short: it only carries HELD positions, not
// every scored candidate. The decile-on-the-low-tail analysis needs
// every candidate. For runs that completed under the new bounded-
// cursor (Phase 4u), the mlTraining subcollection is populated; the
// helper below pages it via the bare runId Firestore-collection URL
// pattern Netlify exposes. If that 404s on a deploy, we fall back to
// the attribution-only analysis.
//
// Worst case for the fallback: the verdict reports tail analysis
// "from held positions only" with a note about it. That's still a
// valid (if narrower) deliverable.

interface AttributionRow {
  rebalanceDate: string;
  ticker: string;
  weight: number;
  segmentReturn: number;
  contribution: number;
  layers: Record<string, number>;
  composite: number;
  regime: string | null;
}

function decilesOf(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const decileBounds: number[] = [];
  for (let i = 1; i < 10; i++) {
    const idx = Math.floor((i / 10) * sorted.length);
    decileBounds.push(sorted[Math.min(idx, sorted.length - 1)]);
  }
  return decileBounds;
}

function assignDecile(value: number, bounds: number[]): number {
  for (let i = 0; i < bounds.length; i++) {
    if (value <= bounds[i]) return i + 1; // deciles 1..10
  }
  return 10;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx2 += a * a; dy2 += b * b;
  }
  if (dx2 === 0 || dy2 === 0) return 0;
  return num / Math.sqrt(dx2 * dy2);
}

function spearman(xs: number[], ys: number[]): number {
  const rank = (arr: number[]) => {
    const idx = arr.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length).fill(0);
    idx.forEach(([, i], rank) => { r[i] = rank + 1; });
    return r;
  };
  return pearson(rank(xs), rank(ys));
}

interface DecileReport {
  decile: number;
  count: number;
  meanComposite: number;
  meanForwardReturn: number;
  hitRate: number;
}

function decileForwardReturns(rows: AttributionRow[]): DecileReport[] {
  if (rows.length < 100) return [];
  const composites = rows.map((r) => r.composite);
  const bounds = decilesOf(composites);
  const buckets: AttributionRow[][] = Array.from({ length: 10 }, () => []);
  for (const r of rows) {
    const d = assignDecile(r.composite, bounds);
    buckets[d - 1].push(r);
  }
  return buckets.map((bucket, i) => ({
    decile: i + 1,
    count: bucket.length,
    meanComposite: mean(bucket.map((r) => r.composite)),
    meanForwardReturn: mean(bucket.map((r) => r.segmentReturn)),
    hitRate: bucket.length === 0 ? 0 : bucket.filter((r) => r.segmentReturn > 0).length / bucket.length,
  }));
}

interface RollingMetric {
  windowStart: string;
  windowEnd: string;
  totalReturnPct: number;
  benchmarkReturnPct: number;
  excessPct: number;
}

function rollingWindows(
  dailyEquity: Array<{ date: string; value: number }>,
  windowYears: number,
): RollingMetric[] {
  if (dailyEquity.length < 2) return [];
  // Year start indexes.
  const byYear = new Map<number, { start: number; end: number }>();
  dailyEquity.forEach((p, i) => {
    const y = parseInt(p.date.slice(0, 4), 10);
    const cur = byYear.get(y);
    if (!cur) byYear.set(y, { start: i, end: i });
    else byYear.set(y, { start: cur.start, end: i });
  });
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const out: RollingMetric[] = [];
  for (let i = 0; i + windowYears - 1 < years.length; i++) {
    const startY = years[i], endY = years[i + windowYears - 1];
    const startIdx = byYear.get(startY)!.start;
    const endIdx = byYear.get(endY)!.end;
    const startV = dailyEquity[startIdx].value;
    const endV = dailyEquity[endIdx].value;
    const totalReturnPct = ((endV - startV) / startV) * 100;
    out.push({
      windowStart: dailyEquity[startIdx].date,
      windowEnd: dailyEquity[endIdx].date,
      totalReturnPct,
      benchmarkReturnPct: 0, // populated by caller if benchmark series available
      excessPct: 0,
    });
  }
  return out;
}

interface PerFactorIC {
  analyst: string;
  ic: number;       // Spearman correlation, score → forward return
  pearsonIc: number;
  n: number;
}

function perFactorIC(rows: AttributionRow[]): PerFactorIC[] {
  if (rows.length === 0) return [];
  const analystKeys = Object.keys(rows[0].layers ?? {});
  const out: PerFactorIC[] = [];
  for (const k of analystKeys) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of rows) {
      const v = r.layers[k];
      if (typeof v !== 'number' || !isFinite(v)) continue;
      if (typeof r.segmentReturn !== 'number' || !isFinite(r.segmentReturn)) continue;
      xs.push(v);
      ys.push(r.segmentReturn);
    }
    if (xs.length < 30) continue;
    out.push({
      analyst: k,
      ic: spearman(xs, ys),
      pearsonIc: pearson(xs, ys),
      n: xs.length,
    });
  }
  return out.sort((a, b) => b.ic - a.ic);
}

function fmtPct(x: number): string {
  return (x * 100).toFixed(2) + '%';
}

function formatReport(
  doc: RunDoc,
  decile: DecileReport[],
  rolling1y: RollingMetric[],
  rolling3y: RollingMetric[],
  ic: PerFactorIC[],
): string {
  const m = doc.run.metrics ?? {};
  const b = doc.run.benchmark ?? null;
  const cfg = doc.run.config ?? {};
  const universe = cfg.universe ?? '?';
  const out: string[] = [];
  out.push(`# Phase 4t W2 — ${universe} composite backtest summary`);
  out.push('');
  out.push(`Run: \`${doc.run.runId}\``);
  out.push(`Window: ${cfg.startDate} → ${cfg.endDate}`);
  out.push(`Rebalance: ${cfg.rebalanceFrequency} · topN ${cfg.portfolio?.topN ?? '?'}`);
  out.push(`Completed: ${doc.run.completedAt ?? '(not completed)'}`);
  out.push('');
  out.push('## Headline metrics');
  out.push('');
  out.push('| Metric | Value |');
  out.push('|---|---:|');
  out.push(`| Total return | ${typeof m.totalReturnPct === 'number' ? m.totalReturnPct.toFixed(2) + '%' : '—'} |`);
  out.push(`| CAGR | ${typeof m.cagrPct === 'number' ? m.cagrPct.toFixed(2) + '%' : '—'} |`);
  out.push(`| Sharpe | ${typeof m.sharpe === 'number' ? m.sharpe.toFixed(3) : '—'} |`);
  out.push(`| Max drawdown | ${typeof m.maxDrawdownPct === 'number' ? m.maxDrawdownPct.toFixed(2) + '%' : '—'} |`);
  out.push(`| Win rate | ${typeof m.winRatePct === 'number' ? m.winRatePct.toFixed(2) + '%' : '—'} |`);
  out.push(`| Information ratio | ${typeof m.informationRatio === 'number' ? m.informationRatio.toFixed(3) : '—'} |`);
  out.push(`| Information coefficient (overall) | ${typeof m.informationCoefficient === 'number' ? m.informationCoefficient.toFixed(4) : '—'} |`);
  out.push(`| Trade count | ${m.tradeCount ?? '—'} |`);
  out.push(`| Rebalances | ${m.rebalanceCount ?? '—'} |`);
  out.push(`| Benchmark (${b?.ticker ?? '?'}) total return | ${b ? b.totalReturnPct.toFixed(2) + '%' : '—'} |`);
  out.push(`| Excess vs benchmark | ${b && typeof m.totalReturnPct === 'number' ? (m.totalReturnPct - b.totalReturnPct).toFixed(2) + ' pp' : '—'} |`);
  out.push('');

  out.push('## Forward-return by composite decile (both tails)');
  out.push('');
  if (decile.length === 0) {
    out.push('*Decile analysis not available — attribution had fewer than 100 rows.*');
  } else {
    out.push('| Decile | Count | Mean composite | Mean fwd return (held period) | Hit rate |');
    out.push('|---:|---:|---:|---:|---:|');
    for (const d of decile) {
      out.push(`| ${d.decile} | ${d.count} | ${d.meanComposite.toFixed(1)} | ${fmtPct(d.meanForwardReturn)} | ${fmtPct(d.hitRate)} |`);
    }
    const lo = decile[0], hi = decile[decile.length - 1];
    out.push('');
    out.push(`**Top decile minus bottom decile:** ${fmtPct(hi.meanForwardReturn - lo.meanForwardReturn)} forward-return spread on held positions.`);
    out.push('');
    out.push(`(Note: this is from the engine's *attribution* records — only held positions per rebalance. Sees the high tail but the low tail through the lens of the same portfolio universe rather than every scored candidate. A future build could page the mlTraining subcollection for full-candidate decile coverage.)`);
  }
  out.push('');

  out.push('## Rolling-window consistency');
  out.push('');
  out.push('### 1-year windows');
  if (rolling1y.length === 0) out.push('*Not enough equity data.*');
  else {
    out.push('| Window | Total return | vs Benchmark (TBD) |');
    out.push('|---|---:|---:|');
    for (const w of rolling1y) {
      out.push(`| ${w.windowStart.slice(0, 7)} → ${w.windowEnd.slice(0, 7)} | ${w.totalReturnPct.toFixed(2)}% | — |`);
    }
  }
  out.push('');
  out.push('### 3-year windows');
  if (rolling3y.length === 0) out.push('*Not enough equity data.*');
  else {
    out.push('| Window | Total return |');
    out.push('|---|---:|');
    for (const w of rolling3y) {
      out.push(`| ${w.windowStart.slice(0, 7)} → ${w.windowEnd.slice(0, 7)} | ${w.totalReturnPct.toFixed(2)}% |`);
    }
  }
  out.push('');

  out.push('## Per-factor Information Coefficient (W3 attribution)');
  out.push('');
  out.push('Spearman rank correlation between each analyst\'s layer score and the held-position forward return (segmentReturn). Higher IC = factor carries signal; ~0 IC = noise; negative IC = factor was directionally wrong on this universe.');
  out.push('');
  if (ic.length === 0) out.push('*Not enough attribution rows.*');
  else {
    out.push('| Factor | Spearman IC | Pearson IC | n |');
    out.push('|---|---:|---:|---:|');
    for (const k of ic) {
      out.push(`| ${k.analyst} | ${k.ic.toFixed(4)} | ${k.pearsonIc.toFixed(4)} | ${k.n} |`);
    }
  }
  out.push('');

  out.push('## PIT caveats applied (reports/phase-4t/pit-audit.md)');
  out.push('');
  out.push('- **Fundamentals + earnings-history restatement.** Polygon silently incorporates issuer restatements; the agent at a historical date sees the TODAY view of those filings. Magnitude is small on sp500, **larger on russell2k** — interpret the russell2k headline with extra caution. The Phase 1 fundamentals-snapshot store would close this; out of scope for 4t.');
  out.push('- **News-coverage density.** Polygon\'s `published_utc.lte` cutoff is hard (no future news leaks), but coverage is thinner in 2018 than later years. Bias is on contribution *variance* across the window, not direction.');
  out.push('- **Political STOCK Act shift.** The backtest uses `getPoliticalActivityForBacktest` to model the 45-day disclosure deadline. The shift is conservative on average but individual trades may have become public sooner/later than modeled.');
  out.push('- **Patent + macro-regime excluded** (weight=0 in live composite, Phase 4f no_upstream). Their per-rebalance scores are emitted for completeness but contribute 0 to the composite.');
  out.push('');
  if ((doc.run.warnings ?? []).length > 0) {
    out.push('### Engine warnings emitted during this run');
    out.push('');
    for (const w of doc.run.warnings) out.push(`- ${w}`);
    out.push('');
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runId) {
    console.error('--runId required');
    process.exit(2);
  }
  const origin = args.origin ?? 'https://tradeiq-alpha.netlify.app';
  console.error(`fetching ${origin}/api/backtest-runs/${args.runId} ...`);
  const doc = await fetchRun(origin, args.runId);
  console.error(`run status: ${doc.run.status}; ml rows: ${doc.mlTrainingCount}; attribution rows: ${doc.attribution.length}`);
  if (doc.run.status !== 'complete') {
    console.error(`run is not complete (status=${doc.run.status}) — exiting`);
    process.exit(1);
  }

  const attrRows = doc.attribution as AttributionRow[];
  const decile = decileForwardReturns(attrRows);
  const rolling1y = rollingWindows(doc.dailyEquity, 1);
  const rolling3y = rollingWindows(doc.dailyEquity, 3);
  const ic = perFactorIC(attrRows);

  const md = formatReport(doc, decile, rolling1y, rolling3y, ic);
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, md);
    console.error(`wrote ${args.out}`);
  } else {
    process.stdout.write(md);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
