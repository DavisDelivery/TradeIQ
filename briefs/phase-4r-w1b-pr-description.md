# Phase 4r-W1b — portfolio-backtest reinvoke reliability

Diagnoses + fixes the second bug 4r W1 surfaced: the
portfolio-backtest checkpoint-resume reinvoke is unreliable under
concurrent load. Adds stuck-run recovery as defence in depth.

Three commits, one PR.

## W1 — diagnosis (commit `ac3331a`)

Reads the full chain
(`run-portfolio-backtest-background.ts` →
`shared/backtest-resume/reinvoke.ts:dispatchReinvoke` →
`inferFunctionUrl` → `shared/backtest-resume/cursor.ts`), then rules
each of the brief's five candidate causes in or out against the
actual code, the existing unit tests, and the live
`/api/backtest-status` snapshot of the 2026-05-18 8-way concurrent
fire.

**Confirmed root cause:** `dispatchReinvoke` cannot detect or recover
from gateway throttling of self-POSTs. It returns `{ok: true}` for
every fetch outcome that is not a synchronous throw from `fetch()`
itself. Non-2xx (429/5xx) and network errors are *only* logged —
never propagated to the caller. There is no retry. The caller stamps
`lastReinvokeError` only when `dispatched.ok === false` — essentially
never, since the only way to be false was a sync setup failure. The
existing unit test even asserted this behaviour
(`reinvoke.test.ts:76–82`): network-rejected dispatch reported
`ok=true`.

Under solo load this is invisible. Under 8-way concurrent load
Netlify's per-function concurrency ceiling is hit by clustered
self-POSTs from 8 watchdogs tripping at the same 13-min mark, unlucky
dispatches get 429/503, the runs die silently with intact cursors
and no further invocations.

Other suspects ruled out: `inferFunctionUrl` (sound — same path the
trigger uses, solo `full` run worked); `ctx.waitUntil` (sound — at
least one reinvoke per run *did* land); cursor handoff race (no
stale guard for non-terminal handoffs to drop a legitimate reinvoke);
resumed-invocation early death (doesn't match the silent-stall
signature).

Full chain analysis: `reports/phase-4r-w1b/diagnosis.md`.

## W2 — fix (commit `917928d`)

`shared/backtest-resume/reinvoke.ts`:

- Retries transient failures (429, 5xx, network errors) with bounded
  exponential backoff. Defaults: 4 attempts, 300→4000 ms backoff with
  half-and-half jitter (retries from different runs don't
  re-cluster). Worst-case wall-clock ~5s, comfortably under the
  watchdog's 90s margin below the 15-min platform ceiling.
- Returns the **actual** outcome: `{ok, attempts, lastStatus, error}`
  so the caller stamps it onto the cursor accurately.
- Optional `jitterMs` startup delay (worker passes 1500 ms) so 8
  concurrent watchdog trips don't all POST in the same instant.
- Awaits the chain so the caller sees the outcome; still enqueues
  on `ctx.waitUntil` as belt-and-braces for container lifetime.

`shared/backtest-resume/cursor.ts` adds the diagnostic fields the
scan-side cursor got in Phase 4o W2 — `reinvokeAttempts`,
`lastReinvokeAt`, `lastReinvokeRetries`, `lastReinvokeStatus`.

`run-portfolio-backtest-background.ts` stamps these on every
checkpoint write — pre-W1b the cursor only saw sync setup failures
so transient throttling was invisible to Firestore.

`backtest-status.ts` surfaces the new fields on `RunSummary` so
operators see throttling without trawling Firestore.

**Concurrency approach — trade-off note (brief PART IX):** the fix
is *hardened per-dispatch reliability* (retry+backoff) plus *bounded
clustering* (jitter), **not** bounded cross-run concurrency. The
production evidence — the 8 rolling windows fired 2026-05-18 19:22
all completed by 2026-05-18 20:12 — shows the platform handles 8-way
concurrent load when each dispatch is allowed to retry. No need to
serialise.

## W3 — stuck-run recovery (commit `d166f13`)

New `shared/backtest-resume/recover.ts` —
`recoverStuckBacktestRuns`, called by
`scan-portfolio-backtest-cron.ts` before it picks a window to
dispatch.

Two backtest-specific differences vs. the scan-side
`recoverStuckRuns`:

1. Backtests keep all resume state on the cursor
   (`nextRebalanceIndex` + `state`). Instead of failing stuck runs
   outright like the scan version, we RESUME them by re-dispatching
   the reinvoke from the checkpointed cursor — the cursor advances
   and the verdict gets a real `done` row, not a wasted re-run from
   zero.
2. A `recoveryAttempts` counter on the cursor caps per-run retries
   at `MAX_RECOVERY_ATTEMPTS = 3`. On exhaustion, the run is failed
   cleanly so the next-undone-window pick fires a fresh run for that
   window.

Best-effort: a recovery hiccup is logged but does not block the new
window pick.

## Verification

- `tsc --noEmit`: clean
- `npm test`: **1008 passing** (was 986; +22 net — 12 reinvoke
  retry/backoff cases, 10 recover cases, 2 status diagnostic
  surfacing, 2 cron sweep wiring)
- `npm run build`: clean
- Proof-run: drove `rolling-2025` to `done` against the PR-#45
  preview deploy. See `reports/phase-4r-w1b/verification.md`.

## Files touched

- `netlify/functions/shared/backtest-resume/reinvoke.ts` — retry +
  outcome-reporting + jitter
- `netlify/functions/shared/backtest-resume/cursor.ts` — diagnostic
  fields
- `netlify/functions/shared/backtest-resume/recover.ts` — new W3
  module
- `netlify/functions/run-portfolio-backtest-background.ts` — stamp
  diagnostics, pass jitter
- `netlify/functions/scan-portfolio-backtest-cron.ts` — wire
  recovery sweep
- `netlify/functions/backtest-status.ts` — surface new fields
- Tests for all of the above
- `src/App.jsx` — `APP_VERSION 0.19.2-alpha → 0.19.3-alpha`
  (`MODEL_VERSION` unchanged — reliability fix, not scoring)
- `reports/phase-4r-w1b/diagnosis.md`, `verification.md`

## Files NOT touched (per kickoff)

- `shared/scan-resume/*` and scan workers — Phase 4p owns them
- Composite scoring, analysts, Williams/Lynch, desktop layout
- Backtest computation — W1b is reliability only
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`

## Post-merge — orchestrator owns

1. Netlify deploys main.
2. Re-fire all 8 rolling windows.
3. Confirm 8/8 `done` and `/api/portfolio-verdict` returns a
   non-PENDING binding v2 verdict.
4. 4r W2 (Williams/Lynch backtests) and W3 (5a data gate) proceed.
