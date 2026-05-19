# Phase 4u Executor Kickoff — Backtest engine robustness

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a new Claude chat. The GitHub PAT is embedded
> inline; no follow-up needed.

---

You are an executor agent. Your assignment is **Phase 4u** of the
TradeIQ project. The conversation you are reading is your boot prompt.
Read it end-to-end, then read `briefs/phase-4u-brief.md` in the repo
(full diagnosis + architecture), then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app` — a React/Vite SPA backed by
TypeScript Netlify functions and Firestore. It has a backtest engine
that runs strategies against historical data on a checkpoint-resume
background-function pattern: a worker runs a batch, writes the engine's
in-progress `state` onto a Firestore cursor document, and reinvokes
itself to continue. Owner: Chad Davis.

## The problem you're fixing (full detail in the brief)

Phase 4r W2/W3 surfaced a real engine defect. The Williams *baseline*
backtest failed in production — the `background_run_failed` Sentry
alert, 2026-05-19 02:28 UTC. Root cause: the run's checkpoint cursor
document grew until it exceeded Firestore's hard **1 MiB per-document
limit**, and the checkpoint write threw. It failed at **invocation 18**;
the baseline emitted ~30× the mlTraining rows of the discrete run.

The reinvoke machinery (Phase 4r-W1b) was **not** at fault — this is the
**engine's persisted-state shape**: `cursor.state` accumulates without
bound as a run gets longer or produces more. The mlTraining *rows* are
already handled correctly (appended to a subcollection per batch, only
a count on the cursor). Something *else* in the persisted state grows.

A second gap was confirmed alongside it: **failed backtest runs are
invisible** — `/api/backtest-runs` excludes any run without a
`completedAt`, so a failed run's error is only ever seen in Sentry.

## Your assignment in one sentence

Diagnose exactly what in the backtest cursor's persisted state grows
unbounded, bound it so a large run cannot overflow the 1 MiB document
limit, and make failed runs inspectable through the API.

## Why this is urgent — the sequencing

Phase 4t (next) backtests the ten-analyst composite on the **Russell
2000 — ~2,000 tickers, the largest run TradeIQ will attempt.** A cursor
that already overflowed on a Williams baseline will certainly overflow
on that. **4u is the prerequisite that lets 4t run.** Fix it for the
run that is coming, not just the run that broke.

## The disciplines that are not optional

- **Diagnose before fixing.** We know the *symptom* (cursor > 1 MiB),
  not yet the *cause* (which field grows). Instrument, measure,
  identify — then fix. A guessed fix that misses the real accumulator
  overflows again mid-4t. This is the discipline that resolved the
  scan and reinvoke chains (Phases 4o/4p, 4r-W1b).
- **If the fix turns out to be a large, invasive engine refactor — stop
  and report** before ploughing into a rewrite.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4u@tradeiq.local"
git config user.name "Executor 4u"

npm ci    # if it fails on cross-platform optional deps, fall back to: npm install
npx tsc --noEmit
npm test
npm run build

git checkout -b phase-4u-backtest-engine-robustness
```

If baseline fails, STOP and report. Bump APP_VERSION one patch in
`src/App.jsx`. MODEL_VERSION unchanged — infrastructure only.

**Environment note:** if commits fail from `/home/claude/TradeIQ`, the
signing server may expect commits from `/home/user/TradeIQ` (or a
`/tmp` path) — relocate the repo and commit there.

Read `briefs/phase-4u-brief.md` before writing code.

**Secrets:** GitHub PAT (write-scoped) in the clone URL. Backtests run
**server-side on Netlify**, which has the Firebase/Polygon/Finnhub
credentials — you fire runs by `curl`-ing trigger endpoints and poll
the status endpoints. You do not need local API keys.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key existing code

- `netlify/functions/run-backtest-background.ts` — the non-portfolio
  worker. Each non-terminal batch checkpoints the cursor with the
  engine's `res.state` and reinvokes. Its top-level `catch` logs
  `background_run_failed` (the Sentry event).
- `netlify/functions/shared/backtest-resume/cursor.ts` — the checkpoint
  cursor; holds `state`, cumulative metrics, the resume pointer. **This
  is where the unbounded growth lives.**
- `netlify/functions/shared/backtest/engine.ts` — produces `res.state`,
  the per-batch carried-forward state.
- `netlify/functions/shared/backtest/persistence.ts` —
  `persistRunResult` / `persistRunFailure` (already writes
  `status:'failed'` + the error string onto the run doc);
  `appendMLTrainingRows` / `readAllMLTrainingRows` — **the existing
  subcollection pattern that already bounds mlTraining rows. This is
  the model for W1's fix.**
- `netlify/functions/backtest-runs-list.ts` — `/api/backtest-runs`;
  orders by `completedAt`, excludes incomplete runs (the W2 gap).
- `netlify/functions/backtest-runs-get.ts` — `/api/backtest-runs/:runId`
  get-by-id.
- `netlify/functions/backtest-status.ts` — the Phase 4r-W1 diagnostic.
- `netlify/functions/run-portfolio-backtest-background.ts` — the
  portfolio worker; shares the `backtest-resume` machinery — W1 audits
  whether its cursor has the same defect.
- `configs/` — backtest run configs. The **Williams baseline** config
  is the known reproducer of the overflow (the discrete config without
  `discreteSignalOnly`, i.e. score-ranked, ~30× ML emission). Confirm
  the exact filename in `configs/`.

## 2.2 Files you ARE allowed to touch

- `netlify/functions/shared/backtest-resume/cursor.ts` — the cursor fix
- `netlify/functions/shared/backtest/engine.ts`,
  `shared/backtest/persistence.ts` — the persisted-state shape
- `netlify/functions/run-backtest-background.ts` — checkpoint write
- `netlify/functions/run-portfolio-backtest-background.ts` — ONLY if the
  W1 audit finds the same defect there
- `netlify/functions/backtest-runs-list.ts` /
  `backtest-runs-get.ts` — the W2 failed-run surface
- `netlify.toml` — ONLY to add a `[[redirects]]` block if W2 adds a new
  route
- test files for all of the above
- `src/App.jsx` — APP_VERSION bump
- `reports/phase-4u/diagnosis.md` + `verification.md`
- `briefs/phase-4u-pr-description.md`
- `ORCHESTRATOR.md` — mark 4u done at the end

## 2.3 Files you may NOT touch

- The reinvoke code (`shared/backtest-resume/reinvoke.ts`,
  `recover.ts`, `watchdog.ts`) — Phase 4r-W1b owns it; it is correct
- The composite scoring, the analysts, the Williams/Lynch signal logic
- What backtests compute — 4u is reliability/observability only
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`

## 2.4 Environment notes

- Any new `/api/` route needs a matching `[[redirects]]` block in
  `netlify.toml`. (Extending an existing endpoint needs none.)
- Any new Firestore query shape may need a composite index in
  `firestore.indexes.json` — a `FAILED_PRECONDITION` at runtime is that
  symptom (the W2 query-by-start-time may need one).

---

# PART 3 — THE WORK (order W1 → W2)

## W1 — Bound the cursor's persisted state

**Diagnose before fixing.**

1. **Identify what accumulates.** Instrument the checkpoint write — log
   the serialized cursor size and the size of each top-level field of
   `cursor.state` per batch. Run a backtest large enough to reproduce
   the growth (the Williams baseline config is the known reproducer).
   Determine exactly which field(s) grow and at what rate. Write it to
   `reports/phase-4u/diagnosis.md`.
2. **Bound the shape.** The correct pattern already exists — mlTraining
   rows go to a subcollection per batch, only a count on the cursor.
   Apply the same discipline to whatever else is unbounded: a growing
   list (accumulated trades, position history, per-rebalance snapshots)
   moves to a subcollection written incrementally; the cursor keeps
   only a bounded summary/pointer. The cursor is a **checkpoint**, not
   a ledger.
3. **Size target.** After the fix, the cursor for the largest run
   TradeIQ will attempt — a ten-analyst composite backtest of the
   Russell 2000 (~2,000 tickers, the Phase 4t workload) — must stay
   comfortably under 1 MiB at every checkpoint. Verify against that
   scale by measurement or a defensible projection from the
   instrumented sizes.
4. **Audit the portfolio cursor.** Check whether
   `run-portfolio-backtest-background`'s cursor has the same unbounded
   shape. Fix it the same way if so; explain its absence if not.
5. **Proof:** re-run the Williams baseline (the run that failed) and
   confirm it completes to a persisted result.

**If the diagnosis shows the fix is a large invasive engine refactor —
stop and report before proceeding.**

## W2 — Make failed runs visible

`persistRunFailure` already writes `status:'failed'` + the error string
onto the run doc — the data exists; nothing exposes it.

- Give the API a way to list and inspect **failed** (and ideally
  **running**) backtest runs with their `status` and `error` — e.g. a
  `status` filter / `includeIncomplete` parameter on
  `backtest-runs-list` that queries by start time instead of requiring
  `completedAt`; and confirm `backtest-runs-get` returns failed runs
  with their error.
- Keep it small — an observability fix, not a redesign. The requirement
  is that **a failed backtest run, and its error, is inspectable
  through the API without going to Sentry.**

---

# PART 4 — TESTS

- W1: a test covering a multi-batch *resumed* run — proving the bounded
  cursor still resumes correctly; and a test/assertion that the cursor
  size stays bounded as rows/trades accumulate.
- W2: a failed run is returned by the API surface with its error.
- Mock Firestore; no network in unit tests.
- Report the real test delta; don't pad.

---

# PART 5 — CONVENTIONS

- One PR. One commit per workstream + tests + the diagnosis/verification
  reports.
- APP_VERSION bumped one patch. MODEL_VERSION unchanged.
- `strict: true` TypeScript; no `any` without an inline reason.
- Match the house style of the existing backtest code; follow the
  mlTraining subcollection pattern for the W1 fix.

---

# PART 6 — PR + ACCEPTANCE

```bash
git push -u origin phase-4u-backtest-engine-robustness
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4u - backtest engine robustness",
    "head": "phase-4u-backtest-engine-robustness",
    "base": "main",
    "body": "See briefs/phase-4u-brief.md and reports/phase-4u/. Bounds the backtest checkpoint cursor so a large run cannot overflow the Firestore 1 MiB document limit (the cause of the 2026-05-19 02:28 UTC background_run_failed); makes failed runs inspectable via the API. Verified by re-running the Williams baseline and projecting to russell2k-composite scale."
  }'
```

**Open the PR as ready-for-review, NOT a draft.** If your tooling
defaults to draft, immediately mark it ready.

Post-merge, the orchestrator verifies and then sequences Phase 4t —
4t's kickoff is not fired until 4u is merged.

---

# PART 7 — HAND-OFF FORMAT

When the PR is mergeable, post one message:

```
PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Diagnosis (W1):
- What grew in cursor.state: <the field(s), measured growth rate>

Fix (W1):
- <how it's bounded — what moved to a subcollection / what's now a
  pointer>
- russell2k-composite scale: cursor projected/measured at <size> —
  under 1 MiB: yes
- Williams baseline re-run: completed to persisted result — runId <id>
- Portfolio cursor audit: <same defect fixed / not present, why>

Failed-run visibility (W2):
- <how a failed run + its error is now inspectable via the API>

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was <baseline>)
- npm run build: clean

Acceptance: DEFERRED — orchestrator review + merge; 4t sequences after.
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Guessing what grows** instead of measuring it — a fix that misses
  the real accumulator overflows again mid-4t.
- **Verifying only against the Williams baseline** — the bar is
  russell2k-composite scale, the bigger run that's coming.
- **Ploughing into a large engine refactor** without stopping to
  report first.
- **Touching the reinvoke code** — Phase 4r-W1b owns it; it is correct.
- **Breaking checkpoint-resume** — the bounded cursor must still resume
  a multi-batch run correctly; the Williams-baseline re-run is the
  proof.
- **Networking in unit tests. Opening the PR as a draft.**

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4u of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4u-executor.md — that's your full assignment —
   then read briefs/phase-4u-brief.md for the diagnosis.

Everything you need is in those two files. A real engine defect: the
non-portfolio backtest checkpoint cursor (cursor.state) grows unbounded
and overflowed the Firestore 1 MiB per-document limit on the Williams
baseline run (~30x ML emission, failed at invocation 18) — that's the
2026-05-19 02:28 UTC background_run_failed Sentry alert. The reinvoke
(4r-W1b) is fine; this is the engine's persisted-state shape. W1
diagnose-first (instrument the cursor size, reproduce with the Williams
baseline config, find exactly what field grows — no guessed fix), then
bound it (move any growing list to a subcollection, the mlTraining
pattern the codebase already uses; keep only a bounded checkpoint on
the cursor); verify at russell2k-composite scale (~2,000 tickers — the
bigger run coming in Phase 4t), re-run the Williams baseline to
completion, and audit the portfolio cursor for the same defect. W2 make
failed runs visible — failed runs are currently invisible via the API
(/api/backtest-runs excludes runs with no completedAt); expose
failed/running runs and their error. Infra only, MODEL_VERSION
unchanged. If the cursor fix turns out to be a large invasive refactor,
stop and report. Backtests run server-side on Netlify (it has the
credentials) — fire via curl, poll the status endpoints. If commits
fail from /home/claude/TradeIQ, relocate to /home/user/TradeIQ. Open
the PR ready-for-review, not a draft. Start with PART 1 once you've read
both. ~3-5 hour session.
