#!/usr/bin/env node
// Phase 4e-1 — CLI for the portfolio-engine backtest validation.
//
// Usage:
//   npx tsx scripts/run-portfolio-backtest.ts --window full
//   npx tsx scripts/run-portfolio-backtest.ts --window rolling-2020
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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPortfolioBacktest, type BacktestWindow, type PriceSource } from '../netlify/functions/shared/prophet-portfolio/backtest-harness';
import { compositeRankingSignal } from '../netlify/functions/shared/prophet-portfolio/signal';
import type { PortfolioConfig } from '../netlify/functions/shared/prophet-portfolio/types';

interface CliArgs {
  window: string;
  out?: string;
  startCapital?: number;
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
    }
  }
  if (!out.window) {
    console.error('Missing required --window arg. Try: full | half-2018 | half-2022 | covid | rate-hikes | rolling-YYYY');
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const win = windowSpec(args.window);
  const config: PortfolioConfig = {
    ...RULE_CONFIG_BASE,
    startDate: win.start,
    startCapital: args.startCapital ?? RULE_CONFIG_BASE.startCapital,
  };

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
