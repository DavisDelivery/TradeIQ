# Phase 4r-W1b Executor Kickoff — Portfolio-backtest reinvoke reliability

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a new Claude chat. The GitHub PAT is embedded
> inline; no follow-up needed.

---

You are an executor agent. Your single assignment is **Phase 4r-W1b**
of the TradeIQ project. The conversation you are reading is your boot
prompt. Read it end-to-end, then read `briefs/phase-4r-w1b-brief.md` in
the repo (full diagnosis + architecture), then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app` — a React/Vite SPA backed by
TypeScript Netlify functions and Firestore. It has a backtest engine
that runs portfolio strategies against historical data on a
checkpoint-resume background-function pattern: a worker runs a batch
within a 13-minute budget, checkpoints a cursor, and self-reinvokes
until the run is done. Owner: Chad Davis.

## The problem you're fixing (full detail in the brief)

Phase 4r W1 (PR #43, merged) fixed the rolling-window cron and the
v1/v2 verdict versioning. Driving the 8 rolling-window backtests to
8/8 then exposed a **second bug**: the portfolio-backtest checkpoint-
resume **reinvoke is unreliable**.

Evidence — three `/api/backtest-status` polls comparing
`invocationAgeMs` deltas: each of the 8 rolling runs reinvoked **0–2
times** then **stalled at the 15-minute platform ceiling** without
handing off — `status: running`, `invocationAgeMs` climbing past 20,
30+ minutes, a dead container. ~50 minutes after firing: **0 of 8
done.** Critically, the `full` window completed cleanly on 2026-05-16
(31 min, ≥1 successful reinvoke) — but it ran *alone*. **The reinvoke
degrades under concurrent load** — that is the central clue.

## Your assignment in one sentence

Diagnose *why* the portfolio-backtest reinvoke is unreliable under
concurrency, fix the confirmed cause, add a recovery path for runs that
stall anyway, and prove it by driving one rolling-window backtest to
`done`.

## The discipline that is not optional

**Diagnose before fixing — no guessed fix.** The concurrency
correlation is the starting *clue*, not the answer. Instrument, observe
the actual failure, fix the confirmed cause. This is the discipline
that resolved the russell2k scan chain (Phase 4o diagnosed, 4p fixed).

## No open decisions for Chad

The structure is settled. One judgment call is yours, from the
diagnosis: if the platform rejects simultaneous self-invocations, the
fix may *bound* reinvoke concurrency (slower, serialized) rather than
only hardening each reinvoke. A correct-but-slower path is acceptable —
completing reliably beats completing fast. Report the trade-off you
chose.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4rw1b@tradeiq.local"
git config user.name "Executor 4r-W1b"

npm ci    # if it fails on cross-platform optional deps, fall back to: npm install
npx tsc --noEmit
npm test
npm run build

git checkout -b phase-4r-w1b-reinvoke-reliability
```

If baseline fails, STOP and report. Bump APP_VERSION one patch in
`src/App.jsx`. MODEL_VERSION unchanged — this is a reliability fix, not
a scoring change.

**Environment note:** if commits fail from `/home/claude/TradeIQ`, the
signing server may expect commits from `/home/user/TradeIQ` (or a
`/tmp` path) — relocate the repo and commit from there.

Read `briefs/phase-4r-w1b-brief.md` before writing code.

**Secrets:** GitHub PAT (write-scoped) in the clone URL. The backtest
runs execute **server-side on Netlify**, which has the credentials —
you fire runs by `curl`-ing trigger endpoints and poll
`/api/backtest-status`. You do not need local API keys.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key existing code

- `netlify/functions/run-portfolio-backtest-background.ts` — the
  background worker. Runs a batch under a 13-min watchdog (`BUDGET_MS`,
  90s margin under the 15-min ceiling); on a non-terminal batch it
  checkpoints the cursor and calls `dispatchReinvoke`.
- `netlify/functions/shared/backtest-resume/reinvoke.ts` —
  `dispatchReinvoke`: a `fetch(functionUrl, POST {runId, resume:true})`
  wrapped in `ctx.waitUntil(...)`; catches fetch failures, stamps
  `lastReinvokeError` onto the cursor, logs `reinvoke_dispatched` /
  `reinvoke_dispatch_non_2xx` / `reinvoke_fetch_error`.
- `inferFunctionUrl` — builds the reinvoke target URL.
- `netlify/functions/shared/backtest-resume/watchdog.ts` — the budget
  timer.
- `netlify/functions/shared/backtest-resume/cursor.ts` — the checkpoint
  cursor (last-write-wins; has a stale-reinvoke-loop guard).
- `netlify/functions/portfolio-backtest-trigger.ts` — server-side
  trigger; fires a run with `{"window":"<name>"}`.
- `netlify/functions/scan-portfolio-backtest-cron.ts` — the cron (4r W1
  made it pick the next undone window of the active rule version).
- `netlify/functions/backtest-status.ts` → `/api/backtest-status` —
  the 4r W1 diagnostic; already exposes per-run `status`,
  `invocationAgeMs`, cursor fields incl. `lastReinvokeError`. Extend it
  if W1 needs more reinvoke instrumentation.

## 2.2 Files you ARE allowed to touch

- `netlify/functions/shared/backtest-resume/*` — the reinvoke fix
  (`reinvoke.ts`, `watchdog.ts`, `cursor.ts`)
- `netlify/functions/run-portfolio-backtest-background.ts` — the worker
- `netlify/functions/backtest-status.ts` — extra reinvoke
  instrumentation, if W1 needs it
- `netlify/functions/scan-portfolio-backtest-cron.ts` and/or the
  watchdog — W3 stuck-run recovery
- `inferFunctionUrl`'s source — if W1 confirms a URL defect
- test files for all of the above
- `src/App.jsx` — APP_VERSION bump
- `reports/phase-4r-w1b/diagnosis.md` + `verification.md`
- `briefs/phase-4r-w1b-pr-description.md`
- `ORCHESTRATOR.md` — mark 4r-W1b done at the end

## 2.3 Files you may NOT touch

- The scan-side reinvoke (`shared/scan-resume/*`, the scan workers) —
  Phase 4p already fixed it; you may *reference* its pattern, not
  modify it
- The composite scoring, the analysts, the Williams/Lynch code, the
  desktop layout — unrelated
- What the backtests compute — W1b is reliability only, not behavior
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`

## 2.4 Environment notes

- Any new `/api/` endpoint needs a matching `[[redirects]]` block in
  `netlify.toml`. (You likely won't add one — extending the existing
  `backtest-status` endpoint needs no new redirect.)
- Any new Firestore query shape may need a composite index in
  `firestore.indexes.json` — a `FAILED_PRECONDITION` at runtime is that
  symptom.

---

# PART 3 — THE WORK (order W1 → W2 → W3)

## W1 — Diagnose the reinvoke unreliability

**Diagnose before fixing.** Confirm the actual failure; the
concurrency correlation is the lead, not the conclusion. Suspects —
confirm or rule out each:

- Reinvoke fetch **rejected/throttled under load** — 8 near-
  simultaneous self-POSTs hit a Netlify concurrent-function or rate
  limit; gateway returns 429/503; the run dies. (Strong suspect.)
- `inferFunctionUrl` builds a **wrong/ambiguous URL** in the
  background-function context.
- `ctx.waitUntil` **not keeping the container alive** long enough for
  the dispatch fetch to land.
- The **cursor handoff races** — a resumed invocation reads a stale
  cursor, or the stale-reinvoke-loop guard drops a *legitimate*
  reinvoke.
- The **resumed invocation dies early** and never re-dispatches.

Extend `/api/backtest-status` if needed to surface reinvoke attempt
counts / dispatch outcomes per run. Write the confirmed diagnosis to
`reports/phase-4r-w1b/diagnosis.md`.

## W2 — Fix the confirmed root cause

Fix what W1 confirms — not a guess. Likely shapes:

- Reinvoke fetch throttled under load → **retry with backoff** on the
  dispatch, and/or **bounded reinvoke concurrency** so the platform is
  not asked for many simultaneous self-invocations.
- Wrong URL → correct `inferFunctionUrl`.
- Cursor handoff race → fix the handoff / the stale guard.
- Reference the Phase 4p russell2k fix pattern (a dedicated, reliably-
  dispatched reinvocation step) where it fits.

The fix must make a backtest reliably reinvoke across as many 15-minute
ceilings as the run needs — **including when several backtests run
concurrently.**

## W3 — Stuck-run recovery for portfolio backtests

Defence in depth: a run that stalls anyway must not stay dead forever.
Add recovery — analogous to Phase 4p's `recoverStuckRuns` on the scan
side. A portfolio-backtest run `status: running` with a cursor stale
beyond a sane threshold (comfortably past 15 min) must be detected and
**resumed** (re-dispatch the reinvoke from the checkpointed cursor) or
cleanly **failed**, by the cron or a watchdog. There is currently *no*
such recovery for backtests.

## Proof of fix (part of W1b, before hand-off)

Drive **one** rolling-window backtest to `status: done` cleanly through
the fixed reinvoke — fire it via `portfolio-backtest-trigger`, poll
`/api/backtest-status`, confirm it completes. Report the run ID and
elapsed time in the hand-off. (The orchestrator re-fires all 8
post-merge.)

---

# PART 4 — TESTS

- W2: tests covering the reinvoke fix — the confirmed failure path now
  succeeds (e.g. a throttled dispatch retries and lands).
- W3: a stale-`running` backtest is detected and resumed/failed.
- Mock Firestore and the reinvoke `fetch`; no network in unit tests.
- Report the real test delta; don't pad.

---

# PART 5 — CONVENTIONS

- One commit per workstream + tests + the diagnosis/verification
  reports. One PR.
- APP_VERSION bumped one patch. MODEL_VERSION unchanged.
- `strict: true` TypeScript; no `any` without an inline reason.
- Match the house style of the existing backtest-resume code.

---

# PART 6 — PR + ACCEPTANCE

```bash
git push -u origin phase-4r-w1b-reinvoke-reliability
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4r-W1b - portfolio-backtest reinvoke reliability",
    "head": "phase-4r-w1b-reinvoke-reliability",
    "base": "main",
    "body": "See briefs/phase-4r-w1b-brief.md and reports/phase-4r-w1b/. Diagnoses and fixes the portfolio-backtest checkpoint-resume reinvoke stalling under concurrency; adds stuck-run recovery. Proven by driving one rolling-window backtest to done."
  }'
```

**Open the PR as ready-for-review, NOT a draft.** If your tooling
defaults to draft, immediately mark it ready.

Post-merge, the **orchestrator** re-fires all 8 rolling windows,
confirms 8/8 `done` and a non-PENDING v2 verdict — then 4r W2/W3
proceed.

---

# PART 7 — HAND-OFF FORMAT

When the PR is mergeable, post one message:

```
PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Diagnosis (W1):
- Reinvoke-unreliability root cause: <what it actually was>

Fix (W2):
- <what changed>; concurrency approach: <hardened reinvoke / bounded
  concurrency / both> — trade-off: <note>

Recovery (W3):
- Stuck-run recovery: <how — resume vs fail, threshold, who runs it>

Proof:
- Drove rolling-window <name> to done — runId <id>, elapsed <N> min

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was <baseline>)
- npm run build: clean

Acceptance: DEFERRED — orchestrator re-fires all 8 rolling windows,
confirms 8/8 + non-PENDING v2 verdict, then 4r W2/W3 resume.
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Shipping a guessed fix** without confirming the root cause.
- **Verifying only solo** — the fix and the proof run must hold under
  the concurrency that actually broke it; the orchestrator re-fires 8.
- **Skipping W3** — without stuck-run recovery, one stall still freezes
  a window forever.
- **Touching the scan-side reinvoke** — Phase 4p owns it; reference its
  pattern, don't modify it.
- **Networking in unit tests.** **Opening the PR as a draft.**

---

# PART 9 — PARALLEL CONTEXT

4k, 4m, 4n, 4r-W1, 4s all merged. Phase 4q (clickable analyst
contributions) may run in parallel — it is detail-panel UI and shares
no file with the backtest engine. If you hit an unexpected conflict on
`main`, stop and report.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4r-W1b of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4r-w1b-executor.md — that's your full assignment
   — then read briefs/phase-4r-w1b-brief.md for the diagnosis.

Everything you need is in those two files: the portfolio-backtest
checkpoint-resume reinvoke is unreliable — each run reinvokes 0-2x then
stalls at the 15-min platform ceiling; the `full` window completed solo
but firing 8 rolling windows in parallel stalled 7+/8, so the failure
is concurrency-correlated. W1 diagnose why (instrument the reinvoke
chain — dispatchReinvoke / inferFunctionUrl / watchdog / cursor — no
guessed fix, the 4o/4p model); W2 fix the confirmed cause (likely
reinvoke retry+backoff and/or bounded reinvoke concurrency); W3 add
stuck-run recovery for backtests (nothing currently resumes a stalled
run — the 4p recoverStuckRuns pattern). Prove the fix by driving ONE
rolling-window backtest to done. Runs execute server-side on Netlify
(it has the credentials) — fire via curl, poll /api/backtest-status. If
commits fail from /home/claude/TradeIQ, relocate to /home/user/TradeIQ.
Open the PR ready-for-review, not a draft. Start with PART 1 once
you've read both. ~3-4 hour session.
