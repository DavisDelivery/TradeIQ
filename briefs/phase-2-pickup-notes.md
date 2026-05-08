# Phase 2 — Pickup Notes (mid-flight)

This branch has Workstream 1 complete and merged-ready, plus Workstream 2 file
extractions on disk and committed. **Workstream 2 wiring + Workstream 3 are
not yet done.** Read this before resuming so the next agent doesn't redo
already-done work.

## Where things stand on `phase-2-refactor-foundation`

### ✅ W1 — Zod schemas at provider boundaries (DONE, on origin)

Three commits, all pushed:

1. `1e54bf0  phase-2(zod): install zod + base schema scaffolding`
2. `4263b1a  phase-2(zod): wire data-provider + Quiver providers through safeParse`
3. `42b0a54  phase-2(zod): 54 schema tests across all four providers`

State:
- `netlify/functions/shared/schemas/{polygon,finnhub,fred,quiver,parse,index}.ts`
  exist with full schemas + reusable `parseOrFallback` helper.
- All 10 fetches in `data-provider.ts` go through `safeParse`.
- `quiver-client.ts` accepts an optional `schema` arg; the four
  Quiver-backed providers (govcontracts, patent, political × 2 datasets)
  pass their dataset schemas.
- 54 fixture-based tests cover happy / drift / passthrough cases per provider.
- Total test count: **116 passing** (was 62 baseline). Brief minimum was 30+.
- Typecheck clean. Build clean. Bundle: 238.58 kB gzipped (well under 820 kB
  budget — note: brief's "current ~789kB" appears to refer to non-gzipped
  raw size; gzipped reality is much smaller).

### 🟡 W2 — App.jsx split (PARTIAL, on origin)

One commit pushed:

4. `e1d391b  phase-2(split): extract 9 inline views to per-file modules`

What's done:
- All 9 inline views extracted to per-file modules:
  - `src/TargetBoardView.jsx` (472 lines; also exports `LiveTargetBoard` + `TargetDetail`)
  - `src/RegimeView.jsx` (137)
  - `src/AnalystsView.jsx` (72)
  - `src/AlertsView.jsx` (205)
  - `src/EngineTestView.jsx` (190)
  - `src/EarningsView.jsx` (576; exports `EarningsPlaysView`)
  - `src/OptionsFlowView.jsx` (190; exports `OptionsFlowView` — note
    name mismatch with App.jsx's `<OptionsPlaysView>` callsite)
  - `src/SettingsView.jsx` (59)
  - `src/BacktestView.jsx` (306)
- Shared helpers extracted:
  - `src/lib/mockData.js` — all `MOCK_*` constants
  - `src/lib/formatters.jsx` — `fmt`, `tierColor`, etc.
  - `src/components/Badges.jsx` — `ConvictionBadge`, `DirectionPill`
  - `src/components/ResearchPanel.jsx`

What's NOT done:
- **App.jsx still has all 9 inline view definitions** alongside the new
  files. The new files are **dead code** — nothing imports them. App.jsx is
  still 2,965 lines.
- Brief target: App.jsx ≤ 800 lines.

### ❌ W3 — TanStack Query (NOT STARTED)

Nothing yet. No `@tanstack/react-query` install, no hooks, no provider wrap.

### ❌ Other Phase 2 closeout (NOT DONE)

- `APP_VERSION` still `0.10.0-alpha`. Should bump to `0.11.0-alpha` at the
  end.
- `ORCHESTRATOR.md` Status table still shows Phase 2 `pending`.
- No PR description doc in `briefs/` yet.
- No live-deploy smoke test.

## Next session — recommended order

### Step 1: Finish W2 (the App.jsx rewiring)

This is a single, careful, atomic commit. Don't split it — partial states
break the build.

**Precise deletions in App.jsx** (line numbers from current main, will shift
as deletions happen — work bottom-up):

| Region                          | Approx lines    | What                                      |
|---------------------------------|------------------|-------------------------------------------|
| `MOCK_REGIME` through `MOCK_EQUITY_CURVE` | 91-(end of MOCK_EQUITY_CURVE) | Replace with `import { ... } from './lib/mockData.js'` |
| Inline `TargetBoardView`        | 688-966          | Use `import { TargetBoardView } from './TargetBoardView.jsx'` |
| Inline `RegimeView`             | 967-1103         | `import { RegimeView } from './RegimeView.jsx'` |
| Inline `AnalystsView`           | 1104-1175        | `import { AnalystsView } from './AnalystsView.jsx'` |
| Inline `AlertsView`             | 1176-1381        | `import { AlertsView } from './AlertsView.jsx'` |
| Inline `EngineTestView`         | 1382-1572        | `import { EngineTestView } from './EngineTestView.jsx'` |
| `DetailStat` helper             | 1573-1579        | Now lives inside `EarningsView.jsx` |
| `MOCK_EARNINGS`                 | 1580-1599        | `import { MOCK_EARNINGS } from './lib/mockData.js'` (or just delete — only EarningsView used it) |
| `EARNINGS_WINDOWS`, `PLAY_TYPE_LABELS`, `PLAY_TYPE_COLORS`, `fmtUsdEarnings` | 1601-1628 | Now in `EarningsView.jsx` |
| Inline `EarningsPlaysView`      | 1630-1890        | `import { EarningsPlaysView } from './EarningsView.jsx'` |
| `ACCT_SIZE_KEY` + `readAccountSize` + `writeAccountSize` + `fmtCompact` | 1895-1916 | Now in `EarningsView.jsx` |
| Inline `EarningsSetupDetail`    | 1918-2163        | Now in `EarningsView.jsx` |
| `MOCK_OPTIONS_PLAYS`            | 2169-2195ish     | `import { MOCK_OPTIONS_PLAYS } from './lib/mockData.js'` (or delete if only OptionsView used it) |
| Inline `OptionsPlaysView`       | 2196-2386        | `import { OptionsFlowView as OptionsPlaysView } from './OptionsFlowView.jsx'` |
| Inline `SettingsView`           | 2387-2446        | `import { SettingsView } from './SettingsView.jsx'` |
| Inline `BacktestView`           | 2447-(end of BacktestView) | `import { BacktestView } from './BacktestView.jsx'` |

**Naming gotcha.** `OptionsFlowView.jsx` exports `OptionsFlowView`, but
App.jsx renders `<OptionsPlaysView />` at line 2945. Easiest fix:

```jsx
import { OptionsFlowView as OptionsPlaysView } from './OptionsFlowView.jsx';
```

**TargetBoardView gotcha.** The extracted file exports three things:
`TargetBoardView`, `LiveTargetBoard`, `TargetDetail`. App.jsx currently uses
the original prop-driven `<TargetBoardView targets={...} ... />` shape; only
`TargetBoardView` needs to be imported for the W2 wiring. `LiveTargetBoard`
and `TargetDetail` are forward-leaning extras the prior agent added; they're
not wired anywhere yet and can stay dormant.

**Verify after rewiring:**
```bash
npx tsc --noEmit
npm run build
npm test
```

**Expected result.** App.jsx should be ~700-800 lines. Build clean. All 116
tests still passing. Bundle size unchanged (or slightly smaller due to
better tree-shaking).

### Step 2: W3 — TanStack Query

Brief is detailed; follow it as written. Install order:

```bash
npm install @tanstack/react-query @tanstack/react-query-devtools
```

Then create:
- `src/lib/queryKeys.js`
- `src/lib/queryClient.js`
- `src/hooks/use{TargetBoard,Prophet,Catalyst,Insider,Williams,Lynch,Earnings,Health,Regime,AnalystsStatus,Research,ChartAnalysis,SnapshotHistory}.js`

Wrap `<App />` in `<QueryClientProvider>` in `src/main.jsx`. Devtools gated
by `import.meta.env.DEV`.

Then refactor each view (now in its own file thanks to W2) to use its hook
instead of `useState + useEffect + fetchWithRetry`. **Critical:** force-rescan
must use `qc.setQueryData`, NOT `invalidateQueries` — the brief is explicit
about why.

### Step 3: Closeout

1. Bump `APP_VERSION` in App.jsx to `0.11.0-alpha`.
2. Write `briefs/phase-2-pr-description.md` per the brief's checklist.
3. Open PR titled `Phase 2: Refactor foundation — Zod boundaries + monolith
   split + TanStack Query (v0.11.0-alpha)`.
4. After merge + Netlify deploy, verify version live and smoke-test all 7
   board views.
5. Edit `ORCHESTRATOR.md` Status row for Phase 2 → `done` with date.

## What NOT to redo

- Don't reinstall zod or rewrite schemas — they're done and tested.
- Don't re-extract any view file — they all exist in `src/`.
- Don't try to delete the new view files thinking they're dead code; they
  ARE dead code right now, but Step 1 of the next session wires them in.

## Risks the next session should watch

- **Subtle drift between extracted view and inline view.** The prior
  extractions appear faithful but were not diffed line-by-line against the
  inline source. After Step 1's deletions, manually click through each tab
  on the dev server (`npm run dev`) — any view that looks broken probably
  has a copy mismatch.
- **Helper functions used by both an extracted view AND something still
  inline in App.jsx.** Grep for each helper name globally before deleting
  it from App.jsx. The known cases are documented in the deletion table
  above; spot-check anyway.
- **Bundle size after TanStack Query.** Brief's 820 kB gzipped budget is
  fine — current bundle is 238 kB gzipped, so TanStack Query's ~13 kB lands
  it around 251 kB. The brief's "current ~789kB" was confused (probably
  referring to raw, not gzipped). No code-splitting needed.
