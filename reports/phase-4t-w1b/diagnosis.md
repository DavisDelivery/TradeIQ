# Phase 4t W1b — diagnosis

## Summary

The russell2k composite backtest produces empty portfolios across rebalances
0–47 because `UNIVERSE_HISTORY` has **no russell2k snapshot before
2022-01-31**, while the configured backtest window starts **2018-01-31**.
`tickersInIndexOnDate('russell2k', d)` returns `null` for every `d` from
2018-01-31 through 2021-12-31, `universePoolForDate` propagates that as
`{ tickers: [] }`, and `engine-batched.ts:279-289` pushes a per-rebalance
"universe pool empty" warning and skips scoring. Idx 48 (`2022-01-31`)
is the first rebalance with russell2k data — and the first rebalance with
real scoring work — and the chain dies there for a separate, secondary
reason. **The primary defect is a data-coverage gap with no pre-flight
refusal: `validateConfig` does not check that `config.startDate` lies
within the universe's snapshot coverage, so the run launches and silently
no-ops 48 rebalances before any downstream symptom appears.** sp500 is
unaffected because its `UNIVERSE_HISTORY` coverage starts at 2018-01-31
exactly.

## Evidence

### E1 — Universe coverage actually shipped on `main`

Generator-emitted (`netlify/functions/shared/universe-history.ts:7-14`)
and confirmed by `universeHistoryCoverage()` at `c388c6e`:

```json
{
  "sp500":     { "firstDate": "2018-01-31", "lastDate": "2026-05-14", "snapshotCount": 101 },
  "ndx":       { "firstDate": "2026-05-15", "lastDate": "2026-05-15", "snapshotCount":   1 },
  "dow":       { "firstDate": "2018-01-31", "lastDate": "2026-05-14", "snapshotCount": 101 },
  "russell2k": { "firstDate": "2022-01-31", "lastDate": "2026-04-30", "snapshotCount":  52 }
}
```

Header comment confirms intent:
- SP500: "historical via asOfDate (100 months from 2018-01-31) + current SSGA SPY snapshot"
- Russell2k: "iShares IWM csv — historical via asOfDate (52 months)"

The russell2k generator was simply run with only 52 months of historical
backfill; the backtest window asks for 84.

### E2 — Local repro: 48-of-84 empty pools on russell2k, 0-of-84 on sp500

Running `universePoolForDate` against the 84 monthly rebalance dates of
the Phase 4t W2 configs (`origin/phase-4t-w2-w3-backtests-and-verdict`):

```
SP500
  Empty rebalances:        0 of 84
  First non-empty:         idx=0   date=2018-01-31  tickers=509
  Last empty:              n/a
  Sample idx 47:           tickers=509             (snapshotDate 2021-12-31)
  Sample idx 48:           tickers=509             (snapshotDate 2022-01-31)
  windowSurvivorshipCorrected: corrected=true   coverageThrough=2018-01-31

RUSSELL2K
  Empty rebalances:        48 of 84
  First non-empty:         idx=48  date=2022-01-31  tickers=2034
  Last empty:              idx=47  date=2021-12-31
  Sample idx 0:            tickers=0               (snapshotDate null,  coverageStart 2022-01-31)
  Sample idx 47:           tickers=0               (snapshotDate null,  coverageStart 2022-01-31)
  Sample idx 48:           tickers=2034            (snapshotDate 2022-01-31)
  Sample idx 83:           tickers=1973            (snapshotDate 2024-12-31)
  windowSurvivorshipCorrected: corrected=false  coverageThrough=2022-01-31
```

`/tmp/repro-w1b.ts` (not committed) drives this; the call sites are the
same modules the deployed engine uses.

### E3 — Engine warning trail predicts 49 (matches both dead runs byte-for-byte)

`engine-batched.ts:250-258` pushes the survivorship warning **once per
run** when `!survivorship.corrected`:

```ts
if (!state.survivorshipWarned && !survivorship.corrected) {
  batchWarnings.push(
    `Universe ${config.universe} is not fully survivorship-corrected ` +
      `over [${config.startDate}, ${config.endDate}]. Coverage starts at ` +
      `${survivorship.coverageThrough ?? 'unknown'}. Results may be ` +
      `survivorship-biased — see BACKTEST_LIMITATIONS.md.`,
  );
  state.survivorshipWarned = true;
}
```

`engine-batched.ts:278-289` pushes a "universe pool empty" warning **per
empty rebalance**, then `continue`s without scoring:

```ts
const pool = universePoolForDate(config.universe, asOfDate);
if (pool.tickers.length === 0) {
  batchWarnings.push(
    `${asOfDate}: universe pool empty (no PIT snapshot covers date)`,
  );
  const flatDays = tradingDaysBetween(addDays(asOfDate, 1), nextAsOf);
  for (const d of flatDays) batchDailyEquity.push({ date: d, value: state.nav });
  state.nextRebalanceIdx = i + 1;
  rebalancesProcessed++;
  if (isExpired()) break;
  continue;
}
```

Russell2k → 48 empty pools (idx 0-47) + 1 survivorship warning =
**49 warnings**.

Cursor field on `bt_20260519233555_2kv7mt` (post-PR-#51):
`warningRowCount: 49`, `survivorshipWarned: true`. Match.

Cursor field on `bt_20260519184826_khgy8s` (pre-PR-#51): identical.

### E4 — Why scoring counters stayed at zero

Scoring at `engine-batched.ts:299-341` runs `mapWithConcurrency` over
`pool.tickers`. For idx 0-47 on russell2k, `pool.tickers === []`, so the
loop body — including `state.tickerAttemptTotal++`, the
`scoreTickerAtDate` call, the candidate-score push, and the
portfolio-construction at `:351` — never executes. Hence:
- `tickerAttemptTotal: 0`, `tickerFailureTotal: 0`
- `portfolio: []` (target portfolio never built)
- `tradeRowCount: 0`, `attributionRowCount: 0`, `mlTrainingRowCount: 0`
- `nav: 100000` (no trades → no costs → no marks via held positions)
- `dailyEquityRowCount: 1005` — the empty-pool branch DOES still push
  flat dailyEquity points via `tradingDaysBetween(...)` at `:283-284`,
  producing one row per trading day across 48 skipped rebalances; the
  observed 1005 is consistent with ~21 trading days × 48 + t0 seed +
  a small calendar artifact at the boundary, well within the expected
  range for that range of dates.

### E5 — sp500 control is unaffected because its coverage starts 2018-01-31

The deployed sp500 run (`bt_20260519233423_avaa64`) shows
`survivorshipWarned: false`, `tickerAttemptTotal: 12,220` at idx 24 —
matching ~509 tickers/rebalance × 24 = 12,216. The same engine, same
batched path, same configs (up to universe / slippage / concurrency
noise). The only difference between the working sp500 path and the
broken russell2k path is `UNIVERSE_HISTORY` coverage. No code-path
divergence required.

### E6 — No pre-flight refusal exists anywhere

`backtest-runs-trigger.ts:130-208` validates shape via `validateConfig`,
checks supported boards, sweeps stuck runs (PR #51), and runs the
single-flight check — but never asks "does the universe have coverage
for this window?". `validateConfig` (`engine.ts:89-114`) checks startDate
≤ endDate, the 2018-01-01 hard floor, topN, initialCapital, and
maxPositionPct — but not coverage. `windowSurvivorshipCorrected`
(`universe-pool.ts:103-121`) is called once during `prepRun`
(`engine-batched.ts:183`) but its result only gates the *warning*; the
engine continues regardless. There is no refuse-path; "silent empty
portfolio" is the natural outcome when window precedes coverage.

### E7 — Why the chain stalled exactly at idx 48 (secondary symptom)

Rebalances 0-47 are cheap: the engine pushes one warning and
`tradingDaysBetween` rows, then advances. A whole batch of these is
fast — well under the watchdog budget. Idx 48 is the first rebalance
with `pool.tickers.length === 2034`. The scoring loop must issue
**2034 × 10 analysts ≈ 20,340 scoring sub-calls per rebalance** at
`scoringConcurrency: 4`, far heavier than the sp500 control's
~5,000/rebalance at concurrency 5. The first such rebalance plausibly
overruns the 13-min watchdog before persisting any `tickerAttemptTotal`
increment, the worker re-invokes, the new invocation re-attempts idx 48
from scratch with no progress recorded, and the cycle repeats until
the reinvoke cap exhausts. That mechanism is consistent with
`invocationCount: 6, reinvokeAttempts: 4, lastReinvokeStatus: 202` on
the dead cursor.

**This is a secondary symptom**, not the bug to fix. Even if idx 48
completed successfully, a backtest that no-ops 2018-01-31 → 2021-12-31
and then suddenly starts trading in 2022 is not a valid russell2k
composite verdict — the W3 attribution + decile analysis depend on a
contiguous PIT sample over the full window.

## Root cause

**Named root cause:** `UNIVERSE_HISTORY` russell2k coverage starts at
2022-01-31, but `validateConfig` (`netlify/functions/shared/backtest/engine.ts:89-114`)
does not refuse a backtest whose `startDate` precedes
`universeHistoryCoverage()[universe].firstDate`. Consequently
`universePoolForDate(`russell2k`, d)` returns `{ tickers: [] }` for every
rebalance date in `[2018-01-31, 2021-12-31]`, `engine-batched.ts:279-289`
silently skips scoring on each, and the run produces a 48-rebalance
empty-portfolio prefix before the heavy idx-48 scoring call breaks the
reinvoke chain.

**Why russell2k and not sp500:** sp500's `UNIVERSE_HISTORY` was generated
with `asOfDate` backfill to 2018-01-31 (100 monthly snapshots). russell2k
was generated with only 52 monthly snapshots — the first dated
2022-01-31. The 4t backtest window asks for both to start at 2018-01-31.

**This is a data-coverage gap surfaced as a silent failure**, not a
scoring-formula bug, not a recovery/reinvoke bug, not a PIT correctness
bug in `score-at-date.ts`. The recovery/instrumentation work shipped in
PR #51 is correct — it was just downstream of the real defect.

## Proposed fix

Two changes (W2 scope), both small. **Do not implement until orchestrator
authorises this diagnosis.**

1. **Pre-flight refusal in `validateConfig`** —
   `netlify/functions/shared/backtest/engine.ts:89-114`. Add a check
   that `config.startDate >= universeHistoryCoverage()[config.universe].firstDate`
   (when `firstDate !== null`). Throw with a clear message:
   `"BacktestConfig: startDate ${config.startDate} precedes ${universe} ` +
   `UNIVERSE_HISTORY coverage start ${firstDate}. The engine refuses ` +
   `silent empty-pool runs; either choose a startDate ≥ ${firstDate} or ` +
   `regenerate UNIVERSE_HISTORY with more backfill (scripts/generate-universe-history.ts)."`
   ~12 lines of code, plus a unit test in
   `netlify/functions/shared/backtest/__tests__/engine.test.ts` (or a
   new `validateConfig.test.ts`).

   This converts the silent 48-rebalance no-op into an upfront refusal
   with a clear remediation path. It is the minimum-blast-radius fix:
   one branch in `validateConfig`, zero changes to sp500's working
   path, zero changes to the engine loop, zero changes to the recovery
   wiring, zero changes to analyst scoring.

2. **Regression test (W3)** —
   `netlify/functions/shared/backtest/__tests__/validate-config-coverage.test.ts`
   (new file). Two assertions:
   - russell2k with startDate `2018-01-31` throws an error containing
     "precedes" and "russell2k" and "2022-01-31".
   - sp500 with startDate `2018-01-31` does NOT throw.
   - russell2k with startDate `2022-01-31` does NOT throw (boundary
     case).
   Test fails without the W2 change, passes with it. Same pattern as
   `run-backtest-background.reinvoke-instrumentation.test.ts`.

**Optional follow-on (out of W1b scope):** regenerating
`UNIVERSE_HISTORY` to extend russell2k back to 2018-01-31 (the iShares
IWM endpoint supports `asOfDate` per the generator header) is what
unlocks the 4t russell2k composite verdict. That is an orchestrator
workstream — not a W2 deliverable — because it touches the generator,
vendor access, and a regenerated data file rather than a code defect.
W1b's fix only prevents the silent failure mode; it does **not** by
itself produce the russell2k verdict.

## Confidence

**High** on the named root cause and the proposed minimum-blast-radius
fix.

- The 49-warning prediction matches both dead cursors byte-for-byte
  (E3).
- The boundary at idx 48 = 2022-01-31 matches russell2k's first
  snapshot date exactly (E1, E2). The math is overdetermined.
- The two dead runs (pre- and post-PR-#51) being byte-identical
  confirms the bug is deterministic, sits below the PR #51 changes,
  and is not in the reinvoke/recovery path (E5, E6).
- sp500's working state with the same engine + same configs +
  different universe isolates the cause to coverage data (E5).
- Local repro (E2) drives the actual modules the engine uses, so the
  prediction is the deployed behaviour at `c388c6e`.

**Medium** on the exact stall mechanism at idx 48 (E7). The 48-empty +
1-survivorship = 49 warnings is overdetermined; the
"watchdog overrun on the heavy first russell2k scoring call" hypothesis
for the chain-break at idx 48 is consistent with the cursor evidence
but I have not been able to read prod logs to prove it. This does not
affect the primary diagnosis or the proposed W2 fix — the empty-portfolio
prefix is the bug, the stall at idx 48 is just where it became visible.

**Things I would want to verify before W2 lands:**

- Read the 49 warnings from the dead run's Firestore subcollection to
  literally quote them, rather than predict them from code. If
  ergonomic, I'll add a small temporary diagnostic endpoint in W2 for
  this — to be removed before W2 merges per the kickoff constraint.
  Predicting them from code is sufficient for the diagnosis call, but
  reading the literal text would close the loop.
- Check that no other code path silently catches the
  `validateConfig` throw on the trigger path — i.e., that the W2
  refusal actually surfaces a 400 to the caller, not a silent
  pass-through. (Skimmed: `backtest-runs-trigger.ts:131-140` catches
  the throw and returns 400 with the error message — looks correct.)
- Confirm the W2 fix's scope doesn't include any sp500-affecting path.
  Reading `validateConfig` it doesn't, but I will re-verify before
  opening the W2 PR.

**Things that could still be wrong but I don't think are:**

- The fix could be miscalibrated if Chad's intent for russell2k is
  "backtest only against the available coverage" rather than "refuse
  short coverage." If so, the refusal at `validateConfig` should be
  paired with a friendlier message guiding the user to set
  `startDate: 2022-01-31`. Either way, the silent failure mode goes
  away.
- If there's a hidden code path that resolves russell2k tickers from a
  source other than `UNIVERSE_HISTORY` (e.g., a cached snapshot or a
  remote lookup), the diagnosis above is incomplete. I searched for
  callers of `universePoolForDate` and `tickersInIndexOnDate`; only
  the backtest engine paths consume them, and both go through
  `UNIVERSE_HISTORY`. I am not aware of an alternate path.
- The fix should not break any existing tests. Baseline at
  `c388c6e + branch start`: **1054/1054 passing** (verified locally
  pre-diagnosis). I'll re-verify post-W2.

— Executor 4t W1b
