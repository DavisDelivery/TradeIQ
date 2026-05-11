#!/usr/bin/env node
// CLI for running backtests manually.
//
// Usage:
//   npx tsx scripts/run-backtest.ts --config configs/dow-2018-2024-monthly-top20.json
//   npx tsx scripts/run-backtest.ts \
//     --universe dow --start 2018-01-01 --end 2024-12-31 \
//     --rebalance monthly --top-n 20 --board prophet
//
// Loads config from a JSON file or CLI flags, runs runBacktest, prints a
// summary to stdout, writes the full result to Firestore. Returns the
// runId so the user can reference it later (Phase 4b UI consumes it).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runBacktest } from '../netlify/functions/shared/backtest/engine';
import { DEFAULT_COSTS } from '../netlify/functions/shared/backtest/costs';
import type {
  BacktestBoard,
  BacktestConfig,
  BacktestUniverse,
  RebalanceFrequency,
} from '../netlify/functions/shared/backtest/types';

interface CliArgs {
  config?: string;
  universe?: BacktestUniverse;
  start?: string;
  end?: string;
  rebalance?: RebalanceFrequency;
  topN?: number;
  board?: BacktestBoard;
  capital?: number;
  noPersist?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--config':
        out.config = next;
        i++;
        break;
      case '--universe':
        out.universe = next as BacktestUniverse;
        i++;
        break;
      case '--start':
        out.start = next;
        i++;
        break;
      case '--end':
        out.end = next;
        i++;
        break;
      case '--rebalance':
        out.rebalance = next as RebalanceFrequency;
        i++;
        break;
      case '--top-n':
        out.topN = parseInt(next, 10);
        i++;
        break;
      case '--board':
        out.board = next as BacktestBoard;
        i++;
        break;
      case '--capital':
        out.capital = parseFloat(next);
        i++;
        break;
      case '--no-persist':
        out.noPersist = true;
        break;
      case '--help':
      case '-h':
        printHelpAndExit();
        break;
    }
  }
  return out;
}

function printHelpAndExit(): never {
  console.log(`
TradeIQ backtest CLI

Usage:
  npx tsx scripts/run-backtest.ts [options]

Options:
  --config <path>           JSON config file (CLI flags override its fields)
  --universe <name>         dow | sp500 | ndx | russell2k
  --start YYYY-MM-DD        backtest start date (>= 2018-01-01)
  --end YYYY-MM-DD          backtest end date
  --rebalance <freq>        weekly | monthly | quarterly
  --top-n <N>               number of positions
  --board <name>            prophet (V1) | target | catalyst | insider | williams | lynch
  --capital <USD>           initial capital (default 100000)
  --no-persist              do not write run to Firestore (dry run)

Examples:
  npx tsx scripts/run-backtest.ts --config configs/dow-2018-2024-monthly-top20.json
  npx tsx scripts/run-backtest.ts \\
    --universe dow --start 2018-01-01 --end 2024-12-31 \\
    --rebalance monthly --top-n 20 --board prophet
`);
  process.exit(0);
}

function loadConfig(args: CliArgs): BacktestConfig {
  let base: Partial<BacktestConfig> = {};
  if (args.config) {
    const raw = fs.readFileSync(path.resolve(args.config), 'utf8');
    base = JSON.parse(raw) as Partial<BacktestConfig>;
  }
  const merged: BacktestConfig = {
    universe: (args.universe ?? base.universe ?? 'dow') as BacktestUniverse,
    startDate: args.start ?? base.startDate ?? '2018-01-01',
    endDate: args.end ?? base.endDate ?? '2024-12-31',
    rebalanceFrequency: (args.rebalance ?? base.rebalanceFrequency ?? 'monthly') as RebalanceFrequency,
    board: (args.board ?? base.board ?? 'prophet') as BacktestBoard,
    portfolio: base.portfolio ?? {
      topN: args.topN ?? 20,
      weighting: 'equal',
      maxPositionPct: 0.10,
      maxSectorPct: 0.40,
      cashSleeve: 0.02,
      minComposite: 50,
    },
    costs: base.costs ?? DEFAULT_COSTS,
    initialCapital: args.capital ?? base.initialCapital ?? 100_000,
    scoringConcurrency: base.scoringConcurrency ?? 5,
  };
  if (args.topN !== undefined) {
    merged.portfolio = { ...merged.portfolio, topN: args.topN };
  }
  return merged;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args);

  console.log('TradeIQ backtest');
  console.log('================');
  console.log(`Universe:     ${config.universe}`);
  console.log(`Window:       ${config.startDate} -> ${config.endDate}`);
  console.log(`Rebalance:    ${config.rebalanceFrequency}`);
  console.log(`Board:        ${config.board}`);
  console.log(`Top-N:        ${config.portfolio.topN}`);
  console.log(`Capital:      $${config.initialCapital.toLocaleString()}`);
  console.log('');

  const startMs = Date.now();
  const result = await runBacktest(config, {
    noPersist: args.noPersist,
    onProgress: (e) => {
      if (e.phase === 'rebalance_start') {
        const pct = (((e.rebalanceIndex ?? 0) + 1) / (e.totalRebalances ?? 1)) * 100;
        process.stdout.write(
          `\r  Rebalance ${e.rebalanceDate} (${(e.rebalanceIndex ?? 0) + 1}/${e.totalRebalances}, ${pct.toFixed(0)}%)`,
        );
      }
    },
  });
  console.log('');
  console.log('');

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log(`runId:            ${result.runId}`);
  console.log(`elapsed:          ${elapsedSec}s`);
  console.log(`rebalances:       ${result.metrics.rebalanceCount}`);
  console.log(`trades:           ${result.metrics.tradeCount}`);
  console.log('');
  console.log('--- metrics ---');
  console.log(`total return:     ${result.metrics.totalReturnPct.toFixed(2)}%`);
  console.log(`CAGR:             ${result.metrics.cagrPct.toFixed(2)}%`);
  console.log(`Sharpe:           ${result.metrics.sharpe.toFixed(3)}`);
  console.log(`Sortino:          ${result.metrics.sortino.toFixed(3)}`);
  console.log(`Max DD:           ${result.metrics.maxDrawdownPct.toFixed(2)}%`);
  console.log(`recovery (days):  ${result.metrics.recoveryDays ?? 'no recovery'}`);
  console.log(`win rate:         ${result.metrics.winRatePct.toFixed(1)}%`);
  console.log(`profit factor:    ${result.metrics.profitFactor.toFixed(2)}`);
  console.log(`IC (Spearman):    ${result.metrics.informationCoefficient.toFixed(3)}`);
  console.log(`IR vs ${result.benchmark?.ticker ?? '???'}:        ${result.metrics.informationRatio.toFixed(3)}`);
  console.log('');
  console.log(`benchmark return: ${result.benchmark?.totalReturnPct.toFixed(2) ?? 'n/a'}%`);
  console.log('');
  console.log('--- universe correction ---');
  console.log(`corrected:        ${result.universeSurvivorshipCorrected.corrected}`);
  console.log(`coverage starts:  ${result.universeSurvivorshipCorrected.coverageThrough ?? 'none'}`);
  if (result.warnings.length > 0) {
    console.log('');
    console.log('--- warnings ---');
    for (const w of result.warnings) console.log(`  ${w}`);
  }
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
