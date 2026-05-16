# Phase 4e-1-infra — Verification Report

**Status:** DEFERRED to post-merge — end-to-end live verification cannot
run from the executor sandbox (no outbound to tradeiq-alpha.netlify.app
from this container). Static verification is complete; the orchestrator
will fire the live curl after the PR merges to main and Netlify rebuilds.

## Architecture summary

This PR makes the two backtest background functions resumable across
Netlify's hard 15-min wall-clock ceiling. Mechanism:

1. **Cursor** (`netlify/functions/shared/backtest-resume/cursor.ts`) —
   per-run resume state stored as a top-level `cursor` field on the run
   document (`portfolioBacktests/{runId}` / `backtestRuns/{runId}`).
2. **Watchdog** (`netlify/functions/shared/backtest-resume/watchdog.ts`) —
   13-min budget (90s safety margin under the 15-min kill). The batch
   loop checks `isExpired()` after each rebalance and breaks out early.
3. **Self-reinvoke** (`netlify/functions/shared/backtest-resume/reinvoke.ts`) —
   `context.waitUntil(fetch(SAME_FUNCTION_URL))` so the dispatch fetch
   gets grace time before the container freezes. This is the same race
   PR #30 and #31 fixed at the trigger layer.

Per-batch flow:

```
trigger writes:   {status: pending, config: ..., cursor: <absent>}
invocation 1:     readCursor=null → init state, persistRunRunning,
                  process BATCH_SIZE rebalances,
                  appendMLTrainingRows(startIdx=0)        // regular only
                  writeCursor({nextRebalanceIndex=8, state, count=400}),
                  dispatchReinvoke via ctx.waitUntil,
                  return 202
invocation 2..N:  readCursor → resume from saved state,
                  invocationCount++,
                  process next batch,
                  appendMLTrainingRows(startIdx=cumulative),
                  writeCursor, reinvoke
final batch:      done=true → readAllMLTrainingRows (regular) →
                  finalize → persistRunResult → clearCursor →
                  return 200, no reinvoke
```

- **Batch size:** 8 rebalances/invocation (configurable via env
  `BACKTEST_BATCH_SIZE`). 8 × 63s ≈ 8.4 min, well under the 13-min budget.
- **Watchdog budget:** 13 min (env `BACKTEST_BUDGET_MS`).
- **Cursor schema:** generic over `TState`; portfolio + regular each
  define their own state shape that captures everything needed to resume
  (positions, NAV, accumulated equity curve, trades, attribution, etc.).
- **mlTraining rows:** written to subcollection per batch (the regular
  path) — too big to keep in cursor (50 × 84 ≈ 4200 rows ≈ 1.3 MiB,
  past Firestore's 1 MiB ceiling). Final batch reads them back via
  `readAllMLTrainingRows` to compute the information coefficient.

## Files

**New (shared primitives):**
- `netlify/functions/shared/backtest-resume/cursor.ts`
- `netlify/functions/shared/backtest-resume/watchdog.ts`
- `netlify/functions/shared/backtest-resume/reinvoke.ts`
- `netlify/functions/shared/backtest-resume/__tests__/cursor.test.ts`
- `netlify/functions/shared/backtest-resume/__tests__/watchdog.test.ts`
- `netlify/functions/shared/backtest-resume/__tests__/reinvoke.test.ts`

**New (batched engine + harness):**
- `netlify/functions/shared/prophet-portfolio/backtest-harness-batched.ts`
- `netlify/functions/shared/prophet-portfolio/__tests__/backtest-harness-batched.test.ts`
- `netlify/functions/shared/backtest/engine-batched.ts`
- `netlify/functions/shared/backtest/__tests__/engine-batched.test.ts`

**Modified (bg-functions + persistence):**
- `netlify/functions/run-portfolio-backtest-background.ts` (refactored to
  cursor-driven; uses processPortfolioBatch + finalizePortfolioBacktest)
- `netlify/functions/run-backtest-background.ts` (refactored to
  cursor-driven; uses processRegularBatch + finalizeRegularBacktest)
- `netlify/functions/shared/backtest/engine.ts` (adds `_engineInternals`
  export so the batched module reuses the per-rebalance math — single
  source of truth for cache keys + bar-window edge cases)
- `netlify/functions/shared/backtest/persistence.ts` (adds
  `appendMLTrainingRows(runId, rows, startIdx)` and
  `readAllMLTrainingRows(runId)`)

**Modified (existing tests rewritten for the new architecture):**
- `netlify/functions/__tests__/run-portfolio-backtest-background.test.ts`
- `netlify/functions/__tests__/run-backtest-background.test.ts`

**New (checkpoint chain integration tests):**
- `netlify/functions/__tests__/run-portfolio-backtest-background.checkpoint.test.ts`
- `netlify/functions/__tests__/run-backtest-background.checkpoint.test.ts`

**Version bump:**
- `src/App.jsx` — `APP_VERSION` 0.18.1-alpha → 0.18.2-alpha
  (MODEL_VERSION unchanged — no scoring math changes).

## Static verification

| Check                  | Result                              |
|------------------------|-------------------------------------|
| `npx tsc --noEmit`     | clean                               |
| `npm test`             | 691 passing (was 638; +53 new)      |
| `npm run build`        | clean (built in ~7.8s)              |
| `git status`           | tree clean on phase-4e-1-infra branch |

Test additions:
- W1-W3 unit tests (cursor, watchdog, reinvoke): 26
- W4 batched portfolio harness equivalence + checkpoint: 8
- W4 portfolio bg-function handler: 9
- W4 portfolio bg-function checkpoint chain integration: 5
- W5 batched regular engine equivalence + checkpoint: 7
- W5 regular bg-function handler: 9
- W5 regular bg-function checkpoint chain integration: 4
- Total: **53 new tests**

The W4 + W5 equivalence tests are the load-bearing ones — they pin that
the batched + finalize pipeline produces the same numeric output as
`runBacktest` / `runPortfolioBacktest` when the chain covers the same
schedule. Same trades, same dailyEquity, same metrics within float
tolerance.

## End-to-end verification — DEFERRED

The kickoff's W6 step calls for firing live curls against
tradeiq-alpha.netlify.app and watching `cursor.invocationCount`
increment across batches until status flips to `done`. The executor
sandbox does not have outbound network access to that host. Per the
kickoff fallback ("If you can't verify in your sandbox … document in
PR description, orchestrator will fire after merge"), the runbook is:

```bash
# Portfolio full-window — should chain ~6-7 invocations over ~90-120 min
curl -sS -X POST https://tradeiq-alpha.netlify.app/api/portfolio-backtest/start \
  -H "Content-Type: application/json" \
  -d '{"window": "full"}'

# Regular sp500 full-window (0a-2 acceptance) — should chain similarly
curl -sS -X POST https://tradeiq-alpha.netlify.app/api/backtest-runs/start \
  -H "Content-Type: application/json" \
  -d '{
    "universe": "sp500",
    "startDate": "2018-01-01",
    "endDate": "2024-12-31",
    "rebalanceFrequency": "monthly",
    "board": "prophet",
    "portfolio": {"topN": 50, "weighting": "equal", "maxPositionPct": 0.05, "maxSectorPct": 0.40, "cashSleeve": 0.00, "minComposite": 50},
    "costs": {"slippageBps": {"sp500": 10}, "commission": 0},
    "initialCapital": 100000
  }'
```

What to watch (poll every 3 min):
- `cursor.nextRebalanceIndex` advances 0 → 8 → 16 → … → 84 across invocations.
- `cursor.invocationCount` increments — proves the self-reinvoke loop
  works under real Netlify runtime semantics (the existing test mocks
  cover the dispatch path but not the actual `context.waitUntil`
  behavior).
- `status` flips `pending` → `running` (invocation 1) → stays `running`
  through all checkpoint batches → flips to `done` on the terminal batch.
- The cursor field disappears (set to `null`) atomically with the
  terminal write.

Acceptance:
- **Portfolio:** `status: done`, `cursor: null`, `invocationCount >= 6`,
  total wall-clock 90-120 min.
- **Regular sp500 7yr:** `status: complete`, `tradeCount > 0`,
  mlTraining subcollection has >= 3000 rows.

## Risks + open questions

- **Live `context.waitUntil` behavior.** The unit tests pass a spy as
  `ctx.waitUntil` and assert the fetch promise is enqueued. The actual
  Netlify Background Function runtime injects `waitUntil` on the v1
  HandlerContext at runtime; this is documented as the only way to keep
  the container alive past the handler's promise resolution. If
  Netlify's runtime DOESN'T have `waitUntil` on the v1 context for
  background functions (which would surprise us), the reinvoke helper
  falls back to `await fetch(...)` — which still works for the dispatch
  but loses the grace-time guarantee that's the whole point. Live
  verification will confirm.
- **mlTraining subcollection read latency.** `readAllMLTrainingRows`
  pulls every doc in the subcollection on the terminal batch. For the
  full sp500/monthly run that's ~4200 docs. Firestore can stream this
  but if it takes >1 min the terminal batch could brush the 15-min
  ceiling. Watchdog won't fire on the read itself — but the terminal
  batch's pre-finalize work is bounded, so this should be fine.
  Worth checking in the live run.
- **Cursor doc size on the regular path.** Cumulative `trades` +
  `attribution` + `dailyEquity` could approach the 1 MiB ceiling for
  very large topN. Current config (topN=50) is well under
  (estimated ~500 KB). If a future run pushes topN much higher, those
  arrays would need to move to subcollections too.

## What would prove the architecture is wrong

- Both ends of a chain disagree on the final result vs. a single-pass
  run for the same window. Equivalence tests pin this for synthetic
  data; the live run validates against Polygon / Firebase.
- The reinvoke fetch never lands and the run sits stuck at the cursor
  position from invocation 1 (the same failure mode PR #30/#31 fixed at
  the trigger layer). Symptom: `cursor.invocationCount = 1` 30 min in.
- Watchdog never fires and a batch gets killed mid-rebalance by Netlify.
  Symptom: cursor stamped between batches but `nextRebalanceIndex`
  doesn't advance on the next invocation. Recovery: bump BATCH_SIZE
  down via env var without redeploy.
