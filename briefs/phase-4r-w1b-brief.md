# Phase 4r-W1b — Portfolio-backtest reinvoke reliability

**Author:** orchestrator (CTO + CFO combined voice — house style)
**Target version:** patch bump; MODEL_VERSION unchanged (no scoring
change).
**Priority:** HIGH — this is the bug blocking all of Phase 4r.
**Dependencies:** follows Phase 4r W1 (PR #43, merged — cron-window
picking + v1/v2 version-awareness + `/api/backtest-status`). This phase
fixes the *second* bug W1 surfaced.
**Estimated effort:** one executor agent session, ~3–4 hours — most of
it diagnosis + driving a verification run, not lines of code.

---

## Executive summary — the decision and the ask

Phase 4r W1 fixed the rolling-window cron and the v1/v2 verdict
versioning. Then the orchestrator fired the 8 rolling-window backtests
to drive the series to 8/8 — and a *second* bug surfaced, exactly the
one the 4r brief warned about: **the portfolio-backtest checkpoint-
resume reinvoke is unreliable.**

Across three `/api/backtest-status` polls, every one of the 8 rolling
runs reinvoked 0–2 times and then stalled at the 15-minute platform
ceiling without handing off. None reached `done`. The `full` window
completed cleanly on 2026-05-16 — but it ran *alone*. The failure is
**concurrency-correlated**: fire one backtest and the reinvoke chain
holds; fire eight and the chain breaks for most of them.

This is the bug blocking all of Phase 4r. Until the reinvoke is
reliable, the rolling-window series cannot reach 8/8, the binding v2
portfolio verdict cannot compute, and 4r's W2 (the Williams/Lynch
backtests) and W3 (the 5a data gate) — which run through the same
background-function machinery — would stall the same way.

Phase 4r-W1b diagnoses *why* the reinvoke is unreliable, fixes it, and
adds a recovery path for runs that stall anyway. Diagnose first — no
guessed fix. Approve; this unblocks the rest of 4r.

---

# PART I — THE PROBLEM

### The symptom, precisely

After 4r W1 deployed, the orchestrator fired all 8 rolling-window
backtests (`rolling-2018` … `rolling-2025`) via `portfolio-backtest-
trigger`. All 8 dispatched cleanly (`dispatchOk: true`, run IDs
assigned). Then, across three `/api/backtest-status` polls comparing
`invocationAgeMs` deltas:

- Each run reinvokes **0–2 times** — a fresh invocation's
  `invocationAgeMs` resets, proving the reinvoke *can* land — then on a
  later 15-minute ceiling it does **not** reinvoke. The run sits at
  `status: running` with `invocationAgeMs` climbing past 15, then 20,
  then 30+ minutes — a dead container, frozen cursor.
- ~50 minutes after firing: **0 of 8 done.** All 8 effectively stalled.

### Why it matters that it's concurrency-correlated

The `full` window backtest completed cleanly on 2026-05-16 in 31
minutes — that is *more* than one 15-minute invocation, so it
reinvoked successfully at least once. But `full` ran alone. The
rolling-window runs were fired 8-way parallel and 7+ stalled. **The
reinvoke is not universally broken — it degrades under concurrent
load.** That is the central clue for the diagnosis.

### Consequence

The 8 rolling-window backtests never complete → the rolling series
never reaches 8/8 → `/api/portfolio-verdict` never computes the binding
"beats SPY in ≥5/8 windows" verdict. And 4r's W2/W3 backtests run
through the same background machinery, so they would stall identically.
**4r-W1b is the unblocker for all of 4r.**

---

# PART II — CURRENT-STATE ASSESSMENT (CTO)

The reinvoke chain, as it exists:

- `run-portfolio-backtest-background.ts` — the background worker. Runs
  a batch of windows under a **13-minute watchdog budget** (`BUDGET_MS`
  — 90s margin under Netlify's 15-min Background Function kill
  ceiling). On a non-terminal batch it checkpoints the cursor and calls
  `dispatchReinvoke`.
- `shared/backtest-resume/reinvoke.ts → dispatchReinvoke` — does a
  `fetch(functionUrl, { method: 'POST', body: { runId, resume: true }})`
  wrapped in `ctx.waitUntil(...)` so Netlify keeps the container alive
  until the fetch lands. Catches fetch failures; stamps
  `lastReinvokeError` onto the cursor; logs `reinvoke_dispatched` /
  `reinvoke_dispatch_non_2xx` / `reinvoke_fetch_error`.
- `inferFunctionUrl` — builds the reinvoke target URL.
- `shared/backtest-resume/watchdog.ts` — the budget timer.
- `shared/backtest-resume/cursor.ts` — the checkpoint cursor;
  last-write-wins, with logic to prevent a stale reinvoke from looping.
- `scan-portfolio-backtest-cron.ts` — the cron (4r W1 made it pick the
  next undone window of the active rule version).
- `/api/backtest-status` (4r W1) — the diagnostic; already exposes
  per-run `status`, `invocationAgeMs`, and cursor fields.

What is missing: **nothing recovers a stalled run.** A run frozen at
`status: running` with a dead cursor is not `done`, so the cron may
re-fire that window — as a *new* run that then stalls the same way.
There is no equivalent of the scan side's `recoverStuckRuns` (Phase 4p)
for portfolio backtests.

---

# PART III — FINANCIAL ANALYSIS (CFO)

- **No run cost, no tokens.** This is an infrastructure-reliability fix.
- **Build cost:** one agent session, ~3–4 hours — weighted toward
  diagnosis and a verification run, not code volume.
- **The cost of not fixing it:** all of Phase 4r is stuck. The v2
  portfolio verdict (which gates the 4e-1 ship decision and 4e-2), the
  Williams/Lynch backtests, and the 5a data gate all sit behind this
  one bug. High leverage for a small fix.

Approve; expedite — it is on the critical path.

---

# PART IV — PROPOSED SOLUTION (CTO)

One PR. Order **W1 → W2 → W3**, then orchestrator-driven verification.

### W1 — Diagnose why the reinvoke is unreliable under concurrency

**Diagnose before fixing. No guessed fix.** The russell2k chain (4o
diagnosed, 4p fixed) is the model. Instrument and confirm the actual
failure; the symptom (concurrency-correlated) is the starting clue, not
the answer.

Candidate causes — **suspects, not conclusions** — to confirm or rule
out:

- **Reinvoke fetch rejected/throttled under load.** Eight near-
  simultaneous self-POSTs may hit a Netlify concurrent-function or rate
  limit; the gateway returns 429/503; `dispatchReinvoke` logs it but
  the run is then dead. (Strong suspect — fits the concurrency
  correlation.)
- **`inferFunctionUrl` builds a wrong/ambiguous URL** in the
  background-function context, so the reinvoke fetch lands nowhere or
  hits the SPA fallback.
- **`ctx.waitUntil` not keeping the container alive long enough** — the
  container freezes before the dispatch fetch completes.
- **The cursor handoff races** — a resumed invocation reads a stale
  cursor, or the stale-reinvoke-loop guard drops a *legitimate*
  reinvoke.
- **The resumed invocation dies early** — e.g. errors loading the
  cursor or running the first batch, so it never re-dispatches.

`/api/backtest-status` already exposes cursor fields including
`lastReinvokeError`; extend the diagnostic if needed to surface
reinvoke attempt counts / dispatch outcomes per run. Write the
confirmed diagnosis to `reports/phase-4r-w1b/diagnosis.md`.

### W2 — Fix the confirmed root cause

Fix what W1 confirms — not a guess. Likely shapes, depending on the
diagnosis:

- If the reinvoke fetch is throttled/rejected under load: a **retry
  with backoff** on the reinvoke dispatch, and/or **bounded reinvoke
  concurrency** so the platform is not asked for 8 simultaneous
  self-invocations.
- If `inferFunctionUrl` is wrong: correct the URL derivation.
- If the cursor handoff races: fix the handoff / the stale-guard.
- The 4p russell2k fix is a reference pattern — a dedicated, reliably-
  dispatched reinvocation step — apply its lessons where they fit.

The fix must make a portfolio backtest reliably reinvoke across as many
15-minute ceilings as the run needs, **including when several backtests
run concurrently.**

### W3 — Stuck-run recovery for portfolio backtests

Even with W2, defence in depth: add a recovery path so a run that
stalls anyway does not stay dead forever — analogous to Phase 4p's
`recoverStuckRuns` on the scan side. A portfolio-backtest run that is
`status: running` with a cursor stale beyond a sane threshold
(comfortably past the 15-min ceiling) must be detected and **resumed**
(re-dispatch its reinvoke from the checkpointed cursor) or cleanly
**failed**, by the cron or a watchdog. At minimum a stalled run must
not silently block its window forever.

### Verification (orchestrator, post-merge)

W1b's executor proves the fix by driving **one** rolling-window
backtest to `done` cleanly through the fixed reinvoke. After the PR
merges, the **orchestrator** re-fires all 8 rolling windows, confirms
8/8 `done`, and confirms `/api/portfolio-verdict` returns a non-PENDING
binding v2 verdict. Only then do 4r W2/W3 proceed.

---

# PART V — ARCHITECTURE & SEQUENCING DETAIL (CTO)

### Diagnose-before-fix, again

The reinvoke unreliability has not been root-caused — only observed.
W1 instruments and confirms; W2 fixes the confirmed cause. Shipping a
guessed fix risks the runs stalling again and burning another cycle.

### Concurrency is the clue

Treat the concurrency correlation as the primary lead: `full` solo
worked; 8-way parallel stalled. Whatever the fix, it must hold under
concurrent backtests — because the orchestrator will re-fire 8 rolling
windows to verify, and 4r W2 fires Williams + Lynch backtests.

### This unblocks the rest of 4r

4r W2 (Williams/Lynch backtests) and W3 (5a data gate) were explicitly
held pending this fix — they run through the same background-function
reinvoke machinery. Once W1b is verified (8/8 rolling windows complete,
verdict computes), 4r W2/W3 resume.

### Out of scope

- The composite scoring (Phase 4s — separate, merged).
- The scan-side reinvoke (Phase 4p — already fixed; W1b may *reference*
  its pattern but does not touch scan code).
- Changing what the backtests compute — W1b is reliability only.

---

# PART VI — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | A guessed fix that doesn't address the real cause | Medium | Runs stall again | Diagnose-before-fix; W1 confirms via instrumentation; verify by driving a real run to `done`. |
| R2 | Fix works solo but still fails under concurrency | Medium | 4r still blocked | The fix and the verification must both be done under concurrent load (8 rolling windows). |
| R3 | Stuck-run recovery re-fires a run that then re-stalls (loop) | Low–Medium | Wasted runs | W3 recovery resumes from the checkpointed cursor; bound retries; W2's reliability fix is the real cure. |
| R4 | Pre-W1b zombie `running` runs confuse the verdict / cron | Low | Noise | W3 recovery clears or fails them; the cron's active-version filter (4r W1) already scopes the verdict. |

No cost risk — infrastructure fix.

---

# PART VII — ACCEPTANCE CRITERIA

**W1b (executor):**
1. The reinvoke-unreliability root cause is diagnosed and documented in
   `reports/phase-4r-w1b/diagnosis.md` — confirmed via instrumentation,
   not asserted.
2. The fix is shipped; **one rolling-window backtest is driven to
   `status: done`** through the fixed reinvoke as proof.
3. Stuck-run recovery exists — a stalled `running` backtest is detected
   and resumed or cleanly failed.
4. `tsc --noEmit` clean, full suite green, `npm run build` clean, with
   tests covering the reinvoke fix and the recovery path.

**Orchestrator (post-merge):**
5. All 8 rolling-window backtests re-fired complete `done` — verified
   under concurrent load.
6. `/api/portfolio-verdict` returns a **non-PENDING binding v2
   verdict**.

Then — and only then — 4r W2/W3 proceed.

---

# PART VIII — ROLLOUT PLAN

1. One PR (ready-for-review, not draft) — W1 diagnosis + W2 fix + W3
   recovery + tests. Orchestrator reviews; the review focus is that the
   fix addresses the *confirmed* cause and the proof-run genuinely
   reached `done`.
2. Merge (confirm `merged: True` before branch delete). Netlify
   deploys.
3. Orchestrator re-fires the 8 rolling windows, confirms 8/8 + the
   non-PENDING v2 verdict.
4. 4r W2/W3 resume (Williams/Lynch backtests, 5a data gate).
5. ORCHESTRATOR.md updated.

Rollback: a normal revertible PR.

---

# PART IX — OPEN DECISIONS

The structure is settled. One judgment call belongs to the executor's
diagnosis, not to Chad up front:

- **Reliability vs. bounded concurrency.** If W1 confirms the platform
  rejects simultaneous self-invocations, the fix may *bound* how many
  backtests reinvoke at once (slower, serialized) rather than purely
  hardening each reinvoke. The executor decides this from the
  diagnosis and reports the trade-off. A correct-but-slower path is
  acceptable — completing reliably beats completing fast.

**No open decisions for Chad.**

---

*End of brief. Phase 4r-W1b fixes the reinvoke-reliability bug that
Phase 4r W1's own verification exposed — the bug blocking the entire
backtest line of work. Diagnose first, fix the confirmed cause, add a
recovery net, prove it by driving a real run to completion.
Recommendation: approve and expedite — it is on the critical path for
the v2 verdict, the 4e-1 ship decision, the Williams/Lynch backtests,
and Phase 5a.*
