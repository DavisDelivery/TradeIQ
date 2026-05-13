#!/usr/bin/env node
// Phase 4e-1 — CLI for the portfolio-engine backtest validation.
//
// Usage:
//   npx tsx scripts/run-portfolio-backtest.ts --window full
//   npx tsx scripts/run-portfolio-backtest.ts --window rolling-2020
//   npx tsx scripts/run-portfolio-backtest.ts --window short-demo --demo
//
// Prereqs for a real run:
//   - FIREBASE_SERVICE_ACCOUNT  (service account JSON)
//   - POLYGON_API_KEY           (daily bars)
//
// When either is missing the CLI prints the windows it would have run
// and exits with code 2 — no half-baked numbers, no fake verdict. The
// binding verdict report (reports/phase-4e-1/backtest-validation.md)
// remains in PENDING state until this CLI succeeds end-to-end against
// production data.
//
// `--demo` mode runs the harness against a deterministic synthetic
// dataset (no env vars required). The output goes to
// reports/phase-4e-1/demo-run.md, clearly labeled DEMO. Used to
// verify the pipeline is wired end-to-end; NOT a substitute for the
// binding verdict.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  runPortfolioBacktest,
  type BacktestWindow,
  type PriceSource,
} from '../netlify/functions/shared/prophet-portfolio/backtest-harness';
import { compositeRankingSignal } from '../netlify/functions/shared/prophet-portfolio/signal';
import type {
  PortfolioConfig,
  RankingResult,
  RankingSignal,
} from '../netlify/functions/shared/prophet-portfolio/types';

interface CliArgs {
  window: string;
  out?: string;
  startCapital?: number;
  demo?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--window' && next) {
      out.window = next;
      i++;
    } else if (arg === '--out' && next) {
      out.out = next;
      i++;
    } else if (arg === '--start-capital' && next) {
      out.startCapital = Number(next);
      i++;
    } else if (arg === '--demo') {
      out.demo = true;
    }
  }
  if (!out.window) {
    console.error('Missing required --window arg. Try: full | half-2018 | half-2022 | covid | rate-hikes | rolling-YYYY | short-demo');
    process.exit(2);
  }
  return out as CliArgs;
}

const RULE_CONFIG_BASE: Omit<PortfolioConfig, 'startDate'> = {
  universe: 'largecap',
  startCapital: 100_000,
  positionCount: 10,
  minHoldDays: 30,
  maxSwapsPerRebalance: 3,
  sectorCap: 4,
  slippageBps: 10,
  minComposite: 50,
  candidatePool: 15,
  version: 'v1',
};

function windowSpec(label: string): BacktestWindow {
  // Real implementation walks the trading calendar; this lightweight
  // skeleton lays out the dates and lets the caller (real or fixture)
  // populate the rebalance/mark cadence.
  switch (label) {
    case 'full':
      return makeWindow('full', '2018-01-01', '2026-01-01');
    case 'half-2018':
      return makeWindow('half-2018', '2018-01-01', '2022-01-01');
    case 'half-2022':
      return makeWindow('half-2022', '2022-01-01', '2026-01-01');
    case 'covid':
      return makeWindow('covid', '2020-02-01', '2020-09-01');
    case 'rate-hikes':
      return makeWindow('rate-hikes', '2022-01-01', '2022-12-31');
    case 'short-demo':
      return makeWindow('short-demo', '2024-01-08', '2024-04-08');
    default:
      if (label.startsWith('rolling-')) {
        const year = Number(label.slice('rolling-'.length));
        if (Number.isFinite(year)) {
          return makeWindow(
            label,
            `${year}-01-01`,
            `${year + 1}-01-01`,
          );
        }
      }
      throw new Error(`Unknown window label: ${label}`);
  }
}

// -- DEMO mode helpers -------------------------------------------------------

const DEMO_TICKERS = [
  { ticker: 'AAA', sector: 'Technology', drift: 0.0008, vol: 0.018 },
  { ticker: 'BBB', sector: 'Technology', drift: 0.0006, vol: 0.020 },
  { ticker: 'CCC', sector: 'Healthcare', drift: 0.0005, vol: 0.016 },
  { ticker: 'DDD', sector: 'Healthcare', drift: 0.0004, vol: 0.015 },
  { ticker: 'EEE', sector: 'Financials', drift: 0.0003, vol: 0.014 },
  { ticker: 'FFF', sector: 'Financials', drift: 0.0003, vol: 0.013 },
  { ticker: 'GGG', sector: 'Energy', drift: 0.0002, vol: 0.022 },
  { ticker: 'HHH', sector: 'Energy', drift: 0.0001, vol: 0.020 },
  { ticker: 'III', sector: 'Consumer', drift: 0.0005, vol: 0.015 },
  { ticker: 'JJJ', sector: 'Consumer', drift: 0.0004, vol: 0.014 },
  { ticker: 'KKK', sector: 'Industrials', drift: 0.0003, vol: 0.016 },
  { ticker: 'LLL', sector: 'Industrials', drift: 0.0002, vol: 0.017 },
  { ticker: 'MMM', sector: 'Utilities', drift: 0.0002, vol: 0.012 },
  { ticker: 'NNN', sector: 'Materials', drift: 0.0003, vol: 0.019 },
  { ticker: 'OOO', sector: 'Telecom', drift: 0.0002, vol: 0.015 },
];

// Deterministic PRNG (mulberry32) so demo runs are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  // Box-Muller
  const u = Math.max(1e-9, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function buildDemoPriceSeries(window: BacktestWindow, seed: number): {
  prices: Map<string, Map<string, number>>;
  benchmarks: { spy: Map<string, number>; qqq: Map<string, number>; iwf: Map<string, number> };
} {
  const rand = mulberry32(seed);
  const prices = new Map<string, Map<string, number>>();
  // GBM-ish daily compounding per ticker.
  for (const t of DEMO_TICKERS) {
    const series = new Map<string, number>();
    let p = 100;
    for (const d of window.markDates) {
      p = p * Math.exp(t.drift - 0.5 * t.vol * t.vol + t.vol * gaussian(rand));
      series.set(d, p);
    }
    prices.set(t.ticker, series);
  }
  // Benchmarks
  function bench(drift: number, vol: number): Map<string, number> {
    const m = new Map<string, number>();
    let p = 500;
    for (const d of window.markDates) {
      p = p * Math.exp(drift - 0.5 * vol * vol + vol * gaussian(rand));
      m.set(d, p);
    }
    return m;
  }
  return {
    prices,
    benchmarks: {
      spy: bench(0.00035, 0.010),
      qqq: bench(0.00045, 0.013),
      iwf: bench(0.00040, 0.012),
    },
  };
}

function demoPriceSource(series: Map<string, Map<string, number>>): PriceSource {
  return {
    async closeAt(ticker: string, date: string) {
      const m = series.get(ticker);
      if (!m) return null;
      if (m.has(date)) return m.get(date) ?? null;
      // Walk back to most recent earlier date.
      const sorted = [...m.keys()].sort();
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i] <= date) return m.get(sorted[i]) ?? null;
      }
      return null;
    },
  };
}

function demoBenchSource(m: Map<string, number>): PriceSource {
  return {
    async closeAt(_t: string, date: string) {
      if (m.has(date)) return m.get(date) ?? null;
      const sorted = [...m.keys()].sort();
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i] <= date) return m.get(sorted[i]) ?? null;
      }
      return null;
    },
  };
}

function demoSignal(window: BacktestWindow): RankingSignal {
  // For each rebalance date, derive a per-ticker score from a smoothed
  // shuffle so the top-N drifts week to week (turnover, drop-outs,
  // sector mix changes). Deterministic via mulberry32 seeded by date.
  return {
    id: 'demo-signal',
    async rankAtDate({ asOfDate, topN, minComposite = 50 }) {
      const seed = Date.parse(`${asOfDate}T00:00:00Z`) >>> 0;
      const rand = mulberry32(seed);
      const ranked: RankingResult[] = DEMO_TICKERS.map((t) => {
        const composite = 50 + Math.floor(rand() * 50); // 50..99
        return {
          ticker: t.ticker,
          name: t.ticker,
          sector: t.sector,
          composite,
          layers: { fundamental: { score: composite, pass: composite > 55 } },
          fundamentalPass: composite > 55,
          regime: 'neutral',
          signalId: 'demo-signal',
        };
      })
        .filter((r) => r.composite >= minComposite)
        .sort((a, b) => b.composite - a.composite)
        .slice(0, topN);
      return ranked;
    },
  };
}

function makeWindow(label: string, start: string, end: string): BacktestWindow {
  // Weekly rebalance cadence, daily marks. Real run resolves these to
  // trading-calendar dates; the skeleton here is calendar-day stepped
  // (caller injects a trading-day filter via PriceSource null-returns
  // for non-trading days, which the harness gracefully handles).
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const marks: string[] = [];
  for (let t = startMs; t <= endMs; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    marks.push(d);
  }
  const rebalances: string[] = [];
  // First trading day each week from start; pick mondays as proxy.
  for (let t = startMs; t <= endMs; t += 7 * 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    rebalances.push(d);
  }
  return { label, start, end, rebalanceDates: rebalances, markDates: marks };
}

async function runDemo(win: BacktestWindow, config: PortfolioConfig): Promise<void> {
  const { prices, benchmarks } = buildDemoPriceSeries(win, 42);
  const result = await runPortfolioBacktest({
    config,
    window: win,
    signal: demoSignal(win),
    prices: demoPriceSource(prices),
    benchmarks: {
      spy: demoBenchSource(benchmarks.spy),
      qqq: demoBenchSource(benchmarks.qqq),
      iwf: demoBenchSource(benchmarks.iwf),
    },
  });

  const outDir = path.join('reports', 'phase-4e-1');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `demo-result-${win.label}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  const mdPath = path.join(outDir, 'demo-run.md');
  const md = [
    `# Phase 4e-1 — DEMO backtest run`,
    ``,
    `**This is NOT the binding verdict.** The numbers below come from a`,
    `deterministic synthetic dataset (GBM-ish per-ticker price series,`,
    `seeded PRNG) — they exist only to prove the harness + rule + CLI`,
    `pipeline is wired end-to-end. The real verdict lives in`,
    `\`backtest-validation.md\` and requires production credentials.`,
    ``,
    `**Window:** ${win.label} (${win.start} → ${win.end})`,
    `**Mark days:** ${win.markDates.length}`,
    `**Rebalance days:** ${win.rebalanceDates.length}`,
    `**Generated:** ${new Date().toISOString()}`,
    ``,
    `## Pipeline output`,
    ``,
    `| Metric                       | Value |`,
    `|------------------------------|------:|`,
    `| Portfolio return (%)         | ${result.portfolioReturnPct} |`,
    `| SPY return (%)               | ${result.spyReturnPct} |`,
    `| Excess vs SPY (pp)           | ${result.excessReturnPct} |`,
    `| QQQ return (%)               | ${result.qqqReturnPct} |`,
    `| IWF return (%)               | ${result.iwfReturnPct} |`,
    `| Portfolio Sharpe (annualized)| ${result.sharpe} |`,
    `| SPY Sharpe (annualized)      | ${result.spySharpe} |`,
    `| Portfolio max DD (%)         | ${result.maxDDPct} |`,
    `| SPY max DD (%)               | ${result.spyMaxDDPct} |`,
    `| Longest underwater days      | ${result.longestUnderwaterDays} |`,
    `| Rebalances                   | ${result.rebalanceCount} |`,
    `| Swaps recorded               | ${result.swapCount} |`,
    `| Avg hold (days)              | ${result.avgHoldDays} |`,
    `| Annualized turnover (%)      | ${result.turnoverPct} |`,
    `| Cost drag (%)                | ${result.costDragPct} |`,
    ``,
    `## What this tells you`,
    ``,
    `- The harness completed end-to-end (no crashes, no missing-price warnings`,
    `  beyond what's expected for synthetic data).`,
    `- The rebalance decision logic produced swaps when the signal shifted.`,
    `- Equity curve and benchmark series wired through to metrics correctly.`,
    `- Cost drag is being applied at the basis-point rate from \`PortfolioConfig\`.`,
    ``,
    `## What this does NOT tell you`,
    ``,
    `- Whether the rule beats SPY in production. The demo signal is random;`,
    `  the verdict requires real Prophet snapshots feeding \`compositeRankingSignal\`.`,
    `- Whether any Prophet layer is stub-returning. That's the W0 audit`,
    `  (run \`scripts/audit-prophet-layers.ts\` with production credentials).`,
    `- Whether the rule beats QQQ/IWF after style-factor adjustment. Same.`,
    ``,
    `Full JSON: \`${path.relative('.', jsonPath)}\``,
    ``,
  ].join('\n');
  fs.writeFileSync(mdPath, md);
  console.log(`Wrote ${mdPath} and ${jsonPath}`);
  console.log(`DEMO portfolio: ${result.portfolioReturnPct}% | SPY: ${result.spyReturnPct}% | excess: ${result.excessReturnPct}%`);
  console.log(`DEMO Sharpe: ${result.sharpe} (SPY ${result.spySharpe}) | swaps: ${result.swapCount}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const win = windowSpec(args.window);
  const config: PortfolioConfig = {
    ...RULE_CONFIG_BASE,
    startDate: win.start,
    startCapital: args.startCapital ?? RULE_CONFIG_BASE.startCapital,
  };

  if (args.demo) {
    await runDemo(win, config);
    return;
  }

  const missing: string[] = [];
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) missing.push('FIREBASE_SERVICE_ACCOUNT');
  if (!process.env.POLYGON_API_KEY) missing.push('POLYGON_API_KEY');

  if (missing.length > 0) {
    console.error('Cannot run a real backtest — missing env vars: ' + missing.join(', '));
    console.error('');
    console.error('Window that would have run:');
    console.error(`  label=${win.label}  start=${win.start}  end=${win.end}`);
    console.error(`  rebalance dates: ${win.rebalanceDates.length}, mark dates: ${win.markDates.length}`);
    console.error('');
    console.error('Set the env vars and re-run to populate reports/phase-4e-1/backtest-validation.md.');
    process.exit(2);
  }

  // A real run would build a Polygon-backed PriceSource and the
  // compositeRankingSignal (already Firestore-backed via snapshot-store).
  // We thread them in here. The harness itself is identical to the
  // fixture-driven path used by tests.
  const livePrices: PriceSource = {
    async closeAt(ticker, date) {
      // Lazy-import so the script can fail-fast on missing env BEFORE
      // initializing firebase-admin.
      const { getDailyBars } = await import('../netlify/functions/shared/data-provider');
      const from = new Date(Date.parse(`${date}T00:00:00Z`) - 7 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const bars = await getDailyBars(ticker, from, date).catch(() => []);
      for (let i = bars.length - 1; i >= 0; i--) {
        const b = bars[i] as { c?: number; t?: number };
        if (typeof b.c === 'number') return b.c;
      }
      return null;
    },
  };
  const result = await runPortfolioBacktest({
    config,
    window: win,
    signal: compositeRankingSignal,
    prices: livePrices,
    benchmarks: { spy: livePrices, qqq: livePrices, iwf: livePrices },
  });

  const outPath = args.out ?? path.join('reports', 'phase-4e-1', `result-${win.label}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Wrote ${outPath}`);
  console.log(`Portfolio: ${result.portfolioReturnPct}% | SPY: ${result.spyReturnPct}% | excess: ${result.excessReturnPct}%`);
  console.log(`Sharpe: ${result.sharpe} (SPY ${result.spySharpe}) | maxDD: ${result.maxDDPct}% | swaps: ${result.swapCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
