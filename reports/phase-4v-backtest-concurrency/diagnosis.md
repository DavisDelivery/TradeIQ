# Phase 4v — diagnosis: two dead non-portfolio composite backtests

**Question:** why did the two Phase 4t composite backtests Chad fired
post-PR #48 merge (sp500 + russell2k, both monthly/top20/board=target)
both stall at `status: running` and never reach `complete`, while
otherwise comparable portfolio backtests on the same deploy succeed?

Brief: `briefs/phase-4v-backtest-concurrency.md` (this PR).

---

## Section 1 — symptom evidence (the two dead runs)

Pulled from `GET /api/backtest-runs/:runId` against
`tradeiq-alpha.netlify.app` at 2026-05-19T22:39 UTC. Both runs started
within 7 s of each other (Chad fired them as a parallel pair for the
W2 large-cap vs small-cap composite verdict).

### Run A — `bt_20260519184819_0pwnxc` (sp500 / monthly / target)

```
startedAt:                2026-05-19T18:48:19.769Z
updatedAt:                2026-05-19T20:58:17.889Z   (~2h10m later)
status:                   running
cursor.invocationCount:   5
cursor.nextRebalanceIndex: 33 / 84
cursor.lastInvocationStartedAt: 2026-05-19T20:43:29.158Z
cursor.lastReinvokeError: "HTTP 500"
cursor.state.nav:         110692.40
cursor.state.tradeRowCount:    924
cursor.state.attributionRowCount: 660
cursor.state.mlTrainingRowCount: 6289
cursor.state.tickerAttemptTotal: 16802
```

Per-subcollection counts at the moment of capture confirm the per-batch
sub-writes landed: dailyEquity=692, trades=500, attribution=660,
warnings=0.

`updatedAt` is ~14m 48s after `lastInvocationStartedAt`, almost exactly
the 15-min Background Function ceiling — the 5th invocation reached
the budget watchdog, attempted its reinvoke, and got back an **HTTP 500
response** from the next invocation. The cursor was stamped with the
error but **no further reinvoke was attempted** — there is no
recovery sweep on the non-portfolio path (see §5).

### Run B — `bt_20260519184826_khgy8s` (russell2k / monthly / target)

```
startedAt:                2026-05-19T18:48:26.516Z
updatedAt:                2026-05-19T18:48:36.568Z   (10s after start)
status:                   running
cursor.invocationCount:   6
cursor.nextRebalanceIndex: 48 / 84
cursor.lastInvocationStartedAt: 2026-05-19T18:48:36.056Z
cursor.lastReinvokeError: <ABSENT>
cursor.lastReinvokeAt:    <ABSENT>
cursor.reinvokeAttempts:  <ABSENT>
cursor.state.nav:         100000   (initial — never invested)
cursor.state.tradeRowCount:    0
cursor.state.attributionRowCount: 0
cursor.state.mlTrainingRowCount: 0
cursor.state.tickerAttemptTotal: 0
cursor.state.warningRowCount:    49
cursor.state.dailyEquityRowCount: 1005
```

Six invocations ran in **~10 seconds total**, but `tickerAttemptTotal:
0`. The combination of warnings=49 + dailyEquity=1005 + zero scoring
attempts indicates **48 consecutive rebalances were skipped** because
the russell2k PIT universe pool was empty at every rebalance date
through ~2022; `processRegularBatch` lines 278-289 emit a "pool empty"
warning and roll forward equity flat. That is **the universe-coverage
gap** in `universePoolForDate('russell2k', ...)`, which is a separate
known issue (the same warnings show on completed dow runs in 2018).

This made each batch trivial (~1.5s), so 6 batches × ~1.5s ≈ 10s
matches the 10-second cursor age window. After invocation 6 (which
reached rebalance 47, last index in the 6th 8-batch slice), **the
reinvoke chain stopped**. There is **no `lastReinvokeError` recorded
and no `lastReinvokeAt` recorded** — the cursor has no evidence the
dispatch was even attempted. This is the fingerprint of the bug
documented below.

---

## Section 2 — what was ruled out

Already-merged work, not re-litigated here:

1. **Cursor 1 MiB overflow** — Phase 4u (PR #47) moved
   dailyEquity/trades/attribution/warnings to subcollections. The
   russell2k cursor at capture is ~3 KB and the sp500 cursor is
   ~7 KB. Bounded.
2. **PIT correctness of the composite** — `reports/phase-4t/pit-audit.md`
   classifies each of the 10 analysts. Not relevant here; the russell2k
   run never scored a single ticker (so the composite math never ran),
   and the sp500 run produced sane composites (e.g. AVGO composite 83
   with 10 layers populated). The stall is downstream of scoring.
3. **Portfolio reinvoke chain (4r-W1b)** — fixed in PR #45 against
   `run-portfolio-backtest-background.ts`. The shared module
   `shared/backtest-resume/reinvoke.ts` carries the retry + jitter +
   honest-result discipline. But the **regular bg-function does not
   use it the same way** — see §3.
4. **Two-runs-fired-back-to-back / single-flight bypass** — Chad
   intentionally fired both runs in parallel for the W2 verdict
   (`allowParallel: true` or a manual second click; the trigger's
   30-min single-flight would otherwise block run B because run A is
   still in flight). This is a feature, not a bug. The runs are
   correctly entitled to run concurrently.

---

## Section 3 — root cause

`netlify/functions/run-backtest-background.ts:290-321` (the
non-terminal-batch tail of the regular bg-function) writes the cursor
**before** dispatching the reinvoke, and only writes a *second* cursor
update **when the dispatch fails**:

```ts
// Line 290-299 — cursor for "this batch wrapped, here is what's next"
const nextCursor: BacktestCursor<RegularBacktestState> = {
  ...cursor,
  state: res.state,
  nextRebalanceIndex: res.state.nextRebalanceIdx,
  cumulativeMetrics: { ... },
};
await writeCursor(db, COLLECTION, runId, nextCursor);

// Line 307-313 — dispatch the reinvoke
const reinvokeUrl = inferFunctionUrl(headers, '/.netlify/functions/run-backtest-background');
const reinvokeCtx: ReinvokeContext = context as unknown as ReinvokeContext;
const dispatched = await dispatchReinvoke(reinvokeUrl, runId, reinvokeCtx);
//                                                                  ^^^ no jitterMs

// Line 315-321 — stamp ONLY on failure
if (!dispatched.ok) {
  await writeCursor(db, COLLECTION, runId, {
    ...nextCursor,
    lastReinvokeError: dispatched.error,
  });
  log.error('reinvoke_dispatch_failed', { runId, err: dispatched.error });
}
```

Compare to the portfolio path's contract in
`run-portfolio-backtest-background.ts:380-433`:

```ts
// Line 380-390 — same shape pre-dispatch
await writeCursor(db, COLLECTION, runId, nextCursor);

// Line 408-415 — dispatch WITH jitter
const dispatched = await dispatchReinvoke(
  reinvokeUrl, runId, reinvokeCtx, { window: label },
  { jitterMs: REINVOKE_JITTER_MS },   // 1500 ms
);

// Line 417-433 — ALWAYS stamp the outcome, success or failure
const cursorWithDispatch: BacktestCursor<PortfolioBacktestState> = {
  ...nextCursor,
  lastReinvokeAt: new Date().toISOString(),
  reinvokeAttempts: (cursor.reinvokeAttempts ?? 0) + 1,
  lastReinvokeRetries: dispatched.attempts,
  lastReinvokeStatus: dispatched.lastStatus,
  ...(dispatched.ok
    ? { lastReinvokeError: undefined }
    : { lastReinvokeError: dispatched.error ?? 'unknown dispatch failure' }),
};
await writeCursor(db, COLLECTION, runId, cursorWithDispatch);
```

The non-portfolio path is **missing two W1b properties**:

**Property 1 — observability gap.** `lastReinvokeAt`, `reinvokeAttempts`,
`lastReinvokeRetries`, `lastReinvokeStatus` are never written on the
non-portfolio path, only `lastReinvokeError` is, and only on failure.
That is exactly what we see on the russell2k cursor: the run has 6
invocations and **zero W1b telemetry fields** on the cursor. Compare
the portfolio recent-completed runs in `/api/backtest-status` — they
report `lastReinvokeStatus`, `reinvokeAttempts` etc. The regular
bg-function never wrote them because the code does not write them.

**Property 2 — no startup jitter.** `dispatchReinvoke` is invoked with
no `jitterMs` argument (line 313), which defaults to `0` in
`reinvoke.ts:93`. Two parallel runs whose 13-min watchdogs trip near
the same instant POST to `/.netlify/functions/run-backtest-background`
within milliseconds, hitting Netlify per-function concurrency. The
sp500 run's cursor records `lastReinvokeError: "HTTP 500"` — that is
the next invocation's handler returning 500 (Netlify gateway maps an
overloaded background-function invocation to 500 in the response to
the dispatch POST). The retry inside `dispatchReinvoke` retries up to
4 × on transient 5xx, but if *every* retry hits the same throttle
window, the chain exhausts.

**Property 3 — no stuck-run recovery.** On the portfolio side,
`scan-portfolio-backtest-cron.ts:169` calls `recoverStuckBacktestRuns`
before picking the next window, which resumes any run whose
`lastInvocationStartedAt` is more than 30 min stale. The regular
non-portfolio path has **no such sweep** — `grep -rn
"recoverStuckBacktestRuns\b" netlify/` finds only the portfolio cron
caller. So even if the reinvoke chain breaks for any reason, the
run is stuck forever until someone re-fires a trigger, and even then
the new trigger does not clear the stale doc.

### Why this is the root cause of both stuck runs

The two runs failed by different proximate mechanisms but the same
underlying gap:

- **russell2k:** the reinvoke after invocation 6 dispatched (we
  cannot prove from the cursor whether it succeeded or failed because
  no `lastReinvokeAt` was written), the next invocation never landed,
  and there is no recovery to retry. Most likely: dispatch returned
  2xx but the gateway then throttled the actual invocation (Netlify's
  per-function concurrency limit was hit by the parallel sp500 run),
  and without the W1b "stamp on success" we lost the proof. The
  alternative — that the dispatch's 4-retry chain failed silently
  without writing `lastReinvokeError` — would require the
  `writeCursor` on line 316 to also fail, which is unlikely on a
  3-KB cursor.

- **sp500:** the reinvoke after invocation 5 explicitly failed with
  `HTTP 500`, the cursor was stamped, the run was dead. Recovery
  would have re-dispatched within 30 min and the run would have
  finished; there is no recovery.

Either way, **without the W1b "always-stamp" instrumentation we
cannot diagnose precisely**. Adding it is a prerequisite for any
future post-mortem of this class of failure, AND it gives operators
the diagnostic surface to write a recovery loop.

### Why the portfolio path doesn't suffer this

The portfolio side has both (a) the always-stamp pattern (so when
something throttles, we can see it) and (b) the cron-driven
`recoverStuckBacktestRuns` sweep that catches stale `running` docs
on the next cron tick. The non-portfolio path has neither.

---

## Section 4 — what the fix is

Surgical: bring the regular bg-function up to the same contract the
portfolio bg-function already implements.

1. **Always-stamp** — replace the failure-only second `writeCursor`
   with an unconditional one carrying `lastReinvokeAt`,
   `reinvokeAttempts`, `lastReinvokeRetries`, `lastReinvokeStatus`,
   and `lastReinvokeError` (cleared on success).

2. **Pre-dispatch jitter** — pass `jitterMs: REINVOKE_JITTER_MS`
   (1500 ms default, env-overridable, same constant the portfolio
   path uses) to `dispatchReinvoke` so parallel runs do not cluster
   their watchdog-tripped reinvokes at the gateway.

3. **Stuck-run recovery wired into the non-portfolio trigger** —
   the trigger (`backtest-runs-trigger.ts`) calls
   `recoverStuckBacktestRuns({ collection: 'backtestRuns', ... })`
   before its single-flight check, so a fresh trigger clears stale
   `running` docs and either advances them (still resumable) or
   fails them (cap exhausted). Mirrors the portfolio cron's pattern
   at `scan-portfolio-backtest-cron.ts:169`.

This is **not** a portfolio-path change. `shared/backtest-resume/reinvoke.ts`
and `recover.ts` are already shared and are not modified. The diff is
contained to `run-backtest-background.ts` and `backtest-runs-trigger.ts`
plus tests.

### What this fix does and does not claim

- It **fixes the observability gap** — the next stuck run will leave a
  full diagnostic trail on the cursor.
- It **reduces the probability of clustered-arrival throttle** — but
  jitter is a probabilistic mitigation, not a guarantee. If Netlify's
  per-function concurrency limit is genuinely 1, two parallel runs
  will still serialise; jitter only avoids the simultaneous-arrival
  pathology that triggers 500s rather than queueing.
- It **adds a recovery loop** — runs that DO stall now self-heal on
  the next trigger fire. They no longer need manual intervention.
- It **does not** prove the precise cause of run A's HTTP 500
  (a Netlify control-plane log would be needed to distinguish "container
  throttled" from "downstream Polygon timeout in the next invocation's
  prepRun"). The observability fix is the prerequisite for proving it
  next time.

The recovery wiring is mandatory regardless of root cause — the gap
between portfolio-side stuck-run recovery and non-portfolio-side
nothing is overdue. Even without the always-stamp change, recovery
alone would have unstuck both runs.

---

## Section 5 — what is *not* the cause (specifically ruled out)

- **Engine-batched compute** — both runs produced sane state for the
  rebalances they processed (sp500: 924 trades, 6,289 ML rows, 10-layer
  composites populated; russell2k: empty pools correctly emitted
  warnings + flat equity). No engine bug.
- **Cursor 1 MiB ceiling (Phase 4u)** — measured cursor sizes ≈3 KB
  and ≈7 KB. Bounded.
- **PIT scoring path for `target` (Phase 4t)** — never even reached on
  russell2k (zero ticker attempts); on sp500 it produced sane scores
  through rebalance 32. Not the failure point.
- **`dispatchReinvoke` itself** — the shared module already retries
  with backoff and reports the outcome honestly. The fault is that
  the regular path's *caller* throws away the outcome.
- **`reinvoke.ts` / `cursor.ts` / `recover.ts` / `watchdog.ts`** — no
  shared-module change is required. No portfolio path change is
  required.
- **Trigger's single-flight** — Chad fired both runs intentionally in
  parallel. The trigger correctly accepted both.

---

## Section 6 — verification approach

A regression test in
`netlify/functions/__tests__/run-backtest-background.checkpoint.test.ts`
(or a sibling) drives the non-terminal-batch branch with a mocked
`dispatchReinvoke` that:

1. Returns `{ ok: true, attempts: 1, lastStatus: 202 }` — the test
   asserts the cursor's `lastReinvokeAt`, `reinvokeAttempts`,
   `lastReinvokeStatus`, `lastReinvokeRetries` are stamped, and
   `lastReinvokeError` is absent/undefined.
2. Returns `{ ok: false, attempts: 4, lastStatus: 500, error: 'HTTP 500' }`
   — asserts the cursor's `lastReinvokeError` is stamped AND the
   four success-side fields are also stamped (so the failure path
   surfaces both the error and "we tried").
3. The jitterMs parameter is passed to `dispatchReinvoke` (assert via
   call-args).

The trigger recovery wiring adds a test that drives
`recoverStuckBacktestRuns` as the trigger's first DB call when the
trigger is invoked. Existing trigger tests continue to pass.

All previously-passing tests (1023 on the post-PR #48 baseline) must
continue to pass.
