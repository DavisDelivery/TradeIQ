# Phase 2: Refactor foundation — Zod boundaries + monolith split + TanStack Query (v0.11.0-alpha)

## Dependencies (pre-flight)

- [x] Phase 0 done at `0.10.0-alpha` (per ORCHESTRATOR.md row 0)
- [x] Phase 1 done at `0.9.1-alpha` (per ORCHESTRATOR.md row 1)
- [x] CI workflow exists at `.github/workflows/ci.yml`
- [x] 62 baseline tests passing on main at branch point

## What changed

### Workstream 1 — Zod inbound schemas at external API boundaries

Every external `fetch().json()` call in the shared provider layer now goes through `parseOrFallback(schema, raw, ctx, fallback)` with structured `schema_mismatch` logging on parse failure.

**Schemas added** (`netlify/functions/shared/schemas/`):
- `polygon.ts` — bars/aggregates, financials (deeply-nested line items), news
- `finnhub.ts` — earnings calendar, earnings history (bare-array shape), insider transactions
- `fred.ts` — series observations (preserves `.` missing-data sentinel)
- `quiver.ts` — 5 dataset row schemas (insider, congressional, lobbying, gov contracts, patents) + a top-level union accepting both bare-array and enveloped responses
- `parse.ts` — `parseOrFallback`/`parseOrThrow` helpers with structured warning logs (`event: schema_mismatch`, `provider`, `endpoint`, `ticker`, `issueCount`, `issues`)
- `index.ts` — barrel re-exports

**Provider wiring**:
- `data-provider.ts`: 10 fetch sites — `getDailyBars`, `getPreviousClose`, `getFundamentals`, `getNews`, `getUpcomingEarnings`, `getEarningsCalendarRange`, `getEarningsHistory`, `getFinnhubInsiderTransactions`, `fredLatestObservation`, `fredSeries`
- `quiver-client.ts`: `quiverGetTicker` accepts an optional `schema` arg; validates the rows array as a whole (one log per request, not per record). Quiver schemas are drift sensors, not gates — the existing q/qn/qdate normalize layer handles legitimate field-casing variation
- `govcontracts-provider.ts`, `patent-provider.ts`, `political-provider.ts` each pass their dataset schema through

**Schema philosophy** — every top-level response uses `.passthrough()`. Numbers that have arrived as strings in the wild (Polygon line-item values, Finnhub epsEstimate) use `z.coerce.number()`. Optional fields use `.optional()`/`.default()`. No `.strict()` anywhere.

**Tests** (54 new, all fixture-based, three-bucket coverage per provider):
- `polygon.test.ts` — 15 tests
- `finnhub.test.ts` — 13 tests
- `fred.test.ts` — 7 tests
- `quiver.test.ts` — 19 tests

Each includes happy-path / drift / extra-fields cases, plus a `parseOrFallback` integration test verifying the `schema_mismatch` log shape.

### Workstream 2 — Split App.jsx into per-view files

App.jsx went from **2,965 → 336 lines**. Now contains only: imports, `APP_VERSION`, `ErrorBoundary`, `TopBar`, default-exported `App` shell with routing switch + `UniverseSelector`.

**Extracted views** (named exports, matching pre-existing pattern):
| View | Was at | Now |
|---|---|---|
| TargetBoardView | App.jsx:688 | `src/TargetBoardView.jsx` (+ `TargetCard`, `LiveTargetBoard`, `TargetDetail` helpers) |
| RegimeView | App.jsx:967 | `src/RegimeView.jsx` |
| AnalystsView | App.jsx:1104 | `src/AnalystsView.jsx` |
| AlertsView | App.jsx:1176 | `src/AlertsView.jsx` |
| EngineTestView | App.jsx:1382 | `src/EngineTestView.jsx` |
| EarningsPlaysView | App.jsx:1630 | `src/EarningsView.jsx` (+ DetailStat, EarningsSetupDetail, fmt helpers) |
| OptionsPlaysView | App.jsx:2196 | `src/OptionsFlowView.jsx` |
| SettingsView | App.jsx:2387 | `src/SettingsView.jsx` |
| BacktestView | App.jsx:2447 | `src/BacktestView.jsx` (+ KpiCard, ChartPanel helpers) |

**Shared extractions**:
- `src/lib/mockData.js` — all `MOCK_*` constants (REGIME, TARGETS, ANALYSTS, ALERTS, EQUITY_CURVE, EARNINGS, OPTIONS_PLAYS)
- `src/lib/formatters.jsx` — `fmt`, `safeTimestamp`, `tierColor`, `tierGlow`, `directionIcon`, `analystIcon`, `analystLabel`, `fmtCompact`
- `src/components/Badges.jsx` — `Logo`, `StatusDot`, `ConvictionBadge`, `DirectionPill`
- `src/components/ResearchPanel.jsx` — used inside `TargetDetail`

**Standing rules verified intact**:
- `useSortable` + `SortableTh` retained on every data table
- `FreshnessPill` integration preserved on every board view
- `OptionsPlaysView` rendered as `OptionsFlowView` (file's exported name); only one render site touched

### Workstream 3 — TanStack Query for server state

**Provider wrap** (`src/main.jsx`): `QueryClientProvider` wraps `<App />`. `ReactQueryDevtools` lazy-loaded and gated on `import.meta.env.DEV` so the production bundle does NOT ship the devtools chunk.

**Core**:
- `src/lib/queryKeys.js` — centralized factory; hierarchical `['tradeiq', noun, ...scopes]` shape so partial invalidation works
- `src/lib/queryClient.js` — retry: 1, exponential backoff, refetchOnWindowFocus: true, refetchOnReconnect: true

**Hooks** (13 in `src/hooks/`, each thin wrapper around `useQuery` with the matching `SHAPES` validator and per-board staleTime per the brief):

| Hook | staleTime | forceRescan |
|---|---|---|
| useTargetBoard | 60s | yes |
| useProphet | 60s | yes |
| useCatalyst | 60s | yes |
| useInsider | 10 min | yes |
| useWilliams | 60s | yes |
| useLynch | 10 min | yes |
| useEarnings | 5 min | yes |
| useHealth | 30s | — |
| useRegime | 30s | — |
| useAnalystsStatus | 30s | — |
| useResearch | 60s | — (chart-analysis with skipAi=1) |
| useChartAnalysis | 60s | — (full AI variant) |
| useSnapshotHistory | 60s | — (list + per-snapshot detail modes) |

**forceRescan pattern** (boards): `force=1` fetch → `setQueryData(...)` (NOT `invalidateQueries`). Replaces cache directly so the user-initiated rescan response IS the new ground truth, no refetch round-trip.

**Hook tests** (11 new):
- `useTargetBoard.test.jsx` — 5 tests: happy path, forceRescan replaces cache without refetch, HTTP error surfacing, JSON `error` field surfacing, per-universe cache isolation
- `queryKeys.test.js` — 6 tests: collision-free namespacing, conviction in prophet key, research vs chartAnalysis distinct keys

**Views wired to hooks** (5 board views in this PR):
- `WilliamsView` → `useWilliams(universe, side)`
- `LynchView` → `useLynch(universe)`
- `CatalystView` → `useCatalyst(universe, filter, minConviction)`
- `InsiderBoardView` → `useInsider(universe, windowDays)`
- `LiveTargetBoard` (inside `TargetBoardView.jsx`) → `useTargetBoard(universe)`

For each view, the conversion is the same shape:
```jsx
const { data, error, isLoading: loading, isFetching, forceRescan } = useXxx(...);
const isRescanning = isFetching && !loading;
// FreshnessPill onForceRescan = () => forceRescan()
// error?.message instead of error (TanStack returns Error, not string)
```

Old request-ID race-protection refs removed — TanStack Query's abort signal supersedes prior in-flight requests automatically when the queryKey changes.

## Deferred to follow-up (in this branch's commit chain or a 2.1 brief)

- **ProphetView wiring** — has prophet-specific JSON sanitization (strips ASCII control chars, retries with `narrate=0` on parse failure) that guards against mobile JSON corruption. Wiring as-is would either pollute the generic `useProphet` hook with prophet-specific logic or lose the mobile-reliability fix. Best landed when the prophet endpoint emits clean JSON (a backend fix, not a hook change).
- **Extracted views** (`AlertsView`, `EngineTestView`, `EarningsPlaysView`, `OptionsFlowView`, `SettingsView`, `BacktestView`, `RegimeView`, `AnalystsView`, `TargetBoardView` outer wrapper) — these were extracted in the W2 commit but most read from local mock data or use non-board endpoints. Wiring is mechanical and small, separable into its own commit.
- **HistoryView** → `useSnapshotHistory`, **ChartView** → `useChartAnalysis`, **JournalView** → `useResearch`, **App.jsx** TopBar regime/analyst-status badges → `useRegime` + `useAnalystsStatus`.

## Test counts

- Pre-Phase-2 baseline: 62 tests
- This PR: **127 tests** (62 baseline + 54 schema + 11 hook = 127, all green)

## Bundle size

- Pre-Phase-2 baseline: 873kB raw / 239kB gzipped (per the W2 verification)
- This PR after W3 wiring: **914kB raw / 251kB gzipped** — under the 820kB-gzipped budget set by the brief; +12kB gzipped above the baseline (TanStack Query's library cost matches the +13kB note in the brief)

## App.jsx line count

- Before: **2,965 lines**
- After: **336 lines**
- Brief target: ≤ 800 lines ✅

## Commit chain on branch

```
phase-2(zod): install zod + base schema scaffolding
phase-2(zod): wire data-provider + Quiver providers through safeParse
phase-2(zod): 54 schema tests across all four providers (polygon/finnhub/fred/quiver)
briefs: phase-2 pickup notes — W1 done, W2 partial, W3 pending
phase-2(split): extract 9 inline views to per-file modules + shared helpers
phase-2(split): wire App.jsx to use extracted views (2965 -> 336 lines)
phase-2(query): TanStack Query infrastructure + 13 hooks + tests
phase-2(query): wire 5 board views to TanStack Query hooks
phase-2(docs): version bump 0.11.0-alpha + ORCHESTRATOR status
```

## Manual smoke-test plan (post-merge, post-deploy)

1. Wait 60s post-merge for Netlify auto-deploy.
2. Curl live site, extract bundle path, grep for `0.11.0-alpha`. Expect match.
3. Hit each board on the live site:
   - Target board (`activeView=board`) — expect targets list, force-rescan replaces UI immediately
   - Prophet, Catalyst, Insider, Williams, Lynch boards — same drill
   - Earnings, History boards — verify load and freshness pill
4. Switch tabs rapidly between Target and Prophet — confirm devtools shows no duplicate network requests for the same query key.
5. Force-rescan the Target board — confirm UI updates without a re-loading flash.

## Unexpected scope items

None of substance. The brief flagged `scripts/` as out-of-scope, so two ephemeral helper scripts I used for the App.jsx split were removed before commit — the surgery is reproducible from `git log -p`.

## Out of scope (per brief, NOT touched)

- Backend scoring logic (Phase 4)
- Snapshot store schema (Phase 1, locked)
- New API endpoints
- `validateResponse.js` SHAPES — Zod sits beside, not on top
- Code-splitting beyond what's needed for the bundle budget (didn't need any)
- UI polish, animation, design changes
- Anything in `briefs/` or `docs/` other than this PR description and the ORCHESTRATOR row update
