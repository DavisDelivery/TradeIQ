# Phase 4b-2: Backtest run launcher (v0.15.0-alpha)

UI launch of Phase 4a backtests. CLI still works
(`npx tsx scripts/run-backtest.ts`), but the phone-friendly path is now:
open Backtest tab → fill out the form → tap RUN BACKTEST → watch the run
transition from `pending` → `running` → `complete` live in the run-detail
view as the engine grinds through it.

## Phase 4b-1 dependency confirmation

- Phase 4a (engine + correctness) — `done` @ 0.13.0-alpha (PR #7)
- Phase 4b-1 (read-only viewer) — `done` @ 0.14.0-alpha (PR #15)

Baseline before this PR: 331 tests passing on `main` at `2c29c8f`.
After: **367 passing (+36 new)**, `npx tsc --noEmit` clean, build clean.

## The shape

Backend (entire surface area = 2 new endpoints):

```
POST /api/backtest-runs              → backtest-runs-trigger.ts        (sync, <1s)
POST /.netlify/functions/             → run-backtest-background.ts     (15-min bg)
       run-backtest-background
```

Frontend (3 new pieces of state):

- `useStartBacktest` mutation hook → fires `POST /api/backtest-runs`
- `useBacktestRun` patched with `refetchInterval` → polls every 5s while
  the run is `pending` or `running`, stops on `complete`/`failed`
- `BacktestLauncher` component → replaces the 4b-1 launcher placeholder

## Why background functions

Netlify HTTP gateways time out at 211s. Backtests take 5–15 minutes. The
only way to run the engine end-to-end via HTTP without a paid add-on is
Netlify's `-background.ts` filename convention: any function whose file
ends in this suffix is bundled with a 15-min container window. The
gateway accepts the POST, returns 202 immediately, and the handler
keeps running. This is the same pattern `seed-scan-background.ts` has
been using in production since PR #14.

## Workstreams

### W1 — `run-backtest-background.ts`

`netlify/functions/run-backtest-background.ts`. Accepts `{ runId, config }`
from the trigger. Flips `pending → running` via the new
`persistRunRunning` helper, then awaits `runBacktest(config, { resumeRunId })`.
The engine's existing `persistRunResult` / `persistRunFailure` paths write
the terminal status; if it throws, the engine has already persisted
the failure record by the time the catch block here runs. Wrapped in
`withSentry` so unhandled exceptions get captured.

**Persistence schema changes** (`shared/backtest/persistence.ts`):

- New `persistRunPending(runId, config)` — writes `status: 'pending'`
  + `startedAt`. Called by the trigger endpoint.
- New `persistRunRunning(runId)` — merge-flip `pending → running`.
  Called by the background function before kicking the engine.
- Top-of-file docstring updated to document the four-state lifecycle
  (`pending → running → complete | failed`).
- CLI path unchanged: `persistRunStart` still writes `'running'`
  directly because the CLI invokes `runBacktest` synchronously and
  there's no queued window.

**Engine change** (`shared/backtest/engine.ts`):

- `validateConfig` exported (was module-private). Reused by the trigger
  endpoint so we can't drift.
- `RunBacktestOptions.resumeRunId` added — when set, the engine skips
  `generateRunId` AND skips `persistRunStart` (the trigger already wrote
  `pending`, the background already flipped to `running`; re-running
  `set()` would clobber the transition).

**Tests** (`__tests__/run-backtest-background.test.ts`, 7 cases): 405 on
GET, 400 on bad JSON, 400 on missing runId, 400 on missing config,
happy path with `resumeRunId` passthrough, defensive swallow of
`persistRunRunning` failure (transient Firestore hiccup shouldn't kill
an otherwise-valid engine run), 500 on engine throw with the error
message round-tripped.

### W2 — `backtest-runs-trigger.ts`

`netlify/functions/backtest-runs-trigger.ts`. Synchronous, <1s. Five
gates before returning 202:

1. **HTTP method** — 405 on non-POST.
2. **JSON parse** — 400 on bad body.
3. **validateConfig** — 400 with the engine's own error message (e.g.
   "startDate 2017-06-01 is before 2018-01-01").
4. **Prophet-only** — 400 if `board !== 'prophet'`. Other boards' PIT
   scoring is incomplete; accepting them would produce systematically
   biased backtests. See BACKTEST_LIMITATIONS.md.
5. **Single-flight** — query `backtestRuns` for any document with
   `status in ('pending', 'running')` (single-field `in` query, no
   composite index needed), filter the 30-min window in code. If
   found, 409 with the existing runId. Chad is the only user; this
   guards against an accidental double-click, not real concurrency.

On all-clear: generate runId, write `'pending'` row via `persistRunPending`,
fire-and-forget `POST` to `${origin}/.netlify/functions/run-backtest-background`
with `{ runId, config }`. Origin built from the request's
`x-forwarded-host` so deploy previews invoke their own background
function. Return 202 with the runId in <1s.

**netlify.toml**: two `/api/backtest-runs` redirects now coexist. POST
condition is listed FIRST (Netlify matches the first rule); unconditional
GET fallback second, still routing to `backtest-runs-list`.

**Tests** (`__tests__/backtest-runs-trigger.test.ts`, 9 cases): 405,
400 (bad JSON / startDate>endDate / pre-2018 floor / non-prophet),
409 with existing runId, 202 happy path with config-shape + background
dispatch assertion, deploy-preview host wiring, 500 on pending-write
failure (verifies we do NOT dispatch background when the queued-row
write itself failed — wouldn't have a Firestore record to land into).

### W3 — `useStartBacktest`

`src/hooks/useStartBacktest.js`. TanStack `useMutation`. Reads the
response as text first, then tries `JSON.parse`, so an HTML 500 page
or 502 from the gateway doesn't crash JSON.parse and the user gets
a useful error message. Annotates the thrown Error with `.status` and
(on 409) `.runId` so the launcher UI can render a "View existing run"
deep link. On 2xx, invalidates the `backtestRuns(20)` list query so
the new pending row pops to the top of the runs list.

**Tests** (`__tests__/useStartBacktest.test.jsx`, 4 cases): happy 202,
409 with `error.status=409` + `error.runId`, 400 with validation
message, non-JSON 502 falling through to a generic HTTP-status error.

### W4 — `BacktestLauncher` (visible deliverable)

`src/components/BacktestLauncher.jsx`. Mobile-first single-column form.
2-column grid on `sm+`. All local React state — no React Hook Form,
no Zod schema, because the field set is small and the server's
`validateConfig` is the source of truth for shape.

**Form fields** (mapping to `BacktestConfig`):

| UI | Field | Default | Constraint |
|---|---|---|---|
| Universe radio | `universe` | `dow` | dow/sp500/ndx/russell2k; ⚠ icon on uncorrected, ⏱ on russell2k |
| Start date | `startDate` | `2018-01-01` | ≥ 2018-01-01 |
| End date | `endDate` | today − 30d | ≤ today; window ≥ 90 days |
| Rebalance radio | `rebalanceFrequency` | `monthly` | weekly/monthly/quarterly |
| Board radio | `board` | `prophet` | only prophet enabled; others tooltipped to BACKTEST_LIMITATIONS.md |
| Top N | `portfolio.topN` | `20` | 5..50 |
| Capital | `initialCapital` | `100000` | $10K..$10M |
| (Advanced) Min composite | `portfolio.minComposite` | `50` | 0..100 |
| (Advanced) Max position % | `portfolio.maxPositionPct` | `0.10` | 0.01..0.5 |
| (Advanced) Max sector % | `portfolio.maxSectorPct` | `0.40` | 0.05..1.0 |
| (Advanced) Cash sleeve | `portfolio.cashSleeve` | `0.05` | 0..0.5 |
| (Advanced) Weighting | `portfolio.weighting` | `equal` | equal/composite |

**Inline pre-warnings**:

- Sp500/Ndx selection → reuses the existing `SurvivorshipBanner` (same
  component used in run-detail) with a synthetic `{ corrected: false }`
  stamp. Reuse, not fork.
- Russell 2k selection → amber Clock-icon banner about the 15-min cap.

**Submit outcomes**:

- 202 → green CheckCircle2 success banner + `setSelectedRunId(runId)`.
  Parent view navigates to the new run's detail panel; `useBacktestRun`
  starts polling at 5s intervals because `status: 'pending'`.
- 409 → red banner: "A backtest is already running" + "View existing
  run →" deeplink that calls `setSelectedRunId(error.runId)`.
- 400 → red banner with the server's validation message + Retry.
- 5xx / network → same red banner shape + Retry.

**Tests** (`src/__tests__/BacktestLauncher.test.jsx`, 14 cases): 9
end-to-end with mocked fetch (defaults, disabled boards with tooltip,
sp500 banner reveal, russell2k pre-warning reveal, pre-2018 startDate
blocks submit with aria-invalid, happy 202 with config-shape +
setSelectedRunId assertion, 409 deeplink-click setSelectedRunId,
pending spinner, Advanced toggle), 5 unit tests of form helpers
(validateForm valid baseline, <90-day window, pre-2018 floor, topN
out-of-range, buildConfig shape).

### W5 — Wire into BacktestView

`src/BacktestView.jsx`: replaced `<LauncherPlaceholder />` with
`<BacktestLauncher setSelectedRunId={setSelectedRunId} />`, deleted
the now-unused inner `LauncherPlaceholder` component (it was a
documentation stub from 4b-1), dropped the orphaned `Activity` icon
import. The 4b-1 layout was designed so the launcher slots into the
same spot as the placeholder — zero structural changes.

### W6 — Polling integration

`src/hooks/useBacktestRun.js`: added `refetchInterval` that inspects
`query.state.data?.run?.status` and returns 5000 for `pending|running`,
`false` for `complete|failed`. Once a run reaches a terminal state,
polling stops on the same fetch that observed the transition — the
final metrics + subcollections all arrive in that payload. `staleTime:
Infinity` guarantee for terminal runs preserved.

**Tests** (added to existing `useBacktestRuns.test.jsx`, 2 cases): a
3-fetch transition `pending → running → complete` with vitest's fake
timers + 30s of post-completion silence asserting no further fetches,
and zero-poll on a run that starts terminal. `advanceTimersByTimeAsync`
calls wrapped in `act()` to suppress the React 18 + TanStack v5 warning
that surfaced before the wrap.

### W7 — Version + ORCHESTRATOR + PR

- `APP_VERSION` → `0.15.0-alpha`
- ORCHESTRATOR row 4b-2 marked `done` @ 0.15.0-alpha with the
  architectural callouts (15-min background-function cap leveraged
  via filename suffix, single-flight 30-min lock, prophet-only at
  server + client + UI tooltip, polling integrated into existing hook
  rather than new hook).
- ORCHESTRATOR row 4b-3 added as `pending`: "Run cancellation +
  config presets + saved templates" (folds in granular progress as
  the engine-side dependency).

## Decisions worth pinning

1. **`pending` as a real state, not a synthetic UI mode.** The trigger
   endpoint writes `status: 'pending'` to Firestore before dispatching
   the background. This means:
   - The runId is visible in the runs list immediately, even if the
     background function takes 2-3s to cold-start.
   - The single-flight check has a stable signal — no race where one
     request is mid-dispatch and another asks "is anything running?"
     and gets "no" because the background hasn't written its row yet.
   - The polling logic in the run-detail view sees `pending` and
     stays in polling mode, so the UI doesn't blink between "loading"
     and "no run found" during the brief queued window.

2. **Single-flight via single-field query, no composite index.**
   `where('status', 'in', ['pending', 'running'])` returns ≤20 rows
   (no scenario with that many in-flight runs); we filter the 30-min
   window in code. If Chad genuinely runs >20 backtests in any 30-min
   window, that's a separate problem.

3. **Validation in two places, intentionally.** The launcher form
   does client-side range checks + a 90-day minimum window. The trigger
   endpoint calls the engine's `validateConfig`. They overlap (both
   check pre-2018 startDate, for example). The duplication is on
   purpose: the client validation fails fast and avoids a wasted
   network round-trip, while the server validation is the authoritative
   source of truth. The 90-day minimum is client-only — the engine
   doesn't enforce it; we just want to spare the user a 5-min run
   that produces an empty rebalance list.

4. **Background URL built from `x-forwarded-host`, not env var.**
   Deploy previews can invoke their own background function this way.
   Hardcoding `process.env.URL` would route preview launches to the
   production background — easy mistake; explicit is better.

5. **No new hook for polling.** The brief specifically called this
   out. Patching `useBacktestRun` with `refetchInterval` keeps the
   read-while-fresh / poll-while-incomplete logic in one place; the
   launcher does NOT have to manage a separate "watcher" hook.

## Caveat / known unknowns

The architecture has been verified locally + by unit test, but the
full end-to-end behavior (trigger → background → engine → Firestore →
poll → terminal status in the UI) can only be confirmed against the
real Phase 4a engine on the deploy preview. Specifically:

- The `-background.ts` suffix IS bundled differently by Netlify
  (verified in production for `seed-scan-background.ts`), but I
  haven't observed `run-backtest-background.ts` actually exceed 30s
  in this branch — that confirmation happens on the deploy preview.
- The 5s polling interval might be too aggressive for free-tier
  Firestore reads if a large universe (sp500/russell2k) runs for the
  full 15 minutes. ~180 reads per run + the daily Firestore quota is
  fine for one user; worth keeping an eye on if/when this scales.

## Out of scope (deferred to Phase 4b-3)

- Run cancellation
- Config presets / saved templates
- Multi-board configs in one launcher submit
- Granular progress beyond `status` ("Rebalance 6 of 84")
- Resumable runs after the 15-min cap kills a russell2k run

## Bundle delta

- Before (after 4b-1 merge): 256.18 kB gzipped
- After this PR: **259.68 kB gzipped** (+3.5 kB; brief budget +5 kB) ✓

## Test count

- Baseline on `main` at `2c29c8f`: 331 passing
- After this PR: **367 passing** (+36)
- `npx tsc --noEmit`: clean
- `npm run build`: clean

## Manual smoke test plan (deploy preview)

1. Open deploy-preview URL → Backtest tab → form renders with defaults
2. Submit a cheap config: dow / 2018-01-01 / 2018-04-01 / monthly /
   prophet / topN=10 / capital=$10k (should run in <2 min)
3. Watch the run appear in the list with `status: pending`, then
   `running`, then `complete`. Auto-select should land in run-detail.
4. While the first run is in flight, hit launch again with another
   config → expect 409 with the existing runId; click "View existing
   run →" → should navigate to the in-flight run
5. After completion, launch a second dow run → expect 202 with new runId
6. Sentry should be clean. Failed configs should be `background_run_failed`
   log events, not Sentry exceptions
