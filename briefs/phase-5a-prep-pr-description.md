# Phase 5a-prep — per-candidate mlTraining row emission

Changes `mlTraining` row generation from **once per held position** to
**once per scored candidate**, so the Phase 5a ML pipeline trains on the
full cross-section of the universe rather than a tiny, selection-biased
subset of held picks.

A full sp500/monthly/7-year backtest emitted ~165 ml rows under the old
scheme — far short of the ≥10k Phase 5a needs, and biased toward the
names the strategy already picked. After this PR the same run emits
~42,000 rows (~500 scored names × 84 monthly rebalances), each carrying
a new `inPortfolio` boolean so the 5a consumer can filter to held-only
without losing the unbiased sample.

## What changed

| File | Status | Why |
|---|---|---|
| `netlify/functions/shared/backtest/types.ts` | edit | `MLTrainingRow` gains `inPortfolio: boolean` (required) |
| `netlify/functions/shared/backtest/engine.ts` | edit | Combined loop split into §7a attribution (per held position, unchanged) + §7b ml rows (NEW, per scored candidate) |
| `netlify/functions/shared/backtest/engine-batched.ts` | edit | Identical §7a/§7b split — mirrors `engine.ts` |
| `netlify/functions/shared/backtest/__tests__/metrics.test.ts` | edit | 4 IC fixtures gain `inPortfolio` |
| `netlify/functions/shared/backtest/__tests__/engine-batched.test.ts` | edit | Equivalence assertions extended; 3 new tests |
| `reports/phase-5a-prep/verification.md` | new | Verification report |
| `briefs/phase-5a-prep-pr-description.md` | new | This file |
| `src/App.jsx` | edit | `APP_VERSION` 0.18.3-alpha → 0.18.4-alpha |
| `ORCHESTRATOR.md` | edit | Mark 5a-prep row done |

## Approach

The old code had a single `for (const p of target)` loop that did both
per-position attribution **and** ml-row emission. This PR splits it:

- **§7a attribution** — unchanged. Attribution is portfolio-level: one
  record per held position, explaining the portfolio's realized return.
  Still iterates `target`.
- **§7b ml rows** — NEW. Iterates the full `scored` candidate set. For
  each candidate it computes the same entry price + four forward
  returns as before, and sets `inPortfolio` from a `Set` of held
  tickers.

Both engines (`engine.ts` and `engine-batched.ts`) get the identical
change — they must stay in lockstep or the equivalence tests fail.

### Per-candidate bar fetches

The ml-row loop now does ~500 `getCachedBars` calls per rebalance
(one per scored candidate) instead of ~2. These run through
`mapWithConcurrency` at concurrency 6, so a rebalance does not fan out
500 simultaneous Polygon calls. Bars are PIT-cached: the first run of a
config is slower, re-runs are cheap. `mapWithConcurrency` preserves
input order, so ml rows land deterministically in `scored` order —
which keeps the batched engine's subcollection doc-id assignment stable
across resumes.

## Cursor arithmetic

No change was needed and none was made. `engine-batched.ts` already
advanced `state.mlTrainingRowCount` by the **actual** `batchMlRows.length`,
and `run-backtest-background.ts` (out of scope, untouched) already
passes the cumulative count as `startIdx` to `appendMLTrainingRows`.
Both use real array lengths, so `startIdx` accounting stays correct at
the larger ~500-row/rebalance scale. A new test proves it: a 2-batch
and a 1-batch run over the same window write byte-identical contiguous
`mlTraining` doc ids with no gaps, dupes, or seam overwrite.

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — 694 passing (was 691)
- `npm run build` — clean

See `reports/phase-5a-prep/verification.md` for the full report,
including the expected ~42k row count and the rationale for the +3 test
delta (the pre-existing equivalence tests already passed unchanged).

## Acceptance

DEFERRED to post-merge — the executor sandbox has no outbound route to
the live deploy. The orchestrator fires a fresh sp500/monthly/top50/
2018-2024 backtest after merge and confirms `mlTrainingCount >= 10000`
(expected ~42,000).

## Known limitations

First-run slowness: the ~500 bar fetches per rebalance make a cold-cache
sp500/monthly/7yr run materially slower on its first pass. This is
absorbed by the Phase 4e-1-infra checkpoint-and-resume harness (batches
process fewer rebalances per invocation if per-rebalance cost rises), so
it affects wall-clock time, not run completion. Re-runs hit the cache.
