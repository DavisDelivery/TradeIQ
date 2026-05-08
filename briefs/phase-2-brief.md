# Phase 2 Agent Brief — TradeIQ Refactor Foundation

You are the Phase 2 agent for TradeIQ. Your job is to land Phase 2 of the orchestrator: Zod schemas at every external API boundary, App.jsx monolith split into per-view files, TanStack Query for server state. One PR, one version bump, status table updated.

You have all credentials embedded below. Do not ask the user for tokens.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Live site.** `https://tradeiq-alpha.netlify.app`
**Netlify site ID.** `8e90d525-78f3-4288-9c15-8b1968e994c1`
**Netlify team ID.** `69c43f638748ee6e940f5f62`
**Currently live.** `0.10.0-alpha` (Phase 0 + Phase 1 merged; Sentry + spend cap + 70+ tests + CI gating + snapshot-first boards + HistoryView all in production)
**Stack.** React 18 + Vite, TypeScript Netlify Functions, Tailwind, Firebase Firestore, Anthropic Opus 4.7.

**Required state before you start.**
- Phase 0 must show `done` in `ORCHESTRATOR.md`
- Phase 1 must show `done` in `ORCHESTRATOR.md`
- CI workflow must exist at `.github/workflows/ci.yml`
- 70+ tests passing on main

If any of these aren't true, surface to user and stop.

---

## Credentials (use these — do not request from user)

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
NETLIFY_TEAM_ID=69c43f638748ee6e940f5f62
```

Existing Netlify env vars (reference only):
- `ANTHROPIC_API_KEY`, `POLYGON_API_KEY`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `QUIVER_API_KEY`
- `SENTRY_DSN`, `VITE_SENTRY_DSN`, `ANTHROPIC_DAILY_BUDGET_USD`
- `FIREBASE_SERVICE_ACCOUNT`

You will not create any new env vars in Phase 2.

---

## Required tools

`bash_tool`, `str_replace`, `create_file`, `view`, plus the Netlify deploy/read connectors.

---

## Read these first (in order)

1. `ORCHESTRATOR.md` — Phase 2 spec is the master; this brief is the implementation directive.
2. `briefs/phase-0-reconciliation-brief.md` — for context on what Phase 0 + Phase 1 produced.
3. `package.json` + `vitest.config.ts` — current deps, test setup.
4. `src/App.jsx` — 2,965 lines, mostly inline view components. Don't read it cover-to-cover; grep for `^const.*View` to find each view's anchor line and read in chunks.
5. `src/lib/validateResponse.js` — existing thin response validator. Phase 2 deepens this with Zod.
6. `netlify/functions/shared/data-provider.ts`, `insider-provider.ts`, `political-provider.ts`, `patent-provider.ts`, `govcontracts-provider.ts` — these are where external APIs are called and where Zod schemas wrap.
7. Existing per-view files for the pattern: `src/WilliamsView.jsx`, `src/LynchView.jsx`, `src/CatalystView.jsx`, `src/InsiderBoardView.jsx`, `src/ProphetView.jsx`, `src/HistoryView.jsx`, `src/JournalView.jsx`, `src/ChartView.jsx`. Match their style.

---

## Phase 2 scope (three workstreams)

Order matters. Do them in sequence within one PR.

---

### Workstream 1 — Zod inbound schemas at external API boundaries

**Why.** Polygon, Finnhub, Quiver, FRED — third-party APIs change response shapes occasionally. Right now there's no schema validation at the inbound boundary, so a field rename in a vendor API surfaces as `undefined` three calls deep with no signal. Zod at the boundary catches it as one log line at the source.

**Install.**
```bash
npm install zod
```

**Files to create.**

```
netlify/functions/shared/schemas/polygon.ts
netlify/functions/shared/schemas/finnhub.ts
netlify/functions/shared/schemas/quiver.ts
netlify/functions/shared/schemas/fred.ts
netlify/functions/shared/schemas/index.ts          # re-exports
```

**Schema scope per provider (only schemas for endpoints actually called).**

Audit each provider file to find every `fetch()` call. Write one Zod schema per response shape. Do not invent schemas for endpoints not called.

For Polygon: at minimum daily aggregates (bars), reference tickers, financials, news, and ticker overview. For Finnhub: earnings calendar, earnings surprises, recommendation trends, company profile. For Quiver: insider trading, congressional trades, government contracts, lobbying, patents. For FRED: series observations.

**Pattern (illustrative).**
```ts
// schemas/polygon.ts
import { z } from 'zod';

export const PolygonBarSchema = z.object({
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
  t: z.number(),
  n: z.number().optional(),
  vw: z.number().optional(),
});

export const PolygonAggregatesResponseSchema = z.object({
  ticker: z.string().optional(),
  status: z.string(),
  results: z.array(PolygonBarSchema).optional().default([]),
  resultsCount: z.number().optional(),
  // tolerate extra fields
}).passthrough();

export type PolygonBar = z.infer<typeof PolygonBarSchema>;
export type PolygonAggregatesResponse = z.infer<typeof PolygonAggregatesResponseSchema>;
```

**Critical schema rules.**
- Use `.passthrough()` on every top-level response schema. Vendor APIs add fields constantly; failing on unknown keys is a recipe for production breakage.
- Optional fields use `.optional()` and `.default()` where the downstream code expects a value.
- Numbers that vendors sometimes return as strings: use `z.coerce.number()`.
- Never use `.strict()` — too brittle.

**Wrap pattern in providers.**
```ts
// before:
const json = await res.json();
return json;

// after:
const json = await res.json();
const parsed = PolygonAggregatesResponseSchema.safeParse(json);
if (!parsed.success) {
  log.warn('schema_mismatch', {
    provider: 'polygon',
    endpoint: 'aggregates',
    issues: parsed.error.issues.slice(0, 5),
  });
  return { results: [] }; // safe default
}
return parsed.data;
```

**Files to modify.**
- `netlify/functions/shared/data-provider.ts` (Polygon, Finnhub, FRED)
- `netlify/functions/shared/insider-provider.ts` (Quiver / Finnhub)
- `netlify/functions/shared/political-provider.ts` (Quiver)
- `netlify/functions/shared/patent-provider.ts` (Quiver)
- `netlify/functions/shared/govcontracts-provider.ts` (Quiver)

Every external `fetch().then(r => r.json())` call goes through a `safeParse`.

**Tests.**
For each schema, add a fixture-based test in `netlify/functions/shared/schemas/__tests__/`:
- Happy path: a real response sample parses cleanly
- Drift path: same sample with one field renamed → safeParse fails, schema_mismatch logged
- Extra fields path: response has new vendor field → passes thanks to `.passthrough()`

Aim for ≥ 30 new tests across all schemas. CI will gate.

**Validation.** `npm test` reports new schema tests; manual check on `/api/target-board?universe=sp500` returns the same shape it did before (no regression).

---

### Workstream 2 — Split App.jsx into per-view files

**Why.** App.jsx is 2,965 lines. Re-renders are expensive, state is hard to reason about, code review on phone is impossible. Split lets each view get its own ErrorBoundary, its own bundle chunk (Phase 13 pre-work), and its own reasoning surface.

**Inline views to extract** (line numbers from current main; grep first to confirm):
| View | Current location | Move to |
|---|---|---|
| TargetBoardView | App.jsx:688 | `src/TargetBoardView.jsx` |
| RegimeView | App.jsx:967 | `src/RegimeView.jsx` |
| AnalystsView | App.jsx:1104 | `src/AnalystsView.jsx` |
| AlertsView | App.jsx:1176 | `src/AlertsView.jsx` |
| EngineTestView | App.jsx:1382 | `src/EngineTestView.jsx` |
| EarningsPlaysView | App.jsx:1630 | `src/EarningsView.jsx` |
| OptionsPlaysView | App.jsx:2196 | `src/OptionsFlowView.jsx` |
| SettingsView | App.jsx:2387 | `src/SettingsView.jsx` |
| BacktestView | App.jsx:2447 | `src/BacktestView.jsx` |

**Mock data extraction.**
All `MOCK_*` constants in App.jsx → `src/lib/mockData.js`. Each view that uses them imports from there. Don't try to delete MOCKs unless a view is fully wired to real APIs (Phase 2 is not the time to remove MOCK fallbacks).

**Helper components inline in App.jsx.**
If a small helper (a 30-line internal component) is used by exactly one view, move it with the view. If used by multiple views, extract to `src/components/<Name>.jsx`.

**Standing rules to honor.**
- Every data table column must remain sortable via `useSortable` + `SortableTh`. Don't remove or weaken these.
- Every board view must keep its `FreshnessPill` integration. The pill reads from `data` prop and calls `load({ force: true })` — preserve those signatures.
- Each extracted view must be wrapped in its own `ErrorBoundary` in App.jsx (matches existing pattern).

**Export pattern.**
Match `WilliamsView.jsx` etc.: named export.
```jsx
export const TargetBoardView = ({ targets, onOpenTarget, scanMeta }) => { ... };
```

**App.jsx after split.**
Should contain only:
- The top-level `<App />` shell
- Routing logic (`activeView` state and the render switch)
- Header / nav
- Universe selector
- ErrorBoundary
- Top-level data fetches that are shared across views (regime, analysts-status, etc.) — and these will move to TanStack Query hooks in Workstream 3, so leave them as `useState + useEffect` for now and refactor in W3.

Target: App.jsx ≤ 800 lines after split.

**Validation.**
- `npm run build` succeeds
- Bundle size same or smaller than current `~789kB` gzipped (verify via Vite output)
- All existing tests still pass
- Manually click through every nav tab on the live deploy preview — no view should crash, regress, or lose state

---

### Workstream 3 — TanStack Query for server state

**Why.** Every view in this app does its own `useEffect + fetch + setState + setLoading + setError` ceremony. TanStack Query gives you all of that for free, plus dedup (multiple components asking for the same data → one network call), background revalidation, focus refetching, retry logic, and proper cache invalidation when forcing a rescan.

**Install.**
```bash
npm install @tanstack/react-query @tanstack/react-query-devtools
```

**Files to create.**

```
src/lib/queryKeys.js          # centralized query key factory
src/lib/queryClient.js        # QueryClient configuration
src/hooks/useTargetBoard.js   # one hook per board endpoint
src/hooks/useProphet.js
src/hooks/useCatalyst.js
src/hooks/useInsider.js
src/hooks/useWilliams.js
src/hooks/useLynch.js
src/hooks/useEarnings.js
src/hooks/useHealth.js
src/hooks/useRegime.js
src/hooks/useAnalystsStatus.js
src/hooks/useResearch.js
src/hooks/useChartAnalysis.js
src/hooks/useSnapshotHistory.js
```

**queryKeys.js pattern.**
```js
export const queryKeys = {
  all: ['tradeiq'],
  targetBoard: (universe) => ['tradeiq', 'targetBoard', universe],
  prophet: (universe, conviction) => ['tradeiq', 'prophet', universe, conviction],
  earnings: (windowDays) => ['tradeiq', 'earnings', windowDays],
  // ...
};
```

**Hook pattern (illustrative, useTargetBoard.js).**
```jsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse';

export function useTargetBoard(universe) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.targetBoard(universe),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/target-board?universe=${universe}`, { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.targetBoard, 'target-board');
    },
    staleTime: 60_000,           // 1 min — boards refresh more often than this is wasteful
    refetchOnWindowFocus: true,
  });

  const forceRescan = async () => {
    const r = await fetchWithRetry(`/api/target-board?universe=${universe}&force=1`);
    const json = await r.json();
    if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
    qc.setQueryData(queryKeys.targetBoard(universe), validate(json, SHAPES.targetBoard, 'target-board'));
  };

  return { ...query, forceRescan };
}
```

**Per-board staleTime defaults** (match snapshot freshness from Phase 1):
- target-board, prophet, catalyst, williams: 60s (intraday)
- earnings: 5 min
- insider, lynch: 10 min
- health, regime, analysts-status: 30s

**FreshnessPill integration.**
Every view currently passes `data` and `onForceRescan` to FreshnessPill. After conversion:
```jsx
const { data, isFetching, forceRescan } = useTargetBoard(universe);
// ...
<FreshnessPill meta={data} isRescanning={isFetching} onForceRescan={forceRescan} />
```

**Provider wrap.**
In `src/main.jsx`, wrap `<App />` in `<QueryClientProvider>`:
```jsx
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { queryClient } from './lib/queryClient';

<QueryClientProvider client={queryClient}>
  <App />
  {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
</QueryClientProvider>
```

**Devtools only in dev.** Use `import.meta.env.DEV` to gate. Production bundle should not ship devtools.

**Files to modify.**
- Every view file (10+ files): replace `useState + useEffect + fetchWithRetry` with the matching hook
- `src/main.jsx`: add provider wrap

**Risk: cache invalidation on force-rescan.**
Existing pattern: force-rescan replaces local state. New pattern: force-rescan must update the query cache via `setQueryData` so other components reading the same cache see the fresh data. Don't use `invalidateQueries` for force — that triggers a refetch instead of replacing the data, defeating the purpose of the user-initiated rescan. Use `setQueryData`.

**Tests.**
Add unit tests for one or two hooks proving:
- staleTime is respected
- forceRescan replaces cache (not refetch)
- queryFn handles error responses correctly

Don't aim for full coverage on hooks — they're thin wrappers. Two-three representative tests is enough.

**Validation.**
- `npm test` passes (existing 70+ tests + new schema tests + new hook tests)
- `npm run build` succeeds
- Bundle size: TanStack Query adds ~13kB gzipped — note this in PR description but don't try to optimize it
- Manual: switch tabs rapidly, confirm no duplicate network requests for the same query
- Manual: force-rescan a board, confirm UI updates immediately

---

## Standing rules (apply to every commit)

- ALWAYS bump `APP_VERSION` in `src/App.jsx`. Phase 2 ships `0.11.0-alpha` (minor bump for the refactor layer).
- Every data table column sortable via `useSortable` + `SortableTh`. No regressions.
- Every board view has a `FreshnessPill`. No regressions.
- Anything to be copied into another tool/conversation goes in a markdown doc or code block. Never plain prose.
- Critical data ingest preserves four layers (raw bytes, raw rows, parsed, aggregations). Phase 2 doesn't change ingest, but if you find yourself simplifying a provider response to "just the fields we use" — STOP. That's a regression.
- Brand blue: `#1e5b92` (Davis Delivery family — TradeIQ stays neutral dark).
- CI must stay green throughout. Push commits as you complete each workstream so CI runs incrementally.

---

## Deploy pattern

After your PR is merged to main, Netlify auto-deploys. Verify:
1. Wait 60s post-merge.
2. Curl the live site, extract the bundle path, download it, grep for version.
3. Expect `0.11.0-alpha`.
4. Smoke-test: hit each board on the live site (target, prophet, catalyst, insider, williams, lynch, earnings, history). Force-rescan one of them and confirm UI updates.

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
git checkout -b phase-2-refactor-foundation
```

---

## Commit and PR protocol

Commit per workstream, granular within. Examples:

- `phase-2(zod): install zod + base schema scaffolding`
- `phase-2(zod): polygon schemas (bars, financials, news, ticker)`
- `phase-2(zod): finnhub schemas (earnings, recommendations, profile)`
- `phase-2(zod): quiver schemas (insider, political, contracts, lobbying, patents)`
- `phase-2(zod): fred schemas + wire all providers through safeParse`
- `phase-2(zod): 30+ schema tests across all providers`
- `phase-2(split): extract TargetBoardView, RegimeView, AnalystsView`
- `phase-2(split): extract EarningsView, OptionsFlowView, BacktestView`
- `phase-2(split): extract EngineTestView, AlertsView, SettingsView`
- `phase-2(split): MOCK_* constants → src/lib/mockData.js`
- `phase-2(query): install @tanstack/react-query + provider wiring`
- `phase-2(query): board hooks (target, prophet, catalyst, insider, williams, lynch, earnings)`
- `phase-2(query): non-board hooks (health, regime, analysts, research, chart, snapshot-history)`
- `phase-2(query): wire all views to hooks; remove ad-hoc fetch+useState patterns`
- `phase-2(query): hook tests + force-rescan verification`
- `phase-2(docs): version bump 0.11.0-alpha + ORCHESTRATOR status`

**PR title.** `Phase 2: Refactor foundation — Zod boundaries + monolith split + TanStack Query (v0.11.0-alpha)`

**PR description (in `briefs/phase-2-pr-description.md` on the branch).** Must include:
- Confirmation of Phase 0 + Phase 1 dependencies satisfied
- Test count (existing + new)
- App.jsx line count before/after
- Bundle size before/after (and the +13kB TanStack Query note)
- Manual smoke-test results per board
- Any unexpected scope items surfaced

---

## Status table update (do this last)

After deploy verifies live and version matches, edit `ORCHESTRATOR.md` Status table:

```
| 2 | Refactor foundation (schemas + monolith split + TanStack Query) | done | 0.11.0-alpha | YYYY-MM-DD | Zod at all 5 provider boundaries; App.jsx 2965 -> ~XXX lines; 14 view hooks via TanStack Query |
```

Direct push to main (doc-only edit, branch protection should allow with admin override or post-merge update).

---

## Success criteria (testable definition of done)

All must be true before marking Phase 2 done:

- [ ] Every external API call in providers wraps through a Zod `safeParse`
- [ ] 30+ new schema tests added; CI green
- [ ] App.jsx ≤ 800 lines, contains only shell/routing
- [ ] All 9 inline views extracted to per-file modules matching the existing pattern
- [ ] `MOCK_*` constants in `src/lib/mockData.js`
- [ ] `@tanstack/react-query` provider in `src/main.jsx`
- [ ] All board endpoints have a corresponding `useXxx` hook
- [ ] Every view uses its hook (no remaining `useEffect + fetch + setState` patterns for server data)
- [ ] FreshnessPill integration intact on all 7 board views
- [ ] `useSortable` + `SortableTh` intact on all data tables
- [ ] `npm test` ≥ 100 tests, all green
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` clean
- [ ] Bundle size ≤ 820kB gzipped (current ~789kB + ~13kB for TanStack Query budget)
- [ ] `APP_VERSION` = `0.11.0-alpha`, verified live
- [ ] All 7 board views smoke-tested on live deploy
- [ ] ORCHESTRATOR.md Status table shows Phase 2 as `done`

---

## What to do if blocked

- **Schema mismatch on a real response.** Don't tighten the schema to match — vendor sent a value that wasn't documented. Use `.optional()` or `.passthrough()` and document the discovery in the schema file's comments.
- **A view's state is too entangled to extract cleanly.** Extract anyway, leaving complex state in props. Don't try to refactor business logic during the split — only the file move.
- **TanStack Query tests are flaky.** Tests for hooks need a `QueryClientProvider` wrapper. Use `@tanstack/react-query`'s `renderHook` from `@testing-library/react`. If still flaky, accept and note — hook integration tests are notoriously fragile, and the live smoke tests catch the real issues.
- **Bundle size blows past 820kB.** Don't ship the increase to production. Code-split a heavy view (the BacktestView is the most likely candidate) using dynamic import to bring it back down.
- **Surfacing a Phase 1 bug during refactor.** Document in PR but don't fix in this PR. Open a follow-up issue.

---

## Out of scope for Phase 2

These are tempting but defer:
- Refactoring backend scoring logic (Phase 4 territory).
- Changing snapshot store schema or adding new snapshot fields (Phase 1 territory; locked).
- Adding new API endpoints or features (none in Phase 2).
- Changing the `validateResponse.js` SHAPES — those stay as-is, with Zod added underneath. Replacing them is Phase 13 polish.
- Reducing scoring math precision or aggregating provider data "to save bytes." Standing rule.
- Adding code-splitting beyond what's needed to keep the bundle under 820kB.
- Adding any animation, UI polish, or design changes.
- Touching anything in `briefs/`, `docs/`, `scripts/`.

If you find yourself reaching into Phase 3+ work, stop and note in PR description.

---

## First actions

```bash
# 1. Get the working tree
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b phase-2-refactor-foundation

# 2. Confirm preconditions
grep "^| 0\|^| 1" ORCHESTRATOR.md
ls .github/workflows/
npm ci --silent
npm test 2>&1 | tail -3

# 3. Survey state before refactoring
wc -l src/App.jsx
grep -n "^const.*View = " src/App.jsx
ls netlify/functions/shared/

# 4. Workstream 1 — install zod, start with one provider
npm install zod
```

Then proceed: Workstream 1 (Zod) → Workstream 2 (App.jsx split) → Workstream 3 (TanStack Query). Each workstream in its own commit chain, push as you go so CI runs incrementally.

---

End of brief. Begin work.
