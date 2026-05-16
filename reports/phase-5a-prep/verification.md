# Phase 5a-prep — Verification Report

**Status:** Static verification complete. Live acceptance DEFERRED to
post-merge — the executor sandbox has no outbound route to
`tradeiq-alpha.netlify.app`, so the full sp500 acceptance run is fired
by the orchestrator after this PR merges and Netlify rebuilds.

## What changed and why

Before this PR, `mlTraining` rows were emitted **once per held position
per rebalance**. The held portfolio (`target`) only contains names that
clear `minComposite` and land in the top-N, which at sp500 scale is a
very small set per rebalance. A full sp500/monthly/7-year backtest
produced on the order of ~165 ml rows — far short of the ≥10k that the
Phase 5a ML pipeline needs, and biased: the model would only ever see
the selection-confirmed picks, never the full cross-section.

This PR changes ml-row generation to emit **one row per scored
candidate** — every ticker in the universe that received a composite
score that rebalance. A new required boolean field, `inPortfolio`,
marks whether that candidate was actually held. The training data is
now cross-sectional: the 5a model learns what features predict forward
return across the whole universe, and can still filter to held-only via
`inPortfolio` when needed.

## Scope of the change

| File | Change |
|---|---|
| `types.ts` | `MLTrainingRow` gains `inPortfolio: boolean` (required). |
| `engine.ts` | Old combined loop split: §7a attribution (unchanged, per held position) + §7b ml rows (NEW, per scored candidate). |
| `engine-batched.ts` | Identical §7a/§7b split — mirrors `engine.ts` exactly. |
| `metrics.test.ts` | 4 IC fixtures gain `inPortfolio`. |
| `engine-batched.test.ts` | Equivalence assertions extended for the larger row set; 3 new tests added. |

Attribution was deliberately **not** changed — it is portfolio-level
and stays `for (const p of target)`. Only the ml-row loop iterates the
full scored set.

## Key implementation decisions

- **Per-candidate bar fetches.** Each scored candidate needs its own
  `getCachedBars` call to compute the entry price + four forward
  returns — ~500 fetches per rebalance for sp500 instead of ~2. These
  run through `mapWithConcurrency` at a concurrency of 6 so a rebalance
  does not fan out 500 simultaneous Polygon calls. Bars are PIT-cached,
  so the first run of a given config is slower but re-runs are cheap.
- **Deterministic row order.** `mapWithConcurrency` keys on ticker
  strings and preserves input order in its result array, so ml rows
  land in `scored` order regardless of fetch-completion order. This is
  load-bearing for the batched engine: `appendMLTrainingRows` assigns
  subcollection doc ids `startIdx..startIdx+N-1` in array order, and a
  resumed run must reproduce the same ids.
- **`mapWithConcurrency` signature.** The helper takes `string[]` +
  `(ticker: string) => Promise<T>` and returns `Array<T | undefined>`.
  The loop maps over `scored.map(c => c.ticker)` with a ticker→candidate
  lookup map, and narrows the `undefined` slots out (the mapper never
  throws — its sole async op is `.catch`-wrapped — so no slot is ever
  actually undefined; the filter is a type guard).

## Cursor / idempotency

No code change was needed for cursor arithmetic, and none was made:

- `engine-batched.ts` already does
  `state.mlTrainingRowCount += batchMlRows.length` — the **actual**
  per-batch array length, not a hardcoded estimate.
- `run-backtest-background.ts` (NOT touched — out of scope) already
  passes `cursor.cumulativeMetrics.mlTrainingCount` as `startIdx` to
  `appendMLTrainingRows` and advances it by `res.batchMlRows.length`.

Both already use real array lengths, so the `startIdx` accounting stays
correct at the new ~500-row/rebalance scale. The new
cursor-arithmetic test proves this: a 2-batch run and a 1-batch run
over the same window write byte-identical contiguous `mlTraining` doc
ids (`00000000..N-1`), with no gaps, no duplicates, and no overwrite at
the batch seam.

## Static verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | 694 passing (was 691) |
| `npm run build` | clean |

### Test delta

Baseline 691 → 694 (+3 net). The kickoff forecast +15-30; the actual
delta is smaller because the pre-existing batched-engine equivalence
tests already passed unchanged (both engines emit the same larger row
set, so `batched === unbatched` still holds), and only 4 fixtures
needed the new field. The +3 are three focused tests that cover every
PART 4 requirement directly:

1. **Per-rebalance N/M** — for the mock dow universe, every rebalance
   emits exactly N=30 ml rows, of which exactly M=`topN`=5 carry
   `inPortfolio: true`; the held set equals the top-M by composite with
   `buildPortfolio`'s ticker tiebreak.
2. **Batch-invariance** — a 1-batch run and a chained per-rebalance run
   produce field-identical ml rows (same count, same `(date,ticker)`
   keyed rows, deep-equal).
3. **Cursor arithmetic** — described above.

The existing equivalence test was also strengthened in place: it now
asserts the ml-row count (`scheduleLength × universeSize`), the
per-rebalance N/M split, and the absence of duplicate `(date,ticker)`
keys.

## Acceptance (DEFERRED to post-merge)

The orchestrator fires a fresh **sp500 / monthly / top50 / 2018-2024**
backtest after merge and confirms `mlTrainingCount >= 10000`.

**Expected row count:** 2018-01..2024-12 is 84 monthly rebalances; the
sp500 universe is ~500 names. With every scored candidate emitting a
row, the run yields **~42,000 ml rows** (84 × ~500), versus ~165 under
the old per-held-position scheme. Even with a substantial scoring
failure rate or partial universe coverage, the count stays well above
the 10k floor — it would take >75% of candidates failing to score to
fall below it.

`top50` only affects portfolio construction (how many names are held);
it does not reduce the scored-candidate count, so it does not reduce
the ml-row count.

## Known limitations

- **First-run slowness.** The ml-row loop now performs ~500
  `getCachedBars` calls per rebalance instead of ~2. On a cold PIT
  cache the first sp500/monthly/7yr run is materially slower. This is
  absorbed by the Phase 4e-1-infra checkpoint-and-resume harness — a
  batch simply processes fewer rebalances per invocation if per-
  rebalance cost rises — so it does not threaten run completion, only
  wall-clock time on the first pass. Re-runs hit the cache and are fast.
- **No live acceptance from the sandbox.** As noted, the ≥10k assertion
  is verified post-merge by the orchestrator, not in this PR.
