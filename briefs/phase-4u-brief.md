# Phase 4u — Backtest engine robustness

**Author:** orchestrator (CTO + CFO combined voice — house style)
**Target version:** patch bump; MODEL_VERSION unchanged — infrastructure
only, no scoring change.
**Priority:** HIGH — a confirmed engine defect, and a **prerequisite
for Phase 4t**.
**Dependencies:** none new — the defect is in the merged engine (Phase
4r W2/W3, PR #46). **4u BLOCKS 4t** — see PART V.
**Estimated effort:** one executor session, ~3–5 hours. W1 (the cursor
fix) is the substantive part; W2 is small.

---

## Executive summary — the decision and the ask

Phase 4r W2/W3 surfaced a real engine defect. The Williams *baseline*
backtest failed in production (the `background_run_failed` Sentry alert,
2026-05-19 02:28 UTC): the run's checkpoint cursor grew until the
Firestore document blew past the hard **1 MiB per-document limit**, and
the checkpoint write failed. The reinvoke (Phase 4r-W1b) was not at
fault — this is the **engine's persisted-state shape**: `cursor.state`
accumulates without bound as a run gets longer or emits more rows.

That is not a one-off. **Phase 4t backtests the ten-analyst composite
on the Russell 2000 — ~2,000 tickers, the largest run TradeIQ will
attempt.** A cursor that already overflowed on a Williams baseline will
overflow on that. So 4u must land *before* 4t runs.

While diagnosing the Sentry alert, a second gap was confirmed: **failed
backtest runs are invisible.** `/api/backtest-runs` orders by
`completedAt` and excludes any run without one — failed and running
runs cannot be inspected through the API at all. The only signal that a
backtest failed is a Sentry email.

Phase 4u fixes both: **W1** bounds the cursor's persisted state so a
large run cannot overflow the document limit; **W2** makes failed runs
inspectable. Small, focused, infrastructure-only — and it clears the
runway for 4t. Approve.

---

# PART I — THE PROBLEM

### Defect 1 — the cursor overflows the Firestore 1 MiB limit

The non-portfolio backtest worker (`run-backtest-background.ts`) runs in
batches on a checkpoint-resume pattern: each batch writes the engine's
in-progress `state` onto a Firestore cursor document, then the worker
reinvokes to continue. Firestore enforces a hard **1 MiB limit per
document**.

The Williams baseline run emitted roughly 30× the mlTraining rows of
the discrete run, and at **invocation 18** the cursor document exceeded
1 MiB — the checkpoint write threw, the worker's top-level `catch`
fired `background_run_failed`, and the run died (it is the
2026-05-19 02:28 UTC Sentry event).

`cursor.state` is **not bounded.** It grows with run length and with
how much the run produces. The mlTraining *rows* are already handled
correctly — appended to a subcollection per batch, with only a count
kept on the cursor. Something *else* in the persisted state is
accumulating. W1's first job is to find exactly what.

### Defect 2 — failed runs are invisible

`backtest-runs-list.ts` (`/api/backtest-runs`) orders results by
`completedAt desc` and **excludes any run without a `completedAt`** —
the source comment states this is intentional. Consequence: a backtest
that **fails** has a `failed` status and an error string written by
`persistRunFailure`, but **no API surface exposes it.** The only way to
learn a backtest failed is a Sentry alert. With 4t about to run large
backtests, that is a blind spot worth closing.

---

# PART II — CURRENT-STATE ASSESSMENT (CTO)

- `netlify/functions/run-backtest-background.ts` — the worker; on each
  non-terminal batch it checkpoints `cursor` with the engine's
  `res.state` and reinvokes.
- `netlify/functions/shared/backtest-resume/cursor.ts` — the checkpoint
  cursor; holds `state`, cumulative metrics, the position pointer.
- `netlify/functions/shared/backtest/engine.ts` — produces `res.state`,
  the per-batch carried-forward state.
- `netlify/functions/shared/backtest/persistence.ts` —
  `persistRunResult` / `persistRunFailure`; `appendMLTrainingRows` /
  `readAllMLTrainingRows` (the **existing** subcollection pattern that
  already bounds mlTraining rows — the model W1 should follow).
- `netlify/functions/backtest-runs-list.ts` — `/api/backtest-runs`;
  orders by `completedAt`, excludes incomplete runs.
- `netlify/functions/backtest-runs-get.ts` — `/api/backtest-runs/:runId`
  get-by-id.
- `netlify/functions/backtest-status.ts` — the Phase 4r-W1 diagnostic.
- The portfolio worker (`run-portfolio-backtest-background.ts`) shares
  the `backtest-resume` machinery — W1 must check whether its cursor
  carries the same unbounded shape.

---

# PART III — FINANCIAL ANALYSIS (CFO)

- **No LLM/token cost.** Engine + endpoint code.
- **Verification run cost** — re-running the Williams baseline (~91-min
  wall-clock, the ~30× ML emission) to prove the fix. Bounded compute,
  no per-call LLM cost.
- **Build cost:** one executor session, ~3–5 hours.
- **The cost of not doing it:** Phase 4t cannot run safely. 4t's
  russell2k composite backtest is larger than the run that already
  overflowed; without 4u it would fail the same way, mid-run, after
  burning the compute. 4u is cheap insurance on the most important
  measurement in the project.

Approve; sequence it ahead of 4t.

---

# PART IV — PROPOSED SOLUTION (CTO)

One PR. Order **W1 → W2**.

### W1 — Bound the cursor's persisted state

**Diagnose before fixing.** Do not guess what grows.

1. **Identify what accumulates.** Instrument the checkpoint write —
   log the serialized cursor size (and the size of each top-level field
   of `cursor.state`) per batch — and run a backtest large enough to
   reproduce the growth (the Williams baseline config is the known
   reproducer). Determine exactly which field(s) grow and at what rate.
   Record it in `reports/phase-4u/diagnosis.md`.
2. **Fix the shape.** Bound the persisted state. The correct pattern
   already exists in this codebase: mlTraining rows are appended to a
   subcollection per batch with only a count on the cursor. Apply the
   same discipline to whatever else is unbounded — if the cursor
   carries a growing list (e.g. accumulated trades, position history,
   per-rebalance snapshots), move it to a subcollection written
   incrementally and keep only a bounded summary/pointer on the cursor.
   The cursor must hold a **bounded checkpoint** — where the run is,
   cumulative aggregates, the resume pointer — never an unbounded
   accumulation.
3. **Size target.** After the fix, the cursor for the **largest run
   TradeIQ will attempt** — a ten-analyst composite backtest of the
   Russell 2000, ~2,000 tickers, the Phase 4t workload — must stay
   comfortably under 1 MiB at every checkpoint. Verify against that
   scale, by measurement or a defensible projection from the
   instrumented sizes.
4. **Audit the portfolio cursor.** Check whether
   `run-portfolio-backtest-background`'s cursor has the same unbounded
   shape. If it does, fix it the same way. If it does not, note why in
   the diagnosis.
5. **Proof:** re-run the Williams baseline (the run that failed) and
   confirm it completes through to a persisted result.

If the diagnosis reveals the fix is a large, invasive engine refactor
rather than a contained change, **stop and report** before proceeding —
do not plough into a rewrite.

### W2 — Make failed runs visible

`persistRunFailure` already writes `status: 'failed'` and the error
string onto the run document — the data exists; nothing exposes it.

- Give the API a way to list and inspect **failed** (and ideally
  **running**) backtest runs with their `status` and `error` — e.g. a
  `status` filter / `includeIncomplete` parameter on
  `backtest-runs-list` that queries by start time rather than requiring
  `completedAt`, returning the error field; and confirm
  `backtest-runs-get` (`/api/backtest-runs/:runId`) returns failed runs
  with their error.
- Keep it small — this is an observability fix, not a redesign. The
  executor chooses the exact API shape; the requirement is that **a
  failed backtest run, and its error, is inspectable through the API
  without going to Sentry.**
- If a new endpoint or route is added, add the matching
  `[[redirects]]` block in `netlify.toml`. (Extending an existing
  endpoint needs no new redirect.)

---

# PART V — ARCHITECTURE & SEQUENCING DETAIL (CTO)

### 4u is a prerequisite for 4t

This is the load-bearing point. Phase 4t backtests the ten-analyst
composite on `sp500` and `russell2k`. The russell2k run — ~2,000
tickers — is the largest backtest TradeIQ will attempt. The cursor
already overflowed 1 MiB on a *Williams baseline*; it will certainly
overflow on the 4t russell2k run. **The 4t executor kickoff must not be
fired until 4u is merged and verified.** The orchestrator sequences
4u → 4t.

### Bounded-checkpoint principle

A resume cursor is a *checkpoint*, not a *ledger*. It should answer
"where am I and what are the running totals" in bounded space. Anything
that grows with the number of rows, trades, or rebalances belongs in a
subcollection (the mlTraining pattern), not inline on the cursor. W1
brings the rest of `cursor.state` in line with a rule the codebase
already follows for ML rows and for raw-data preservation.

### Diagnose before fixing

W1 starts with measurement — instrument the cursor size, reproduce the
growth, identify the exact field(s). The fix follows the diagnosis. A
guessed fix risks missing the real accumulator and overflowing again
mid-4t.

### Out of scope

- The Williams/Lynch verdicts (Phase 4r W2/W3 — settled; both NOT
  VALIDATED, honestly).
- Changing what backtests compute — 4u is reliability/observability
  only.
- The composite scoring, the analysts, the reinvoke machinery (4r-W1b —
  already correct).

---

# PART VI — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | A guessed fix misses the real accumulator; cursor overflows again mid-4t | Medium | 4t russell2k run fails after burning compute | W1 diagnoses by instrumentation first; verifies against russell2k scale, not just the Williams baseline. |
| R2 | The cursor-state fix is a large invasive engine refactor | Medium | Scope blowout | W1 step: if the diagnosis shows a big refactor, stop and report before proceeding. |
| R3 | The fix changes resume semantics and breaks checkpoint-resume | Low–Medium | Backtests don't resume correctly | Tests covering a multi-batch resumed run; the Williams-baseline re-run is the integration proof. |
| R4 | The portfolio cursor has the same defect, unfixed | Medium | A long portfolio backtest overflows later | W1 audits the portfolio cursor; fixes it if the shape matches. |
| R5 | W2 exposes failed-run internals too broadly | Low | Minor | Read-only; surface `status` + `error` only; no new write paths. |

No cost risk — infrastructure.

---

# PART VII — ACCEPTANCE CRITERIA

**W1:**
1. `reports/phase-4u/diagnosis.md` identifies exactly what in
   `cursor.state` grew, measured — not asserted.
2. The cursor's persisted state is bounded; the Williams baseline run
   (the run that failed) is re-run and **completes to a persisted
   result**.
3. The cursor stays comfortably under 1 MiB at the
   russell2k-composite scale (~2,000 tickers) — verified by
   measurement or a defensible projection.
4. The portfolio cursor is audited; same-shape defect fixed or its
   absence explained.

**W2:**
5. A failed backtest run and its error are inspectable through the API
   without Sentry.

**Both:**
6. `tsc --noEmit` clean, full suite green, `npm run build` clean, with
   tests covering the bounded cursor (a multi-batch resumed run) and
   the failed-run surface.

---

# PART VIII — ROLLOUT PLAN

1. One PR (ready-for-review, not draft) — W1 cursor fix + diagnosis,
   W2 failed-run visibility, tests. Orchestrator review — the focus is
   that W1 fixed the *measured* accumulator and the russell2k-scale
   projection holds.
2. Merge (confirm `merged: True` before branch delete). Netlify
   deploys.
3. **Then** the 4t executor kickoff may be written/fired — not before.
4. ORCHESTRATOR.md updated.

Rollback: a normal revertible PR.

---

# PART IX — OPEN DECISIONS

None for Chad. The method is settled (diagnose-first, bounded-checkpoint
pattern, fix-before-4t). Whether the portfolio cursor needs the same
fix is an executor finding from the W1 audit, not a decision for Chad.

---

*End of brief. Phase 4u fixes the engine defect behind the
2026-05-19 02:28 UTC Sentry alert — an unbounded checkpoint cursor that
overflows the Firestore 1 MiB document limit — and closes the
failed-run observability gap found alongside it. It is infrastructure
only, and it is the prerequisite that lets Phase 4t backtest the
composite on the Russell 2000 without falling over mid-run.
Recommendation: approve and sequence ahead of 4t.*
