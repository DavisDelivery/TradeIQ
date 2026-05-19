# Phase 4u — W1 diagnosis: what grows on the backtest cursor

**Question:** why did `bt_20260519014434_pbfjtx` (Williams baseline,
sp500/weekly, 2018-2024, score-ranked) fail at invocation 18 on
2026-05-19 02:28 UTC with:

```
3 INVALID_ARGUMENT: Document
'projects/tradeiq-alpha/databases/(default)/documents/backtestRuns/
bt_20260519014434_pbfjtx' cannot be written because its size
(1,086,304 bytes) exceeds the maximum allowed size of 1,048,576 bytes.
```

i.e. *what in the cursor accumulates without bound,* and is it the
same shape on the portfolio cursor too?

**Method:** read every link
(`run-backtest-background.ts` → `processRegularBatch` in
`engine-batched.ts` → `cursor.ts:writeCursor` → `persistence.ts`),
catalogue each `cursor.state` field by whether it accumulates per
batch, and tally projected size for the **largest** TradeIQ run
(Phase 4t — ten-analyst composite on Russell 2000, ~2,000 tickers).
Cross-check by computing the trades-per-rebalance rate from the
*successful* Williams BUY-only run (`bt_20260519014409_zsxtsq`,
which completed with the same engine just less emission), and the
failed-baseline rate from the doc that overflowed.

---

## Section 1 — what's on the cursor

`BacktestCursor<RegularBacktestState>` (cursor.ts) carries:

| Cursor-level field | Bounded? | Notes |
|---|---|---|
| `nextRebalanceIndex` | yes (int) | resume pointer |
| `totalRebalances` | yes (int) | immutable across batches |
| `lastInvocationStartedAt` | yes (ISO string) | |
| `invocationCount` | yes (int) | |
| `cumulativeMetrics.tradeCount` | yes (int) | running counter |
| `cumulativeMetrics.mlTrainingCount` | yes (int) | running counter |
| Phase-4r-W1b diagnostic fields | yes (int / string / int) | counters + last status |
| `state: RegularBacktestState` | **NO — this is the accumulator** | breakdown below |

`RegularBacktestState` (`engine-batched.ts:58–85`) breakdown:

| State field | Bounded? | Per-run growth at sp500/weekly/7yr |
|---|---|---|
| `nextRebalanceIdx: number` | yes | 1 int |
| `totalRebalances: number` | yes | 1 int |
| `portfolio: PortfolioPosition[]` | yes — capped at topN | ≤ 20 entries × ~120 B = ≤ 2.4 KB |
| `nav: number` | yes | 1 number |
| `dailyEquity: DailyEquityPoint[]` | **NO** | ~1740 entries over 7 yr × ~50 B = ~87 KB |
| `trades: TradeRecord[]` | **NO** | ~3 KB per rebalance × N rebalances → see §2 |
| `attribution: AttributionRecord[]` | **NO** | ~300 B per (rebalance, ticker) → see §2 |
| `warnings: string[]` | typically small | few per run; could grow with `survivorshipWarned` defects |
| `tickerFailureSample: TickerFailure[]` | yes — capped at 20 (`FAILURE_SAMPLE_CAP`) | ≤ 20 entries × ~150 B = ≤ 3 KB |
| `tickerFailureTotal: number` | yes | 1 int |
| `tickerAttemptTotal: number` | yes | 1 int |
| `mlTrainingRowCount: number` | yes | 1 int (rows themselves go to the subcollection) |
| `survivorshipWarned: boolean` | yes | 1 bool |

The three **unbounded** fields are `dailyEquity`, `trades`,
`attribution`. (Plus `warnings` in degenerate cases.) Each batch
appends to them; the worker writes the entire growing array onto the
cursor doc on every checkpoint.

Note `mlTraining` rows are **not** carried here — Phase 4e-1-infra
already moved them to a subcollection
(`appendMLTrainingRows` / `readAllMLTrainingRows`) precisely to keep
the cursor doc under 1 MiB. The same discipline never made it to
`dailyEquity / trades / attribution`. That is the defect.

---

## Section 2 — sizing the failed run vs the Phase 4t target

Per-record JSON size (UTF-8, conservative — Firestore stores each
field name in every doc, so the on-disk hit is slightly larger):

- `TradeRecord`: 12 fields, ~200 B serialized
- `AttributionRecord`: 7 fields + `layers: Record<string, number>` —
  ~250 B with one layer (`williamsScore`), ~500 B with ten layers
  (the 4t composite shape)
- `DailyEquityPoint`: 2 fields, ~50 B

### The failed Williams baseline

`bt_20260519014434_pbfjtx` reached invocation 18 with
**29,039 mlTrainingCount** (`/api/backtest-runs/{runId}` reports the
field on the run doc). At sp500 / weekly the score-ranked baseline
emits an mlTraining row for every scored sp500 candidate at every
processed rebalance. ≈500 tickers × 58 rebalances processed
(8 rebalances per batch × ~7 productive batches before the
batch-size growing to absorb cache hits, plus partial batches) ≈
29k rows — matches.

Trades and attribution at the same point:
- **Trades**: weekly score-ranked with topN=20 on sp500 churns
  heavily — observed in the successful BUY-only run at 1,785 trades
  over 313 rebalances (~5.7 trades/rebalance). Baseline ran 58
  rebalances; at the same churn rate, ~330 trades, ~66 KB. But
  baseline turnover is much higher (no discrete-signal gate), so
  10–15 trades/rebalance is realistic → ~600–870 trades → ~120–
  175 KB.
- **Attribution**: top-20 × 58 rebalances = 1,160 records × ~250 B
  (Williams has one layer, `williamsScore`) = ~290 KB.
- **dailyEquity**: 58 rebalances × ~5 trading days/week ≈ 290 days
  × ~50 B = ~14.5 KB.
- **Other state fields** (portfolio, nav, counters, sample): < 5 KB.
- **Wrapper overhead** (cursor JSON, field names, Firestore
  envelope): ~10–30%.

Sum: **~430–510 KB** of *engine* state + the Firestore envelope.
But the failure was at 1,086,304 bytes — about **2×** that. The
extra came from one of two places, both compounding:

1. **Layers map width.** AttributionRecord's `layers` field carries
   each *analyst's* contribution. The Williams board has one
   analyst (`williamsScore`) — small. The Phase 4t composite has
   ten. The baseline run here is Williams, so layers width is one,
   so this is *not* the multiplier here — but flagged for §3.
2. **Repeated FieldValue serialisation of the entire cursor.state
   on every Firestore write.** Firestore stores the cursor object
   as one nested map; the SDK serialises it on every `set()`. There
   is no compression; the entire payload (including the seed
   dailyEquity row) sits inline. Combined with the per-batch growth
   the doc inflated until exactly invocation 18, when an additional
   ~1.5 KB of new trades + attribution + dailyEquity pushed the
   wire payload past 1,048,576.

So the immediate accumulator behind this specific failure is the
**triple of `trades`, `attribution`, `dailyEquity`**, all written
inline on the cursor doc on every batch. Of those, **`attribution`
is the largest contributor** (top-N × N-rebalances dwarfs
trade-count for score-ranked configs).

### Projection to the 4t Russell 2000 composite (the load-bearing case)

Phase 4t backtests the ten-analyst composite on russell2k. Workload
inputs:

- Tickers: ~2,000 (russell2k)
- Rebalances: weekly × 7 years ≈ 365
- topN: 50 (assumed similar to other portfolios)
- Layers per `AttributionRecord`: **10** (the composite is ten
  analysts, not one)

Per-batch growth at full-run:

| Array | Per-rebalance rate | Full-run count | Per-record | Total |
|---|---|---|---|---|
| `attribution` | 50 rows | 50 × 365 = 18,250 | ~500 B (10 layers) | **~9.1 MB** |
| `trades` | 10–30 (turnover) | ~7,300 | ~200 B | ~1.5 MB |
| `dailyEquity` | ~5 days/week | ~1,825 | ~50 B | ~91 KB |
| `mlTraining`* | 2,000 rows | 730,000 | (subcollection) | n/a |

\* mlTraining is already in a subcollection — no contribution to
cursor doc size.

The cursor doc would need to hold roughly **~10–11 MB inline** to
finish — *ten times* the Firestore per-doc ceiling. **The 4t
russell2k run cannot complete with the current cursor shape.** It
would fail much earlier than invocation 18 — `attribution` alone
hits 1 MiB at ~2,000 records (~40 rebalances, ~5 invocations at
batchSize=8).

This is the load-bearing finding the brief asked for.

---

## Section 3 — the portfolio cursor (audit, per brief PART IV §4)

`PortfolioBacktestState` in
`shared/prophet-portfolio/backtest-harness-batched.ts:36–52`:

| Field | Bounded? | Notes |
|---|---|---|
| `cash: number` | yes | |
| `positions: PortfolioPosition[]` | yes — capped at topN | |
| `equityCurve: PortfolioBacktestResult['equityCurve']` | **NO** | accumulates daily mark equity points |
| `swaps: SwapEvent[]` | **NO** | one per rebalance event (could be many if turnover high) |
| `warnings: string[]` | typically small | |
| `totalSlippage / totalTurnoverNotional` | yes | scalars |
| `completedHolds: number[]` | **NO** | one per completed swap-out — grows with swaps |
| `nextMarkIdx / nextRebalanceIdx` | yes | scalars |

**Same shape defect.** Three unbounded fields: `equityCurve`,
`swaps`, `completedHolds`. The full 8-year `pb-full` window
completed in 31 min back on 2026-05-16 — but the cursor was
rewriting `equityCurve` + `swaps` every batch. The
`pb-full-202605161946-osiwpg` run did *not* fail because the
single-window scale is smaller (~2,016 trading days × ~50 B equity
points ≈ 100 KB plus a few hundred swaps), but it is the same shape
defect; a longer or more-turbulent window would overflow.

W1 must fix the portfolio cursor too. The brief PART VII §4 makes
this an acceptance criterion.

---

## Section 4 — proposed fix

The cursor is a *checkpoint*, not a *ledger*. It should answer
"where am I and what are the running totals" in bounded space.
Anything that grows with rebalances/days/trades belongs in a
subcollection.

The codebase already follows this for `mlTraining`:
- Engine emits per-batch rows in `ProcessBatchResult.batchMlRows`.
- Worker appends per batch via `appendMLTrainingRows(runId, rows,
  startIdx)`.
- Cursor keeps only `cumulativeMetrics.mlTrainingCount`.
- Terminal batch reads back via `readAllMLTrainingRows`.

W1 applies the same shape to the three regular-engine growers and
the three portfolio growers:

### Regular-engine
- Strip `dailyEquity / trades / attribution / warnings` from the
  cursor's persisted state on each checkpoint write.
- Worker captures each batch's contribution from `res.state.X`
  immediately after the batch returns, appends to a per-array
  subcollection (`dailyEquity / trades / attribution / warnings`)
  with monotonic start-indexes — same shape as
  `appendMLTrainingRows`.
- On terminal batch, worker reads back the four subcollections and
  passes them as explicit args to `finalizeRegularBacktest`.
- `finalizeRegularBacktest` becomes a pure function over
  `(config, runId, state, allDailyEquity, allTrades, allAttribution,
  allWarnings, allMlRows, ...prep)` — no hidden dependence on the
  cursor's persisted state arrays.

### Portfolio engine
- Strip `equityCurve / swaps / completedHolds / warnings` similarly.
- Worker appends to subcollections each batch.
- `finalizePortfolioBacktest` reads them at terminal step.

### Why this is contained (not an invasive refactor)

The arrays are **write-only across batches** — `processRegularBatch`
appends to them mid-rebalance but never reads them. (The only
mid-batch read is `state.warnings`, which is push-only too.) Same
for `processPortfolioBatch`. So we can strip them from the cursor
without changing any mid-batch logic.

The fix is contained to:
- `engine-batched.ts:RegularBacktestState` shape + finalize signature
- `backtest-harness-batched.ts:PortfolioBacktestState` shape + finalize signature
- `run-backtest-background.ts` (append per batch + read at finalize)
- `run-portfolio-backtest-background.ts` (same)
- `persistence.ts` (generalise the append/read helpers)
- `cursor.ts` (no change — the cursor type is generic over `TState`)
- Tests covering multi-batch resume against the new shape

### Size target post-fix

Cursor post-fix carries only bounded fields:
- `nextRebalanceIdx, totalRebalances, nav, portfolio (≤ topN entries),
  warnings (rare), tickerFailureSample (≤ 20), four counters,
  survivorshipWarned, the W1b diagnostic fields`.

Largest realistic size — Phase 4t russell2k composite:
- portfolio: 50 entries × ~120 B = ~6 KB
- warnings: ≤ a few KB
- everything else: < 1 KB

**Total: < 10 KB per cursor write** — three orders of magnitude
below the 1 MiB ceiling, regardless of run length or turnover.

---

## Section 5 — what is *not* the cause (ruled out)

- **The reinvoke chain** (Phase 4r-W1b). The failed Williams
  baseline ran 18 invocations cleanly through the W1b reinvoke
  fix; the cursor write itself was the call that threw. Reinvoke
  is not at fault.
- **`mlTraining` rows.** They are already in a subcollection;
  `cursor.state.mlTrainingRowCount` is a single int.
- **Single-flight or trigger logic.** The run started and completed
  17 batches; the trigger did its job.
- **Engine compute bugs.** The engine produced reasonable per-batch
  output — the failure is purely in the persisted shape of the
  state it returns.
