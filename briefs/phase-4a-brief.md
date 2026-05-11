# Phase 4a Agent Brief — Backtest Engine + Correctness (no UI)

You are the Phase 4a agent for TradeIQ. Your job is to build the historical backtest engine — the alpha math. No UI in this phase (4b handles that). Output is a CLI script that runs configurable backtests against PIT data, stores auditable result records in Firestore, and emits performance metrics + per-analyst attribution suitable for Phase 5 ML training.

This is the largest brief in the orchestrator so far. Read it twice before starting.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Live site.** `https://tradeiq-alpha.netlify.app`
**Netlify site ID.** `8e90d525-78f3-4288-9c15-8b1968e994c1`
**Currently live.** `0.12.0-alpha` (Phase 0 + 1 + 2 + 3 merged; PIT data layer + ETF-sourced universe history + 182 tests passing on main)
**Stack.** React 18 + Vite, TypeScript Netlify Functions, Tailwind, Firebase Firestore, Anthropic Opus 4.7, TanStack Query, Zod.

**Required state.**
- Phase 0–3 all show `done` in `ORCHESTRATOR.md`
- 182+ tests passing on main
- All providers have `asOfDate` parameters
- `wasInIndexOnDate` / `tickersInIndexOnDate` working in `universe-history.ts`
- `snapshotBeforeDate` / `fieldAtDate` helpers in `snapshot-store.ts`

If any precondition fails, surface to user and stop.

---

## Credentials

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
NETLIFY_TEAM_ID=69c43f638748ee6e940f5f62
```

Existing Netlify env vars (reference only — no new ones in Phase 4a):
- All from Phase 0–3 (Anthropic, Polygon, Finnhub, Quiver, FRED, Sentry, Firebase SA)

---

## Required tools

`bash_tool`, `str_replace`, `create_file`, `view`, plus Netlify deploy/read connectors and Firestore read access for verification.

---

## Read these first (in order)

1. `ORCHESTRATOR.md` — Phase 4 spec is master.
2. `docs/POINT_IN_TIME_AUDIT.md` — every data class with PIT capability + residual risks.
3. `docs/UNIVERSE_HISTORY_RUNBOOK.md` — coverage table tells you which universes are survivorship-corrected.
4. `netlify/functions/shared/analyst-runner.ts` — existing scoring entry point. The backtest reuses this.
5. `netlify/functions/shared/scan-prophet.ts`, `scan-catalyst.ts`, `scan-insider.ts`, etc. — board-specific scoring you'll invoke with `asOfDate`.
6. `netlify/functions/shared/snapshot-store.ts` — `snapshotBeforeDate` / `fieldAtDate` are your PIT-fallback path.
7. `netlify/functions/shared/data-provider.ts` — all PIT-aware fetchers. Confirm `asOfDate` parameter on each.

Don't read view files. Phase 4a doesn't touch UI.

---

## The big idea (the entire game is here)

**A backtest is dishonest if any signal at date T uses data that wasn't public at date T.** This is look-ahead bias. The most common ways it sneaks in:

1. Using today's restated fundamentals to "predict" 2023. Phase 3 fixes this provider-side.
2. Using a current-constituents universe to backtest history. Phase 3 fixes this for Dow + Russell.
3. Using a quarterly snapshot from "now" instead of "as of T." Phase 3 snapshot-store fallback fixes this.
4. **Forward-shift drift on disclosed data.** Congressional trades have a 45-day STOCK Act disclosure window — the trade happened on date X, but it was only public knowledge on X+45d. A backtest at date X that filters `ReportDate <= X` is correct PIT-wise but will hit zero matches because the report doesn't exist yet. A backtest at date X+50d using `ReportDate <= X+50d` is correct. Forward-shift requires the backtest to delay action by the disclosure lag, not just filter.
5. **In-engine clock leaks.** Code that calls `new Date()` or `Date.now()` inside scoring loops — you'll silently use today's date instead of asOfDate. Single most common Phase 4 bug. Tests must trap this.

The engine must enforce walk-forward integrity by construction. Every data fetch carries `asOfDate`. Every signal computation gets `asOfDate`. Every scoring function is pure: same inputs at same asOfDate → same output, today or in three months. Tests verify by mocking the clock and asserting no fetch escaped with a future asOfDate.

If you find yourself thinking "this should be fine, the data is from way back" — STOP and add a test that proves it. Subtle clock leaks are the most expensive bugs in backtest code, and they only surface in production when the live model loses money for reasons that don't replicate.

---

## Effective backtest window (from Phase 3 coverage)

| Universe | Survivorship-corrected? | Earliest backtest start |
|---|---|---|
| Dow | Yes (101 monthly snapshots) | 2018-01-31 |
| Russell 2000 | Yes (52 monthly snapshots) | 2022-01-31 |
| S&P 500 | **No** (current constituents only) | 2024-01-01 (with disclosed bias) |
| NDX | **No** (current seed only) | 2024-01-01 (with disclosed bias) |

Polygon plan tier doesn't reach pre-2018; hardcode `2018-01-01` as the absolute earliest start across the board.

Every backtest result stamps `universeSurvivorshipCorrected` per universe + flags whether the chosen window crosses the corrected horizon. Phase 4b UI surfaces this prominently. Phase 4a stores it on the result record.

---

## Phase 4a scope (14 workstreams)

Execute in order. Each is a discrete commit (or commit chain) on the same branch.

---

### Workstream 1 — Hot PIT cache (Firestore-backed)

**Why first.** Without this, a 4-year × 1900-Russell-ticker × 5-providers-per-month backtest hits API limits and takes days. With it, runs are minutes. Phase 3 tagged every PIT-aware function with `// PIT-cacheable: keyed by (...)` — grep for those.

**Files.**
- `netlify/functions/shared/pit-cache.ts` (new)
- Wrap calls inside each PIT function — minimal change to call sites

**Design.**

```ts
// netlify/functions/shared/pit-cache.ts
import { firestore } from './firebase-admin';

export interface PitCacheKey {
  provider: 'polygon' | 'finnhub' | 'quiver' | 'fred';
  dataClass: 'fundamentals' | 'news' | 'recommendations' | 'insider' | 'political' | 'patents' | 'contracts' | 'macro' | 'bars';
  ticker?: string;        // omitted for macro
  seriesId?: string;      // for FRED
  asOfDate: string;       // YYYY-MM-DD
  extra?: string;         // window suffixes, limit, etc. — deterministic
}

export async function pitCacheGet<T>(key: PitCacheKey): Promise<T | null>;
export async function pitCacheSet<T>(key: PitCacheKey, value: T): Promise<void>;
export async function pitCacheWrap<T>(key: PitCacheKey, fetcher: () => Promise<T>): Promise<T>;
```

**Firestore layout.** Collection `pitCache`, doc id = stable hash of the key (use Node `crypto.createHash('sha1')` over the canonical JSON of the key — sort keys before hashing for determinism). Doc body: `{ key, value, createdAt }`. No TTL — PIT data is immutable by definition; cache hits forever.

**Cost discipline.** Firestore reads are cheap but not free. Backtests read the cache thousands of times per run. Batch reads where the engine knows the keys up front (it usually does — universe × date × dataClass enumerable in advance). Use `firestore.getAll(...refs)` for prefetch.

**Cache-bypass control.** Add an env var `PIT_CACHE_BYPASS=1` for testing. When set, `pitCacheWrap` calls the fetcher every time and overwrites the cache. Useful when verifying a provider's PIT behavior changed.

**Tests.** Mock Firestore in-memory. Verify wrap calls fetcher exactly once for the same key, twice for different keys, never for keys present in cache.

---

### Workstream 2 — Walk-forward date iterator

**Files.**
- `netlify/functions/shared/backtest/walk-forward.ts` (new)
- `netlify/functions/shared/backtest/types.ts` (new — shared types for the engine)

**Pattern.**
```ts
export interface BacktestConfig {
  universe: 'dow' | 'russell2k' | 'sp500' | 'ndx';
  startDate: string;          // YYYY-MM-DD
  endDate: string;             // YYYY-MM-DD
  rebalanceFrequency: 'weekly' | 'monthly' | 'quarterly';
  // ... see W4 for full config
}

export function* walkForwardDates(config: BacktestConfig): Generator<string> {
  // Yield each rebalance date in [startDate, endDate], step by frequency.
  // Skip non-trading days using a trading calendar (need a `trading-calendar.ts`
  // helper too — US market holidays + weekends).
  // First yielded date is the first rebalance ON OR AFTER startDate.
}
```

**Trading calendar.** Add `netlify/functions/shared/backtest/trading-calendar.ts`. Hardcode US market holidays from 2018-current (NYSE published calendar — list is small and stable). Provide `isMarketOpen(date: string): boolean`. Test against known holidays (e.g., 2024-01-01 closed, 2024-01-02 open, Thanksgiving closed).

---

### Workstream 3 — Universe pool per date

**File.** `netlify/functions/shared/backtest/universe-pool.ts` (new)

**Pattern.**
```ts
export function universePoolForDate(
  universe: BacktestConfig['universe'],
  asOfDate: string,
): { tickers: string[]; survivorshipCorrected: boolean } {
  const tickers = tickersInIndexOnDate(universe, asOfDate);
  const correctedThrough = lastSnapshotDate(universe);
  return {
    tickers,
    survivorshipCorrected: asOfDate <= correctedThrough,
  };
}
```

If `tickersInIndexOnDate` returns empty (asOfDate before earliest snapshot), surface a clear error — the backtest config is asking for a date with no universe coverage. Don't silently fall back to current.

---

### Workstream 4 — Signal computation per (ticker, date)

**Files.**
- `netlify/functions/shared/backtest/score-at-date.ts` (new)

**Pattern.**
```ts
export async function scoreTickerAtDate(
  ticker: string,
  asOfDate: string,
  board: 'prophet' | 'target' | 'catalyst' | 'insider' | 'williams' | 'lynch',
): Promise<{
  composite: number;
  layers: Record<string, number>;
  metadata: Record<string, unknown>;
}>;
```

This wraps the existing `scan-prophet.ts` / `scan-catalyst.ts` / `scan-insider.ts` scorers, threading `asOfDate` through every data fetch. **Don't rewrite scoring math.** If a scorer doesn't currently accept `asOfDate`, that's a Phase 3 oversight — extend the scorer's signature and audit every internal call to use the parameter. Phase 3 already plumbed `asOfDate` through the providers; the scorers just need to pass it.

**Cache integration.** `scoreTickerAtDate` calls go through `pitCacheWrap` keyed by `(board, ticker, asOfDate)`. Composite scoring at the same date for the same ticker is deterministic, so the cache is safe and hot.

**Verify no clock leaks in scorers.** Grep for `new Date()` and `Date.now()` in all `scan-*.ts` files. Any hit that's NOT explicitly for `asOfDate` substitution is a clock leak — fix or flag.

---

### Workstream 5 — Portfolio construction

**File.** `netlify/functions/shared/backtest/portfolio.ts` (new)

**Config.**
```ts
interface PortfolioConfig {
  topN: number;                 // default 20
  weighting: 'equal' | 'composite';  // composite = weight ∝ composite score
  maxPositionPct: number;       // default 0.05 (5%)
  maxSectorPct: number;         // default 0.30 (30%)
  cashSleeve: number;           // default 0.05 (5%)
  minComposite: number;         // default 0 — drop candidates below this
}
```

**Per-rebalance flow.**
1. Score all universe tickers at this rebalance date → ranked list
2. Filter: composite ≥ `minComposite`
3. Pick top N by composite
4. Apply position-size caps + sector caps (Phase 4a uses sector from Polygon ticker reference — flagged that as not as-of in Phase 3, so use current sector with documented caveat)
5. Compute target weights
6. Hold to next rebalance

**Output per rebalance.** Array of `{ ticker, targetWeight, composite, layers }` records.

---

### Workstream 6 — Transaction costs + slippage

**File.** `netlify/functions/shared/backtest/costs.ts` (new)

**Model.**

```ts
interface CostModel {
  // Slippage in bps applied to each trade (entry + exit).
  // Realistic ranges based on liquidity tier:
  slippageBps: {
    sp500: number;       // default 5 (large caps)
    ndx: number;         // default 5
    dow: number;         // default 3 (most liquid)
    russell2k: number;   // default 20 (small caps — wider spreads)
  };
  commission: number;    // default 0 — modern broker
  // Borrow cost N/A for long-only V1.
}
```

Slippage applied on both legs. Net per-trade drag = 2 × `slippageBps`. Small-caps eating 40bps per round-trip is a real and large drag on a high-turnover strategy — make it visible in the results.

---

### Workstream 7 — Forward-shift for STOCK Act disclosure

**Why.** Phase 3 PIT-filters Quiver congressional by `ReportDate <= asOfDate`. But a trade made on `TransactionDate` is only public at `ReportDate`, which is up to 45 days later (STOCK Act maximum). A backtest acting at `asOfDate = TransactionDate` would be acting on info that wasn't public yet — even with PIT filtering.

**Fix.**

In `netlify/functions/shared/backtest/score-at-date.ts`, when reading congressional signal, do not call the political provider with `asOfDate` directly. Instead, build a "knowable as of" view: `knowableCongressTrades = trades.filter(t => t.ReportDate <= asOfDate)`. The provider already does this filter; the issue is that the scorer may also use TransactionDate as a freshness signal. Audit the political scorer to ensure no `TransactionDate` field leaks into the signal at a date when it wasn't public.

**Document.** Add a note to `docs/POINT_IN_TIME_AUDIT.md` under the political row: "Forward-shift handled in backtest by using ReportDate-only freshness; TransactionDate is information leak unless ≤ asOfDate."

---

### Workstream 8 — Engine main loop

**File.** `netlify/functions/shared/backtest/engine.ts` (new)

**Top-level function.**

```ts
export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  validateConfig(config);
  const runId = generateRunId();
  await persistRunStart(runId, config);

  let portfolio = initialPortfolio(config);
  const dailyEquity: { date: string; value: number }[] = [];
  const trades: TradeRecord[] = [];
  const perAnalystAttribution: AttributionRecord[] = [];

  for (const rebalanceDate of walkForwardDates(config)) {
    // 1. Get universe pool at this date
    const { tickers, survivorshipCorrected } = universePoolForDate(config.universe, rebalanceDate);

    // 2. Score every ticker at this date (cached)
    const scored = await Promise.all(
      tickers.map(t => scoreTickerAtDate(t, rebalanceDate, config.board)),
    );

    // 3. Build target portfolio
    const targets = buildPortfolio(scored, config.portfolioConfig);

    // 4. Compute trades (current → target), apply costs
    const tradesThisRebalance = diffPortfolios(portfolio, targets, costs);
    trades.push(...tradesThisRebalance);

    // 5. Mark equity through to next rebalance using daily bars (PIT-safe)
    const segmentEquity = await markPortfolioThrough(targets, rebalanceDate, nextRebalanceDate);
    dailyEquity.push(...segmentEquity);

    // 6. Record per-analyst attribution for this segment
    perAnalystAttribution.push(...computeAttribution(targets, scored, segmentEquity));

    portfolio = targets;
  }

  const metrics = computeMetrics(dailyEquity, trades);
  const result: BacktestResult = {
    runId,
    config,
    metrics,
    dailyEquity,
    trades,
    perAnalystAttribution,
    universeSurvivorshipCorrected: /* per-universe map */,
    completedAt: new Date().toISOString(),
  };
  await persistRunResult(runId, result);
  return result;
}
```

**Concurrency note.** `Promise.all` over 1900 Russell tickers at one rebalance date will hit Polygon free tier rate limits. Add a concurrency limiter — `p-limit` or hand-rolled, max 5 concurrent fetches. With the cache warming on subsequent rebalances, this is only painful on the first run per ticker.

**Persistence.** `runId` is `bt_<timestamp>_<random>`. Results stored in Firestore `backtestRuns/{runId}`. Daily equity + trades stored as subcollections to keep doc sizes bounded.

---

### Workstream 9 — Performance metrics

**File.** `netlify/functions/shared/backtest/metrics.ts` (new)

**Required.**
- Total return (%)
- CAGR (annualized)
- Sharpe ratio (252-day, risk-free = 3-month T-bill yield from FRED `DGS3MO`, vintage'd at run-time = asOfDate of computation, but since this is computed end-of-backtest it's the final-date vintage)
- Sortino ratio (downside-only deviation)
- Max drawdown (%)
- Recovery time (days from trough to new high)
- Win rate (% of closed trades positive)
- Average win / Average loss / Profit factor
- Information coefficient — Spearman rank correlation of `composite` to forward 20d return, averaged over rebalances
- Information ratio (excess return over benchmark / tracking error). Benchmark = SPY for SP500-relative; IWM for Russell-relative; DIA for Dow-relative
- Per-regime breakdown — group rebalances by regime label at that date, report metrics per regime

**Tests.** Hand-construct a tiny synthetic equity curve with known answers and verify each metric against analytical truth.

---

### Workstream 10 — ML hooks for Phase 5

**Why now, not Phase 5.** Phase 5 ML training needs per-trade signal vectors + forward returns. If Phase 4a doesn't capture them, Phase 5 needs a re-run of every backtest. Capturing the right shape now saves multiple sessions later.

**Files.**
- Extension to `BacktestResult` type in `netlify/functions/shared/backtest/types.ts`
- Storage in `engine.ts` `persistRunResult`

**Schema.**

```ts
interface MLTrainingRow {
  runId: string;
  ticker: string;
  asOfDate: string;
  composite: number;
  layers: Record<string, number>;        // per-analyst scores at the entry decision
  regime: string;
  sector: string;
  marketCapBucket: 'small' | 'mid' | 'large';
  entryPrice: number;
  exitPrice: number | null;              // null if still open at backtest end
  holdDays: number | null;
  forward5dReturn: number | null;
  forward20dReturn: number | null;
  forward60dReturn: number | null;
  forward252dReturn: number | null;
  realizedPnl: number | null;
}
```

Stored in Firestore subcollection `backtestRuns/{runId}/mlTraining/`. Phase 5 reads from there.

**Don't BUILD ML in Phase 4a.** Just preserve the data shape.

---

### Workstream 11 — Walk-forward integrity tests (the most important tests in the codebase)

**File.** `netlify/functions/shared/backtest/__tests__/walk-forward-integrity.test.ts` (new)

**Tests.**

1. **No future fetches.** Mock the providers. Run a backtest from `2023-01-01` to `2023-06-30`. Assert every provider call's `asOfDate` is ≤ the rebalance date that triggered it. Fail loudly if any future date was passed.

2. **Deterministic results.** Run the same backtest config twice. Hash the result. Should be identical. (PIT data is immutable; same config → same result, forever.)

3. **Clock-injection test.** Override the engine's notion of "now" to a past date. Run a backtest ending at that past date. Run it again with real `now`. Same result. (Catches `Date.now()` leaks.)

4. **Universe membership test.** For a known historical pick (e.g., a 2019 Dow stock the engine picked), verify `wasInIndexOnDate` returns true for the asOfDate it was picked.

5. **STOCK Act forward-shift test.** Construct a synthetic congressional trade with `TransactionDate=2023-01-01`, `ReportDate=2023-02-10` (40 days later). Run the political scorer at `asOfDate=2023-02-01`. Assert the trade is NOT in the scorer's input (ReportDate > asOfDate). At `asOfDate=2023-02-15`, assert it IS in the input.

6. **Survivorship correction stamped.** Run a backtest on SP500 from 2023-01-01 (current-seed only). Assert result has `universeSurvivorshipCorrected.sp500 === false`. Same backtest on Dow → `true`.

**These tests are mandatory and gate the PR.** A walk-forward integrity test failing means the engine is silently producing dishonest backtest results. Treat as P0.

---

### Workstream 12 — CLI script for manual triggering

**File.** `scripts/run-backtest.ts` (new)

**Usage.**
```bash
npx tsx scripts/run-backtest.ts --config configs/default.json
npx tsx scripts/run-backtest.ts \
  --universe dow \
  --start 2018-01-01 \
  --end 2024-12-31 \
  --rebalance monthly \
  --top-n 10 \
  --board prophet
```

Loads a config (from JSON file or CLI flags), runs `runBacktest`, prints summary metrics to stdout, writes full result to Firestore. Returns the `runId` so the user can reference it later in Phase 4b UI.

Add a few sample configs in `configs/`:
- `dow-2018-2024-monthly-top20.json`
- `russell2k-2022-2024-weekly-top30.json`
- `sp500-2024-monthly-top20-uncorrected.json` (explicitly named to flag the survivorship caveat)

---

### Workstream 13 — Honest limitations doc

**File.** `docs/BACKTEST_LIMITATIONS.md` (new)

Single page. Sections:
- Polygon plan tier hardcoded earliest = 2018-01-01
- SP500 + NDX universes are current-seed only (no historical constituent data); backtest results on these are survivorship-biased — surface this in every result, refuse to proceed silently
- Polygon ticker reference returns current `sector` + `marketCap`, not as-of — Phase 4a uses current sector with documented caveat (small impact since sectors change rarely)
- Polygon fundamentals restatement drift remains residual (Phase 3 noted)
- Quiver congressional STOCK Act 45-day forward-shift handled
- Finnhub recommendation history limited to Phase 1 snapshot accumulation depth (deeper history not available)
- Transaction costs are modeled, not measured — actual fills will differ
- Daily bars only (no intraday) — backtest assumes execution at next day's open for trade triggered at close T

---

### Workstream 14 — APP_VERSION + ORCHESTRATOR + PR

Bump `APP_VERSION` to `0.13.0-alpha`. Update ORCHESTRATOR.md Phase 4 row:

```
| 4 | Real backtest v2 (engine + correctness) | done | 0.13.0-alpha | YYYY-MM-DD | Walk-forward engine; hot PIT cache; portfolio + costs + slippage; per-analyst attribution; ML hook data for Phase 5; walk-forward integrity tests; Dow + Russell fully backtest-able with survivorship correction. UI in Phase 4b. |
```

Note: this completes 4a only. Phase 4b (UI) is a separate row to be added or the existing Phase 4 row gets split. Recommend: add a row "4b | Backtest UI (BacktestView wired to engine) | pending | ..." to make the split explicit in the orchestrator.

---

## Standing rules (apply to every commit)

- ALWAYS bump `APP_VERSION` only at the W14 final commit. Workstreams 1–13 don't bump (no live deploy until the engine is complete).
- Critical data ingest preserves four layers — DO NOT collapse provider responses to "just the fields backtest uses." Phase 5 ML will want raw signals.
- Brand blue `#1e5b92` (Davis Delivery family — TradeIQ stays neutral dark).
- CI must stay green throughout. Push per workstream so CI runs incrementally.
- **Anti-clock-leak discipline.** Every `new Date()` / `Date.now()` in scoring code is suspect. The brief tests in W11 catch them but the discipline starts at write-time.
- **No backtest result without `universeSurvivorshipCorrected` stamp.** Every result record must carry this. UI consumers (Phase 4b) will rely on it to gate honest disclosure.

---

## Working tree setup

```bash
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b phase-4a-backtest-engine
npm ci --silent
```

---

## Commit + PR protocol

Granular commits per workstream:

- `phase-4a(cache): Firestore-backed PIT hot cache + wrap pattern`
- `phase-4a(walk-forward): trading calendar + walk-forward date iterator`
- `phase-4a(universe): universe pool per date with survivorship flag`
- `phase-4a(scorer): asOfDate-aware scoreTickerAtDate wrapping existing scan-*`
- `phase-4a(scorers): clock-leak audit + asOfDate plumbing in scan-prophet/catalyst/insider`
- `phase-4a(portfolio): top-N selection + sizing + sector/position caps`
- `phase-4a(costs): slippage model with per-universe defaults`
- `phase-4a(stockact): forward-shift for Quiver congressional ReportDate`
- `phase-4a(engine): main backtest loop + persistence`
- `phase-4a(metrics): Sharpe/Sortino/MaxDD/IC/IR + per-regime breakdown`
- `phase-4a(ml-hooks): MLTrainingRow schema + Firestore subcollection persistence`
- `phase-4a(tests): walk-forward integrity tests (P0)`
- `phase-4a(cli): scripts/run-backtest.ts + sample configs`
- `phase-4a(docs): BACKTEST_LIMITATIONS.md + audit-doc updates`
- `phase-4a(version): bump 0.13.0-alpha + ORCHESTRATOR row update + PR description`

PR title: `Phase 4a: Backtest engine + correctness (v0.13.0-alpha)`

PR description in `briefs/phase-4a-pr-description.md` must include:
- Phase 0–3 dependency confirmation
- Each workstream's outcome
- Test count before/after (target: ≥ 200 total, ≥ 18 new)
- Walk-forward integrity test count (target: ≥ 6, all P0)
- Sample backtest results from running `scripts/run-backtest.ts` on a Dow 2018-2024 monthly config (Sharpe, max DD, IC) — sanity check
- Known residual limitations (the BACKTEST_LIMITATIONS.md content summarized)
- Bundle size unchanged (Phase 4a is server-side; no frontend deltas)

---

## Status table update (do last)

After deploy verifies clean, edit `ORCHESTRATOR.md`:
- Phase 4 row → split into 4a (done) + 4b (pending)
- Total estimate sessions: bump if scope expanded

---

## Success criteria (testable definition of done)

- [ ] `pit-cache.ts` wraps every PIT-aware data fetcher; cache hits prevent vendor calls (verified by test)
- [ ] `walkForwardDates` iterates only trading days, respects rebalance frequency
- [ ] `tickersInIndexOnDate` used for universe pool with survivorship flag
- [ ] `scoreTickerAtDate(ticker, asOfDate, board)` returns same composite for same inputs across runs (deterministic)
- [ ] Portfolio honors topN + position cap + sector cap + cash sleeve
- [ ] Costs: slippage applied to both legs of every trade
- [ ] STOCK Act forward-shift handled (test passes)
- [ ] Engine writes auditable run records to Firestore `backtestRuns/{runId}` with daily equity + trades subcollections
- [ ] Metrics: Sharpe, Sortino, max DD, win rate, profit factor, IC, IR, per-regime
- [ ] ML training rows persisted to `backtestRuns/{runId}/mlTraining/` with all schema fields
- [ ] Walk-forward integrity tests (≥ 6, all green) gate the PR
- [ ] CLI `npx tsx scripts/run-backtest.ts --universe dow --start 2018-01-01 --end 2024-12-31 --rebalance monthly --top-n 20` completes successfully
- [ ] `npm test` ≥ 200 tests, all green
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` clean (frontend untouched)
- [ ] `APP_VERSION = 0.13.0-alpha`, verified live
- [ ] ORCHESTRATOR.md split Phase 4 → 4a (done) + 4b (pending)

---

## What to do if blocked

- **An existing scorer (e.g., `scan-prophet.ts`) doesn't accept `asOfDate`.** Phase 3 plumbed `asOfDate` through providers but may not have threaded it through every scorer. Audit. If a scorer needs the parameter added, do it — that's in scope. If the scoring math itself needs to change (not just propagation), STOP and surface to user; that's Phase 5 territory.
- **A backtest on Dow 2018-2024 takes longer than 30 minutes.** First run will be slow (cold cache). Subsequent runs should be minutes. If first run is taking hours, profile — most likely a missing cache wrap or concurrency limit not in place.
- **Walk-forward integrity test fails.** Treat as P0. Do not push. Fix the clock leak or PIT bypass it found.
- **Polygon hits rate limit during a backtest run.** Lower concurrency limit. Implement exponential backoff in `pitCacheWrap` on the fetcher path. Cache hits keep subsequent runs fast.
- **A metric value looks suspicious** (e.g., Sharpe > 3 on Dow 2018-2024 — too good to be true). Audit. Almost certainly a look-ahead leak. Common sources: a scorer reading "current price" instead of asOfDate price, attribution computed using forward returns, regime label leaking future state.
- **Firestore write quota.** Backtest runs produce a lot of trade + equity records. If you hit write quota, batch with `firestore.batch()` (500 writes per batch max). Worst case, store equity as a single JSON blob on the run doc instead of subcollection.

---

## Out of scope for Phase 4a

- **UI.** That's Phase 4b. Phase 4a's output is JSON + Firestore. No new view files. No frontend deltas.
- **ML.** No model training, no inference, no calibration. Just preserve the data shape Phase 5 will consume.
- **Live trading.** No order routing, no broker integration, no real-money paths.
- **Options backtest.** Separate phase later.
- **Short side.** Long-only V1.
- **Calibration / weight tuning.** Phase 5.
- **Backtest of the meta-ranker.** Phase 5 builds the meta-ranker; Phase 5 backtests it.
- **Frontend bundle changes.** None expected.

If you find yourself reaching into Phase 4b or 5+, stop and note in PR description.

---

## First actions

```bash
# 1. Working tree
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b phase-4a-backtest-engine
npm ci --silent

# 2. Confirm preconditions
grep "^| 0\|^| 1\|^| 2\|^| 3 " ORCHESTRATOR.md
ls .github/workflows/
npm test 2>&1 | tail -3

# 3. Survey scoring infrastructure
grep -n "asOfDate" netlify/functions/shared/scan-*.ts | head -20
grep -n "new Date()\|Date.now()" netlify/functions/shared/scan-*.ts netlify/functions/shared/*-scorer.ts | head -20

# 4. Find PIT-cacheable tags from Phase 3
grep -rn "PIT-cacheable" netlify/functions/shared/ | head
```

Then proceed: W1 (cache) → W2 (walk-forward) → W3 (universe pool) → W4 (scoring) → W5 (portfolio) → W6 (costs) → W7 (STOCK Act) → W8 (engine main) → W9 (metrics) → W10 (ML hooks) → W11 (integrity tests — P0) → W12 (CLI) → W13 (docs) → W14 (version + status).

---

End of brief. Begin work.
