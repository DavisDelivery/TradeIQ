# Phase 4e-1-infra Executor Kickoff — Backtest checkpoint-and-resume

> **For Chad:** paste the bootstrap at the end of this conversation
> as the opening message of a new Claude chat. The GitHub PAT is
> embedded inline; no follow-up message needed.

---

You are an executor agent. Your single assignment is **Phase 4e-1-infra
— checkpoint-and-resume for the backtest background functions** in
the TradeIQ project. The conversation you're reading right now is
your complete boot prompt. Read end-to-end, then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. Its backtest engine runs as a
Netlify Background Function (`-background.ts` filename suffix) that
processes a sequence of rebalance dates, scoring each ticker through
the analyst pipeline and persisting trades + mlTraining rows to
Firestore. Owner: Chad Davis. Stack: TypeScript Netlify functions
+ React 18 / Vite SPA + Firestore + Polygon / Finnhub / Quiver / FRED.

## Your assignment in two sentences

Both `run-portfolio-backtest-background.ts` and
`run-backtest-background.ts` are monolithic single-pass implementations
that hit Netlify's hard 15-minute Background Function execution
ceiling for any window over ~14 rebalances. Add cursor-based
checkpoint-and-resume with `Context.waitUntil()` self-reinvoke so a
full 7-year sp500 monthly backtest (~84 rebalances) can complete by
chaining batched invocations.

---

# PART 1 — COLD START

## 1.1 Boot commands

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -6
# Expected (top, in some order):
#   orchestrator: discovered Netlify 15-min ceiling kills multi-year backtests
#   orchestrator: bgfix-2 (PR #31 -> 08aff83); 0a-2 acceptance re-fired
#   fix: backtest-runs-trigger awaits dispatch fetch (bg-dispatch race, mirrors #30) (#31)
#   orchestrator: bg-dispatch fixed (PR #30 -> 1a8a003); 4e-1-finish re-fired
#   fix: portfolio-backtest-trigger awaits dispatch fetch (bg-dispatch race) (#30)

git config user.email "executor-4e-1-infra@tradeiq.local"
git config user.name "Executor 4e-1-infra"

npm ci
npx tsc --noEmit             # must be clean
npm test                     # baseline 638 passing as of ebeae7a
npm run build                # must complete cleanly

git checkout -b phase-4e-1-infra-checkpoint-resume
```

If baseline fails, STOP and report to Chad with exact output.

## 1.2 Secrets handling

**Inline:**
- GitHub PAT (write-scoped, repo): already in clone URL above. Used
  for `git push` and `POST /pulls` (PR open).

You will NOT need any other credentials. The end-to-end verification
runs against live Netlify deploys; Polygon + Firebase env vars are
already configured server-side.

---

# PART 2 — REPO ORIENTATION

## 2.1 Files you ARE allowed to touch

**Editing (the load-bearing changes):**
- `netlify/functions/run-portfolio-backtest-background.ts` — the portfolio bg-function
- `netlify/functions/run-backtest-background.ts` — the regular bg-function

**Creating (shared utility):**
- `netlify/functions/shared/backtest-resume/cursor.ts` — cursor schema + read/write
- `netlify/functions/shared/backtest-resume/watchdog.ts` — wall-clock budget guard
- `netlify/functions/shared/backtest-resume/reinvoke.ts` — self-reinvoke helper
- `netlify/functions/shared/backtest-resume/__tests__/*.test.ts` — unit tests
- `netlify/functions/__tests__/run-portfolio-backtest-background.checkpoint.test.ts` — integration
- `netlify/functions/__tests__/run-backtest-background.checkpoint.test.ts` — integration
- `reports/phase-4e-1-infra/verification.md` — end-to-end results

## 2.2 Files you may NOT touch

- The triggers (`portfolio-backtest-trigger.ts`, `backtest-runs-trigger.ts`).
  They were already fixed in #30 + #31; they just write `pending` docs
  and dispatch to the bg-functions.
- Any analyst / scoring code under `netlify/functions/shared/`
  except the new `backtest-resume/` subdirectory you create.
- `src/` — the React app doesn't need changes for this.
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`.
- Anything under `scripts/` except adding to existing test-fixture
  files if you need to.

## 2.3 The bug (confirmed live)

```
pb-short-demo-202605151412-89zcqq  (3-month / 14 rebalances)
  startedAt:    14:12:13 UTC
  runningAt:    14:45:02 UTC
  completedAt:  14:59:47 UTC        ← 14m 45s compute (BARE squeak under 15-min wire)
  status:       done
  Result:       complete with full metrics

pb-full-202605151418-8v4k66        (7-year / ~84 rebalances)
  startedAt:    14:18:47 UTC
  runningAt:    14:51:34 UTC
  last update:  14:51:34 UTC        ← never updated again after runningAt
  status:       running              ← DEAD (killed by Netlify at 15-min mark; doc stays in this state forever)
  Result:       silently killed; ~14 rebalances of 84 may have processed but nothing persisted
```

Per-rebalance compute at sp500/monthly = ~63 sec. Hard ceiling = 15
min wall-clock = at most ~14 rebalances per invocation. Full 7-year
window = 84 rebalances = ~88 min compute = MUST chain across at
least 6-7 invocations.

---

# PART 3 — ARCHITECTURE

## 3.1 The target shape

```
trigger writes:                    {status: pending, config: ..., cursor: null}
first bg-invocation:               reads cursor, processes batch 0,
                                   writes {status: running, cursor: {batch: 1, ...}}
                                   self-reinvokes BEFORE 13-min mark
second bg-invocation:              reads cursor, processes batch 1,
                                   writes {status: running, cursor: {batch: 2, ...}}
                                   self-reinvokes
...
final bg-invocation:               reads cursor, processes last batch,
                                   writes {status: done, metrics: {...},
                                   trades: [...], dailyEquity: [...], ...,
                                   completedAt: now, cursor: null}
                                   does NOT self-reinvoke
```

Critical properties:

1. **Idempotency.** A re-fired invocation (e.g., Netlify duplicates
   a dispatch) reading the same cursor must produce the same result.
   Use cursor state as the source of truth, not in-memory variables.

2. **Atomicity of checkpoint.** The cursor write at the end of a
   batch must include ALL state needed to resume: current rebalance
   index, current portfolio composition, equity curve so far, trades
   so far, mlTraining row count, sector exposure tracker, any rolling
   metrics. If you split state across multiple Firestore docs, write
   them BEFORE updating the cursor doc — last-write-wins must always
   point to a fully-committed snapshot.

3. **Watchdog with safety margin.** Function MUST self-terminate
   well before the 15-min ceiling. Recommend a 13-min budget (90s
   safety margin for Firestore final write + reinvoke fetch).
   `setTimeout(handleBudgetExpiry, 13 * 60 * 1000)` at function entry.

4. **Self-reinvoke via `Context.waitUntil()`.** This is the only
   reliable way to extend execution on Netlify. Pattern (from
   MarginIQ M4):

   ```ts
   import type { Context } from '@netlify/functions';

   export const handler = async (event: HandlerEvent, context: Context) => {
     // ... process batch ...
     if (notDone) {
       await persistCursor(...);
       context.waitUntil(
         fetch(SAME_FUNCTION_URL, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ runId, resume: true }),
         })
       );
       return { statusCode: 202, body: 'continuing in next invocation' };
     }
     // ... write terminal status ...
   };
   ```

   `context.waitUntil` ensures the fetch promise is given time to
   resolve before the container freezes, unlike a bare `fetch()`
   (the same bug PR #30 and #31 fixed at the trigger layer).

5. **Resume detection.** Trigger writes the initial doc with
   `cursor: null`. First bg-invocation sees `cursor: null`, knows
   this is fresh, initializes state. Subsequent invocations see
   `cursor: {...}` and resume. This avoids needing a "resume:
   true" flag in the request body, though you can pass it as an
   extra safety check.

## 3.2 Batch size

Process **8-10 rebalances per invocation** at sp500/monthly. That's:
- 8 rebalances × 63 sec = ~8.4 min compute (well under 13-min budget)
- 10 rebalances × 63 sec = ~10.5 min compute (still under budget)

Pick 8 as default; make it configurable via env var `BACKTEST_BATCH_SIZE`
so we can tune without redeploying.

For smaller universes (dow, smaller windows) the per-rebalance cost
is lower; the same batch size of 8 stays well-budgeted.

## 3.3 Cursor schema

```ts
export interface BacktestCursor {
  // Position in the rebalance schedule
  nextRebalanceIndex: number;      // 0-based; first batch starts at 0
  totalRebalances: number;         // computed at startup, immutable

  // Wall-clock provenance (for debugging)
  lastInvocationStartedAt: string; // ISO timestamp
  invocationCount: number;         // 1-indexed; increments each invocation

  // Portfolio state at the last completed rebalance
  portfolioState: {
    cash: number;
    positions: Array<{ ticker: string; shares: number; entryPrice: number; entryDate: string; sector: string }>;
    sectorExposure: Record<string, number>;
    equity: number;
  } | null;                        // null = before any rebalance has run

  // Accumulating metrics across batches
  cumulativeMetrics: {
    tradeCount: number;
    mlTrainingCount: number;
    realizedPnL: number;
    fees: number;
  };
}
```

Store cursor in the same backtest doc as a top-level field. Don't
create a separate cursor collection — keeps reads atomic.

For trades + dailyEquity + mlTraining rows (potentially thousands of
entries), don't accumulate them in the cursor — write each batch's
rows directly to a subcollection on each invocation. Final batch
aggregates totals into the summary doc. Subcollection path:

- `portfolioBacktests/{runId}/trades/{tradeId}`
- `portfolioBacktests/{runId}/dailyEquity/{YYYY-MM-DD}`
- `backtestRuns/{runId}/mlTraining/{rowId}` (same pattern for regular)
- `backtestRuns/{runId}/dailyEquity/{YYYY-MM-DD}`

The list endpoints aggregate these subcollections on read.

## 3.4 Failure handling

- **Network hiccup on Firestore write**: Firestore client retries
  automatically; if all retries fail, the function returns with an
  error and Netlify will retry the invocation. Idempotency makes
  this safe.

- **Self-reinvoke fetch fails**: catch the error, write
  `cursor.lastReinvokeError` to the doc, then return non-200 so
  Netlify retries the invocation. Worst case: function gets killed
  at 15-min and there's a manual recovery path (orchestrator can
  fire a re-invoke curl).

- **Function killed mid-batch before checkpoint**: cursor still
  reflects the last successfully committed batch boundary. Next
  invocation re-processes that batch (which is idempotent because
  each rebalance reads the cursor's portfolio state).

- **runId not found in Firestore**: function logs and exits cleanly
  (don't throw — that loops). This handles the case where someone
  manually deletes the doc mid-run.

---

# PART 4 — IMPLEMENTATION ORDER

Work in this order; each step has its own commit.

## W1 — Cursor schema + read/write helpers

`netlify/functions/shared/backtest-resume/cursor.ts`:
- Exports `BacktestCursor` interface
- Exports `readCursor(db, collection, runId): Promise<BacktestCursor | null>`
- Exports `writeCursor(db, collection, runId, cursor): Promise<void>`
- Exports `clearCursor(db, collection, runId): Promise<void>` (for terminal state)

Tests: hermetic, mock Firestore admin SDK. Cover null/not-null cases.

## W2 — Watchdog helper

`netlify/functions/shared/backtest-resume/watchdog.ts`:
- Exports `createWatchdog(budgetMs: number, onExpiry: () => void): { start, stop, isExpired }`
- Internally uses `setTimeout` for the timer
- The `onExpiry` callback fires once; subsequent calls to `isExpired()`
  return true. Useful for the batch loop to check `if
  (watchdog.isExpired()) break;` after each rebalance.

Tests: use vitest fake timers. Cover budget-not-yet, budget-expired,
double-expiry-suppression.

## W3 — Reinvoke helper

`netlify/functions/shared/backtest-resume/reinvoke.ts`:
- Exports `dispatchReinvoke(functionUrl: string, runId: string, ctx: Context): Promise<void>`
- Uses `ctx.waitUntil(fetch(...))` so the promise is given grace time
- Returns immediately (caller's handler can return 202)
- Logs success/failure to console for Netlify Functions logs visibility

Tests: mock fetch; assert waitUntil is called with the promise.

## W4 — Portfolio bg-function checkpoint integration

Refactor `run-portfolio-backtest-background.ts`:

1. On entry: read cursor. If null, initialize. If non-null, resume.
2. Process batch of 8 rebalances (or fewer if near end of schedule).
3. Inside batch loop: after each rebalance, check `watchdog.isExpired()`;
   if expired, break early (still commit what was processed).
4. After batch: write cursor; if not done, dispatch reinvoke and
   return 202. If done, write terminal status (`done`, metrics,
   completedAt, clear cursor).
5. Errors: catch + log + write `cursor.lastError` to doc for visibility.

Test: integration test that mocks Firestore + scoring pipeline and
asserts:
- Fresh start: processes batch 0, persists cursor with `nextRebalanceIndex=8`
- Resume: reads cursor at index=8, processes batch 1, persists `nextRebalanceIndex=16`
- Final batch: processes remaining, writes terminal status, clears cursor
- Watchdog expiry mid-batch: commits partial progress; next invocation resumes
- Double-invocation race: second invocation sees cursor and skips already-processed rebalances

## W5 — Regular bg-function checkpoint integration

Same pattern as W4 but for `run-backtest-background.ts`. Most of
the cursor / watchdog / reinvoke code should be reusable; pull
shared parts into `backtest-resume/` directory if not already
extracted.

The regular bg-function additionally writes mlTraining rows; ensure
each batch's rows are written to subcollections before cursor update,
not buffered in memory across invocations.

## W6 — End-to-end verification

This is the part where you confirm the architecture actually works
on Netlify, not just in tests:

1. After W4 lands (still in your branch), push the branch and let
   Netlify deploy the preview build OR merge the W4 commit alone
   to main if Chad approves.
2. Fire a fresh full-window portfolio backtest:
   ```bash
   curl -sS -X POST https://tradeiq-alpha.netlify.app/api/portfolio-backtest/start \
     -H "Content-Type: application/json" \
     -d '{"window": "full"}'
   ```
3. Poll the run every 2-3 minutes. Verify:
   - `cursor.nextRebalanceIndex` advances over time
   - `cursor.invocationCount` increments (proves self-reinvoke works)
   - `status` eventually flips to `done` with `completedAt` populated
   - Total wall-clock should be ~90-120 min for the 7-year window
4. Same for non-portfolio path after W5 (use the 0a-2 acceptance
   config from PART 7 below).
5. Record results in `reports/phase-4e-1-infra/verification.md`.

If verification fails, do NOT open the PR. Diagnose the failure,
fix, retry. The PR is only mergeable once both functions have
verified end-to-end successfully.

If you can't verify in the sandbox (network restrictions), open
the PR as DRAFT with verification noted as TBD; orchestrator
will fire the verification from this side after deploy.

---

# PART 5 — CONVENTIONS

## 5.1 Commit cadence

One commit per workstream (W1-W6). Suggested messages:

```
phase-4e-1-infra: W1 cursor schema + read/write helpers
phase-4e-1-infra: W2 watchdog with budget timer + fake-timer tests
phase-4e-1-infra: W3 reinvoke helper using context.waitUntil
phase-4e-1-infra: W4 portfolio bg-function checkpoint integration
phase-4e-1-infra: W5 regular bg-function checkpoint integration
phase-4e-1-infra: W6 verification report + end-to-end notes
```

## 5.2 APP_VERSION + MODEL_VERSION

APP_VERSION 0.18.1-alpha → 0.18.2-alpha (infrastructure change but
user-visible: backtests now actually complete for long windows).
MODEL_VERSION unchanged (no scoring math changes).

## 5.3 Test conventions

- Runner: vitest
- Path: `netlify/functions/shared/backtest-resume/__tests__/` for
  unit tests; `netlify/functions/__tests__/` for integration
- All tests hermetic — mock Firestore admin SDK, mock fetch, use
  vitest fake timers for watchdog tests
- Baseline 638 + targeted growth 35-60 new tests

## 5.4 TypeScript

- `strict: true`
- No `any` without inline comment
- Exported functions: explicit types
- Cursor type lives in `cursor.ts`; both bg-functions import from
  there to keep the schema in one place

## 5.5 Firestore writes

- Batched writes where multiple rows land in the same batch
  (mlTraining rows, dailyEquity rows)
- Single doc writes for cursor + summary
- Don't await each individual write inside a tight loop; use
  `Promise.all` after batching

## 5.6 Logging

- Console.log liberally at batch boundaries — Netlify function logs
  are the only visibility into how this thing is behaving in
  production
- Log shape: `{runId, batch, rebalanceIndex, totalRebalances,
  invocationCount, elapsedMs}` at the START and END of each batch
- This is critical for debugging if it goes wrong post-merge

---

# PART 6 — REFERENCE PATTERN: MarginIQ M4

If you want a worked example of this pattern, look at the MarginIQ
migration's M4 phase. The Davis MarginIQ repo
(`DavisDelivery/DavisMarginIQ`) has scheduled and on-demand functions
that use `Context.waitUntil()` self-reinvoke loops to process large
batches across the 15-min ceiling. The architecture conventions are:

- Firestore doc tracks `cursor` + `status`
- Function processes N records per invocation (M4 used 50 files per batch)
- `Context.waitUntil()` for the next-batch dispatch
- Watchdog timer enforces early-exit
- Terminal state written only on final batch

You don't need to read that repo — TradeIQ's implementation will be
analogous but tighter (one cursor per backtest run, not per migration
phase).

---

# PART 7 — PR + ACCEPTANCE TEST

## 7.1 Push the branch

```bash
git push -u origin phase-4e-1-infra-checkpoint-resume
```

## 7.2 Open the PR

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4e-1-infra — backtest checkpoint-and-resume across the 15-min ceiling",
    "head": "phase-4e-1-infra-checkpoint-resume",
    "base": "main",
    "body": "See reports/phase-4e-1-infra/verification.md for end-to-end results."
  }'
```

## 7.3 Acceptance test (the critical one)

Both backtest paths must demonstrate completion of a multi-batch run:

**Portfolio path:**
```bash
curl -sS -X POST https://tradeiq-alpha.netlify.app/api/portfolio-backtest/start \
  -H "Content-Type: application/json" \
  -d '{"window": "full"}'
# Capture runId; poll every 3 min
# Acceptance: status=done within ~120 min, cursor.invocationCount >= 6
```

**Regular path (0a-2 acceptance, the long-pending one):**
```bash
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
# Acceptance: status=complete within ~120 min, tradeCount > 0, mlTrainingCount >= 3000
```

If you can't verify in your sandbox (network restrictions): document
in PR description, orchestrator will fire after merge.

---

# PART 8 — HAND-OFF MESSAGE FORMAT

When the PR is mergeable, post a single message in this conversation
with this shape:

```
PR #N open: https://github.com/DavisDelivery/TradeIQ/pull/N

Architecture summary:
- Cursor schema: {nextRebalanceIndex, totalRebalances, portfolioState, cumulativeMetrics, ...}
- Batch size: 8 rebalances per invocation (configurable via BACKTEST_BATCH_SIZE)
- Watchdog: 13-min budget (90s safety margin)
- Reinvoke: Context.waitUntil(fetch(SAME_FUNCTION_URL))

End-to-end verification:
- Portfolio full-window:    DONE | DEFERRED — runId: <id>, status: <s>, invocations: <N>
- Regular sp500 full-window: DONE | DEFERRED — runId: <id>, status: <s>, trades: <N>

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was 638)
- npm run build: clean

Tests added: <N> (target was 35-60)

Files changed:
- netlify/functions/run-portfolio-backtest-background.ts  (refactored to cursor-driven)
- netlify/functions/run-backtest-background.ts            (refactored to cursor-driven)
- netlify/functions/shared/backtest-resume/cursor.ts      (NEW)
- netlify/functions/shared/backtest-resume/watchdog.ts    (NEW)
- netlify/functions/shared/backtest-resume/reinvoke.ts    (NEW)
- ...

Known limitations:
- <anything that didn't quite work>
- <anything that needs follow-up>

Versions: APP_VERSION 0.18.1 → 0.18.2-alpha (MODEL_VERSION unchanged)
```

---

# PART 9 — FAILURE MODES TO AVOID

- **Writing cursor INSIDE the rebalance loop.** Cursor write happens
  ONCE per batch, at the boundary. If you write per-rebalance you'll
  thrash Firestore and exceed the watchdog budget.

- **Forgetting to clear the cursor on terminal write.** Final batch
  must set `cursor: null` (or omit field) and `status: done`
  atomically. If cursor stays populated, a stale re-invocation could
  loop forever.

- **Not using `Context.waitUntil()` for the reinvoke fetch.** This is
  the exact bug PR #30 + #31 fixed at the trigger layer. The bg-function
  has the same constraint: bare `fetch()` will race against container
  freeze. Use `ctx.waitUntil(fetch(...))` always.

- **Sending state via request body to the reinvoke.** Don't do this.
  The cursor is the source of truth and must be in Firestore. Request
  body should only have `{runId, resume: true}` as a sanity check.

- **Hard-coding the batch size as a magic number.** Use a const
  `BATCH_SIZE = parseInt(process.env.BACKTEST_BATCH_SIZE ?? '8')`.
  Allows tuning without code changes.

- **Skipping the watchdog because tests pass without it.** The
  watchdog is the safety net for runs that take longer per rebalance
  than expected (e.g., Polygon throttling, network slowness). Without
  it a single slow rebalance can blow the budget and silently die.
  Always include it.

- **Touching the triggers.** They were fixed in PR #30 + #31 and are
  out of scope. If you find yourself wanting to modify them, stop
  and reconsider — the trigger only writes the initial pending doc
  and dispatches; everything else is the bg-function's job.

---

# PART 10 — PARALLEL CONTEXT

No other agents are in flight right now. Chad has spawned 4 agents
today across 5 PRs (4f, 4f-finish, 0a-2, bg-fix portfolio, bg-fix
non-portfolio). All have merged. You are the only agent active.

The 0a-2 acceptance test (`bt_20260515171213_mclesk`) is currently
in flight but will die at the 15-min ceiling without your fix. After
your W5 ships, it can be re-fired and will actually complete. The
4e-1-finish full-window verdict is the same — needs your fix to land
before a real 7-year backtest can complete.

Don't wait for those runs to die before starting your work — they'll
fail silently at the ceiling regardless.

---

End of kickoff. Read end-to-end before starting. Begin with W1.
