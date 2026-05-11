# Phase 4a: Backtest engine + correctness (v0.13.0-alpha)

Walk-forward backtest engine for TradeIQ. PIT-correct by construction;
the alpha math, not the UI. Phase 4b will wire BacktestView to this
engine.

## Phase 0–3 dependency confirmation

- Phase 0 (Engineering foundation + safety nets) — `done` @ 0.10.0-alpha
- Phase 1 (Universe coverage + snapshot infrastructure) — `done` @ 0.9.1-alpha
- Phase 2 (Refactor foundation) — `done` @ 0.11.0-alpha
- Phase 3 (Point-in-time data layer) — `done` @ 0.12.0-alpha

Baseline before this PR: 182 tests passing on `main`. After: **279 passing
(+97 new)**, `npx tsc --noEmit` clean, frontend bundle unchanged.

## Workstreams (all 14 delivered as discrete commits)

### W1 — Firestore-backed PIT hot cache

`netlify/functions/shared/pit-cache.ts`. Single Firestore collection
`pitCache` keyed by stable sha1 of `(provider, dataClass, ticker?,
seriesId?, asOfDate, extra?)`. `pitCacheWrap()` is the common idiom.
`pitCacheGetMany()` for batched prefetch via `getAll(...refs)`.
`PIT_CACHE_BYPASS=1` env forces re-fetch for provider verification.
Distinguishes cache-miss from cached-null via internal sentinel — null
is a legitimate PIT answer (e.g. "no insider activity in window") and
must survive the round-trip. **12 tests.**

### W2 — Trading calendar + walk-forward iterator

`backtest/trading-calendar.ts` hardcodes NYSE full-closure holidays
2018-2027 including Juneteenth (first observed 2022-06-20), the 2025
National Day of Mourning for Carter, and all weekend/holiday observed
dates. `walk-forward.ts` generator yields trading-day rebalance dates
at weekly / monthly / quarterly cadence, snapping non-trading dates
forward. `types.ts` is the single source of truth for engine types
(BacktestConfig, ScoredCandidate, PortfolioPosition, TradeRecord,
DailyEquityPoint, AttributionRecord, MLTrainingRow, PerformanceMetrics,
BacktestResult). **31 tests.**

### W3 — Universe pool per date

`backtest/universe-pool.ts`. `universePoolForDate` returns tickers and
the `survivorshipCorrected` flag. Strict: refuses to silently substitute
"current" when no PIT snapshot covers the date — returns empty + flag
false, and the engine surfaces a warning. `windowSurvivorshipCorrected`
aggregates over a full rebalance schedule. **10 tests.**

### W4 — Score-at-date wrapper

`backtest/score-at-date.ts`. `scoreTickerAtDate(ticker, asOfDate, board,
ctx)` reuses the pure scoring math (`layer*`, `composeProphet`,
`scoreInsider/Political/Contracts/Patents`) from the live scan modules
but threads `asOfDate` through every data fetch via the providers'
PIT-aware paths. Shared market context (SPY + sector ETFs + regime)
built once per rebalance via `buildMarketContextAtDate(asOfDate)` — saves
1000+ duplicate fetches per scan. Every fetch wrapped in `pitCacheWrap`.

Plumbing changes to enable PIT scoring:
- `earnings-intel.getEarningsIntel` — `opts.asOfDate` threaded;
  `Date.now()` replaced with asOfDate-derived `nowMs` in
  `daysUntilEarnings` + PEAD calculations (**2 real clock leaks fixed**).
- `data-provider.getUpcomingEarnings` — `opts.asOfDate`; window computed
  from asOfDate. Post-filter for safety.
- `data-provider.getEarningsHistory` — `opts.asOfDate` post-filters
  reports with `period > asOfDate`. Fetches 4× limit to absorb filter
  losses.
- `regime.computeRegime` — `opts.asOfDate` threaded through to
  `getMacroData` (Phase 3 already PIT via FRED vintage_dates).
- `scan-prophet` — sub-scorers `scoreInsider/Political/Contracts/Patents`
  exported so backtest reuses the same math.

Live scan paths unchanged (default `asOfDate=undefined` falls through to
legacy code path). V1 supports prophet board only — others return null
and emit a warning per the brief.

### W5 — Portfolio construction

`backtest/portfolio.ts`. `buildPortfolio` pipeline: filter by
`minComposite` → top-N by composite (alpha tiebreak) → raw weights (equal
or composite-proportional) → iterative position cap with overflow
redistribution → sector cap by dropping lowest-composite in over-cap
sector → scale to `(1 - cashSleeve)` but capped at `topN ×
maxPositionPct` (residual becomes implicit cash when caps can't fill the
budget). `diffPortfolios` produces prev → next trades. **9 tests.**

### W6 — Costs / slippage

`backtest/costs.ts`. Per-leg basis-point slippage with per-universe
defaults: dow=3, sp500/ndx=5, russell2k=20. Modern broker commission
default = 0. Round-trip drag on Russell positions runs ~40bps which is
real and meaningful. **6 tests.**

### W7 — STOCK Act forward-shift

`backtest/stock-act-shift.ts`. `STOCK_ACT_LAG_DAYS = 45` +
`shiftedPoliticalAsOfDate()` + `getPoliticalActivityForBacktest()`
wrapper. Score-at-date routes political fetches through this. Trade
dated 2023-01-01 first appears in scorer's input at `asOfDate >=
2023-02-15`. Audit doc updated to mark STOCK Act residual resolved.
**6 tests** including brief's exact synthetic-trade scenario.

### W8 — Engine main loop

`backtest/engine.ts` + `backtest/persistence.ts`. `runBacktest(config,
options)` per-rebalance:
1. Resolve PIT universe pool
2. Build shared market context
3. Concurrency-limited per-ticker scoring (default 5; Polygon plan-tier safe)
4. Build target portfolio
5. Diff with prev, apply costs (cost drag paid from NAV upfront)
6. Mark equity daily through next rebalance using daily bars
7. Capture per-position attribution + ML training rows

asOfDate is the ONLY source of "now"; engine never calls
`new Date()`/`Date.now()` for window math. Validates `startDate >=
2018-01-01` (Polygon plan floor). Firestore writes to
`backtestRuns/{runId}` with `dailyEquity/trades/attribution/mlTraining`
subcollections; batched 500/commit. `options.noPersist` bypasses for
integrity tests + dry runs.

### W9 — Performance metrics

`backtest/metrics.ts`. Total return / CAGR / Sharpe (252-day, optional
risk-free) / Sortino / max DD / recovery days / win rate / avg win &
loss / profit factor / IC (mean Spearman of composite vs forward 20d
return per rebalance) / IR vs benchmark (DIA/SPY/QQQ/IWM per universe)
/ per-regime breakdown. Pure `spearman()` with tie-handling via average
rank. **12 tests** on synthetic curves (V-shaped DD, never-recover,
perfect-IC, win/loss accounting).

### W10 — ML training row persistence

`MLTrainingRow` schema stamped per-position-per-rebalance: composite +
layers + regime + sector at decision time, forward 5d/20d/60d/252d
returns. Persisted to `backtestRuns/{runId}/mlTraining/`. Phase 5 ML
reads from there; no re-running needed. `marketCapBucket=null` in 4a
(FundamentalsSnapshot doesn't expose marketCap; Phase 11 will add).

### W11 — Walk-forward integrity tests (P0)

`backtest/__tests__/walk-forward-integrity.test.ts`. **11 tests, all
green, all P0.** Mandatory green for merge.

1. `walkForwardDates` never yields beyond `endDate`
2. Every rebalance date is a trading day
3. `walkForwardArray` deterministic across runs
4. Varying real wall-clock via `Date.now` mock doesn't change a backtest
   ending in the past
5. `wasInIndexOnDate('AAPL', 'dow', '2020-06-30') === true`
6. Every ticker in `pool[date]` is in `index[date]`
7. STOCK Act shift hides synthetic trade until disclosure window
   (brief's exact scenario)
8. `STOCK_ACT_LAG_DAYS === 45`
9. Dow corrected window → `corrected: true`
10. SP500 (current-seed) → `corrected: false`
11. Static audit: no backtest source contains the smoking-gun
    window-derivation patterns `new Date().toISOString().slice(0,10)`
    or `Date.now()`. Allowed: timestamp-recording uses of `toISOString()`
    in run metadata.

### W12 — CLI script + sample configs

`scripts/run-backtest.ts`. Loads `--config <json>` or builds from flags;
runs `runBacktest`; prints summary; returns `runId`. Progress printed
inline as `Rebalance YYYY-MM-DD (N/M, P%)`. Configs in `configs/`:
- `dow-2018-2024-monthly-top20.json`
- `russell2k-2022-2024-weekly-top30.json`
- `sp500-2024-monthly-top20-uncorrected.json` (filename + `_caveat`
  field flag survivorship bias).

### W13 — Honest limitations doc

`docs/BACKTEST_LIMITATIONS.md`. 14 sections enumerating every residual
limitation — Polygon plan floor, current-seed universes, sector/cap
drift, restatement drift, STOCK Act (resolved), recommendation depth,
modeled-not-measured costs, daily-bar execution, long-only, single
board, no meta-ranker yet, no options/futures/FX, immutable-PIT cache
assumption, slow first run. If a backtest result conflicts with reality
the first hypothesis should be that one of these is biting.

### W14 — Version + ORCHESTRATOR + this PR

`APP_VERSION = '0.13.0-alpha'`. ORCHESTRATOR phase 4 row split into 4a
(done @ 0.13.0-alpha) + 4b (pending). This PR description.

## Test count

- Before: 182 (Phase 3 baseline)
- After: **279** (+97 new)
- Walk-forward integrity tests (P0): **11**, all green
- `npx tsc --noEmit` clean
- `npm run build` clean (frontend untouched in Phase 4a)
- Bundle size unchanged

## Sample backtest output

Phase 4a delivers the engine. A live backtest run against real Polygon
data would require provider keys at execute time and would consume real
API budget priming the cold cache — recommend running the flagship
config (`dow-2018-2024-monthly-top20.json`) overnight after merge as
the canonical smoke test for sanity-checking Sharpe / max DD / IC.

## Known residual limitations (summary from BACKTEST_LIMITATIONS.md)

- Polygon plan tier earliest reach: 2018-01-01 (hard floor)
- SP500/NDX universes: current-seed only — survivorship biased; result
  records carry the `corrected: false` flag and the engine emits a
  warning. Phase 4b UI must gate on this.
- Polygon ticker reference (sector/marketCap) is current, not as-of
- Polygon fundamentals restatement drift (Phase 3 residual)
- Quiver congressional STOCK Act 45-day shift — **handled** in 4a
- Finnhub recommendation history limited to Phase 1 snapshot depth
- Costs modeled (flat bps per leg), not measured
- Daily bars only — no intraday execution simulation
- Long-only V1; no shorts, no borrow modeling
- Prophet board only — other boards return null + warning
- No ML / meta-ranker (data shape preserved for Phase 5)
