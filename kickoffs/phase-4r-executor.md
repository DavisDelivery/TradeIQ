# Phase 4r Executor Kickoff — Backtest verdict resolution

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a new Claude chat. The GitHub PAT is embedded
> inline; no follow-up needed.

---

You are an executor agent. Your single assignment is **Phase 4r** of
the TradeIQ project. The conversation you are reading is your boot
prompt. Read it end-to-end, then read `briefs/phase-4r-brief.md` in the
repo (full audit + architecture), then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app` — a React/Vite SPA backed by
TypeScript Netlify functions, Firestore, Polygon and Finnhub. It has a
backtest engine that runs portfolio strategies against historical data
on a checkpoint-resume background-function pattern. Owner: Chad Davis.

## The problem you're fixing (full detail in the brief)

The backtest *engine* is sound — but three runs that were supposed to
produce verdicts never finished:

1. **The 4e-1 portfolio verdict is stuck.** `/api/portfolio-verdict`
   returns `PENDING`, with "Full-window: done. Audit: done. **Rolling:
   1/8 done. Awaiting cron-driven completion.**" The 8 rolling-window
   backtests — needed for the binding "beats SPY in ≥5/8 windows"
   verdict — have been stuck at 1 of 8 since 2026-05-16. The cron
   chaining them has stalled.
2. **The 4n Williams + Lynch backtests never ran.** Verdict tables in
   `reports/phase-4n/` are empty `__` placeholders.
3. **The 5a ML data gate was never confirmed.** The acceptance run
   proving ≥10k mlTraining rows exist was never verified.

## Your assignment

- **W1:** diagnose *why* the rolling-window series stalled, fix the
  root cause, drive it to 8/8 so the binding verdict computes.
- **W2:** run the 4n Williams + Lynch backtests, populate the verdicts.
- **W3:** confirm the 5a ML data gate.

## The sequencing rule (FINAL — do not deviate)

**W1 ships as its own PR, is merged, and is verified live (rolling
series confirmed 8/8) BEFORE W2 and W3 begin.** Reason: if the stall is
a shared dispatch or checkpoint-resume bug, the same bug would sabotage
the W2/W3 runs. W1 first de-risks everything after it. Do not fire the
W2/W3 runs until W1 is merged and verified.

## Two disciplines that are not optional

- **Diagnose before fixing.** W1 must not ship a guessed fix.
  Instrument, observe the actual failure, fix the confirmed cause —
  the discipline that resolved the russell2k scan chain (Phase 4o
  diagnosed, 4p fixed). The dispatch-race bug class already bit this
  codebase twice (4e-1-bgfix, bgfix-2) — treat it as a prime suspect,
  not a conclusion.
- **Honest verdicts.** W2's Lynch backtest keeps its look-ahead-bias
  caveat banner. W3 reports a data-gate shortfall honestly if one
  exists. A flattering number presented as clean, or a gate declared
  met when it isn't, is a negative deliverable.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4r@tradeiq.local"
git config user.name "Executor 4r"

npm ci    # if it fails on cross-platform optional deps, fall back to: npm install
npx tsc --noEmit
npm test
npm run build
```

If baseline fails, STOP and report. Bump APP_VERSION one patch when a
code change lands (W1's fix). MODEL_VERSION unchanged — 4r runs the
engine, it does not change scoring.

**Environment note:** if commits fail from `/home/claude/TradeIQ`, the
signing server may expect commits from `/home/user/TradeIQ` (or a
`/tmp` path) — relocate the repo and commit from there.

Read `briefs/phase-4r-brief.md` before writing code.

**Secrets:** GitHub PAT (write-scoped) in the clone URL. The runs
themselves execute **server-side on Netlify**, which already has
`POLYGON_API_KEY`, `FINNHUB_API_KEY`, and the Firebase service account
configured — you fire runs by `curl`-ing trigger endpoints and polling,
the way scans are fired. You do not need local API keys.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key existing code

- `netlify/functions/shared/backtest/` — the engine: `engine.ts`,
  `engine-batched.ts`, `score-at-date.ts`, `metrics.ts`,
  `persistence.ts`, `portfolio.ts`, `walk-forward.ts`, etc.
- `netlify/functions/shared/backtest-resume/{cursor,watchdog,reinvoke}.ts`
  — the checkpoint-resume infra (4e-1-infra).
- `netlify/functions/backtest-runs-trigger.ts` — server-side trigger
  for non-portfolio backtests (the 4n configs go here).
- `netlify/functions/portfolio-backtest-trigger.ts` — server-side
  trigger for the portfolio backtest.
- `run-backtest-background.ts` / `run-portfolio-backtest-background.ts`
  — the cursor-driven background workers.
- the rolling-window cron — fires the 8 rolling sub-window runs; **this
  is what has stalled.** Find it (look for a scheduled function around
  the portfolio/rolling backtest).
- `netlify/functions/portfolio-verdict.ts` — backs
  `GET /api/portfolio-verdict`; computes the live verdict from
  Firestore, flips off PENDING once full-window + audit + 8/8 rolling
  are done.
- `configs/williams-sp500-2018-2024-weekly-top20.json`,
  `configs/lynch-sp500-2018-2024-quarterly-top20.json` — the 4n run
  configs.
- `reports/phase-4n/{williams,lynch}-backtest.md` — verdict tables to
  populate; `runbook.md` — the documented run procedure;
  `pit-integrity-attestation.md` — the Lynch caveat source.
- `/api/backtest-status` currently errors — there is no working
  backtest-run inspection endpoint. Building/fixing one is a legitimate
  W1 deliverable (mirror how Phase 4o built `/api/scan-status`).

## 2.2 Files you ARE allowed to touch

- `netlify/functions/shared/backtest/*` and `backtest-resume/*` — W1
  fix, if the root cause is here
- the rolling-window cron / trigger functions — W1 fix
- `netlify/functions/backtest-status.ts` (new or repaired) + its
  `netlify.toml` redirect — W1 diagnostic
- `reports/phase-4n/williams-backtest.md`, `lynch-backtest.md` — W2
  verdict population
- `reports/phase-4r/*` — verification + a diagnosis writeup
- `briefs/phase-4r-pr-description.md`
- test files for any code changed
- `src/App.jsx` — APP_VERSION bump (W1 PR)
- `ORCHESTRATOR.md` — mark 4r progress; **correct the stale
  4e-1-finish row** ("verdicts complete" is wrong)

## 2.3 Files you may NOT touch

- Analyst/scoring logic, the Williams/Lynch signal code, the scan
  workers, the desktop layout — 4r runs the engine, it does not change
  what the engine scores
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`

## 2.4 Environment notes

- Any new `/api/` endpoint needs a matching `[[redirects]]` block in
  `netlify.toml` — routes are mapped one-per-endpoint, not wildcard.
  (A backtest-status endpoint will need one.)
- Any new Firestore query shape may need a composite index in
  `firestore.indexes.json` — if a diagnostic query throws
  `FAILED_PRECONDITION`, that is the cause.

---

# PART 3 — THE WORK

## W1 — Diagnose + fix the rolling-window cron stall (own PR, first)

1. **Diagnose.** Establish *why* the rolling series is stuck at 1/8.
   Build or repair a backtest-status diagnostic endpoint so you can see
   each rolling run's status/cursor. Candidate causes — none assumed:
   a dead/misconfigured cron; a fire-and-forget dispatch race (bit the
   codebase twice — prime suspect); a checkpoint-resume failure; each
   rolling window failing individually; a verdict-aggregation counter
   that never advances.
2. **Fix the confirmed root cause.** Not a guess.
3. **Resolve the rule-version question.** The live verdict shows
   `Rule version: v1`; Phase 4i moved the portfolio config to v2.
   Determine whether the stuck series is a v1 series to complete or
   must be re-run under v2 — **report your reasoning, do not pick
   silently.** Flag it to the orchestrator if consequential.
4. **Drive the rolling-window series to 8/8.**
5. **Done when** `/api/portfolio-verdict` returns a **non-PENDING
   binding verdict** for the correct rule version.
6. Ship W1 as its own PR. **Stop and hand off — do not start W2/W3
   until W1 is merged and the orchestrator confirms 8/8 live.**

## W2 — Run the 4n Williams + Lynch backtests (after W1 verified)

1. Fire both backtests **server-side** (via `backtest-runs-trigger` or
   the documented equivalent) using the two `configs/` files.
2. Drive each to completion; populate the verdict tables in
   `reports/phase-4n/williams-backtest.md` and `lynch-backtest.md` with
   real numbers (total return, excess vs SPY, Sharpe, max drawdown, win
   rate; Williams: target-hit-before-stop).
3. Run the **score-ranked baseline** (runbook step 4 — same configs
   without `discreteSignalOnly`); report the BUY-only-vs-score-ranked
   delta.
4. **Keep the Lynch look-ahead-bias caveat banner** on the populated
   Lynch verdict.

## W3 — Confirm the 5a ML data gate (after W1 verified)

1. Confirm — or re-fire — the 5a-prep acceptance run (full sp500 /
   monthly / 7-year backtest; per-candidate ML rows → ~42k expected).
2. Verify the gate: **≥10k `mlTraining` rows across ≥5 runs.**
3. If met, report that Phase 5a (PR #24) is unblocked. *Running the 5a
   pipeline is NOT part of 4r.*
4. If the row generation still falls short, **report the shortfall
   honestly** — do not declare the gate met.

---

# PART 4 — TESTS

- W1: any code fix gets tests covering the confirmed failure mode (e.g.
  the dispatch/cron path now advances). Mock Firestore; no network in
  unit tests.
- W2/W3 are run-and-populate — no new unit tests expected unless a
  small code fix is needed to fire a run.
- Report the real test delta; don't pad.

---

# PART 5 — CONVENTIONS

- W1: one PR, one commit per logical change + tests + a diagnosis
  writeup in `reports/phase-4r/`.
- W2/W3: a second PR (verdict-report population + any small fixes), or
  hand the populated reports to the orchestrator if no code changed.
- APP_VERSION bumped one patch on the W1 PR. MODEL_VERSION unchanged.
- `strict: true` TypeScript; no `any` without an inline reason.

---

# PART 6 — PR + ACCEPTANCE

**W1 PR first:**

```bash
git checkout -b phase-4r-w1-rolling-window-fix
# ... diagnose, fix, test ...
git push -u origin phase-4r-w1-rolling-window-fix
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4r W1 - rolling-window cron-stall fix",
    "head": "phase-4r-w1-rolling-window-fix",
    "base": "main",
    "body": "See briefs/phase-4r-brief.md and reports/phase-4r/. Diagnoses and fixes the stalled 4e-1 rolling-window backtest series (stuck 1/8). Includes a backtest-status diagnostic endpoint. Drives the series toward 8/8 so /api/portfolio-verdict computes the binding verdict."
  }'
```

**Open the PR as ready-for-review, NOT a draft.** If your tooling
defaults to draft, immediately mark it ready.

After W1 merges and the orchestrator confirms the rolling series is
8/8 live, proceed to W2/W3 — a second PR titled
`Phase 4r W2+W3 - Williams/Lynch verdicts + 5a data gate`, or hand the
populated reports directly to the orchestrator if no code changed.

---

# PART 7 — HAND-OFF FORMAT

**After W1** — post one message:

```
PHASE 4r — W1 PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Diagnosis:
- Rolling-window stall root cause: <what it actually was>
- Rule-version (v1 vs v2): <finding + reasoning>

Fix:
- <what changed>; backtest-status diagnostic: <built/repaired>

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was <baseline>)
- npm run build: clean

Rolling series state at hand-off: <X/8>

Acceptance: DEFERRED — orchestrator merges, then confirms 8/8 +
non-PENDING verdict live. W2/W3 START ONLY AFTER THAT.
```

**After W2/W3** — post one message:

```
PHASE 4r — W2+W3 complete.

W2 — Williams backtest: <total return / excess vs SPY / Sharpe / maxDD>
     Lynch backtest: <numbers> (look-ahead caveat retained)
     BUY-only vs score-ranked delta: <finding>
W3 — 5a data gate: <N rows across M runs — MET / SHORT by ...>

<PR #N link if a PR was needed, or "reports handed off, no code change">
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Firing W2/W3 before W1 is merged and verified 8/8.** The whole
  point of the sequencing — a shared bug would sabotage them.
- **Shipping a guessed W1 fix** without diagnosing the real cause.
- **Picking v1 or v2 silently** — surface and report it.
- **A Lynch verdict presented as clean** without the restatement
  caveat. **A 5a gate declared met** when the run came up short.
- **Running the 5a ML-discovery pipeline** — that's a separate phase;
  4r only confirms the gate.
- **Networking in unit tests.** **Opening the PR as a draft.**
- Leaving the stale 4e-1-finish ORCHESTRATOR row uncorrected.

---

# PART 9 — PARALLEL CONTEXT

4k, 4m, 4n all merged. Phase 4q (clickable analyst contributions) may
run in parallel — it touches the detail-panel UI and does not share any
file with 4r (4r is backtest engine + reports). If you hit an
unexpected conflict on `main`, stop and report.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4r of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4r-executor.md — that's your full assignment —
   then read briefs/phase-4r-brief.md for the audit and architecture.

Everything you need is in those two files: three pending backtest runs
to resolve — W1 diagnose + fix the stalled 4e-1 rolling-window series
(stuck 1/8 since 2026-05-16; the cron chaining it has stalled), W2 run
the 4n Williams + Lynch backtests and populate their verdict tables, W3
confirm the 5a ML data gate (≥10k rows). CRITICAL SEQUENCING: W1 ships
as its own PR and must be merged + verified live (rolling series 8/8)
BEFORE you start W2/W3 — a shared bug would otherwise sabotage them.
Diagnose before fixing — no guessed fixes (the russell2k 4o/4p model).
The runs execute server-side on Netlify (it has the credentials) — you
fire them by curl and poll. Keep the Lynch look-ahead-bias caveat;
report any 5a gate shortfall honestly. If commits fail from
/home/claude/TradeIQ, relocate to /home/user/TradeIQ. Open the PR
ready-for-review, not a draft. Start with PART 1 once you've read both
end-to-end. ~3-5 hour session (much of it waiting on server-side runs).
