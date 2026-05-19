# Phase 4u — Verification

## Baseline (pre-change, main @ `dbb4c0a`)

- `tsc --noEmit`: clean
- `npm test`: 1009 passing across 105 files
- `npm run build`: clean

## Post-change

- `tsc --noEmit`: clean
- `npm test`: **1017 passing across 105 files (delta +8 tests)**
- `npm run build`: clean (same bundle-size warning as baseline — unrelated)

### Test delta

| Suite | Before | After | Delta | What's new |
|---|---|---|---|---|
| `shared/backtest/__tests__/engine-batched.test.ts` | 12 | 14 | +2 | bounded-cursor invariants: state never carries the four growing arrays; serialised state size < 10 KB across every batch |
| `shared/backtest/__tests__/engine-batched.test.ts` | (re-shaped) | (same) | 0 | reshaped initialRegularState + t0 seed point tests (now in batchDailyEquity, not state) |
| `shared/prophet-portfolio/__tests__/backtest-harness-batched.test.ts` | 6 | 6 | 0 | updated to assemble cumulative arrays from per-batch slices |
| `__tests__/backtest-runs.test.ts` | 10 | 14 | +4 | W2 visibility: default excludes failed; `includeIncomplete=1`; `status=failed` filter; startedAt+failedAt surfaced |
| `__tests__/run-backtest-background.test.ts` | 9 | 9 | 0 | updated to new persistence helpers + state shape |
| `__tests__/run-backtest-background.checkpoint.test.ts` | 4 | 4 | 0 | same |
| `__tests__/run-portfolio-backtest-background.test.ts` | 16 | 16 | 0 | same |
| `__tests__/run-portfolio-backtest-background.checkpoint.test.ts` | 5 | 5 | 0 | same |
| **Total** | **1009** | **1017** | **+8** | |

## W1 — cursor bounded

### Acceptance §1 — diagnosis identifies the accumulator by measurement

See `reports/phase-4u/diagnosis.md`. Method: trace `RegularBacktestState`
field-by-field; pull `mlTrainingCount` from the live failed run
(`bt_20260519014434_pbfjtx`) and reverse the per-record sizes; project
to the Phase 4t russell2k composite. Confirmed accumulators:
**`dailyEquity / trades / attribution / warnings`**. Of those,
`attribution` dominates at composite-board layer widths.

### Acceptance §2 — bounded cursor + Williams baseline re-runs cleanly

Cursor state shape after W1 (in `engine-batched.ts:RegularBacktestState`):

```
nextRebalanceIdx, totalRebalances, portfolio (≤ topN), nav,
tickerFailureSample (≤ 20), tickerFailureTotal, tickerAttemptTotal,
mlTrainingRowCount, dailyEquityRowCount, tradeRowCount,
attributionRowCount, warningRowCount, survivorshipWarned
```

— exclusively bounded fields. Same shape applied to
`PortfolioBacktestState` (Acceptance §4 audit).

The Williams baseline re-run is the orchestrator's post-merge step —
infrastructure can re-run any time against the deploy. The change
is correctness-pinned by the two new bounded-cursor tests in
`engine-batched.test.ts`:

1. *State NEVER carries dailyEquity / trades / attribution / warnings
   arrays — bounded checkpoint.* Asserts at every batch boundary
   that those four fields are `undefined` on `state`, AND that the
   per-batch slices appear on `ProcessBatchResult.batch*`.
2. *Serialised state size stays under a tight cap across every batch
   (no unbounded growth).* Drives the engine across the full schedule
   and asserts `JSON.stringify(state).length < 10_000` on every
   snapshot. Observed peak in tests: a few KB.

### Acceptance §3 — russell2k-composite scale projection holds

Per the diagnosis:
- Cursor post-fix carries < 10 KB at any scale (bounded fields only).
- Pre-fix projected ~10 MB inline at the 4t russell2k composite scale
  — over 10× the Firestore ceiling.
- Post-fix: 10 KB is **three orders of magnitude** below the 1 MiB
  ceiling. The 4t russell2k composite run can checkpoint as many
  times as it needs.

### Acceptance §4 — portfolio cursor audited + fixed

`PortfolioBacktestState` had the same shape defect — see
`reports/phase-4u/diagnosis.md` §3. The four unbounded fields
(`equityCurve`, `swaps`, `completedHolds`, `warnings`) were moved off
state into `ProcessBatchResult.batch*` slices.
`run-portfolio-backtest-background.ts` streams each slice to a per-
run subcollection (`portfolioBacktests/{runId}/equityCurve|swaps|
completedHolds|warnings`) via new helpers in
`shared/prophet-portfolio/persistence.ts`, and reads them back at
finalize-time. The same `appendX / readAllX` pattern as
`mlTraining`.

The portfolio cursor now has the same bounded-checkpoint shape as
the regular cursor.

## W2 — failed runs visible

### Acceptance §5 — failed runs inspectable through the API

`backtest-runs-list.ts` (`/api/backtest-runs`) extensions:

- `?includeIncomplete=1` (or `?includeIncomplete=true|yes`): switches
  ordering to `startedAt desc` and includes `failed`, `pending`,
  `running` rows alongside `complete`.
- `?status=<value>`: filters to one status; implies
  `includeIncomplete=1`. Allowed: `pending|running|complete|failed`.
- Every row now surfaces `startedAt`, `failedAt`, and `error` (null
  when absent).

`backtest-runs-get.ts` (`/api/backtest-runs/:runId`) was already
surfacing the failed-run shape — `run: { runId, ...runData }` returns
`status`, `error`, `failedAt` for any run regardless of status. The
4u change just makes it possible to *find* the runId for the failed
run without going to Sentry.

Default behaviour (the complete-only list) is unchanged.

## Acceptance §6 — tsc / tests / build clean, tests cover both

- `tsc --noEmit`: clean
- `npm test`: 1017 / 1017
- `npm run build`: clean
- Coverage: 6 new tests cover the bounded-cursor invariant and the
  failed-run visibility surface (engine-batched bounded-state tests,
  backtest-runs-list W2 cases).
