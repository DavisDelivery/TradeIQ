# Phase 4b-2 — Backtest run launcher

**Author:** orchestrator
**Target version:** 0.15.0-alpha
**Dependencies:** Phase 4a + 4a-fix-1..4 (engine + persistence) ✓ merged; Phase 4b-1 (read-only viewer) ✓ merged at `2c29c8f`. Both preconditions sit on `main` as of writing.
**Status when this brief is written:** main = `2c29c8f`, APP_VERSION = `0.14.0-alpha`, 311 tests passing, bundle 255.38 kB gzipped.

---

## Why this exists

Phase 4b-1 shipped the read-only viewer. Today users still launch backtests via CLI:

```
npx tsx scripts/run-backtest.ts --config configs/dow-2018-2024-monthly-top20.json
```

That's fine for me, painful for anyone who isn't sitting at a terminal. 4b-2 puts the launcher in the UI: pick a universe, pick a date range, pick a board, hit Run. While the run executes (5–15 min for non-russell2k configs), poll the run row until it flips `status: running` → `complete`, then auto-select it in the run list.

The trade-off everyone hits: Netlify's HTTP gateway times out outbound requests at **211 seconds**. Backtests take 5–15 minutes. So the run cannot happen inside the request/response cycle of the launcher POST. The path that works — proven by `seed-scan-background.ts` in PR #14 — is the **`-background.ts` filename suffix**: any Netlify function whose file ends in `-background.ts` gets the 15-minute background container even when invoked via HTTP. The launcher endpoint returns 202 with a `runId` in <1 second, the actual `runBacktest()` work continues in the background, and the engine's existing `persistRunStart` → `persistRunResult` / `persistRunFailure` chain in `engine.ts` keeps Firestore in sync. The UI polls `/api/backtest-runs/:runId` (already exists, no new endpoint needed) to surface progress.

This means the entire 4b-2 backend reduces to **one new file**: `netlify/functions/run-backtest-background.ts`. Plus a thin POST handler that triggers it. The bulk of the brief is the form UI + polling state machine + tests.

---

## Operational context (every brief preamble)

- Repo: `DavisDelivery/TradeIQ`
- Netlify site: `tradeiq-alpha.netlify.app` (site ID `8e90d525-78f3-4288-9c15-8b1968e994c1`)
- Firebase project: `tradeiq-alpha`
- Read-only `GITHUB_PAT` for in-session reads: `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`. **Chad provides a fresh write-scope PAT per agent session.** Do not push without one.
- Conventions reinforced again:
  - **Bump APP_VERSION on every user-visible change.** `0.14.0-alpha` → `0.15.0-alpha`.
  - Every data table column sortable via `useSortable` + `SortableTh`. (Not applicable here — the launcher has no table.)
  - Mobile-first, single column, phone-sized typography. Form fields stack vertically on `<sm`, 2-column grid `≥sm`.
  - Never deploy from a build chat. Push to a feature branch; Chad merges.
  - `ts c --noEmit`, `npm test`, `npm run build` must all be clean before opening the PR.

---

## W0 — Preconditions (verify, do not skip)

1. `git fetch origin && git log --oneline -3` — confirm main is at `2c29c8f` or later; if newer commits exist they're additive and shouldn't conflict.
2. `npm ci && npm test` — confirm 311 tests passing as a baseline. If anything fails on a clean tree, stop and report.
3. `npm run build` — confirm clean build, capture gzipped bundle size as the "before" number.
4. Read `briefs/phase-4b-pr-description.md` and `briefs/seed-scan-background-brief.md` (if present from PR #14) to internalize the background-function pattern.
5. Read `netlify/functions/seed-scan-background.ts` (the existing reference implementation) end-to-end. The 4b-2 background function is conceptually identical: 202 trigger → background container → engine work → Firestore writes → silent exit.
6. Read `scripts/run-backtest.ts` to understand the CLI's exact `runBacktest()` invocation pattern. The new background function calls the same entry point with the same config shape — DO NOT introduce a parallel engine surface.

---

## W1 — Background function: `run-backtest-background.ts`

**File:** `netlify/functions/run-backtest-background.ts`

This is the entire backend, top to bottom:

```ts
import type { Handler } from '@netlify/functions';
import { runBacktest } from './shared/backtest/engine';
import { DEFAULT_COSTS } from './shared/backtest/costs';
import type { BacktestConfig } from './shared/backtest/types';
import { logger } from './shared/logger';
import { withSentry } from './shared/sentry';

export const handler: Handler = withSentry(async (event) => {
  // POST body is the BacktestConfig the launcher sent. Trigger endpoint
  // already validated; minimal re-check here for defense-in-depth.
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const log = logger.child({ fn: 'run-backtest-background' });

  let config: BacktestConfig;
  try {
    config = JSON.parse(event.body ?? '{}');
  } catch (e: any) {
    log.error('config_parse_failed', { err: String(e?.message ?? e) });
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid config json' }) };
  }

  log.info('background_run_started', {
    universe: config.universe,
    startDate: config.startDate,
    endDate: config.endDate,
    board: config.board,
    rebalance: config.rebalanceFrequency,
  });

  // runBacktest() does its own persistence: persistRunStart at the top,
  // persistRunResult / persistRunFailure at the bottom. We just await
  // it and let exceptions bubble — withSentry captures them.
  try {
    const result = await runBacktest(config, {
      onProgress: (event) => {
        log.info('progress', event);
      },
    });
    log.info('background_run_complete', { runId: result.runId, trades: result.metrics.trades });
    return { statusCode: 202, body: JSON.stringify({ ok: true, runId: result.runId }) };
  } catch (err: any) {
    // persistRunFailure already wrote the failure record to Firestore.
    log.error('background_run_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
});
```

**Why the suffix `-background.ts`:** Netlify's bundler treats any function whose filename ends in `-background.ts` (or `.js`) as a background function with a 15-minute container window. The HTTP gateway accepts the POST and returns immediately; the handler keeps running. This is the same trick `seed-scan-background.ts` uses. Confirmed in production.

**Tests:** Skip integration tests against the live engine in the unit suite — too slow, too flaky. Instead:

- Add a mock-engine test in `netlify/functions/__tests__/run-backtest-background.test.ts` that uses `vi.mock('../shared/backtest/engine', () => ({ runBacktest: vi.fn().mockResolvedValue({ runId: 'mock', metrics: { trades: 0 } }) }))` and verifies the handler:
  - Returns 405 for non-POST
  - Returns 400 for non-JSON body
  - Returns 202 with `{ ok: true, runId }` on engine success
  - Returns 500 with the error message on engine throw
  - Logs `background_run_started` and `background_run_complete`

---

## W2 — Trigger endpoint: `POST /api/backtest-runs`

**File:** `netlify/functions/backtest-runs-trigger.ts` (new file, sibling to `backtest-runs-list.ts` and `backtest-runs-get.ts`)

This is the synchronous endpoint the UI POSTs to. Its job:

1. Validate the config shape using `validateConfig` from `engine.ts` (export it if not already exported — re-using the engine's own validator avoids drift).
2. Enforce the **prophet-only** constraint on the board field — return 400 if `board !== 'prophet'`. Other boards' point-in-time scoring is incomplete (per `BACKTEST_LIMITATIONS.md`); accepting them would silently produce garbage backtest results.
3. **Singleflight check:** query `backtestRuns` for any document with `status in ('pending', 'running')` and `startedAt > now - 30 minutes`. If found, return 409 with `{ ok: false, error: 'a backtest is already running', runId: <existing> }`. Chad is the only user; this prevents accidental double-launch from a mistimed second click, not a real concurrency problem.
4. Fire-and-forget POST to the background function. The background function will call `persistRunStart` immediately and write the run record with `status: 'pending'`, so the launcher CAN'T know the runId synchronously. Two ways to solve:
   - **Path A (preferred):** Move `generateRunId()` + `persistRunStart()` into the trigger endpoint. The trigger generates the runId, persists the row with `status: 'pending'`, then POSTs the runId + config to the background function. Background function calls a new `persistRunResume(runId)` helper that flips `pending` → `running`, then executes. Trigger returns `{ ok: true, runId }` immediately.
   - **Path B:** Trigger POSTs the config blind, background generates the runId; the UI has to poll an "in-flight runs" endpoint to discover the new runId. More work, less direct UX. Skip.
5. The fire-and-forget POST itself: use `fetch('https://tradeiq-alpha.netlify.app/.netlify/functions/run-backtest-background', { method: 'POST', body: JSON.stringify({ runId, config }) })` with a short timeout — we don't await the response. (In production functions can call each other via this internal URL; cold-start latency is sub-second.)

**Endpoint shape:**

```
POST /api/backtest-runs
Content-Type: application/json
Body: BacktestConfig

Responses:
  202 { ok: true, runId: "bt_..." }
  400 { ok: false, error: "<validation message>" }
  409 { ok: false, error: "...", runId: "bt_..." }   ← existing in-flight run
  500 { ok: false, error: "..." }
```

Add a redirect rule in `netlify.toml`:

```toml
[[redirects]]
  from = "/api/backtest-runs"
  to = "/.netlify/functions/backtest-runs-trigger"
  status = 200
  conditions = { method = "POST" }
```

Note that there's already a redirect for `/api/backtest-runs` → `backtest-runs-list` for GET (added in 4b-1). Adding the method-conditioned redirect means GET still hits the list endpoint, POST hits the trigger. Verify the precedence rules in `netlify.toml` (most-specific first; the conditioned redirect must come BEFORE the unconditional one).

**Tests:** `netlify/functions/__tests__/backtest-runs-trigger.test.ts`:

- 405 on GET (defense — the redirect handles routing, this is belt-and-suspenders)
- 400 on missing required field
- 400 on `board !== 'prophet'`
- 409 when an in-flight run exists (mock Firestore query to return one)
- 202 with `runId` on happy path (mock Firestore to return empty in-flight; mock fetch to the background URL; verify trigger awaits `persistRunStart` and returns the generated runId)

---

## W3 — Hook: `useStartBacktest`

**File:** `src/hooks/useStartBacktest.js`

Standard TanStack `useMutation`:

```js
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';

export function useStartBacktest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (config) => {
      const r = await fetch('/api/backtest-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const json = await r.json();
      if (!r.ok || json?.ok === false) {
        // Wrap 409 specially so the caller can surface the in-flight runId.
        const err = new Error(json?.error || `HTTP ${r.status}`);
        err.status = r.status;
        err.runId = json?.runId;
        throw err;
      }
      return json; // { ok, runId }
    },
    onSuccess: () => {
      // The new run will appear on the list — invalidate so the viewer
      // refetches and the user sees it in the recent-runs pane.
      qc.invalidateQueries({ queryKey: queryKeys.backtestRuns() });
    },
  });
}
```

No new query keys; the existing `backtestRuns` and `backtestRun` keys cover everything.

**Tests:** `src/hooks/__tests__/useStartBacktest.test.jsx` — three cases:

- Successful POST returns `{ ok, runId }` and the queryClient was invalidated for the list key.
- 400 response surfaces as `mutation.error` with a readable message.
- 409 response surfaces as `mutation.error` with both `error.status === 409` and `error.runId` set, so the caller can show "a backtest started at HH:MM is still running — view it" and link to that run.

---

## W4 — Launcher UI: `BacktestLauncher.jsx`

**File:** `src/components/BacktestLauncher.jsx`

This is the visible deliverable. Replaces `LauncherPlaceholder` (the static stub that 4b-1 dropped in). Mobile-first form, single column on phone, 2 columns on `≥sm`. Inline validation, no submit-time round-trip surprises.

### Form fields (mapping to `BacktestConfig`)

| UI control | Type | Field | Default | Constraints |
|---|---|---|---|---|
| Universe | radio group | `universe` | `dow` | `dow` / `sp500` / `ndx` / `russell2k`; show ⚠ on `sp500`/`ndx` (uncorrected); show ⏱ on `russell2k` (may exceed 15-min cap) |
| Start date | `<input type="date">` | `startDate` | `2018-01-01` | min `2018-01-01`, max `endDate - 90 days`; help text "snapshot history starts 2018-01" |
| End date | `<input type="date">` | `endDate` | today − 30 days | min `startDate + 90 days`, max today − 1 day |
| Rebalance | radio group | `rebalanceFrequency` | `monthly` | `weekly` / `monthly` / `quarterly`; help text on weekly: "more trades = more slippage drag" |
| Board | radio group (4 options, only `prophet` enabled) | `board` | `prophet` | Other boards rendered but `disabled`; tooltip "incomplete point-in-time scoring; Phase 4a leaves this for later" with link to `BACKTEST_LIMITATIONS.md` |
| Top N | number input | `portfolio.topN` | `20` | min 5, max 50 |
| Initial capital | number input | `initialCapital` | `100000` | min 10_000, max 10_000_000 |
| Min composite | number input (collapsed under "Advanced") | `portfolio.minComposite` | `50` | 0–100 |
| Max position % | number input (under "Advanced") | `portfolio.maxPositionPct` | `0.10` | 0.01–0.50 |
| Max sector % | number input (under "Advanced") | `portfolio.maxSectorPct` | `0.40` | 0.05–1.0 |
| Cash sleeve | number input (under "Advanced") | `portfolio.cashSleeve` | `0.05` | 0–0.50 |
| Weighting | radio (under "Advanced") | `portfolio.weighting` | `equal` | `equal` / `composite` |

`costs` and `scoringConcurrency` use `DEFAULT_COSTS` and `5` respectively — not exposed in the UI. (Future option, not 4b-2.)

### Survivorship pre-warning

When the user selects `sp500` or `ndx` as the universe, render a smaller variant of `SurvivorshipBanner` (the same component used in the run detail) inline below the universe picker — same red treatment, same "not corrected" language, same link. Submit is allowed but the user has seen the warning before they clicked Run, not just after.

### Russell2k pre-warning

When `russell2k` is selected, render an amber (not red) inline banner: "Russell2k backtests may exceed the 15-minute function cap; partial results will be stamped accordingly. Consider dow/sp500/ndx first." Submit allowed; this is informational, not blocking.

### Submit behavior

- Button label: `RUN BACKTEST` (caps, mono, matches the BACKTEST header in the parent view).
- While `mutation.isPending`, button label changes to `LAUNCHING…` and button is disabled.
- On 202 success: surface a green "Backtest queued — runId: bt_…" toast/banner above the form, then within ~3 seconds (after the queryClient invalidation propagates) the run should appear at the top of the runs list in the parent view. Auto-select it via `setSelectedRunId(data.runId)` (the launcher receives this setter as a prop from BacktestView — see W5).
- On 400: inline error banner above the submit button, persisting until the user changes any input.
- On 409: red banner saying "A backtest is already running (runId: <id>). [View it]" — clicking the link calls `setSelectedRunId(error.runId)` to jump the parent view to that run.
- On network/500: red banner saying "Failed to launch: <message>. Try again?" with a retry button.

### Polling integration

Once a launch returns 202 with a runId, BacktestView (already using `useBacktestRun(selectedRunId)` from 4b-1) is now reading the in-flight run. We need to **poll** while the run is incomplete. The cleanest patch in `useBacktestRun.js`:

```js
return useQuery({
  queryKey: queryKeys.backtestRun(runId),
  queryFn: ...,
  enabled: !!runId,
  // Phase 4b-2: poll while the run is still pending or running.
  // staleTime stays Infinity for complete runs (immutable), but we
  // refetch every 5s if the latest fetch shows in-flight status.
  staleTime: Infinity,
  refetchInterval: (data) => {
    const status = data?.run?.status;
    if (status === 'pending' || status === 'running') return 5_000;
    return false;
  },
});
```

That single change makes the UI come alive when a run starts. No new component, no separate polling hook.

### Tests

`src/__tests__/BacktestLauncher.test.jsx` — at minimum:

- Renders with default config (verify `dow`, `2018-01-01`, `monthly`, `prophet`, `20`, `100000`).
- Non-prophet board buttons are rendered with `disabled` and a tooltip.
- Selecting `sp500` reveals the `SurvivorshipBanner`.
- Selecting `russell2k` reveals the amber pre-warning.
- Date validation: start ≥ 2018-01-01 (typing earlier date sets `aria-invalid`, blocks submit).
- Submit calls the mutation with the right config shape (mock `useStartBacktest` to return a controlled `mutate`).
- 202 response: banner shows runId, `setSelectedRunId` was called with the new runId.
- 409 response: banner shows in-flight error with the existing runId.

Plus update `src/__tests__/SurvivorshipBanner.test.jsx` if the banner's compact variant requires a new prop like `compact={true}`. (Author's call — either reuse the existing component verbatim or introduce a `compact` prop. Prefer reuse.)

---

## W5 — Wire it into `BacktestView`

**File:** `src/BacktestView.jsx`

Two small changes:

1. Replace `<LauncherPlaceholder />` with `<BacktestLauncher setSelectedRunId={setSelectedRunId} />`. Remove the now-unused `LauncherPlaceholder` inner component.
2. The `useBacktestRun` poll-while-incomplete change from W4 already lives in the hook file, no edits here.

That's it. The 4b-1 layout was designed so the launcher slots into the spot the placeholder occupied. No structural changes to the view.

---

## W6 — Engineering hygiene

- `validateConfig` in `engine.ts` may not be exported today; export it so the trigger endpoint can reuse it. If exporting it introduces a circular import, factor it into a tiny `netlify/functions/shared/backtest/validate-config.ts` module that both engine.ts and the trigger endpoint import.
- Confirm `persistRunStart`, `persistRunResult`, `persistRunFailure` in `persistence.ts` all set/transition `status` correctly: `persistRunStart` should set `'pending'`, the engine should transition to `'running'` once the first rebalance starts, `persistRunResult` to `'complete'`, `persistRunFailure` to `'failed'`. If the engine doesn't currently set `'running'` after `persistRunStart`, add it — without that transition, the poll-while-incomplete logic can't tell the difference between "queued, not started" and "actively scoring tickers." This is a 1-line addition near the top of the rebalance loop in `engine.ts`.
- Net new tests target: ≥10. Add to the 311 baseline. Brief target: **≥321 tests passing.**

---

## W7 — Version bump + docs + PR

- `APP_VERSION` in `src/App.jsx`: `0.14.0-alpha` → `0.15.0-alpha`.
- `ORCHESTRATOR.md` — update the 4b-2 row from `pending` to `done`, fill in the date and version, and write the same narrative-style summary used in 4b-1. Include the architectural callouts:
  - 15-minute background-function cap leveraged via `-background.ts` suffix
  - Single-flight 30-minute lock on simultaneous launches (409 Conflict)
  - Prophet-only enforcement at server + client + UI tooltip
  - Polling integrated into the existing `useBacktestRun` hook (no new hook for polling)
- Add a row for Phase 4b-3 as `pending`: "Run cancellation + config presets + saved templates." Leaves the runway clear for the next iteration.
- PR description in `briefs/phase-4b-2-pr-description.md` covering: workstreams, trade-offs, file-diff table, before/after test count, bundle delta, manual verification steps.

---

## Verification (must pass before opening the PR)

1. `npx tsc --noEmit` — clean.
2. `npm test` — all tests passing, ≥321 total.
3. `npm run build` — clean. Capture the bundle delta. **Budget: net +5 kB gzipped.** If the form adds more than that, reach for code-splitting the launcher behind a dynamic import.
4. Manual smoke test on the deploy preview after pushing:
   - Open the deploy-preview URL, navigate to BACKTEST tab.
   - Submit a dow / 2018-01-01 / 2018-04-01 / monthly / prophet / topN=10 / capital=$10k config (the smallest cheap run — should finish in <2 minutes).
   - Watch the run appear in the list with `status: pending`, transition to `running`, then `complete`. The auto-select should land you in the run detail.
   - Open a second tab, hit the same launcher with another config. Expect 409 with the existing runId.
   - In the same session, after the first run completes, launch a second dow run. Expect 202 with the new runId.
5. Sentry should show no new errors from the new endpoints. Failed configs should land as `background_run_failed` log events, not Sentry exceptions (unless the engine itself throws unexpectedly).

---

## Out of scope (explicit — do not do these now)

- **Run cancellation.** A user starts a russell2k run, regrets it, no way to stop it. The function will hit the 15-min cap and exit; the runId will end with `status: failed` and a "container timed out" message. Acceptable. Cancellation is Phase 4b-3 — needs a Firestore-backed cancellation token the engine polls between rebalances.
- **Config presets / saved templates.** Power-user feature. 4b-3.
- **Multi-board configs.** "Run on prophet AND target" — separate runs by definition. Trigger has to be called twice. UI can sugar that later.
- **Real-time progress beyond `status`.** No "Rebalance 6 of 84" progress bar — engine doesn't emit granular events to Firestore yet; adding it is a non-trivial engine touch. 4b-3.
- **Resumable runs after function timeout.** If the 15-min cap kills a russell2k run, the runId is left in `status: failed`. Resuming from a checkpoint is a Phase 5 conversation (touches the engine itself).
- **Config validation on the wire format level.** The engine's `validateConfig` is the only validator; we lean on it. Don't add a parallel Zod schema unless a real shape-drift bug emerges.

---

## File diff (target shape)

```
netlify/functions/run-backtest-background.ts                       NEW   ~60 lines
netlify/functions/backtest-runs-trigger.ts                         NEW   ~110 lines
netlify/functions/__tests__/run-backtest-background.test.ts        NEW   ~80 lines
netlify/functions/__tests__/backtest-runs-trigger.test.ts          NEW   ~140 lines
netlify/functions/shared/backtest/engine.ts                        edit  ~5 lines (export validateConfig, set status='running')
netlify.toml                                                       edit  ~6 lines (POST redirect)
src/components/BacktestLauncher.jsx                                NEW   ~250 lines
src/__tests__/BacktestLauncher.test.jsx                            NEW   ~150 lines
src/hooks/useStartBacktest.js                                      NEW   ~30 lines
src/hooks/__tests__/useStartBacktest.test.jsx                      NEW   ~80 lines
src/hooks/useBacktestRun.js                                        edit  ~5 lines (refetchInterval while in-flight)
src/BacktestView.jsx                                               edit  ~10 lines (wire launcher in, remove placeholder)
src/App.jsx                                                        edit  1 line (APP_VERSION)
ORCHESTRATOR.md                                                    edit  4b-2 row + 4b-3 row
briefs/phase-4b-2-pr-description.md                                NEW
```

About 14 files, ~1000 lines added net. Comparable to 4b-1 in scope.

---

## Note to the executing agent

The architecture above is intentional and tested in production (`seed-scan-background.ts` proves the background-function pattern works). If something doesn't behave as the brief says it should — particularly the `-background.ts` suffix being respected by Netlify's bundler, or the engine's persistence transitions — surface the actual behavior in the PR description rather than working around it silently. The "in-flight check" is the only piece I'm not 100% sure about; if the Firestore query for `status in ('pending', 'running') AND startedAt > now - 30min` requires a composite index that doesn't exist yet, add it to `firestore.indexes.json` and note the deploy step (Chad runs `firebase deploy --only firestore:indexes` himself; do not run it from the build container).

When in doubt about UI styling, mirror the rest of TradeIQ: neutral dark, narrow borders (`border-neutral-800`), mono labels with `0.2em` tracking, phone-sized typography. The 4b-1 run-detail layout is your style reference.

Ship it.
