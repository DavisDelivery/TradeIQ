# Phase 5a-prep Executor Kickoff — per-candidate mlTraining row emission

> **For Chad:** paste the bootstrap at the end of this conversation
> as the opening message of a new Claude chat. The GitHub PAT is
> embedded inline; no follow-up message needed.

---

You are an executor agent. Your single assignment is **Phase 5a-prep
— change mlTraining row generation from per-held-position to
per-scored-candidate** in the TradeIQ project. The conversation you're
reading right now is your complete boot prompt. Read end-to-end, then
start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. Its backtest engine scores every
ticker in a universe at each rebalance date, builds a top-N portfolio,
and emits `MLTrainingRow` records that Phase 5a's ML pipeline will
train on. Owner: Chad Davis. Stack: TypeScript Netlify functions +
React 18 / Vite SPA + Firestore + Polygon.

## The problem you're fixing

Today, mlTraining rows are emitted **once per held position per
rebalance** (`engine.ts` ~line 489, `for (const p of target)`). The
`target` portfolio only contains names that pass `minComposite >= 50`,
which at sp500 scale is ~2 names per rebalance. A full sp500/monthly
/7-year backtest produces only ~165 ml rows — far short of the ≥10k
Phase 5a needs.

The fix: emit one `MLTrainingRow` per **scored candidate** (every
ticker in the universe that got a composite score that rebalance),
not just per held position. That's ~500 rows × ~84 rebalances ≈
42,000 rows per sp500/monthly/7yr run. This also makes the training
data cross-sectional — the ML model learns "what features predict
forward return across the whole universe," not just "what the
selected picks looked like" (which is a biased, selection-confirmed
subset).

## Your assignment in two sentences

Change ml row generation in both `engine.ts` and `engine-batched.ts`
so a row is emitted for every scored candidate, with a new boolean
field `inPortfolio` marking whether that candidate was actually held.
Preserve all existing fields and forward-return computation; the
equivalence tests must be updated to reflect the new (larger) row
set, and a full sp500 acceptance run must produce ≥10k rows.

---

# PART 1 — COLD START

## 1.1 Boot commands

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
# Expected top commit (in some order near the top):
#   Phase 4i — reframe Prophet Portfolio to active weekly rebalance (v2) (#34)
#   Phase 4e-1-infra — backtest checkpoint-and-resume ... (#32)

git config user.email "executor-5a-prep@tradeiq.local"
git config user.name "Executor 5a-prep"

npm ci
npx tsc --noEmit             # must be clean
npm test                     # baseline 691 passing
npm run build                # must complete cleanly

git checkout -b phase-5a-prep-per-candidate-mltraining
```

If baseline fails, STOP and report with exact output.

## 1.2 Secrets handling

**Inline:** GitHub PAT (write-scoped, repo) in the clone URL above.
Used for `git push` + `POST /pulls`. No other credentials needed —
end-to-end verification runs against the live deploy, which has
Polygon + Firebase configured server-side.

---

# PART 2 — REPO ORIENTATION

## 2.1 The current ml row emission site

`netlify/functions/shared/backtest/engine.ts` around line 489:

```ts
// 7. Per-position attribution + ML training rows
for (const p of target) {
  const rets = positionReturns.get(p.ticker) ?? [];
  // ... attribution.push(...) ...

  // ML row — capture forward returns for the meta-ranker (Phase 5).
  const longBars = await getCachedBars(
    p.ticker,
    addDays(asOfDate, -30),
    addDays(asOfDate, 400),
  ).catch(() => []);
  const entryClose = lastCloseAtOrBefore(longBars, asOfDate);
  mlRows.push({
    runId,
    ticker: p.ticker,
    asOfDate,
    composite: p.composite,
    layers: p.layers,
    regime: (ctx.regime?.regime as string | undefined) ?? null,
    sector: p.sector,
    marketCapBucket: null,
    entryPrice: entryClose,
    exitPrice: null,
    holdDays: null,
    forward5dReturn: forwardReturn(longBars, asOfDate, 5),
    forward20dReturn: forwardReturn(longBars, asOfDate, 20),
    forward60dReturn: forwardReturn(longBars, asOfDate, 60),
    forward252dReturn: forwardReturn(longBars, asOfDate, 252),
    realizedPnl: null,
  });
}
```

`target` is the held portfolio (post-`buildPortfolio`, ~2-50 names).
You want to iterate `scored` instead (the full set of scored
candidates, ~500 names for sp500).

`engine-batched.ts` has the parallel structure (the cursor-driven
batched harness from Phase 4e-1-infra). Both must change identically.

## 2.2 Files you ARE allowed to touch

- `netlify/functions/shared/backtest/engine.ts` — ml row emission loop
- `netlify/functions/shared/backtest/engine-batched.ts` — same, batched
- `netlify/functions/shared/backtest/types.ts` — add `inPortfolio` field to `MLTrainingRow`
- `netlify/functions/shared/backtest/__tests__/*.test.ts` — update equivalence + engine tests
- `netlify/functions/shared/backtest/engine-batched.test.ts` — update the equivalence assertions
- `briefs/phase-5a-prep-pr-description.md` — you create
- `reports/phase-5a-prep/verification.md` — you create
- `ORCHESTRATOR.md` — mark 5a-prep done at the end

## 2.3 Files you may NOT touch

- `netlify/functions/run-portfolio-backtest-background.ts` / `run-backtest-background.ts` —
  the bg-functions; they call the engine, they don't need changes
  (the engine returns more rows; the subcollection writer handles
  any volume)
- `netlify/functions/shared/backtest-resume/*` — the checkpoint
  infrastructure; untouched
- `netlify/functions/shared/backtest/persistence.ts` — `appendMLTrainingRows`
  already chunks at 500/batch and handles any row count; do NOT change it
- Anything under `src/`, `netlify/functions/shared/prophet-portfolio/`,
  any analyst/scoring code
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`

---

# PART 3 — THE CHANGE

## 3.1 Add the `inPortfolio` field

In `types.ts`, extend `MLTrainingRow`:

```ts
export interface MLTrainingRow {
  runId: string;
  ticker: string;
  asOfDate: string;
  composite: number;
  layers: Record<string, number>;
  regime: string | null;
  sector: string | null;
  marketCapBucket: 'small' | 'mid' | 'large' | null;
  inPortfolio: boolean;          // NEW — was this candidate actually held this rebalance?
  entryPrice: number | null;
  exitPrice: number | null;
  holdDays: number | null;
  forward5dReturn: number | null;
  forward20dReturn: number | null;
  forward60dReturn: number | null;
  forward252dReturn: number | null;
  realizedPnl: number | null;
}
```

## 3.2 Change the emission loop

In `engine.ts` (and identically in `engine-batched.ts`):

- Keep the attribution loop `for (const p of target)` AS IS —
  attribution is portfolio-level and should stay per-held-position.
- ADD a separate ml row loop over `scored` (the full scored-candidate
  array). For each scored candidate `c`:
  - `inPortfolio` = whether `c.ticker` appears in `target`
  - `composite`, `layers`, `sector`, `regime` come from the scored
    candidate (not the target position)
  - `entryPrice` + the four `forwardNdReturn` fields are computed the
    same way (fetch `getCachedBars` for that ticker, compute forward
    returns) — this is the per-ticker bar fetch
  - `marketCapBucket`, `exitPrice`, `holdDays`, `realizedPnl` stay
    `null` as today

**Performance note:** this loop now does ~500 `getCachedBars` calls
per rebalance instead of ~2. Those bars are PIT-cached, so a backtest
that's been run once is cheap on re-run, but the FIRST run will be
slower. The Phase 4e-1-infra watchdog + checkpoint-resume already
handles long runs — batches just process fewer rebalances per
invocation if the per-rebalance cost rises. Do NOT add a separate
concurrency limit; the existing `mapWithConcurrency` for scoring is
upstream of this. If the ml-row bar fetches are slow, wrap them in
the same `mapWithConcurrency` helper at a concurrency of ~6.

## 3.3 Idempotency with the cursor

`engine-batched.ts` writes ml rows per batch via `appendMLTrainingRows
(runId, rows, startIdx)` where `startIdx` is the running count. With
~500 rows per rebalance instead of ~2, `startIdx` arithmetic must
stay correct — verify the cursor's `mlTrainingRowCount` (or whatever
the field is named) increments by the actual per-batch row count, not
a hardcoded estimate. A resumed run must not double-write or skip
rows. Add a test for this.

---

# PART 4 — TESTS

- `types.ts` change: the new field is non-optional, so every test
  fixture constructing an `MLTrainingRow` needs `inPortfolio` added.
  Find them all (`grep -rl MLTrainingRow netlify/functions/**/__tests__`).
- `engine-batched.test.ts` equivalence tests: the batched engine's
  ml-row output count will now be much larger. Update the assertions
  — the equivalence guarantee is still "batched output === unbatched
  output", just with the larger row set. Both engines must produce
  identical per-candidate rows.
- ADD a test asserting: for a mock universe of N scored candidates
  where M land in `target`, the run emits exactly N ml rows per
  rebalance, of which exactly M have `inPortfolio: true`.
- ADD a cursor-arithmetic test: a 2-batch run emits the same total
  rows as a 1-batch run of the same window, with no gaps or
  duplicate doc IDs in the mlTraining subcollection.
- Baseline is 691 tests; expect +15-30 net.

---

# PART 5 — CONVENTIONS

- One commit per logical step: (1) types field, (2) engine.ts loop,
  (3) engine-batched.ts loop, (4) test updates, (5) verification report.
- APP_VERSION: bump `0.18.3-alpha` → `0.18.4-alpha` in `src/App.jsx`
  (ml data shape changes; downstream 5a consumers care).
- MODEL_VERSION: unchanged.
- `strict: true` TypeScript; no `any` without inline comment.
- Don't network in unit tests; mock `getCachedBars`.

---

# PART 6 — PR + ACCEPTANCE

## 6.1 Push + open PR

```bash
git push -u origin phase-5a-prep-per-candidate-mltraining
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 5a-prep - per-candidate mlTraining row emission",
    "head": "phase-5a-prep-per-candidate-mltraining",
    "base": "main",
    "body": "See reports/phase-5a-prep/verification.md. Emits one MLTrainingRow per scored candidate (not per held position); adds inPortfolio boolean. sp500/monthly/7yr now yields ~42k rows vs ~165 before."
  }'
```

## 6.2 Acceptance

Live verification deferred to post-merge (sandbox has no outbound to
the deploy). Orchestrator will fire a fresh sp500/monthly/top50
/2018-2024 backtest after merge and confirm `mlTrainingCount >= 10000`.
Document the expected number in the verification report.

---

# PART 7 — HAND-OFF FORMAT

When the PR is mergeable, post a single message in this conversation:

```
PR #N open: https://github.com/DavisDelivery/TradeIQ/pull/N

Change summary:
- MLTrainingRow gains inPortfolio: boolean
- engine.ts + engine-batched.ts emit one row per scored candidate
- equivalence tests updated for the larger row set
- cursor row-count arithmetic verified for batched resume

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was 691)
- npm run build: clean
- Expected ml rows for sp500/monthly/7yr: ~<N> (was ~165)

Acceptance: DEFERRED to post-merge (orchestrator fires the live run)

Known limitations:
- <anything worth flagging — e.g. first-run slowness from the
  ~500 bar fetches per rebalance>
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Changing attribution to per-candidate.** Attribution is
  portfolio-level — it stays `for (const p of target)`. Only the ml
  row loop changes.
- **Breaking cursor row-count arithmetic.** With ~500 rows/rebalance
  the `startIdx` passed to `appendMLTrainingRows` must reflect the
  true running total. A resumed run that miscounts will overwrite or
  gap the subcollection. Test this explicitly.
- **Forgetting `engine-batched.ts`.** Both engines must change
  identically or the equivalence tests fail (correctly).
- **Adding the field as optional.** `inPortfolio` should be required
  (`boolean`, not `boolean | undefined`) — every row genuinely knows
  whether it was held. Optional fields invite silent bugs in the 5a
  consumer.
- **Networking in tests.** Mock `getCachedBars`. The ~500-fetch
  scale-up is a production concern, not a unit-test one.

---

# PART 9 — PARALLEL CONTEXT

Phase 4i just merged (`636c1d9`) — it changed the portfolio config in
`run-portfolio-backtest-background.ts`. You don't touch that file, so
no conflict. No other agents are currently in flight. Two backtests
may be running server-side (`pb-full-202605161946-osiwpg` and an
older sp500 acceptance run) — unrelated to your work; don't poll them.

---

End of kickoff. Read end-to-end, then start with PART 1.
