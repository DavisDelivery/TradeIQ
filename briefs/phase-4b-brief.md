# Phase 4b Agent Brief — Backtest Run Viewer UI (Read-Only)

You are the Phase 4b agent for TradeIQ. Your job is to build the UI for viewing Phase 4a's backtest engine results. The engine writes auditable run records to Firestore (`backtestRuns/{runId}` with subcollections `dailyEquity`, `trades`, `attribution`, `mlTraining`). Phase 4b reads these records and renders them — equity curves, attribution charts, per-regime breakdowns, survivorship-corrected status, all of it.

**Phase 4b is READ-ONLY in this brief.** Backtests are launched via the existing CLI (`npx tsx scripts/run-backtest.ts`). UI launch is deferred to a separate brief (Phase 4b-2) because it requires background-function architecture decisions that warrant separate scoping. Get the viewer landed first, validate the UX with real data, then decide on launcher.

Target version `0.14.0-alpha`. Estimated 2-3 agent sessions.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Live site.** `https://tradeiq-alpha.netlify.app`
**Netlify site ID.** `8e90d525-78f3-4288-9c15-8b1968e994c1`
**Currently live.** `0.13.2-alpha` (or whatever's on main when you start — confirm at W0)
**Stack.** React 18 + Vite, TypeScript Netlify Functions, Tailwind, Firebase Firestore, TanStack Query, Recharts (already a dep).

**Required state.**
- Phase 0-3 + Phase 4a all show `done` in `ORCHESTRATOR.md`
- Hotfixes #1 + #2 + the snapshot seeding all merged and verified
- At least one backtest run exists in `backtestRuns/` (the Phase 4a smoke-test run from earlier — `bt_20260511155722_eg0gv5` — is a good fixture)
- ~281+ tests passing on main

If preconditions fail, surface to user and stop.

---

## The big idea

The Phase 4a engine produces honest backtest numbers (verified by the smoke test: Sharpe 0.224, no look-ahead signature). Currently those numbers live in Firestore where only Chad can see them by hand-querying with admin credentials. Phase 4b puts them in the app so they can be looked at from a phone in 10 seconds.

**Three things this UI must do well:**

1. **Make survivorship-bias status impossible to miss.** Every backtest result carries `universeSurvivorshipCorrected` per universe. When it's `false` (SP500, NDX backtests), the UI must show a red warning banner with "⚠ Universe is not survivorship-corrected — results favor surviving stocks and overstate alpha. Treat with extreme caution." Banner at the top of the run detail, full width. Phase 4a's whole honesty argument falls apart if the UI lets you forget this.

2. **Show equity + drawdown trajectory clearly.** Sharpe of 0.224 by itself is a number. The equity curve traversing $95k → $113k over 7 years with a 9.2% drawdown is a story. Phone-first means responsive charts that work at 375px wide.

3. **Surface per-analyst attribution.** Phase 5's whole calibration loop depends on knowing which analysts contributed to wins and losses. The current Phase 4a engine writes this to the `attribution` subcollection. Phase 4b makes it visible so Chad can eyeball which weights look wrong before Phase 5 starts.

Everything else (metrics tiles, trades table, regime breakdown) is supporting cast.

---

## Credentials (use these — do not request)

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
NETLIFY_TEAM_ID=69c43f638748ee6e940f5f62
```

For E2E testing against a real run, you can read directly from Firestore via the FIREBASE_SERVICE_ACCOUNT (pull from Netlify env using the standard pattern).

---

## Required tools

`bash_tool`, `str_replace`, `create_file`, `view`. Plus Netlify deploy connectors.

---

## Read these first

1. `briefs/phase-4a-brief.md` — engine architecture; understand the `BacktestResult` shape, what gets written to each subcollection
2. `briefs/phase-4a-smoke-test-brief.md` + the smoke test outcome — what real metrics look like, what the survivorship stamp shape is
3. `netlify/functions/shared/backtest/types.ts` — TypeScript types you'll mirror on the frontend
4. `src/BacktestView.jsx` (287 lines) — **PLACEHOLDER FROM PHASE 2 SPLIT, FOR A LEGACY BACKTEST SYSTEM**. Has nice reusable helpers (`KpiCard`, `ChartPanel`) you'll keep. The data-fetching layer is wrong (it hits `/api/backtest?lookbackDays=...` which is an older engine-test endpoint) — that gets replaced entirely.
5. `src/hooks/useBacktest.js` — same legacy concern. Don't reuse for Phase 4b runs. New hook.
6. `src/ProphetView.jsx`, `src/WilliamsView.jsx`, `src/LynchView.jsx` — pattern reference for hook-based views with TanStack Query.
7. `docs/BACKTEST_LIMITATIONS.md` — link to this from the survivorship banner

---

## Critical context: existing BacktestView is for a different system

Phase 2 extracted the inline view into `src/BacktestView.jsx` but the underlying `/api/backtest` endpoint and `useBacktest` hook talk to the **legacy engine-test backtest** that takes a ticker list + lookback days and returns inline results. That's NOT Phase 4a.

**Phase 4a engine writes to Firestore.** Run records at `backtestRuns/{runId}`, subcollections for dailyEquity / trades / attribution / mlTraining. The CLI populates these.

Two clean paths forward — pick one:

**A. Replace BacktestView entirely.** Old `useBacktest` hook stays for the legacy engine-test (it's used by EngineTestView, probably). New view = new file or full rewrite of BacktestView.jsx to be Phase 4a-aware.

**B. Add a new BacktestRunsView alongside.** Keeps the legacy backtest view available, adds the run viewer as a separate nav entry. Two backtest views might confuse the user.

**Recommend A.** Replace `BacktestView.jsx` with the Phase 4a-aware version. Keep the legacy `useBacktest` hook for `EngineTestView` (which is the "run a quick test scan" workflow, not the historical backtest). Rename if needed for clarity but don't break what's working.

Decision goes in the PR description either way — surface the trade-off.

---

## Phase 4b scope (7 workstreams)

Execute in order. Each is a discrete commit or commit chain.

---

### Workstream 1 — Backtest runs HTTP endpoints

**Why first.** The frontend needs API surface to read from. Direct Firestore reads from the browser would require client-side Firebase Admin (security disaster) or unauthenticated rules (data leak). Server-side endpoints proxy the reads cleanly.

**Files.**
- `netlify/functions/backtest-runs-list.ts` (new) — GET, returns recent runs sorted by completedAt desc
- `netlify/functions/backtest-runs-get.ts` (new) — GET, returns one run + its subcollection summaries by runId

**Implementation.**

```ts
// netlify/functions/backtest-runs-list.ts
// GET /api/backtest-runs?limit=20
// Response: { runs: [{ runId, config, metrics: { totalReturn, sharpe, ... }, universeSurvivorshipCorrected, completedAt, status }] }
import { getAdminDb } from './shared/firebase-admin';
import { log } from './shared/logger';
import { withSentry } from './shared/sentry';
import { z } from 'zod';

const QuerySchema = z.object({
  limit: z.coerce.number().min(1).max(50).default(20),
});

export const handler = withSentry(async (event) => {
  try {
    const params = QuerySchema.parse(event.queryStringParameters ?? {});
    const db = getAdminDb();
    const snap = await db.collection('backtestRuns')
      .orderBy('completedAt', 'desc')
      .limit(params.limit)
      .get();

    const runs = snap.docs.map(d => {
      const data = d.data();
      return {
        runId: data.runId ?? d.id,
        config: data.config,
        // Top-level metrics only — full subcollection data on detail endpoint
        metrics: {
          totalReturn: data.metrics?.totalReturn ?? null,
          cagr: data.metrics?.cagr ?? null,
          sharpe: data.metrics?.sharpe ?? null,
          maxDrawdown: data.metrics?.maxDrawdown ?? null,
          winRate: data.metrics?.winRate ?? null,
          trades: data.metrics?.trades ?? 0,
        },
        universeSurvivorshipCorrected: data.universeSurvivorshipCorrected,
        completedAt: data.completedAt,
        status: data.status ?? 'complete',
        warnings: data.warnings ?? [],
      };
    });

    log.info('backtest_runs_listed', { count: runs.length });
    return json(200, { runs });
  } catch (err: any) {
    log.error('backtest_runs_list_failed', { err: String(err?.message ?? err) });
    return json(500, { error: String(err?.message ?? err) });
  }
});
```

```ts
// netlify/functions/backtest-runs-get.ts
// GET /api/backtest-runs/:runId
// Response: { run: { ...full record... }, dailyEquity, trades, attribution, mlTrainingStats }
//
// dailyEquity can be large (1700+ rows for a 7-year backtest). Send all of it
// — Recharts handles thousands of points fine. Trades capped at 500 rows in
// the response (paginate via /api/backtest-runs/:runId/trades?offset=... if
// needed; not part of this brief).
//
// mlTraining is not returned — large, only Phase 5 consumes it. Return count only.

export const handler = withSentry(async (event) => {
  try {
    const runId = event.path.split('/').pop();
    if (!runId) return json(400, { error: 'missing runId' });

    const db = getAdminDb();
    const runRef = db.collection('backtestRuns').doc(runId);
    const [run, equity, trades, attribution, mlCount] = await Promise.all([
      runRef.get(),
      runRef.collection('dailyEquity').orderBy('date', 'asc').get(),
      runRef.collection('trades').orderBy('entryDate', 'asc').limit(500).get(),
      runRef.collection('attribution').get(),
      runRef.collection('mlTraining').count().get(),
    ]);

    if (!run.exists) return json(404, { error: 'run not found' });

    return json(200, {
      run: { runId, ...run.data() },
      dailyEquity: equity.docs.map(d => d.data()),
      trades: trades.docs.map(d => d.data()),
      attribution: attribution.docs.map(d => d.data()),
      mlTrainingCount: mlCount.data().count,
    });
  } catch (err: any) {
    log.error('backtest_run_get_failed', { err: String(err?.message ?? err) });
    return json(500, { error: String(err?.message ?? err) });
  }
});
```

**Redirects.** Add to `netlify.toml`:

```toml
[[redirects]]
  from = "/api/backtest-runs"
  to = "/.netlify/functions/backtest-runs-list"
  status = 200

[[redirects]]
  from = "/api/backtest-runs/:runId"
  to = "/.netlify/functions/backtest-runs-get"
  status = 200
```

**Tests.** Mock Firestore, verify list endpoint returns sorted results with truncated metrics; detail endpoint returns full subcollections; 404 on missing run; 400 on missing runId.

Commit: `phase-4b(api): backtest-runs-list + backtest-runs-get endpoints`

---

### Workstream 2 — React Query hooks

**Files.**
- `src/hooks/useBacktestRuns.js` (new) — lists recent runs
- `src/hooks/useBacktestRun.js` (new) — fetches a single run + subcollections
- Extend `src/lib/queryKeys.js` with `backtestRuns` and `backtestRun(runId)`

**Pattern (matches existing hook style).**

```js
// src/hooks/useBacktestRuns.js
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useBacktestRuns(limit = 20) {
  return useQuery({
    queryKey: queryKeys.backtestRuns(limit),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/backtest-runs?limit=${limit}`, { signal });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 30 * 1000,  // 30s — runs are slow-changing
  });
}
```

```js
// src/hooks/useBacktestRun.js
export function useBacktestRun(runId) {
  return useQuery({
    queryKey: queryKeys.backtestRun(runId),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/backtest-runs/${runId}`, { signal });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    enabled: !!runId,           // don't fire until runId is set
    staleTime: Infinity,        // historical runs are immutable; cache forever
  });
}
```

Commit: `phase-4b(hooks): useBacktestRuns + useBacktestRun`

---

### Workstream 3 — Replace BacktestView with run-list + run-detail

**File.** `src/BacktestView.jsx` (full rewrite, retain `KpiCard` + `ChartPanel` helpers)

**Layout (mobile-first, single column, scrollable).**

```
┌─────────────────────────────────────┐
│ BACKTEST                            │  Header
│ Phase 4a engine • read-only         │  Subtitle
├─────────────────────────────────────┤
│ [Run launcher: coming in Phase 4b-2]│  Banner (placeholder for launcher)
├─────────────────────────────────────┤
│ ▼ RECENT RUNS                       │  Section header
│ ┌─────────────────────────────────┐ │
│ │ bt_2026...rblp3x · DOW · monthly│ │  Run row (clickable)
│ │ +7.30%  Sharpe 0.224  350 trades│ │
│ │ ⚠ uncorrected if applies         │ │
│ ├─────────────────────────────────┤ │
│ │ bt_2026...kxr3 · ...            │ │
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ ▼ RUN DETAIL (selected)             │  When a run is selected
│ [survivorship banner if applies]    │
│ [metrics tiles]                     │
│ [equity curve]                      │
│ [drawdown curve]                    │
│ [per-regime table]                  │
│ [attribution chart]                 │
│ [top 10 trades by P&L]              │
└─────────────────────────────────────┘
```

State: `selectedRunId` (default: first run in the list, or null if none exist).

**Empty state.** If `useBacktestRuns().data.runs.length === 0`:

> "No backtest runs yet. Run one via CLI: `npx tsx scripts/run-backtest.ts --config configs/dow-2018-2024-monthly-top20.json` (see `docs/BACKTEST_LIMITATIONS.md`)."

**Loading + error states.** Spinner during fetch; error message with retry button on failure.

Commit: `phase-4b(view): BacktestView replaces legacy with run-list + run-detail layout`

---

### Workstream 4 — Run detail subcomponents

**Files.**
- `src/components/SurvivorshipBanner.jsx` (new) — the warning banner
- `src/components/RunMetricsTiles.jsx` (new) — KpiCard grid
- `src/components/EquityCurveChart.jsx` (new) — Recharts line chart with benchmark overlay
- `src/components/DrawdownChart.jsx` (new) — Recharts area chart, shows underwater %
- `src/components/AttributionChart.jsx` (new) — Recharts bar chart, per-analyst contribution
- `src/components/RegimeBreakdownTable.jsx` (new) — table with sortable columns via existing `useSortable`
- `src/components/TopTradesTable.jsx` (new) — top 10 by P&L, sortable

#### SurvivorshipBanner

```jsx
export function SurvivorshipBanner({ universeStamp }) {
  if (!universeStamp || universeStamp.corrected) return null;
  return (
    <div className="border border-rose-700/60 bg-rose-950/30 px-4 py-3 mb-4 rounded">
      <div className="flex items-start gap-3">
        <span className="text-rose-400 text-lg leading-none">⚠</span>
        <div className="flex-1 text-sm text-rose-200">
          <div className="font-semibold mb-1">Universe is not survivorship-corrected</div>
          <div className="text-rose-300/80 leading-relaxed">
            Backtest used current {universeStamp.universe.toUpperCase()} constituents only.
            Companies that delisted, got acquired, or dropped from the index over the backtest
            window are not represented. Results favor surviving stocks and overstate alpha.
            Treat with extreme caution.
            {' '}<a href="https://github.com/DavisDelivery/TradeIQ/blob/main/docs/BACKTEST_LIMITATIONS.md"
                   target="_blank" rel="noopener noreferrer"
                   className="underline hover:text-rose-100">Limitations →</a>
          </div>
        </div>
      </div>
    </div>
  );
}
```

This banner MUST render for any backtest on SP500 or NDX. Phase 4a stamps `corrected: false` on those — banner gates off that field. Do not soft-pedal. Make it visible. The integrity of every dishonesty Phase 4a fought to surface gets reversed if this banner doesn't slap the user every time they look at one of those runs.

#### RunMetricsTiles

```jsx
export function RunMetricsTiles({ metrics, benchmark }) {
  const fmt = {
    pct: (v) => v == null ? '—' : `${(v * 100).toFixed(2)}%`,
    num: (v) => v == null ? '—' : v.toFixed(3),
    int: (v) => v == null ? '—' : String(v),
  };
  const tiles = [
    { label: 'Total return', value: fmt.pct(metrics.totalReturn), color: metrics.totalReturn >= 0 ? 'emerald' : 'rose' },
    { label: 'CAGR', value: fmt.pct(metrics.cagr) },
    { label: 'Sharpe', value: fmt.num(metrics.sharpe), color: metrics.sharpe > 1 ? 'emerald' : metrics.sharpe < 0 ? 'rose' : 'neutral' },
    { label: 'Max DD', value: fmt.pct(metrics.maxDrawdown), color: 'rose' },
    { label: 'Win rate', value: fmt.pct(metrics.winRate) },
    { label: 'IC', value: fmt.num(metrics.ic) },
    { label: 'IR vs bench', value: fmt.num(metrics.informationRatio) },
    { label: 'Trades', value: fmt.int(metrics.trades) },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
      {tiles.map(t => <KpiCard key={t.label} {...t} />)}
      {benchmark && <KpiCard label="Benchmark" value={fmt.pct(benchmark.totalReturn)} color="neutral" />}
    </div>
  );
}
```

#### EquityCurveChart

Recharts LineChart. X-axis: `date` from `dailyEquity[]`. Y-axis: `value`. Add a benchmark series (`benchmarkValue` if present in dailyEquity rows; otherwise omit). Use `ResponsiveContainer` with `height={250}`. Tooltip shows date + NAV.

Performance: 1741 data points is fine for Recharts. If a backtest somehow has 5000+ points (longer than 5 years daily), downsample on the client to every-other-point to keep render snappy.

#### DrawdownChart

Compute underwater % series on the client from dailyEquity (or read from result.dailyEquity if it includes a `drawdownPct` field — check the engine's schema). Recharts AreaChart with fill below zero.

#### AttributionChart

Per-analyst bar chart. Read from `attribution[]` subcollection. Each row has `{ ticker, asOfDate, layers: { fundamental, momentum, technical, ... } }` and an associated P&L from the trade outcome. Aggregate by analyst: sum P&L weighted by `layers.<analyst>` score. Sort by total contribution. Color: emerald for positive contribution, rose for negative.

Phase 5 will refine this. For Phase 4b, getting the data into a chart at all is the win.

#### RegimeBreakdownTable

Sortable table. Columns: regime, rebalances, total return, sharpe. Use existing `useSortable` + `SortableTh` per standing rules.

#### TopTradesTable

Top 10 by realized P&L. Sortable. Columns: ticker, entry date, exit date, entry price, exit price, P&L%, hold days.

Commit per component (or grouped logically):
- `phase-4b(banner): SurvivorshipBanner — non-corrected universe warning`
- `phase-4b(metrics): RunMetricsTiles + EquityCurveChart + DrawdownChart`
- `phase-4b(attribution): per-analyst attribution chart from attribution subcollection`
- `phase-4b(regime+trades): RegimeBreakdownTable + TopTradesTable with useSortable`

---

### Workstream 5 — Prophet-only constraint in launcher placeholder

The launcher form isn't built in Phase 4b (deferred to 4b-2). But the **placeholder** for it should already disable non-prophet board options so when launcher lands, the constraint is visible from day one.

The placeholder banner from W3 ("Run launcher: coming in Phase 4b-2") should include a note:

> Board: `prophet` only (other boards' PIT scoring landed partially in Phase 4a — see `docs/BACKTEST_LIMITATIONS.md`).

Pure documentation in the placeholder. No code logic needed for an option that doesn't exist yet.

Commit: `phase-4b(constraint): document prophet-only constraint in launcher placeholder`

---

### Workstream 6 — Tests

**Test files.**
- `src/__tests__/SurvivorshipBanner.test.jsx` — renders when `corrected: false`, doesn't render when `corrected: true`, doesn't render when stamp is missing
- `src/__tests__/RunMetricsTiles.test.jsx` — null metrics render as `—`, positive returns get emerald color
- `src/__tests__/useBacktestRuns.test.js` — hook returns sorted list, handles 500 gracefully
- `netlify/functions/__tests__/backtest-runs.test.ts` — list endpoint sorts by completedAt desc; detail endpoint returns 404 on missing run

Mock Firestore via vi.mock. Use realistic fixture data (the smoke-test run `bt_20260511155722_eg0gv5` shape).

Aim for ~15 new tests. Total suite ≥ 295.

Commit: `phase-4b(tests): banner + metrics + hook + endpoint tests`

---

### Workstream 7 — APP_VERSION + ORCHESTRATOR + PR

Bump `APP_VERSION` to `0.14.0-alpha`. Update ORCHESTRATOR.md status table:

```
| 4b-1 | Backtest run viewer UI (read-only) | done | 0.14.0-alpha | YYYY-MM-DD | List view + run detail with survivorship banner, metrics tiles, equity/drawdown charts, per-analyst attribution, regime breakdown, top-10 trades. Reads from Firestore via /api/backtest-runs endpoints. Launcher deferred to 4b-2. |
| 4b-2 | Backtest run launcher | pending | — | — | UI launch via background function. Form + progress indicator. Prophet-only initially. |
```

PR title: `Phase 4b-1: Backtest run viewer UI (v0.14.0-alpha)`

PR description (in `briefs/phase-4b-pr-description.md`):
- Phase 4a dependency confirmation (engine + hotfixes merged)
- Each workstream's outcome
- Screenshots from running against the smoke-test fixture (`bt_20260511155722_eg0gv5`)
- Test count before/after
- Bundle size before/after (Recharts is already a dep, only marginal bump expected)
- Survivorship banner visible in screenshot of any SP500 or NDX run

Commit: `phase-4b(version+docs): bump 0.14.0-alpha + ORCHESTRATOR row + PR description`

---

## Standing rules

- ALWAYS bump APP_VERSION only at the final W7 commit
- Every data table column sortable via `useSortable` + `SortableTh` — applies to RegimeBreakdownTable and TopTradesTable
- FreshnessPill is NOT used in Phase 4b (it's for live boards, not backtest runs — runs are immutable historical records)
- TradeIQ stays neutral dark (not Davis brand blue)
- CI must stay green throughout. Push per workstream.
- Bundle budget: ≤ 820kB gzipped (Recharts already in, no new heavy deps expected)
- Mobile-first responsive design. Test at 375px width. Charts use `ResponsiveContainer`.

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
git checkout -b phase-4b-backtest-viewer
npm ci --silent
```

---

## Success criteria

- [ ] `/api/backtest-runs` returns sorted runs
- [ ] `/api/backtest-runs/:runId` returns run + subcollections, 404 on missing
- [ ] `useBacktestRuns` + `useBacktestRun` hooks work with TanStack Query
- [ ] BacktestView shows run list + selected run detail in a mobile-friendly single column
- [ ] SurvivorshipBanner renders for non-corrected universes (verify against an SP500 backtest)
- [ ] Equity curve, drawdown, attribution, regime, top trades all render with real data
- [ ] All tables use `useSortable` + `SortableTh`
- [ ] Empty state guides user to CLI launch when no runs exist
- [ ] `npm test` ≥ 295 tests, all green
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` clean
- [ ] Bundle ≤ 820kB gzipped
- [ ] `APP_VERSION = 0.14.0-alpha`, verified live
- [ ] ORCHESTRATOR Phase 4 split into 4b-1 (done) + 4b-2 (pending)
- [ ] Screenshots in PR description showing the smoke-test run rendered

---

## What to do if blocked

- **Smoke-test run doesn't exist in Firestore yet.** A prior backtest needs to have produced it. If `backtestRuns` collection is empty, run the CLI yourself (instructions in `briefs/phase-4a-smoke-test-brief.md`) or surface to user.
- **Existing `BacktestView.jsx` has logic you don't recognize.** It's the legacy engine-test backtest view (not Phase 4a). Replace it; don't try to preserve the old data-fetching path.
- **Recharts performance issue on dailyEquity with 5000+ points.** Downsample client-side or use `recharts`'s `dataKey` with stride.
- **Attribution data doesn't aggregate cleanly per analyst.** Phase 5 will refine; for Phase 4b, even a simplified "sum P&L grouped by which analyst's score was highest at entry" is acceptable. Document in the chart's subtitle if the methodology is rough.
- **Multiple sp500/ndx runs exist with `corrected: false` and the banner is too noisy in the list view.** The banner is for run DETAIL. In the run LIST, show a small ⚠ icon next to the runId and full banner only when selected.

---

## Out of scope

- **Run launcher.** Phase 4b-2. UI form, background function, status polling, progress indicator — all deferred.
- **Phase 5 ML.** No model training. No similarity search UI. Just data display.
- **Backtest parameter sweeps.** UI compares one run at a time. Multi-run comparison view is later.
- **Editing or deleting runs.** Read-only.
- **Real-time charts.** Runs are immutable; no live updates needed.
- **Export to CSV.** Nice-to-have, later.
- **Pagination beyond limit=50.** First 50 runs is plenty for any realistic use.

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
git checkout -b phase-4b-backtest-viewer
npm ci --silent

# 2. Confirm preconditions
grep "^| 4a" ORCHESTRATOR.md
grep "APP_VERSION" src/App.jsx | head -1   # expect 0.13.2-alpha or later
npm test 2>&1 | tail -3

# 3. Survey what's there
cat src/BacktestView.jsx | head -30
ls src/components/ | head
ls src/hooks/ | head

# 4. Confirm a backtest run exists in Firestore (pull env vars + check)
# Use the env-pull pattern from earlier briefs to get FIREBASE_SERVICE_ACCOUNT.
# Then verify backtestRuns collection has at least one document.
```

Then proceed: W1 (API endpoints) → W2 (hooks) → W3 (view layout) → W4 (subcomponents — banner first; it's the single most important element) → W5 (placeholder note) → W6 (tests) → W7 (version + status + PR).

---

End of brief.
