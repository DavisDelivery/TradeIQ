# Phase 4r — Backtest verdict resolution

**Author:** orchestrator (CTO + CFO combined voice — house style)
**Target version:** patch bumps as code changes land (W1 fix → one bump;
W2/W3 are mostly run-and-populate).
**MODEL_VERSION:** unchanged — 4r runs the engine, it does not change
scoring.
**Dependencies:** the backtest engine (4a), checkpoint-resume infra
(4e-1-infra), Williams/Lynch PIT path (4n), per-candidate ML rows
(5a-prep) — all merged. 4r is the run-it-to-completion phase.
**Estimated effort:** one executor agent session — W1 is a diagnostic +
fix; W2/W3 are fire-and-monitor. Plan ~3–5 hours, much of it waiting on
server-side runs.

---

## Executive summary — the decision and the ask

Chad asked to "resolve all the backtest problems." An audit found a
clear, slightly uncomfortable truth: **the backtest engine is sound —
but three runs that were supposed to produce verdicts never finished,
and the tracker has been claiming otherwise.**

- The 4e-1 portfolio verdict is **stuck at 1 of 8 rolling windows** and
  has been since 2026-05-16. ORCHESTRATOR said "verdicts complete." It
  is not — the binding verdict cannot be computed. The ship/no-ship
  decision has been waiting on a number that does not exist yet.
- The 4n Williams + Lynch backtests have **never been run**. Their
  verdict tables are empty placeholders.
- The 5a ML data gate was **never confirmed** — the acceptance run that
  proves there are ≥10k training rows was never verified.

None of this is an engine defect. It is unfinished execution, plus one
genuine bug — the cron that chains the rolling-window backtests has
stalled. Phase 4r resolves all three: diagnose and fix the stall, run
the runs, populate the verdicts.

**Critically: W1 ships and is verified as its own PR before W2/W3
begin.** If the rolling-window stall turns out to be a shared engine or
dispatch bug, that same bug would sabotage the W2/W3 runs. W1 first
de-risks everything after it.

This phase has modest cost (server-side compute, no LLM tokens) and
high leverage — it unblocks the 4e-1 ship decision *and* Phase 5a.
Approve.

---

# PART I — THE PROBLEM

### Problem 1 — the 4e-1 rolling-window series is stalled

The 4e-1 portfolio backtest verdict is computed live by
`/api/portfolio-verdict`. As of 2026-05-18 it returns:

```
verdict: PENDING LIVE-DATA RUN
Rule version: v1
Full-window: done.  Audit: done.  Rolling: 1/8 done.
Awaiting cron-driven completion.
```

The full-window run and the layer audit finished. But the **8
rolling-window backtests** — the sub-windows whose results drive the
binding "beats SPY in ≥5 of 8 windows" verdict — have been stuck at
**1 of 8 since 2026-05-16**. The cron that is supposed to fire each
next rolling window after the previous completes has stopped advancing.

Consequence: the 4e-1-finish ship/no-ship decision is *unmakeable* —
there is no complete verdict to decide on. And ORCHESTRATOR's
"verdicts complete" status for 4e-1-finish is **wrong** and must be
corrected.

### Problem 2 — the 4n Williams + Lynch backtests never ran

Phase 4n (merged in PR #41) shipped the point-in-time scoring path and
the run configs, but the executor session had no credentials, so the
backtests were never executed. `reports/phase-4n/williams-backtest.md`
and `lynch-backtest.md` have verdict tables that are all `__`
placeholders. Whether the Williams trade signal or the Lynch investment
signal actually produces returns is **unknown**.

### Problem 3 — the 5a ML data gate is unconfirmed

Phase 5a (the ML discovery pipeline, PR #24, draft) is gated on having
≥10k mlTraining rows across ≥5 runs. Phase 5a-prep fixed the row
generation (per-candidate emission) and a post-merge acceptance run —
a full sp500 / monthly / 7-year backtest expected to yield ~42k rows —
was supposed to confirm the gate. ORCHESTRATOR still reads "awaiting
5a-prep acceptance run." It was never verified. 5a is blocked behind an
unconfirmed gate.

---

# PART II — CURRENT-STATE ASSESSMENT (CTO)

### The engine is not the problem

The backtest stack is built and hardened: 4a (engine + correctness),
4a-fix-1..4, 4e-1 (Prophet Portfolio), 4e-1-bgfix + bgfix-2 (two
fire-and-forget dispatch-race fixes), 4e-1-infra (checkpoint-resume for
the 15-min Background Function ceiling), 5a-prep (per-candidate ML
rows). 4r does not rebuild any of this. It runs it to completion.

### Credentials are NOT the blocker

Every prior "PENDING — no credentials" note refers to *executor
sandboxes* lacking API keys. The **Netlify deployment already has**
`POLYGON_API_KEY`, `FINNHUB_API_KEY`, and the Firebase service account
configured as env vars. The 4e-1 rolling windows run server-side; the
4n backtests can be fired through the same server-side trigger path.
**4r runs server-side — it does not need anyone exporting keys
locally.**

### The execution surfaces

- `netlify/functions/backtest-runs-trigger.ts` — server-side trigger
  for non-portfolio backtests (the 4n configs go here).
- `netlify/functions/portfolio-backtest-trigger.ts` — server-side
  trigger for the portfolio backtest.
- `run-backtest-background.ts` / `run-portfolio-backtest-background.ts`
  — the cursor-driven background workers (checkpoint-resume).
- the rolling-window cron — fires the 8 rolling sub-window runs; **this
  is what has stalled.**
- `GET /api/portfolio-verdict` — computes the live verdict from
  Firestore; flips off PENDING automatically once full-window + audit +
  8/8 rolling are all done.
- `reports/phase-4n/runbook.md` — the documented run procedure for the
  4n backtests (written for a local shell; W2 prefers the server-side
  trigger equivalent — same engine, deployed creds, checkpoint-resume).
- there is **no clean backtest-run inspection endpoint** — `/api/
  backtest-status` currently errors. Diagnosing W1 will likely require
  building or fixing one, the way Phase 4o built `/api/scan-status`.

---

# PART III — FINANCIAL ANALYSIS (CFO)

- **No LLM/token cost.** Backtests are Polygon/Finnhub data + math —
  zero inference cost.
- **Run cost is bounded API calls**, and the PIT cache means most
  per-(ticker, date) fetches are served from Firestore on warm runs.
  The runbook estimates the 4n runs at ~30–45 min warm, 2–3 hr cold.
  Within existing API plans; no new spend to approve.
- **Build cost:** one agent session — W1 is diagnostic + a fix; W2/W3
  are fire-and-monitor with long waits on server-side runs.
- **Value:** three verdicts that have been pending for weeks finally
  get answered. And the leverage is real — 4r **unblocks the 4e-1 ship
  decision** (which then unblocks 4e-2, the Prophet Portfolio UI) **and
  unblocks Phase 5a** (the entire ML-discovery line of work). For one
  session, that is high return.

Approve.

---

# PART IV — PROPOSED SOLUTION (CTO)

Three workstreams. **W1 ships and is verified as its own PR before W2
and W3 begin** (PART V explains why). Order: W1 → (merge + verify) →
W2 → W3.

### W1 — Diagnose and fix the rolling-window cron stall

**Diagnose before fixing. Do not ship a guessed fix.** The
russell2k chain (4o diagnosed, 4p fixed) is the model.

- Establish *why* the rolling-window series is stuck at 1/8. Candidate
  causes, none assumed: a dead/misconfigured cron; a fire-and-forget
  dispatch race (the exact bug class that bit 4e-1-bgfix and bgfix-2
  **twice** — treat it as a prime suspect); a checkpoint-resume failure
  on the rolling runs; each rolling window failing individually; or a
  verdict-aggregation bug that never advances the counter.
- Inspecting the rolling-run state will likely require a diagnostic —
  build or repair a `/api/backtest-status`-style endpoint that reports
  each backtest run's status/cursor, mirroring how 4o built
  `/api/scan-status`. That diagnostic is a legitimate W1 deliverable.
- Fix the actual root cause. Drive the rolling-window series to **8/8**.
- Resolve the **rule-version question** the diagnosis will surface: the
  live verdict shows `Rule version: v1`, but Phase 4i moved the
  portfolio config to v2. Determine whether the stuck series is a v1
  series to be completed, or must be re-run under v2 — and report the
  reasoning. Do not silently pick one.
- **Done when:** the rolling series is 8/8, and `/api/portfolio-verdict`
  returns a non-PENDING binding verdict (the ≥5/8-windows-beat-SPY
  rule), for the rule version W1 establishes as correct.

### W2 — Run the 4n Williams + Lynch backtests

- Fire both backtests **server-side** (via `backtest-runs-trigger` or
  the documented equivalent) using
  `configs/williams-sp500-2018-2024-weekly-top20.json` and
  `configs/lynch-sp500-2018-2024-quarterly-top20.json`. Server-side so
  the deployed credentials and the checkpoint-resume infra are used.
- Drive each to completion; populate the verdict tables in
  `reports/phase-4n/williams-backtest.md` and `lynch-backtest.md` with
  real numbers — total return, excess vs SPY, Sharpe, max drawdown,
  win rate, and for Williams target-hit-before-stop.
- Also run the **score-ranked baseline** (runbook step 4 — same configs
  without `discreteSignalOnly`). The delta between "BUY-verdict only"
  and "score-ranked" measures how much value is in the *discrete
  signal* versus the *continuous score*. Report it.
- **The Lynch look-ahead-bias caveat stays.** The PIT attestation
  (`reports/phase-4n/pit-integrity-attestation.md`) already classifies
  Lynch as "PIT-correct on filing dates, residual restatement risk."
  The populated Lynch verdict keeps that caveat banner. Report the
  number honestly with its caveat — a flattering number presented as
  clean is a negative deliverable.

### W3 — Confirm the 5a ML data gate

- Confirm — or re-fire — the 5a-prep acceptance run: a full sp500 /
  monthly / 7-year backtest, which with per-candidate ML-row emission
  should yield on the order of ~42k `mlTraining` rows.
- Verify the Phase 5a data gate: **≥10k rows across ≥5 runs.**
- If the gate is met, report that 5a (PR #24) is unblocked. *Running
  the 5a ML-discovery pipeline itself is NOT part of 4r* — 4r confirms
  the gate; 5a is its own phase.
- If the acceptance run reveals the row generation still falls short,
  **report that honestly** as a finding — do not declare the gate met
  if it is not.

---

# PART V — ARCHITECTURE & SEQUENCING DETAIL (CTO)

### Why W1 ships first, on its own PR

The rolling-window stall has an unknown root cause. If that cause is a
shared dispatch race or a checkpoint-resume defect — plausible, given
the dispatch-race bug already recurred twice — then the **same defect
would sabotage the W2 and W3 runs**, which go through the same
trigger/background machinery. Firing W2/W3 before W1 is fixed risks
three stuck runs instead of one. So: W1 is diagnosed, fixed, shipped as
its own PR, merged, and **verified live** (rolling series confirmed
8/8) before W2/W3 are fired. W2/W3 then run on known-good machinery.

### Server-side, not local CLI

The runbook documents a local `npx tsx scripts/run-backtest.ts` path.
4r prefers the **server-side trigger** path: it uses the deployed
credentials, the checkpoint-resume infra (no 15-min ceiling problem),
and the same Firestore the verdict endpoints read. Local CLI is the
fallback only if a server-side trigger path genuinely does not exist
for a given run.

### Diagnose-before-fix

W1 must not ship a guessed fix. Instrument, observe the actual failure,
then fix the confirmed cause. This is the discipline that resolved the
russell2k chain.

### This phase corrects the tracker

4r explicitly corrects the 4e-1-finish ORCHESTRATOR row, which wrongly
reads "verdicts complete." Part of W1's close-out is updating that row
to reflect reality.

---

# PART VI — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | The rolling-window stall is a shared engine/dispatch bug that also breaks W2/W3 | Medium | Three stuck runs | **W1 first** — diagnose, fix, merge, verify before firing W2/W3. |
| R2 | A guessed W1 fix that doesn't address the real cause | Medium | Stall recurs | Diagnose-before-fix; build a backtest-status diagnostic; confirm 8/8 live. |
| R3 | A backtest run is long / hits API limits | Low–Medium | Slow phase | Checkpoint-resume infra (4e-1-infra) already handles long runs; PIT cache limits fetches. |
| R4 | Lynch verdict presented as clean despite restatement risk | Medium | A misleading number | Keep the attestation caveat banner; report honestly. |
| R5 | 5a acceptance run still under-generates rows | Low | 5a stays blocked | Report the shortfall honestly as a finding; do not declare the gate met. |
| R6 | v1-vs-v2 rule-version ambiguity resolved silently/wrongly | Medium | Verdict computed on the wrong config | W1 must surface and reason about the rule version, not pick silently. |

---

# PART VII — ACCEPTANCE CRITERIA

**W1:**
1. The rolling-window cron-stall root cause is diagnosed and documented.
2. The fix is shipped; the rolling-window series reaches **8/8**.
3. `/api/portfolio-verdict` returns a **non-PENDING binding verdict**
   for the rule version W1 establishes as correct.
4. Any code change: `tsc --noEmit` clean, full test suite green,
   `npm run build` clean, with tests covering the fix.

**W2:**
5. `reports/phase-4n/williams-backtest.md` and `lynch-backtest.md`
   verdict tables are populated with real numbers (no `__`).
6. The score-ranked baseline comparison is run and reported.
7. The Lynch verdict retains its look-ahead-bias caveat banner.

**W3:**
8. The 5a data gate (≥10k rows / ≥5 runs) is confirmed met — or its
   shortfall is honestly reported as a finding.

**Close-out:** the 4e-1-finish ORCHESTRATOR row is corrected from its
stale "verdicts complete" status.

---

# PART VIII — ROLLOUT PLAN

1. **W1 as its own PR.** Diagnose → fix → PR (ready-for-review, not
   draft) → orchestrator reviews + merges (confirm `merged: True`
   before branch delete) → Netlify deploys → orchestrator verifies the
   rolling series reaches 8/8 and the verdict flips off PENDING.
2. **Only then W2 + W3.** These are mostly run-and-populate; they may
   land as a second PR (verdict-report population + any small fixes) or
   be driven directly by the orchestrator if no code changes are
   needed. Williams/Lynch verdicts populated; 5a gate confirmed.
3. ORCHESTRATOR updated — 4r done, 4e-1-finish corrected, 5a marked
   unblocked (or its gate-shortfall recorded).

Rollback: W1's fix is a normal revertible PR. W2/W3 produce data and
reports — nothing to roll back.

---

# PART IX — OPEN DECISIONS

The phase structure is settled (Chad, 2026-05-18: one consolidated 4r,
W1-first sequencing baked in). Credentials path is settled (server-side
— see PART II). Universe is settled (sp500, per the 4n defaults).

**No open decisions for Chad.** One item W1 must resolve *and report*
rather than decide unilaterally: the v1-vs-v2 rule-version question for
the rolling-window series (PART IV, W1). The agent diagnoses it,
reasons about it, reports the call — and flags it to the orchestrator
if it proves consequential.

---

*End of brief. Phase 4r finishes what the backtest work started: it
turns three pending/stalled runs into three real verdicts, fixes the
one genuine bug in the way, and corrects a tracker that had been
overclaiming. It unblocks both the 4e-1 ship decision and Phase 5a.
Recommendation: approve and proceed — W1 first.*
