# Phase 4t W1b — Russell 2000 composite PIT scoring defect

> **For the executor:** this brief is the full assignment. Read it
> end-to-end before writing any code. The companion kickoff at
> `kickoffs/phase-4t-w1b-executor.md` is your paste-and-go boot prompt.

## TL;DR

The 4t composite backtest works on sp500 and silently produces empty
portfolios on russell2k. After PR #51's recovery/telemetry fix, two
russell2k composite runs (one pre-fix, one post-fix) ended in
**identical** states: stalled at `nextRebalanceIndex: 48 / 84` with
`tickerAttemptTotal: 0`, `portfolio: []`, `nav: 100000` unchanged, and
49 logged warnings. The sp500 control run is progressing normally
(idx 24/84, nav +4.4%, 20 stocks scored, 4567 mlTraining rows). The
defect is in the **composite PIT scoring path** for the russell2k
universe — not in the recovery path PR #51 just fixed. This phase
diagnoses the specific failure and fixes it so 4t W2/W3 can deliver a
russell2k verdict.

---

## Context

### What 4t is

Phase 4t validates the target board's ten-analyst composite
out-of-sample on sp500 and russell2k over 2018-01-31 → 2024-12-31
monthly. W1 (PR #48, merged) added the point-in-time scoring path so
the composite can be backtested without lookahead bias. W2/W3 (PR #49,
open) holds the configs + the analysis script for factor attribution
and the verdict report. The verdict is what the entire phase exists
to produce.

### What's already been ruled out (PR #51 — 4t-recovery)

The first re-fire attempt against the post-W1 code stalled both
runs. PR #51 (merged at `55e85f0`) addressed three real defects in
the *non-portfolio backtest infrastructure*:
- Missing `jitterMs` on reinvoke dispatch (caused sp500 limp on the
  pre-fix run via gateway 500s).
- Success-path telemetry was silent (russell2k pre-fix run left zero
  audit trail when its chain broke).
- No stuck-run sweep on the non-portfolio path (the May 14-15 prophet
  zombies were proof; recovery wiring added to
  `backtest-runs-trigger.ts`).

PR #51 worked: sp500 now progresses with full telemetry, and the
sweep cleared the old runs from single-flight. **The russell2k root
cause was explicitly NOT pinned by PR #51** — the agent's hypothesis
("jitter+telemetry resolves it") turned out wrong, and the agent said
so up front. The audit trail PR #51 added is exactly what now lets us
diagnose the real russell2k bug.

### What the post-PR-#51 re-fire revealed

The re-fire was run by the orchestrator against deployed main
(commit `c388c6e`). Two backtests fired in parallel against
`/api/backtest-runs/start`, using the configs at
`configs/target-{sp500,russell2k}-2018-2024-monthly-top20.json` on
PR #49's branch (`phase-4t-w2-w3-backtests-and-verdict`).

The sp500 run is alive and progressing real work. The russell2k run
exhibits exactly the same pathology as the pre-fix one — same idx,
same empty state, same trigger to break the dispatch chain. The
contrast is the diagnostic signal: **same code, same engine
infrastructure, two universes, one breaks silently.**

---

## The evidence

### NEW russell2k — `bt_20260519233555_2kv7mt` (post-PR-#51)

```
status:                running  (stalled; dispatch chain broke)
startedAt:             2026-05-19T23:35:55.847Z
last cursor update:    2026-05-19T23:36:11.059Z  (~16s after start)
frozen since:          ~7+ minutes idle at time of diagnosis

cursor.nextRebalanceIndex:   48  of  84
cursor.invocationCount:      6
cursor.reinvokeAttempts:     4
cursor.lastReinvokeStatus:   202    (dispatches succeeded)
cursor.lastReinvokeRetries:  1
cursor.lastInvocationStartedAt: 2026-05-19T23:36:08.915Z
cursor.lastReinvokeAt:       2026-05-19T23:36:11.059Z

state.totalRebalances:       84
state.nextRebalanceIdx:      48
state.tickerAttemptTotal:    0          ← ZERO TICKERS EVER SCORED
state.tickerFailureTotal:    0
state.tickerFailureSample:   []
state.portfolio:             []         ← empty across all 48 rebalances
state.tradeRowCount:         0
state.attributionRowCount:   0
state.mlTrainingRowCount:    0
state.nav:                   100000     ← unchanged from initialCapital
state.dailyEquityRowCount:   1005       ← engine DID advance time daily
state.warningRowCount:       49         ← the smoking gun
state.survivorshipWarned:    true       ← smoking gun #2
```

### OLD russell2k — `bt_20260519184826_khgy8s` (pre-PR-#51)

```
nextRebalanceIndex:    48 of 84       ← identical
tickerAttemptTotal:    0              ← identical
portfolio:             []             ← identical
nav:                   100000         ← identical
dailyEquityRowCount:   1005           ← identical
warningRowCount:       49             ← identical
survivorshipWarned:    true           ← identical
```

Two independent runs, separated by ~5 hours and a code change to
infrastructure, produced **byte-identical** final state. The bug is
deterministic and reproducible. It is **not** the recovery/reinvoke
path PR #51 just fixed — that path is now demonstrably working
(sp500 proves it).

### NEW sp500 control — `bt_20260519233423_avaa64` (same code, same engine, working)

```
status:                  running  (actively progressing)
nextRebalanceIndex:      24  of  84    (~28% done)
invocationCount:         3
reinvokeAttempts:        3
lastReinvokeStatus:      202
lastReinvokeRetries:     1            (jitter+retry engaged)
lastReinvokeAt:          2026-05-19T23:41:40.245Z  (recent)

state.tickerAttemptTotal:  12,220      ← real scoring work
state.portfolio:           20 stocks   (SWKS, FCX, AMD, LRCX, MU, NVDA, AMAT, ...)
state.tradeRowCount:       692
state.attributionRowCount: 480
state.mlTrainingRowCount:  4,567       ← real training data flowing
state.nav:                 104,440     (+4.4% from 100,000)
state.dailyEquityRowCount: 502
state.warningRowCount:     24
state.survivorshipWarned:  false       ← the key contrast
```

The contrast is the diagnostic. Same engine. Same PIT scoring path.
Same window. Same rebalance cadence. Same costs/portfolio config
structure. **Two things differ: the universe, and the
`survivorshipWarned` outcome.** That is where this phase lives.

### Configs used (identical structure)

`configs/target-sp500-2018-2024-monthly-top20.json` (works) and
`configs/target-russell2k-2018-2024-monthly-top20.json` (fails) on
PR #49's branch. Differences:
- `"universe": "sp500"` vs `"universe": "russell2k"`
- `"scoringConcurrency": 5` vs `"scoringConcurrency": 4`
- `"slippageBps": {"sp500": 5}` vs `"slippageBps": {"russell2k": 12}`

The slippage and concurrency differences are noise — neither would
cause `tickerAttemptTotal: 0`. The universe is the variable.

---

## Workstreams

### W1 — Diagnose (THE GATE; no fix code until W1 lands)

**You do not write any fix code until W1 produces a named root cause.**
The 4t-recovery PR shipped a hypothesis-only fix for russell2k and
the hypothesis was wrong. Do not repeat that. Diagnose first.

#### W1.a — Read the 49 warnings

The dead russell2k run has `warningRowCount: 49`. The backtest engine
writes warnings to a Firestore subcollection (the engine's persistence
layer in `netlify/functions/shared/backtest/persistence.ts` is the
likely entry point — confirm by reading). Get those warnings into
your evidence. They will almost certainly name the failure. Options:
1. Add a small temporary diagnostic endpoint
   `/api/backtest-runs/:runId/warnings` (returns the subcollection
   contents; **temporary** — remove before merge).
2. Or read directly from Firestore in your local diagnosis script (the
   admin SDK is already wired in `netlify/functions/shared/firebase-admin.ts`).
3. Or — if you can avoid touching prod data — reproduce the failure
   locally by running the composite scoring path against russell2k
   for a known PIT date.

Whichever you choose, the deliverable is: **a quoted list of the
unique warning messages (and counts) from the dead russell2k run.**

#### W1.b — Find where `survivorshipWarned: true` is set

This flag is the second smoking gun. Trace the code path that sets
it on the engine state. That tells you exactly which check triggered
on russell2k. Likely candidates (find them, do not assume):
- A universe-membership / survivorship-bias lookup in the engine.
- A universe-resolution helper called per rebalance.
- A PIT availability check on the universe-as-of-date.

Quote the exact code line(s) that set the flag, and the conditional
that gates it.

#### W1.c — Run sp500 vs russell2k through the same code path

You have two known cursor states (one working, one not) on the same
engine. Trace what happens at *rebalance 0* — the first scoring call
— for each universe:
- sp500: produces a non-empty portfolio. What did the universe
  resolution return? What's the path?
- russell2k: produces an empty portfolio with the survivorship
  warning. What did the universe resolution return? Where did it
  return zero / undefined / [] / null?

This may require a small instrumented local repro (load the configs,
call the engine's first-rebalance handler) rather than reading code
alone. Whichever works. The deliverable is a **named root cause**: a
specific function + specific failure mode + specific reason this fails
on russell2k but not sp500.

#### W1 deliverable

A `reports/phase-4t-w1b/diagnosis.md` with:
- The unique warnings from the dead russell2k run.
- The code path that sets `survivorshipWarned`.
- The named root cause (function, file, line, the data or logic that
  fails).
- Why the same code path works on sp500.
- The proposed fix scope (one or two specific named changes).

Open the PR as a draft against `phase-4t-w1b-russell2k-pit-defect`
with **only** the diagnosis report committed. Hand off. The
orchestrator reviews the diagnosis before authorising the fix. **Do
not write the fix in the same hand-off as the diagnosis.**

### W2 — Fix (only after W1 is reviewed and authorised)

Whatever W1 surfaces. Constraints:
- **Surface only on russell2k.** Do not modify any code path the
  sp500 control run exercises. The sp500 run is currently in flight;
  a regression that affects sp500 mid-run is a serious incident.
- Do not modify analyst scoring formulas (`netlify/functions/analysts/*.ts`,
  `analysts/core.ts`). The bug is universe / data / availability, not
  scoring math.
- Do not modify the recovery / reinvoke code (`shared/backtest-resume/*.ts`).
  PR #51 did that work; it is correct.
- Do not change the W2/W3 configs on PR #49's branch.

Smallest possible diff that fixes the named root cause. If the fix
is a data seeding (e.g., a missing russell2k survivorship table), do
the seeding as a script in `scripts/` with documentation, and add a
runtime check that fails loud rather than silent if the data is
missing again — silent empty-portfolio runs are the exact failure
mode this brief exists to prevent recurring.

### W3 — Test

Regression test that exercises the russell2k composite PIT scoring
path at a specific date (e.g., 2018-01-31, the first rebalance) and
asserts:
- The universe resolution returns a non-empty list of russell2k
  tickers as-of the PIT date.
- `tickerAttemptTotal > 0` after one scoring call.
- The first-rebalance portfolio is non-empty (positive count).

The test should **fail without the fix** and pass with it (the 4t W1b
acceptance test). Mirror the pattern from 4t-recovery's
`run-backtest-background.reinvoke-instrumentation.test.ts` (7 of 8
fail without the fix).

---

## Acceptance criteria

- W1 diagnosis report on disk with a named root cause and the
  warnings quoted. Reviewed and authorised before fix work begins.
- W2 fix is surface-only on russell2k. Diff is small. No regression
  to sp500's path.
- W3 regression test fails without the fix and passes with it.
- All existing tests still pass (1031+ post-PR-#51 baseline).
- `tsc --noEmit` clean; build clean.
- APP_VERSION bumped one patch on the final fix PR
  (W1's diagnosis-only PR doesn't bump, since it's report-only).
- PR opened ready-for-review (NOT a draft) once the fix is in.

**Post-merge orchestrator verification** (not the executor's job):
re-fire the russell2k composite backtest against fixed main; expect
`tickerAttemptTotal > 0` and a non-empty `portfolio` within the first
1-2 batches. If the new run hits the same `idx 48 / empty / nav
100000` state, the fix is wrong and we go back to W1.

---

## Out of scope

- sp500 composite scoring (working — don't touch).
- Analyst scoring formulas (10 analysts in `analysts/*.ts` and
  `analysts/core.ts`) — read-only.
- Recovery / reinvoke / stuck-run sweep (PR #51 territory).
- The 4t W2/W3 configs (PR #49 branch).
- The 4t W3 verdict report (separate workstream once both backtests
  complete).
- Earnings factor overhaul (the actual Phase 4v — pending 4t verdict).
- Any UI / surface / endpoint change beyond the temporary diagnostic
  read-only endpoint (if you use one, remove before final merge).

---

## Disciplines

- **Diagnose-before-fix is non-negotiable.** PR #51 shipped a
  hypothesis. We are not shipping another. The W1 PR contains only
  the diagnosis report; the W2 fix is a separate commit (or PR) once
  the diagnosis is reviewed.
- **Honest reporting.** If the cause turns out to be a data gap rather
  than a code bug, say so. If a fix you try doesn't actually resolve
  the empty-portfolio pattern, say so. The orchestrator validates
  the cure via re-fire; do not declare victory inside the agent
  session.
- **Test-pin the fix.** A bug this deterministic must have a test that
  pins it. Without the test, the fix could silently regress.
- **Do not disturb the in-flight sp500 run.** It uses deployed code on
  each reinvoke; a russell2k-only fix should not affect it, but verify
  the fix's scope before merging.
- **No new analyst data sources, no new external API integrations.**
  This is a defect fix, not a feature.

---

## Reference state

### Live in-flight (do not touch)

- `bt_20260519233423_avaa64` — sp500 target composite, progressing
  cleanly. Expected to complete in ~30-90 min from re-fire (started
  2026-05-19T23:34:23 UTC). The orchestrator monitors it; the
  W1b executor does not.

### Dead (sweep will reclaim, ignore)

- `bt_20260519184826_khgy8s` — russell2k pre-fix (stalled idx 48).
- `bt_20260519233555_2kv7mt` — russell2k post-PR-#51 (stalled idx 48).
- May 14-15 prophet zombies (`bt_20260515171213_mclesk`,
  `bt_20260515115436_ixxt1o`, `bt_20260514102312_3tyufi`) —
  unrelated, sweep cleans on next trigger.

### Files most likely involved

(read-only unless you have a specific reason to modify; quote in the
diagnosis report)

- `netlify/functions/shared/backtest/engine.ts`
- `netlify/functions/shared/backtest/engine-batched.ts`
- `netlify/functions/shared/backtest/score-at-date.ts` (the PIT
  scoring path — 4t W1's main artifact)
- `netlify/functions/shared/backtest/persistence.ts` (where warnings
  are written)
- `netlify/functions/shared/analyst-runner.ts` (composite scoring;
  read-only)
- Universe resolution / survivorship helpers (find them; they're the
  suspect)
- `reports/phase-4t/pit-audit.md` (4t W1's audit; useful background)

### Phase status this brief assumes

- 4t W1 (PIT path): MERGED, PR #48 (`c4cad24`)
- 4t-recovery: MERGED, PR #51 (`55e85f0`), main bumped to 0.19.8-alpha
- 4q (clickable rationale): MERGED + VERIFIED, PR #50
- 4t W2/W3 (configs + analysis script): PR #49 OPEN, branch
  `phase-4t-w2-w3-backtests-and-verdict`
- 4v (earnings factor overhaul): PLANNED, brief pending 4t verdict.
  Not in 4t W1b's scope.

---

## Session size estimate

W1 diagnosis: 2-4 hours of careful reading + a small repro.
W2 fix + W3 test: 1-3 hours, depending on what W1 surfaces.

If W1 surfaces a cause that requires more than ~150 lines of fix
code, stop and surface that to the orchestrator before writing the
fix — it may need re-scoping.
