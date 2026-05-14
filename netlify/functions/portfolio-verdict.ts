// Phase 4e-1 follow-up — live verdict endpoint.
//
// Reads the most recent audit (prophetPortfolio/audits/runs/) and the
// most recent backtest result per window (portfolioBacktests/) and
// returns the populated `backtest-validation.md` content.
//
//   GET /api/portfolio-verdict        → application/json with markdown + metadata
//   GET /api/portfolio-verdict?fmt=md → text/markdown directly
//
// Auto-derived verdict line:
//   - SHIP                  if full-window excessReturnPct > 0 AND
//                              ≥5/8 rolling 1y windows beat SPY
//   - SHIP WITH CAVEATS     if full-window excessReturnPct > 0 but
//                              <5/8 rolling windows beat SPY (or vice versa)
//   - DON'T SHIP            if full-window excessReturnPct < 0 AND
//                              <5/8 rolling windows beat SPY
//   - PENDING LIVE-DATA RUN if full-window or audit data is missing
//
// Operator does not need to commit anything — this endpoint IS the
// verdict. The repo's `reports/phase-4e-1/backtest-validation.md`
// remains a runbook + scaffolding; the live numbers live here.

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const headers = { 'Content-Type': 'application/json; charset=utf-8' };

interface BacktestSummary {
  runId: string;
  window: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  startDate?: string;
  endDate?: string;
  portfolioReturnPct?: number;
  spyReturnPct?: number;
  qqqReturnPct?: number;
  iwfReturnPct?: number;
  excessReturnPct?: number;
  sharpe?: number;
  spySharpe?: number;
  maxDDPct?: number;
  spyMaxDDPct?: number;
  longestUnderwaterDays?: number;
  swapCount?: number;
  avgHoldDays?: number;
  turnoverPct?: number;
  costDragPct?: number;
  rebalanceCount?: number;
  completedAt?: string;
  error?: string;
}

interface AuditRow {
  generatedAt: string;
  universe: string;
  pickCount: number;
  layers: Array<{
    layer: string;
    mean: number;
    stdev: number;
    pctExactly50: number;
    pctNull: number;
    pctFailing: number;
    verdict: 'live' | 'stub';
  }>;
  stubLayers: string[];
  markdown: string;
}

async function latestAudit(): Promise<AuditRow | null> {
  const db = getAdminDb();
  const snap = await db
    .collection('prophetPortfolio')
    .doc('audits')
    .collection('runs')
    .orderBy('generatedAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].data() as AuditRow;
}

async function latestPerWindow(): Promise<Map<string, BacktestSummary>> {
  const db = getAdminDb();
  const snap = await db
    .collection('portfolioBacktests')
    .orderBy('startedAt', 'desc')
    .limit(50)
    .get();
  const out = new Map<string, BacktestSummary>();
  for (const doc of snap.docs) {
    const d = doc.data() as BacktestSummary;
    if (!d.window) continue;
    if (!out.has(d.window)) out.set(d.window, d);
  }
  return out;
}

const NAMED_WINDOWS = ['full', 'half-2018', 'half-2022', 'covid', 'rate-hikes'];
const ROLLING_WINDOWS = ['rolling-2018', 'rolling-2019', 'rolling-2020', 'rolling-2021', 'rolling-2022', 'rolling-2023', 'rolling-2024', 'rolling-2025'];

function fmt(n: number | null | undefined, suffix = ''): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}${suffix}`;
}

function row(s: BacktestSummary | undefined, label: string): string {
  if (!s || s.status !== 'done') return `| ${label} | — | — | — | — | — | — | — | — |`;
  return `| ${label} | ${fmt(s.portfolioReturnPct)} | ${fmt(s.spyReturnPct)} | ${fmt(s.excessReturnPct)} | ${fmt(s.sharpe)} | ${fmt(s.spySharpe)} | ${fmt(s.maxDDPct)} | ${fmt(s.spyMaxDDPct)} | ${s.swapCount ?? '—'} |`;
}

function rollingRow(s: BacktestSummary | undefined, year: number): string {
  if (!s || s.status !== 'done') return `| ${year} | — | — | — | — |`;
  const beat = (s.excessReturnPct ?? 0) > 0 ? 'YES' : 'NO';
  return `| ${year} | ${fmt(s.portfolioReturnPct)} | ${fmt(s.spyReturnPct)} | ${fmt(s.excessReturnPct)} | ${beat} |`;
}

function deriveVerdict(audit: AuditRow | null, results: Map<string, BacktestSummary>): {
  verdict: string;
  rollingBeats: number;
  rollingDone: number;
  fullExcess: number | null;
  qqqDelta: number | null;
} {
  const full = results.get('full');
  if (!audit || !full || full.status !== 'done') {
    return { verdict: 'PENDING LIVE-DATA RUN', rollingBeats: 0, rollingDone: 0, fullExcess: null, qqqDelta: null };
  }
  const fullExcess = full.excessReturnPct ?? 0;
  const qqqDelta =
    typeof full.portfolioReturnPct === 'number' && typeof full.qqqReturnPct === 'number'
      ? full.portfolioReturnPct - full.qqqReturnPct
      : null;

  let beats = 0;
  let done = 0;
  for (const w of ROLLING_WINDOWS) {
    const r = results.get(w);
    if (r && r.status === 'done') {
      done++;
      if ((r.excessReturnPct ?? 0) > 0) beats++;
    }
  }
  if (done < ROLLING_WINDOWS.length) {
    return {
      verdict: 'PENDING LIVE-DATA RUN',
      rollingBeats: beats,
      rollingDone: done,
      fullExcess,
      qqqDelta,
    };
  }

  const beatsMajority = beats >= 5;
  if (fullExcess > 0 && beatsMajority) return { verdict: 'SHIP', rollingBeats: beats, rollingDone: done, fullExcess, qqqDelta };
  if (fullExcess > 0 || beatsMajority) return { verdict: 'SHIP WITH CAVEATS', rollingBeats: beats, rollingDone: done, fullExcess, qqqDelta };
  return { verdict: "DON'T SHIP", rollingBeats: beats, rollingDone: done, fullExcess, qqqDelta };
}

function buildMarkdown(audit: AuditRow | null, results: Map<string, BacktestSummary>): string {
  const v = deriveVerdict(audit, results);
  const liveCount = audit ? audit.layers.filter((l) => l.verdict === 'live').length : 0;
  const lines: string[] = [];

  lines.push(`# Phase 4e-1 — Backtest Validation Findings (LIVE)`);
  lines.push(``);
  lines.push(`**Verdict:** ${v.verdict}`);
  lines.push(`**Layers active:** ${audit ? `${liveCount} of 7 (stubs: ${audit.stubLayers.join(', ') || 'none'})` : 'unknown (audit pending)'}`);
  lines.push(``);
  if (v.verdict.startsWith('SHIP')) {
    lines.push(`Full-window excess vs SPY: ${fmt(v.fullExcess, '%')}. Rolling 1y windows that beat SPY: ${v.rollingBeats}/${v.rollingDone}. QQQ check (portfolio - QQQ): ${fmt(v.qqqDelta, ' pp')}.`);
  } else if (v.verdict === "DON'T SHIP") {
    lines.push(`Full-window excess vs SPY: ${fmt(v.fullExcess, '%')} (negative). Rolling 1y windows beating SPY: ${v.rollingBeats}/${v.rollingDone} (<5 of 8). Rule v1 disqualified — file 4e-1-fix with v2 proposal.`);
  } else {
    lines.push(`Full-window: ${results.get('full')?.status === 'done' ? 'done' : 'PENDING'}. Audit: ${audit ? 'done' : 'PENDING'}. Rolling: ${v.rollingDone}/${ROLLING_WINDOWS.length} done. Awaiting cron-driven completion.`);
  }
  lines.push(``);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Audit generated:** ${audit?.generatedAt ?? 'never'}`);
  lines.push(`**Source:** \`/api/portfolio-verdict\` (live, computed from Firestore)`);
  lines.push(`**Rule version:** v1`);
  lines.push(`**Costs:** 10 bps slippage per side, $0 commission, $100,000 initial capital`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // § 0 — Layer audit
  lines.push(`## 0. Layer activity audit`);
  lines.push(``);
  if (audit) {
    lines.push(`Sample: ${audit.pickCount} (asOfDate, ticker) rows over the last 30 days, universe=${audit.universe}.`);
    lines.push(``);
    lines.push(`| Layer            |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Verdict |`);
    lines.push(`|------------------|---------:|---------:|-------------:|--------:|-------------:|---------|`);
    for (const r of audit.layers) {
      lines.push(`| ${r.layer.padEnd(16)} | ${r.mean.toFixed(2).padStart(8)} | ${r.stdev.toFixed(2).padStart(8)} | ${r.pctExactly50.toFixed(2).padStart(12)} | ${r.pctNull.toFixed(2).padStart(7)} | ${r.pctFailing.toFixed(2).padStart(12)} | ${r.verdict} |`);
    }
    lines.push(``);
    if (audit.stubLayers.length === 0) {
      lines.push(`**All 7 layers active.** Backtest runs Scenario A only.`);
    } else {
      lines.push(`**Stub-returning layers (${audit.stubLayers.length}/7): ${audit.stubLayers.join(', ')}.** Per brief § W0 step 7, the backtest below should be re-run with stub weights redistributed (Scenario B). Scenario B is not yet wired into this endpoint — this is captured in the orchestrator backlog.`);
    }
  } else {
    lines.push(`No audit run yet. Cron schedules \`scan-prophet-audit-cron.ts\` for Sunday 18:00 UTC; first row appears after the next Sunday post-deploy.`);
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // § 1 — Summary table
  lines.push(`## 1. Summary table — Scenario A (composite as-is)`);
  lines.push(``);
  lines.push(`| Window                  | Port %   | SPY %   | Excess   | Port Sharpe | SPY Sharpe | Port Max DD | SPY Max DD | Swaps |`);
  lines.push(`|-------------------------|---------:|--------:|---------:|------------:|-----------:|------------:|-----------:|------:|`);
  lines.push(row(results.get('full'), '2018-01-01 → 2026-01-01 (full)'));
  lines.push(row(results.get('half-2018'), '2018-01-01 → 2022-01-01'));
  lines.push(row(results.get('half-2022'), '2022-01-01 → 2026-01-01'));
  lines.push(row(results.get('covid'), '2020-02-01 → 2020-09-01 (covid)'));
  lines.push(row(results.get('rate-hikes'), '2022-01-01 → 2022-12-31 (rate-hikes)'));
  lines.push(``);

  // § 3 — Rolling 1y
  lines.push(`## 3. Rolling 1-year windows`);
  lines.push(``);
  lines.push(`| Start (Jan) | Port % | SPY % | Excess | Beat SPY? |`);
  lines.push(`|------------:|-------:|------:|-------:|:---------:|`);
  for (let y = 2018; y <= 2025; y++) lines.push(rollingRow(results.get(`rolling-${y}`), y));
  lines.push(``);
  lines.push(`**Rolling 1y windows that beat SPY:** ${v.rollingBeats}/${v.rollingDone}${v.rollingDone < 8 ? ` (${ROLLING_WINDOWS.length - v.rollingDone} still PENDING)` : ''}`);
  lines.push(``);

  // § 4 — Style
  lines.push(`## 4. Style-factor decomposition (full window)`);
  lines.push(``);
  lines.push(`| Series   | Total Return | vs SPY |`);
  lines.push(`|----------|-------------:|-------:|`);
  const full = results.get('full');
  if (full && full.status === 'done') {
    lines.push(`| Portfolio| ${fmt(full.portfolioReturnPct, '%')} | ref |`);
    lines.push(`| SPY      | ${fmt(full.spyReturnPct, '%')} | 0% |`);
    lines.push(`| QQQ      | ${fmt(full.qqqReturnPct, '%')} | ${fmt((full.qqqReturnPct ?? 0) - (full.spyReturnPct ?? 0), '%')} |`);
    lines.push(`| IWF      | ${fmt(full.iwfReturnPct, '%')} | ${fmt((full.iwfReturnPct ?? 0) - (full.spyReturnPct ?? 0), '%')} |`);
    if (v.qqqDelta != null) {
      const passed = v.fullExcess != null && v.qqqDelta > 0 && v.fullExcess > (full.qqqReturnPct ?? 0) - (full.spyReturnPct ?? 0);
      lines.push(``);
      lines.push(`**Style-factor check:** Portfolio beats SPY by clearly more than QQQ does? ${passed ? 'YES (alpha, not factor)' : 'NO (factor exposure, not edge)'}.`);
    }
  } else {
    lines.push(`| Portfolio| — | ref |`);
    lines.push(`| SPY      | — | 0% |`);
    lines.push(`| QQQ      | — | — |`);
    lines.push(`| IWF      | — | — |`);
    lines.push(``);
    lines.push(`**Style-factor check:** PENDING full-window completion.`);
  }
  lines.push(``);

  // § 5 — Diagnostics
  if (full && full.status === 'done') {
    lines.push(`## 5. Position-level diagnostics (full window)`);
    lines.push(``);
    lines.push(`- Total swaps executed: ${full.swapCount ?? '—'}`);
    lines.push(`- Average hold days per position: ${fmt(full.avgHoldDays)}`);
    lines.push(`- Annualized turnover: ${fmt(full.turnoverPct, '%')}`);
    lines.push(`- Total cost drag (slippage): ${fmt(full.costDragPct, '%')}`);
    lines.push(`- Rebalances: ${full.rebalanceCount ?? '—'}`);
    lines.push(`- Longest underwater stretch (days): ${full.longestUnderwaterDays ?? '—'}`);
    lines.push(``);
  }

  // Failures / warnings
  const failedRuns = [...results.entries()].filter(([_, r]) => r.status === 'failed');
  if (failedRuns.length > 0) {
    lines.push(`## Failed runs`);
    lines.push(``);
    for (const [w, r] of failedRuns) {
      lines.push(`- **${w}** (\`${r.runId}\`): ${r.error ?? 'unknown error'}`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}

export const handler: Handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method not allowed' }) };
  }
  const log = logger.child({ fn: 'portfolio-verdict' });
  try {
    const [audit, results] = await Promise.all([latestAudit(), latestPerWindow()]);
    const md = buildMarkdown(audit, results);
    const verdictLine = md.split('\n').find((l) => l.startsWith('**Verdict:**')) ?? '';
    const v = verdictLine.replace('**Verdict:**', '').trim();
    log.info('verdict_served', {
      verdict: v,
      auditPresent: !!audit,
      resultsCount: results.size,
    });

    if ((event.queryStringParameters ?? {}).fmt === 'md') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        body: md,
      };
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        verdict: v,
        generatedAt: new Date().toISOString(),
        auditGeneratedAt: audit?.generatedAt ?? null,
        resultsCount: results.size,
        markdown: md,
      }),
    };
  } catch (err: any) {
    log.error('verdict_failed', { err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
    };
  }
};
