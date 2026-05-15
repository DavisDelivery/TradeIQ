// Phase 4f — Stub-analyst audit (shared logic).
//
// Walks recent snapshots for a given board × universe, computes
// per-analyst (or per-layer) statistics, classifies each as
// Live / Stub / Degraded per the brief's thresholds, and builds a
// Markdown table the audit doc can ingest verbatim.
//
// Shared between:
//   - scripts/audit-stub-analysts.ts (CLI; reads via firebase-admin)
//   - netlify/functions/audit-stub-analysts.ts (HTTP endpoint; same
//     reads, but caller doesn't need local creds)
//
// Thresholds (per briefs/phase-4f-brief.md § W1):
//   Live    = stdev > 5 AND pctExactly50 < 25%
//   Stub    = stdev < 2 OR pctExactly50 > 60%
//   Degraded = anything else
//
// Two snapshot shapes are supported:
//   board='prophet'   → results: Array<{ layers: Record<name, {score,pass}> }>
//   board='target-board' → results: Array<{ analystContributions: Array<{ analyst,score,weight }> }>

export type AuditBoard = 'prophet' | 'target-board';
export type AuditUniverse = 'largecap' | 'russell2k';

export interface PerAnalystStats {
  count: number;
  sum: number;
  sumSq: number;
  exactly50: number;
  nullCount: number;
  failCount: number;
  uniqueValues: Set<number>;
}

export function emptyStats(): PerAnalystStats {
  return {
    count: 0,
    sum: 0,
    sumSq: 0,
    exactly50: 0,
    nullCount: 0,
    failCount: 0,
    uniqueValues: new Set<number>(),
  };
}

export function mean(s: PerAnalystStats): number {
  return s.count > 0 ? s.sum / s.count : 0;
}

export function stdev(s: PerAnalystStats): number {
  if (s.count < 2) return 0;
  const m = mean(s);
  const v = s.sumSq / s.count - m * m;
  return v > 0 ? Math.sqrt(v) : 0;
}

export function pct(n: number, d: number): number {
  return d > 0 ? +((n / d) * 100).toFixed(2) : 0;
}

export type AnalystVerdict = 'live' | 'stub' | 'degraded';

export function classify(s: PerAnalystStats): AnalystVerdict {
  const std = stdev(s);
  const exactly = pct(s.exactly50, s.count);
  if (std > 5 && exactly < 25) return 'live';
  if (std < 2 || exactly > 60) return 'stub';
  return 'degraded';
}

export interface AuditRow {
  analyst: string;
  count: number;
  mean: number;
  stdev: number;
  pctExactly50: number;
  pctNull: number;
  pctFailing: number;
  uniqueValues: number;
  verdict: AnalystVerdict;
}

export function statsToRow(name: string, s: PerAnalystStats): AuditRow {
  const denom = s.count + s.nullCount;
  return {
    analyst: name,
    count: s.count,
    mean: +mean(s).toFixed(2),
    stdev: +stdev(s).toFixed(2),
    pctExactly50: pct(s.exactly50, s.count),
    pctNull: pct(s.nullCount, Math.max(1, denom)),
    pctFailing: pct(s.failCount, s.count),
    uniqueValues: s.uniqueValues.size,
    verdict: classify(s),
  };
}

// Two payload shapes — pure helper, exposed for unit tests so we can
// feed in synthetic snapshot results without going through Firestore.

interface ProphetLayerPayload {
  score?: number | null;
  pass?: boolean;
}
interface ProphetResult {
  layers?: Record<string, ProphetLayerPayload>;
}

interface TargetContributionPayload {
  analyst?: string;
  score?: number | null;
}
interface TargetResult {
  analystContributions?: TargetContributionPayload[];
}

export function ingestProphetResults(
  results: ProphetResult[],
  stats: Record<string, PerAnalystStats>,
): number {
  let observations = 0;
  for (const r of results) {
    if (!r?.layers) continue;
    for (const [name, layer] of Object.entries(r.layers)) {
      const s = (stats[name] ??= emptyStats());
      const score = typeof layer?.score === 'number' ? layer.score : null;
      if (score == null) {
        s.nullCount++;
        continue;
      }
      s.count++;
      s.sum += score;
      s.sumSq += score * score;
      s.uniqueValues.add(Math.round(score));
      if (score === 50) s.exactly50++;
      if (layer?.pass !== true) s.failCount++;
      observations++;
    }
  }
  return observations;
}

export function ingestTargetResults(
  results: TargetResult[],
  stats: Record<string, PerAnalystStats>,
): number {
  let observations = 0;
  for (const r of results) {
    const contribs = r?.analystContributions;
    if (!Array.isArray(contribs)) continue;
    for (const c of contribs) {
      const name = c?.analyst;
      if (!name) continue;
      const s = (stats[name] ??= emptyStats());
      const score = typeof c?.score === 'number' ? c.score : null;
      if (score == null) {
        s.nullCount++;
        continue;
      }
      s.count++;
      s.sum += score;
      s.sumSq += score * score;
      s.uniqueValues.add(Math.round(score));
      if (score === 50) s.exactly50++;
      observations++;
    }
  }
  return observations;
}

export interface BoardQuadrantAudit {
  board: AuditBoard;
  universe: AuditUniverse;
  snapshotsScanned: number;
  observationCount: number;
  rows: AuditRow[];
}

export function summaryCounts(rows: AuditRow[]): {
  live: number;
  stub: number;
  degraded: number;
} {
  let live = 0;
  let stub = 0;
  let degraded = 0;
  for (const r of rows) {
    if (r.verdict === 'live') live++;
    else if (r.verdict === 'stub') stub++;
    else degraded++;
  }
  return { live, stub, degraded };
}

export function buildQuadrantMarkdown(q: BoardQuadrantAudit): string {
  const lines: string[] = [];
  const c = summaryCounts(q.rows);
  const boardLabel = q.board === 'prophet' ? 'Prophet' : 'Target Board';
  lines.push(`### ${boardLabel} — ${q.universe}`);
  lines.push('');
  lines.push(
    `Snapshots scanned: ${q.snapshotsScanned}.  Observations: ${q.observationCount}.  ` +
      `Verdicts: ${c.live} live · ${c.stub} stub · ${c.degraded} degraded.`,
  );
  lines.push('');
  lines.push(
    `| Analyst/Layer        |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |`,
  );
  lines.push(
    `|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|`,
  );
  for (const r of q.rows) {
    lines.push(
      `| ${r.analyst.padEnd(20)} | ${r.mean.toFixed(2).padStart(8)} | ${r.stdev.toFixed(2).padStart(8)} | ${r.pctExactly50.toFixed(2).padStart(12)} | ${r.pctNull.toFixed(2).padStart(7)} | ${r.pctFailing.toFixed(2).padStart(12)} | ${String(r.uniqueValues).padStart(11)} | ${r.verdict} |`,
    );
  }
  return lines.join('\n');
}

export function buildSummary(quadrants: BoardQuadrantAudit[]): {
  totalAnalysts: number;
  totalLive: number;
  totalStub: number;
  totalDegraded: number;
  stubsByQuadrant: Array<{ board: AuditBoard; universe: AuditUniverse; analyst: string }>;
} {
  let totalAnalysts = 0;
  let totalLive = 0;
  let totalStub = 0;
  let totalDegraded = 0;
  const stubsByQuadrant: Array<{ board: AuditBoard; universe: AuditUniverse; analyst: string }> = [];
  for (const q of quadrants) {
    const c = summaryCounts(q.rows);
    totalAnalysts += q.rows.length;
    totalLive += c.live;
    totalStub += c.stub;
    totalDegraded += c.degraded;
    for (const r of q.rows) {
      if (r.verdict === 'stub') {
        stubsByQuadrant.push({ board: q.board, universe: q.universe, analyst: r.analyst });
      }
    }
  }
  return { totalAnalysts, totalLive, totalStub, totalDegraded, stubsByQuadrant };
}
