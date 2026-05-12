# Phase 4b-1: Backtest run viewer UI (v0.14.0-alpha)

Read-only UI for Phase 4a's auditable backtest run records. The engine
writes runs to `backtestRuns/{runId}` with subcollections
(`dailyEquity`, `trades`, `attribution`, `mlTraining`); until this PR,
those records were only visible by hand-querying Firestore with admin
credentials. Now they're on the phone in 10 seconds.

Launcher (UI form to kick off new runs) is deferred to Phase 4b-2 —
background-function architecture warrants separate scoping. CLI launch
(`npx tsx scripts/run-backtest.ts`) remains the only path; the viewer
linklets that fact in a banner at the top.

## Phase 4a dependency confirmation

- Phase 4a (engine + correctness) — `done` @ 0.13.0-alpha (PR #7)
- Phase 4a-fix-1 (cache undef + silent catch) — `done` @ 0.13.1-alpha (PR #8)
- Phase 4a-fix-2 (ML row bar window) — `done` @ 0.13.3-alpha (PR #9)
- Phase 4a-fix-3 (ProphetDetail useEffect ReferenceError) — `done` @ 0.13.2-alpha (PR #10)
- Seed-snapshots hotfix series — landed (PRs #11–#14)

Baseline before this PR: 290 tests passing on `main` at `df8671d`.
After: **331 passing (+41 new)**, `npx tsc --noEmit` clean, build clean.

## The three things this view does (per brief priorities)

**1. Survivorship-bias status is impossible to miss.** `SurvivorshipBanner`
renders at the top of every run-detail view when (and only when)
`run.universeSurvivorshipCorrected.corrected === false`. Red border, red
fill, ⚠ icon, language that doesn't soft-pedal ("results favor surviving
stocks and overstate alpha — treat with extreme caution"), and a link to
`docs/BACKTEST_LIMITATIONS.md` as deliberate friction. The run-list rows
ALSO show an inline ⚠ next to the runId for uncorrected runs so the user
can flag them without opening detail first.

**2. Equity + drawdown trajectory.** Recharts `LineChart` (equity) +
`AreaChart` (drawdown) wrapped in `ResponsiveContainer`. Auto-overlays
`benchmarkValue` when present in `dailyEquity` rows. Stride-downsamples
above 5000 points; 1741-point Dow runs render fine un-downsampled.

**3. Per-analyst attribution.** Bar chart bucketed by which layer scored
highest at entry. Methodology stated in the chart's subtitle ("Phase 5
will refine"). Lets Chad eyeball which weights look miscalibrated before
Phase 5's calibration loop starts.

## Workstreams

### W1 — Backtest-runs HTTP endpoints

`netlify/functions/backtest-runs-list.ts` and `backtest-runs-get.ts`.

- `GET /api/backtest-runs?limit=N` — recent runs sorted by `completedAt`
  desc with truncated top-level metrics + the survivorship stamp +
  benchmark + warnings. Full subcollections live on the detail endpoint.
  Limit clamped 1..50 via zod.
- `GET /api/backtest-runs/:runId` — full top-level doc + `dailyEquity`
  (ordered by date asc, unbounded), `trades` (ordered by rebalanceDate
  asc, capped at 500), `attribution` (full), `mlTrainingCount` (count
  only — Phase 5 fuel, not 4b UI fuel). 404 on missing run, 400 on
  missing runId. Handles both the direct-function URL form and the
  Netlify `:runId` redirect query-param convention.

Pattern matches existing functions (`Handler` type, `createLogger`,
plain try/catch, JSON Content-Type headers) rather than the
`withSentry` wrapper the brief's sample showed — no function in this
repo actually uses `withSentry`; the structured logger already forwards
errors to Sentry. **10 endpoint tests** using a mocked firebase-admin
module.

### W2 — React Query hooks

- `useBacktestRuns(limit)` — staleTime 30s so a freshly-CLI'd run shows
  up within half a minute.
- `useBacktestRun(runId)` — `enabled: !!runId`, `staleTime: Infinity`
  because historical runs are immutable. Switching between selected
  runs in the list is instantaneous after first fetch.
- `queryKeys`: added `backtestRuns(limit)` + `backtestRun(runId)`. Kept
  the legacy `backtest` key untouched.

Both hooks defend against HTML 500 pages by content-type-checking
before parsing. **8 hook tests** covering happy path, URL
construction, empty payload, 500/404 error surfacing, and the enabled
gate.

### W3 — BacktestView rewrite

Mobile-first single-column layout:

- Header (BACKTEST · Phase 4a · read-only)
- Launcher placeholder (Phase 4b-2 note + CLI command + prophet-only
  constraint, with link to BACKTEST_LIMITATIONS.md)
- Recent Runs grid (1-col mobile, 2-col sm+):
  - Each row: runId, universe/board/freq, relative completedAt, return %,
    Sharpe, trade count
  - Inline ⚠ on uncorrected runs
  - Clickable; selecting drills into Run Detail
- Run Detail (default-selects most recent; user pick wins after):
  - SurvivorshipBanner at the very top
  - Run identity strip
  - RunMetricsTiles
  - EquityCurveChart + DrawdownChart stacked
  - AttributionChart
  - RegimeBreakdownTable + TopTradesTable stacked
  - Warnings panel at the bottom when warnings[] is non-empty

State edge cases: selectedRunId resets to first available run if the
user's pick vanishes from a paginated refetch.

### W4 — Run-detail subcomponents

All in `src/components/`:

- `SurvivorshipBanner` — see "three things" above
- `KpiCard`, `ChartPanel` — extracted from the legacy BacktestView so
  they survive the rewrite
- `RunMetricsTiles` — 2-col mobile / 4-col sm+ grid; engine writes Pct
  fields pre-multiplied by 100 (see `metrics.ts:198`) so client just
  `toFixed`-formats; null/non-finite values collapse to em-dash with
  neutral color
- `EquityCurveChart` — Recharts `LineChart` at 250px; auto-overlays
  `benchmarkValue` when present; stride-downsamples >5000 points
- `DrawdownChart` — `AreaChart` computing underwater % client-side
  (engine doesn't write `drawdownPct`); min matches `maxDrawdownPct`
- `AttributionChart` — per-analyst `BarChart`; for each attribution
  row, attribute its contribution to the layer with highest score at
  entry; sum per analyst; sort desc by contribution. Subtitle states
  "Phase 5 will refine" because the bucketing is deliberately simple
- `RegimeBreakdownTable` — flattens `metrics.perRegime`; sortable via
  `useSortable` + `SortableTh` per standing rule
- `TopTradesTable` — ranked by `|contribution|` from `attribution` (the
  `TradeRecord` shape doesn't carry paired entry/exit prices; attribution's
  `segmentReturn` is the closest the engine writes to a trade outcome).
  Sortable per standing rule.

### W5 — Prophet-only constraint placeholder note

Folded into W3's `LauncherPlaceholder` component. Pure documentation;
no code logic needed for an option that doesn't exist yet. Link to
BACKTEST_LIMITATIONS.md for the long-form caveats.

### W6 — Tests

41 new tests across 4 files:

- `netlify/functions/__tests__/backtest-runs.test.ts` (10): list sort,
  limit clamping, survivorship stamp passthrough, get path-form +
  query-param form, 404, 400, full subcollection unwrap
- `src/hooks/__tests__/useBacktestRuns.test.jsx` (8): happy paths,
  limit param, empty payload, 500/404 error surfacing, enabled gate,
  URL encoding
- `src/__tests__/SurvivorshipBanner.test.jsx` (7): renders/doesn't-render
  matrix across all four stamp states, uppercases universe label, link
  href + target + rel safety attrs
- `src/__tests__/RunMetricsTiles.test.jsx` (10): all 8 labels render,
  Pct fields NOT re-multiplied by 100, null fields → em-dash, missing
  metrics object renders 8 em-dashes, positive→emerald, negative→rose,
  Max DD always rose, benchmark tile conditional
- `src/__tests__/AttributionChart.test.jsx` (6): aggregation
  attributes to top layer, sorts desc, skips empty/non-finite rows,
  handles the real Phase 4a layer set from `bt_20260511155722_eg0gv5`

Brief targeted +15 new tests, suite ≥295. Actual: +41 new, suite **331
passing** (vs 290 baseline).

### W7 — Version + ORCHESTRATOR + PR

- `APP_VERSION` → `0.14.0-alpha`
- ORCHESTRATOR row 4b split into 4b-1 (`done` @ 0.14.0-alpha) + 4b-2
  (`pending` — launcher)

## Decision: replaced BacktestView (option A from the brief)

The legacy `BacktestView.jsx` talked to `/api/backtest` (a Phase 2
engine-test endpoint with a ticker list + lookback). That's NOT the
Phase 4a engine. Brief suggested "the old useBacktest hook stays for
EngineTestView" — but **that turned out to be wrong**: `EngineTestView`
actually uses `useEngineTest` (separate hook against
`/api/engine-test`). So `useBacktest.js` + `netlify/functions/backtest.ts`
are now orphaned with zero consumers. Left in tree as dead code to
keep this PR scoped to Phase 4b; removal is a separate housekeeping pass.

## Caveat on screenshots

The only runs in `backtestRuns` at PR time are three Dow runs (all
`corrected: true`). So the SurvivorshipBanner can't be visually
demonstrated against live data — it's verified via tests (7 cases) and
will activate the first time an SP500 or NDX backtest runs through the
CLI. If you want a live screenshot of the banner before merge, kick
off:

```bash
npx tsx scripts/run-backtest.ts --config configs/sp500-2020-2023-monthly-top20.json
```

(or similar) and the next viewer load will render it.

## Bundle

- Before: ~245 kB gzipped
- After: **256 kB gzipped** (+11 kB for the new components — Recharts
  was already in the bundle)
- Budget: 820 kB ✓

## Test count

- Baseline on `main` at `df8671d`: 290 passing
- After this PR: **331 passing** (+41)
- `npx tsc --noEmit`: clean
- `npm run build`: clean

## Success criteria from the brief

- [x] `/api/backtest-runs` returns sorted runs
- [x] `/api/backtest-runs/:runId` returns run + subcollections, 404 on missing
- [x] `useBacktestRuns` + `useBacktestRun` hooks work with TanStack Query
- [x] BacktestView shows run list + selected run detail in a mobile-friendly single column
- [x] SurvivorshipBanner renders for non-corrected universes (verified via tests; live screenshot pending an SP500 run)
- [x] Equity curve, drawdown, attribution, regime, top trades all render with real data
- [x] All tables use `useSortable` + `SortableTh`
- [x] Empty state guides user to CLI launch when no runs exist
- [x] `npm test` ≥ 295 tests, all green (331)
- [x] `npx tsc --noEmit` clean
- [x] `npm run build` clean
- [x] Bundle ≤ 820 kB gzipped (256 kB)
- [x] `APP_VERSION = 0.14.0-alpha`
- [x] ORCHESTRATOR Phase 4 split into 4b-1 (done) + 4b-2 (pending)

## Out of scope (deferred)

- Phase 4b-2: run launcher (UI form, background function, status polling)
- Phase 5: ML calibration loop
- Multi-run comparison view
- CSV export
- Pagination beyond limit=50
- Removal of orphaned `useBacktest` + `/api/backtest` + their tests
