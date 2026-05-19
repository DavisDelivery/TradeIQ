# Phase 4v — non-portfolio backtest reinvoke instrumentation + stuck-run recovery

## Summary

Two Phase 4t composite backtests Chad fired post-PR #48 merge
(sp500/monthly/target and russell2k/monthly/target, kicked off ~7s
apart on 2026-05-19T18:48 UTC) both stalled at `status: running` and
sat dead for 4+ hours. Neither was the cursor 1 MiB overflow that
4u fixed nor the portfolio reinvoke chain that 4r-W1b fixed. The
root cause is a missing piece on the non-portfolio path that the
portfolio path already has.

## Root cause

`run-backtest-background.ts:290-321` writes the cursor BEFORE the
reinvoke dispatch and only writes a *second* cursor update when the
dispatch **fails**. The portfolio path
(`run-portfolio-backtest-background.ts:380-433`) — corrected in
4r-W1b — always stamps `lastReinvokeAt`, `reinvokeAttempts`,
`lastReinvokeRetries`, `lastReinvokeStatus` regardless of outcome.
The non-portfolio path also passes `jitterMs: 0` (default) to
`dispatchReinvoke`, while the portfolio path passes 1500 ms to break
up clustered arrivals from parallel runs.

Live evidence:
- russell2k run (`bt_20260519184826_khgy8s`): 6 invocations, zero
  W1b telemetry fields on the cursor. The reinvoke chain stopped
  with no audit trail because the success path never wrote.
- sp500 run (`bt_20260519184819_0pwnxc`): 5 invocations,
  `lastReinvokeError: "HTTP 500"`. The 5th batch's reinvoke
  succeeded enough to hit the dispatch failure branch, but there
  was no recovery loop to retry.

The non-portfolio path also has **no stuck-run recovery sweep**.
Portfolio runs get `recoverStuckBacktestRuns` from
`scan-portfolio-backtest-cron.ts:169` on every cron tick; regular
runs had nothing. So once the reinvoke chain dropped, the run was
stuck forever.

Full chain analysis: `reports/phase-4v-backtest-concurrency/diagnosis.md`.

## Fix

Three surgical changes in `netlify/functions/`:

1. **`run-backtest-background.ts`** — replace the failure-only
   post-dispatch cursor write with an unconditional write that
   carries `lastReinvokeAt`, `reinvokeAttempts`,
   `lastReinvokeRetries`, `lastReinvokeStatus`, and conditionally
   `lastReinvokeError`. Pass `jitterMs: REINVOKE_JITTER_MS` (1500
   ms, env-overridable) to `dispatchReinvoke`. Mirror of the
   portfolio path; no shared-module change.

2. **`backtest-runs-trigger.ts`** — call `recoverStuckBacktestRuns({
   collection: 'backtestRuns', ... })` before the single-flight
   check. Best-effort: a Firestore hiccup here logs but doesn't
   block the trigger. Mirror of `scan-portfolio-backtest-cron.ts:169`.

3. **`src/App.jsx`** — `APP_VERSION` 0.19.6-alpha → 0.19.7-alpha.

## Recovery wiring

The non-portfolio trigger now sweeps stuck runs before deciding
what to do with the new request. A run whose `lastInvocationStartedAt`
is more than 30 min stale will be either resumed (cursor advances,
reinvoke re-dispatched) or, if `recoveryAttempts` >= 3, marked
`failed`. The two dead runs from 2026-05-19 will clear on the next
trigger fire — no manual intervention needed.

The shared `recover.ts` was already collection-parameterised in
4r-W1b W3; this PR just wires the second caller in.

## Tests

- `+8 tests` over the 1023-test baseline (now 1031 passing):
  - `run-backtest-background.reinvoke-instrumentation.test.ts` —
    4 tests pinning the W1b stamp pattern (success stamp, failure
    stamp, increment across batches, jitterMs passed). All 4 fail
    without the fix.
  - `backtest-runs-trigger.test.ts` — 4 new tests pinning the
    recovery wiring (collection name + functionPath, runs on
    allowParallel, best-effort on Firestore failure, runs before
    single-flight). 3 of 4 fail without the trigger fix.
- All 1023 previously-passing tests still pass.

## Verification plan

- [x] `npm test` — 1031/1031 passing (was 1023 on `c4cad24`)
- [x] `npx tsc --noEmit` — clean
- [x] New tests reproduce the bug: stash the fix → 4 instrumentation
  + 3 recovery tests fail; restore → all pass
- [ ] On deploy, watch the next trigger fire log
  `stuck_runs_swept` (or `stuck_run_sweep_clean` if the two dead
  runs were manually cleared first) and observe one of the two
  dead runs either advance into status=`complete` (cap-exhausted
  recovery → resumed by a subsequent fire) or land at status=`failed`
  (cap reached). A fresh post-fix composite run should leave full
  W1b telemetry on its cursor at every batch boundary.
- [ ] Spot-check `/api/backtest-runs/<runId>` on a future stuck run
  — `cursor.lastReinvokeAt` and `cursor.reinvokeAttempts` are now
  always populated, giving operators the diagnostic surface to
  reproduce or escalate.

## Caveats

- Jitter is a probabilistic mitigation. If Netlify's per-function
  concurrency is genuinely 1, two parallel runs will still serialise;
  jitter only prevents the simultaneous-arrival pathology that
  causes the gateway to 500 rather than queue.
- The fix proves *future* stuck runs will have a full diagnostic
  trail; it does not retroactively prove the exact proximate cause
  of `bt_20260519184819_0pwnxc`'s HTTP 500 (Netlify control-plane
  logs would be needed). The instrumentation gap was the load-bearing
  hole regardless.
- The two existing dead runs will be cleaned up by the new recovery
  sweep on the next trigger fire — no separate cleanup script.

## Files changed

- `netlify/functions/run-backtest-background.ts` (+30 / -2)
- `netlify/functions/backtest-runs-trigger.ts` (+34 / -2)
- `netlify/functions/__tests__/run-backtest-background.reinvoke-instrumentation.test.ts` (+255, new)
- `netlify/functions/__tests__/backtest-runs-trigger.test.ts` (+86 / -1)
- `reports/phase-4v-backtest-concurrency/diagnosis.md` (new)
- `briefs/phase-4v-backtest-concurrency-pr-description.md` (new — this file)
- `src/App.jsx` (+1 / -1)

https://claude.ai/code/session_0156L7EG1cHfEwt6aszoMnNb
