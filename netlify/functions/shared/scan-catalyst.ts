// Shared scan orchestrator for the Catalyst board.
//
// Catalyst scoring weighs insider buying, congressional activity, gov contract
// flow, and stacked technical setups. 4 live providers per ticker + bars +
// local setup detection. Patent fetch is stubbed (subscription-gated, weight 0).
//
// Both the live endpoint (catalyst-board.ts) and the scheduled full-universe
// scan (scan-catalyst-{universe}.ts) route through runCatalystScan. Filters
// (cluster/patents/political/contracts/setup) and minConviction apply at
// READ time in the live endpoint — the snapshot stores ALL scored picks.

import { UNIVERSE, inIndex, type IndexTag } from './universe';
import { getInsiderActivity } from './insider-provider';
import { getPoliticalActivity } from './political-provider';
import { getGovContractActivity } from './govcontracts-provider';
import { detectSetups } from './technical-setups';
import { scoreCatalysts, type CatalystScore } from './catalyst-scorer';
import { getDailyBars } from './data-provider';
import type { PatentActivity } from './patent-provider';
import { mapWithConcurrency } from './full-scan-iterator';
import type { Logger } from './logger';

export type CatalystUniverseKey = IndexTag | 'all';

/**
 * Bar-fetch lookback in CALENDAR days. Wave 4C (review M4): the old 220-day
 * window yielded ~150 trading bars, permanently starving the two 200-bar
 * setups (`multi_tf_aligned`, `oversold_bounce`) — the "7-setup deck" that
 * the catalyst scorer's 0.30 setup weight assumes was silently a 5-setup
 * deck. 320 calendar days ≈ 220 trading bars restores them with headroom.
 * Cost: zero extra provider calls — getDailyBars is a single Polygon
 * aggregates request whose range param just widens (limit=5000 ≫ 220 rows).
 */
export const CATALYST_BAR_LOOKBACK_DAYS = 320;

export type CatalystPick = CatalystScore & {
  name: string;
  sector: string;
  price: number;
  priceChangePct: number;
  setupLabels: string[];
};

export interface RunCatalystScanOpts {
  universe: CatalystUniverseKey;
  /** Cap on tickers actually scored. Use Infinity for full sweep. */
  scanCap?: number;
  scanBudgetMs: number;
  concurrency?: number;
  pacingMs?: number;
  logger?: Logger;
}

export interface RunCatalystScanResult {
  picks: CatalystPick[];
  scanDurationMs: number;
  universeChecked: number;
  scanned: number;
  warnings: string[];
  budgetExceeded: boolean;
}

// Patent fetch is dataset-gated (403 on current Quiver plan) and weight=0
// in the scorer, so a stub returning empty activity matches the dead path
// without burning round-trips.
function patentStub(ticker: string): PatentActivity {
  return {
    ticker,
    companyName: '',
    lookbackDays: 180,
    totalGrants: 0,
    grantsLast30d: 0,
    grantsLast90d: 0,
    priorPeriodGrants: 0,
    velocityChangePct: 0,
    highValueGrants: 0,
    topCpcGroups: [],
    recentGrants: [],
    fetchedAt: new Date().toISOString(),
  };
}

// Universe meta entry the catalyst scan iterates over.
type CatalystUniverseEntry = { ticker: string; name: string; sector: string };

/** Resolve the ordered universe ticker list for a catalyst universe key.
 *  Stable order so a checkpoint-resume worker can slice it by index across
 *  invocations without double-scan or skip. */
export function resolveCatalystUniverse(
  universe: CatalystUniverseKey,
): CatalystUniverseEntry[] {
  return (universe === 'all' ? UNIVERSE : inIndex(universe)) as CatalystUniverseEntry[];
}

// Score a single ticker. Shared by the full single-pass scan and the
// checkpoint-resume batch worker so both produce identical picks.
// `providerNull` is true when a TRANSPORT failure on insider/political/
// contracts caused the ticker to be skipped (NOT scored neutral).
async function scoreCatalystTicker(
  t: CatalystUniverseEntry,
  from: string,
  to: string,
): Promise<{ pick: CatalystPick | null; providerNull: boolean }> {
  const ticker = t.ticker;
  const [insider, political, contracts, bars] = await Promise.all([
    getInsiderActivity(ticker, 90).catch(() => null),
    getPoliticalActivity(ticker, 180).catch(() => null),
    getGovContractActivity(ticker, 180).catch(() => null),
    getDailyBars(ticker, from, to).catch(() => [] as Awaited<ReturnType<typeof getDailyBars>>),
  ]);
  const patents = patentStub(ticker);
  if (!insider || !political || !contracts) {
    return { pick: null, providerNull: true };
  }
  if (bars.length < 60) return { pick: null, providerNull: false };

  const setups = detectSetups(bars);
  const cat = scoreCatalysts({ ticker, insider, patents, political, contracts, setups });

  const latest = bars.at(-1)!;
  const prev = bars.at(-2);
  const priceChangePct = prev ? ((latest.c - prev.c) / prev.c) * 100 : 0;

  const pick: CatalystPick = {
    ...cat,
    name: t.name,
    sector: t.sector,
    price: +latest.c.toFixed(2),
    priceChangePct: +priceChangePct.toFixed(2),
    setupLabels: setups.map((s) => s.label),
  };
  return { pick, providerNull: false };
}

// Bar-lookback window dates, computed from wall-clock. Exposed so the
// resume worker can derive the same window per batch.
export function catalystBarWindow(): { from: string; to: string } {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - CATALYST_BAR_LOOKBACK_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

export interface RunCatalystScanBatchOpts {
  universe: CatalystUniverseKey;
  startIdx: number;
  batchSize: number;
  concurrency?: number;
  pacingMs?: number;
  logger?: Logger;
}

export interface RunCatalystScanBatchResult {
  picks: CatalystPick[];
  tickersConsumed: number;
  /** TRANSPORT-failure skips this batch (insider/political/contracts null). */
  providerNullSkips: number;
  warnings: string[];
}

/** Score one contiguous slice of the universe. Stateless — the
 *  checkpoint-resume worker owns cursor/partial persistence and calls this
 *  per batch. No internal time budget: the worker's watchdog bounds the
 *  invocation. */
export async function runCatalystScanBatch(
  opts: RunCatalystScanBatchOpts,
): Promise<RunCatalystScanBatchResult> {
  const log = opts.logger;
  const all = resolveCatalystUniverse(opts.universe);
  const slice = all.slice(opts.startIdx, opts.startIdx + opts.batchSize);
  const { from, to } = catalystBarWindow();
  const warnings: string[] = [];
  const picks: CatalystPick[] = [];
  let providerNullSkips = 0;

  const byTicker = new Map(slice.map((t) => [t.ticker, t]));
  await mapWithConcurrency(
    slice.map((t) => t.ticker),
    async (ticker) => {
      const { pick, providerNull } = await scoreCatalystTicker(byTicker.get(ticker)!, from, to);
      if (providerNull) providerNullSkips += 1;
      if (pick) picks.push(pick);
      return pick;
    },
    {
      batchSize: opts.concurrency ?? 8,
      pacingMs: opts.pacingMs,
      onError: (err, ticker) => {
        log?.warn('catalyst_ticker_error', { ticker, err: String(err) });
      },
    },
  );

  return { picks, tickersConsumed: slice.length, providerNullSkips, warnings };
}

export async function runCatalystScan(
  opts: RunCatalystScanOpts,
): Promise<RunCatalystScanResult> {
  const log = opts.logger;
  const start = Date.now();
  const warnings: string[] = [];

  const all = resolveCatalystUniverse(opts.universe);
  const universeChecked = all.length;
  const cap = opts.scanCap ?? Infinity;
  const scanList = isFinite(cap) ? all.slice(0, cap) : all;

  log?.info('catalyst_scan_started', {
    universe: opts.universe,
    universeSize: universeChecked,
    scanCap: cap === Infinity ? 'Infinity' : cap,
    budgetMs: opts.scanBudgetMs,
  });

  const { from, to } = catalystBarWindow();

  let budgetExceeded = false;
  // M8 follow-through: providers now resolve null on TRANSPORT failures
  // (vs the old fake verified-empty), so a Quiver/Finnhub outage skips
  // the ticker instead of scoring it neutral. Count the skips so an
  // outage is visible in the snapshot warnings, not silent.
  let providerNullSkips = 0;
  const picks: CatalystPick[] = [];

  const byTicker = new Map(scanList.map((t) => [t.ticker, t]));
  await mapWithConcurrency(
    scanList.map((t) => t.ticker),
    async (ticker) => {
      const { pick, providerNull } = await scoreCatalystTicker(byTicker.get(ticker)!, from, to);
      if (providerNull) providerNullSkips += 1;
      if (pick) picks.push(pick);
      return pick;
    },
    {
      batchSize: opts.concurrency ?? 8,
      pacingMs: opts.pacingMs,
      shouldAbort: () => {
        if (Date.now() - start > opts.scanBudgetMs) {
          budgetExceeded = true;
          warnings.push('catalyst scan budget exceeded; results may be partial');
          return true;
        }
        return false;
      },
      onError: (err, ticker) => {
        log?.warn('catalyst_ticker_error', { ticker, err: String(err) });
      },
    },
  );

  picks.sort((a, b) => b.composite - a.composite);

  if (providerNullSkips > 0) {
    warnings.push(
      `provider data unavailable (insider/political/contracts) for ${providerNullSkips} tickers — skipped, not scored as neutral`,
    );
    log?.warn('catalyst_provider_degraded', { universe: opts.universe, providerNullSkips });
  }

  const scanDurationMs = Date.now() - start;
  log?.info('catalyst_scan_complete', {
    universe: opts.universe,
    universeChecked,
    scanned: scanList.length,
    picks: picks.length,
    scanDurationMs,
    budgetExceeded,
  });

  return {
    picks,
    scanDurationMs,
    universeChecked,
    scanned: scanList.length,
    warnings,
    budgetExceeded,
  };
}

// Helper exposed for the live endpoint: apply filter + minConviction to a
// pre-scored result list. Matches the original catalyst-board.ts logic.
export function filterCatalystPicks(
  picks: CatalystPick[],
  filter: 'cluster' | 'patents' | 'political' | 'contracts' | 'setup' | 'all',
  minConviction: 'low' | 'medium' | 'high',
): CatalystPick[] {
  const convictionRank = { low: 0, medium: 1, high: 2 } as const;
  return picks.filter((p) => {
    if (filter === 'cluster' && !p.hasClusterBuy) return false;
    if (filter === 'patents' && !p.hasPatentBurst) return false;
    if (filter === 'political' && !p.hasPoliticalTailwind) return false;
    if (filter === 'contracts' && !p.hasContractWin) return false;
    if (filter === 'setup' && !p.hasStackedSetup) return false;
    if (convictionRank[p.conviction] < convictionRank[minConviction]) return false;
    return true;
  });
}
