# Phase 4b-1: Backtest run viewer UI (v0.14.0-alpha)

Read-only viewer for Phase 4a's backtest engine runs. Picks up the
`backtestRuns/{runId}` Firestore docs the engine writes and renders
them — equity curve, drawdown, per-analyst attribution, regime
breakdown, top trades — with a non-dismissible survivorship-bias
warning when the universe was NOT corrected. Run launcher is deferred
to Phase 4b-2.

## Dependencies (preconditions confirmed before merge)

- Phase 4a engine + smoke test merged ✓ (PR #9, #10 — backtestRuns
  collection populating with the smoke-test fixture
  `bt_20260511155722_eg0gv5`)
- Scheduled-function deployment hotfix merged ✓ (PR #12, #13, #14 —
  unrelated to 4b but cleared the operational fog)
- 290 tests passing on main pre-PR

## Trade-off taken (W3)

**Replaced BacktestView entirely** (Option A from the brief). The
previous file targeted the legacy engine-test backtest at
`/api/backtest?lookbackDays=...`; that data path remains for
`EngineTestView` via the unchanged `useBacktest` hook. The Phase 4a
engine writes to a completely different schema (Firestore
`backtestRuns/`), so wedging both into one view would have created
two backtest concepts in the same place — confusing. The legacy
hook is kept; the legacy view file is gone.

## Workstreams (per brief)

### W1 — Endpoints
- `netlify/functions/backtest-runs-list.ts` — GET
  `/api/backtest-runs?limit=20`, returns runs sorted by `completedAt`
  desc with top-level metadata + summary metrics only (no
  subcollection bloat in the list).
- `netlify/functions/backtest-runs-get.ts` — GET
  `/api/backtest-runs/:runId`, returns the full run document plus
  `dailyEquity[]` (all rows), `trades[]` (capped at 500 most recent,
  with a `tradesTruncated` flag), `attribution[]` (all rows), and
  `mlTrainingCount` (count only — Phase 5 consumes the actual rows).
- Two redirect rules in `netlify.toml` map `/api/backtest-runs*` to
  the new functions.
- Both wrapped with `withSentry`. Both use `getAdminDb()`; service
  account bypasses Firestore rules.

### W2 — Hooks
- `src/hooks/useBacktestRuns.js` — `staleTime: 30_000` (newly
  completed runs surface, but the list doesn't churn).
- `src/hooks/useBacktestRun.js` — `staleTime: Infinity` (historical
  runs are immutable, cache forever); `enabled: !!runId` (no fetch
  until a run is selected).
- `queryKeys` extended with `backtestRuns(limit)` and
  `backtestRun(runId)`.

### W3 — View
`BacktestView.jsx` rewritten as a two-section, single-column,
mobile-first layout:

1. Header: `BACKTEST · Phase 4a engine · read-only`
2. `LauncherPlaceholder` — explains 4b-2 deferral and surfaces the
   prophet-only constraint that will apply when the launcher lands.
3. **Recent runs** — `RunRow` per run with a ⚠ icon next to the
   short runId for any run where `universeSurvivorshipCorrected.corrected === false`;
   selected row gets an emerald accent stripe; click selects.
4. **Run detail** — for the selected run, in order:
   `SurvivorshipBanner` (top, full width, non-dismissible) →
   run-id + cadence + universe + start/end timestamps + warnings
   strip if any → `RunMetricsTiles` → `EquityCurveChart` →
   `DrawdownChart` → `RegimeBreakdownTable` → `AttributionChart` →
   `TopTradesTable` → small counts footer.

Auto-selects the most recent run on first arrival; user selection
sticks across list refetches. Empty-state guides the user to the
CLI launcher (`npx tsx scripts/run-backtest.ts`).

### W4 — Subcomponents

Eight new files under `src/components/`:

- `KpiCard.jsx` + `ChartPanel.jsx` — extracted from the old
  BacktestView so other subcomponents can reuse them without
  circular imports.
- `SurvivorshipBanner.jsx` — the most important UI element in this
  brief. Renders only when `universeStamp.corrected === false`.
  Non-dismissible by design. Links to `docs/BACKTEST_LIMITATIONS.md`
  with `target="_blank"`. The text does NOT soften: "Treat with
  extreme caution." If this banner can be ignored, the integrity of
  every dishonesty Phase 4a fought to surface gets reversed.
- `RunMetricsTiles.jsx` — 8-tile 2/4-column grid. Sign-aware colors:
  positive return → emerald, negative → rose, Sharpe>1 → emerald,
  Sharpe<0 → rose, MaxDD always rose. Missing values render as `—`.
- `EquityCurveChart.jsx` — Recharts `LineChart` with optional
  benchmark overlay (gray dashed line). Downsamples to ~500 points
  on the client when `dailyEquity.length > 500` to keep phone
  tooltips snappy without losing the curve's shape.
- `DrawdownChart.jsx` — Recharts `AreaChart`. Computes underwater %
  client-side from `value` if the engine didn't pre-compute
  `drawdownPct`.
- `AttributionChart.jsx` — Recharts `BarChart`. Aggregates per
  analyst as `Σ pnl × (layer_score / Σ_layers)` per attribution row.
  Phase 5 will refine; for now the chart subtitle calls out that
  the methodology is rough.
- `RegimeBreakdownTable.jsx` + `TopTradesTable.jsx` — sortable
  tables via `useSortable` + `SortableTh` per standing rule. Top
  trades capped at 10 by `|pnlPct|` so winners and losers both
  surface (Phase 4a honesty: biggest losers are as informative as
  biggest winners).

### W5 — Prophet-only constraint
Documented in `LauncherPlaceholder` text. No code logic needed for
an option that doesn't exist yet.

### W6 — Tests (+21 new, 311 total)

- `src/__tests__/SurvivorshipBanner.test.jsx` — 4 cases:
  `corrected:false` renders, `corrected:true` returns null, missing
  stamp returns null, undefined stamp returns null. Limitations
  link is verified to be present, external, and point at the
  doc.
- `src/__tests__/RunMetricsTiles.test.jsx` — 5 cases: positive
  return emerald, negative rose, null → `—`, Sharpe>1 emerald,
  null metrics object returns nothing.
- `src/hooks/__tests__/useBacktestRuns.test.jsx` — 5 cases:
  list hook fetches the right URL with abort signal, errors
  surface as `query.error`; detail hook fetches with runId,
  is disabled when runId is null, surfaces 404 messages.
- `netlify/functions/__tests__/backtest-runs.test.ts` — 7 cases:
  list sorted desc by `completedAt`, `limit` respected, list
  returns top-level metrics only; detail returns
  run+subcollections, 404 on missing run, 400 on invalid runId
  chars, 400 on empty runId.

### W7 — Version + status + PR

- `APP_VERSION`: `0.13.6-alpha` → `0.14.0-alpha`
- `ORCHESTRATOR.md`: 4a-fix-4 marked done (with PR #12+#13+#14
  context); new rows for 4b-1 (done) and 4b-2 (pending).

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — **311 passing** (290 before; +21 new; brief target ≥295)
- `npm run build` — clean, single-bundle `255.38 kB` gzipped
  (`+2.23 kB` net for the whole 4b view + 8 components — well under
  the 820 kB budget)

## Manual verification post-merge

1. Hit `/api/backtest-runs?limit=5` from the browser console.
   Should return `{ ok: true, runs: [{ runId, metrics, ... }] }`
   with the smoke-test run at index 0.
2. Hit `/api/backtest-runs/bt_20260511155722_eg0gv5`. Should return
   the full doc + subcollections.
3. Open the app, navigate to Backtest. Most recent run should
   auto-select. Equity curve, drawdown, attribution should render.
4. The smoke-test run is on `dow` which IS survivorship-corrected,
   so the banner should NOT show. Confirm. Then run a CLI backtest
   against `sp500` and confirm the banner shows for that run.

## Out of scope (deferred to Phase 4b-2)

- Run launcher (background-function form)
- Pagination beyond limit=50
- Multi-run comparison
- Run editing/deletion
- CSV export
- Real-time progress on in-flight runs

## Files changed

```
$ git diff --stat main..phase-4b-backtest-viewer
 netlify/functions/__tests__/backtest-runs.test.ts |  ~200
 netlify/functions/backtest-runs-get.ts            |   90
 netlify/functions/backtest-runs-list.ts           |   70
 netlify.toml                                      |   10
 src/App.jsx                                       |    2
 src/BacktestView.jsx                              |  -243 / +238
 src/components/AttributionChart.jsx               |  130
 src/components/DrawdownChart.jsx                  |  110
 src/components/EquityCurveChart.jsx               |  135
 src/components/KpiCard.jsx                        |   46
 src/components/RegimeBreakdownTable.jsx           |   95
 src/components/RunMetricsTiles.jsx                |   75
 src/components/SurvivorshipBanner.jsx             |   50
 src/components/TopTradesTable.jsx                 |  140
 src/__tests__/RunMetricsTiles.test.jsx            |   65
 src/__tests__/SurvivorshipBanner.test.jsx         |   50
 src/hooks/__tests__/useBacktestRuns.test.jsx      |  130
 src/hooks/useBacktestRun.js                       |   30
 src/hooks/useBacktestRuns.js                      |   25
 src/lib/queryKeys.js                              |    5
 ORCHESTRATOR.md                                   |    4
 briefs/phase-4b-pr-description.md                 |  this file
```
