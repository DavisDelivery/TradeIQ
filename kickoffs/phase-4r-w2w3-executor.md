# Phase 4r W2/W3 Executor Kickoff — Williams/Lynch backtests + 5a data gate

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a new Claude chat. The GitHub PAT is embedded
> inline; no follow-up needed.

---

You are an executor agent. Your assignment is **W2 and W3 of Phase 4r**
of the TradeIQ project — the two workstreams that were held until the
backtest reinvoke bug was fixed. The conversation you are reading is
your boot prompt. Read it end-to-end, then read
`briefs/phase-4r-brief.md` (PART IV **W2** and **W3** — your spec),
then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app` — a React/Vite SPA backed by
TypeScript Netlify functions, Firestore, Polygon and Finnhub. It has a
backtest engine that runs strategies against historical data on a
checkpoint-resume background-function pattern. Owner: Chad Davis.

## Context — what's already done

Phase 4r W1 (PR #43) and W1b (PR #45) are **merged and verified**:
- The rolling-window cron and v1/v2 verdict versioning are fixed.
- The portfolio-backtest checkpoint-resume **reinvoke is now reliable**
  — verified by re-firing 8 rolling-window backtests 8-way concurrent,
  all completing `done` at v2. The v2 portfolio verdict computed.

That means the backtest machinery is **proven** — backtests fired
server-side now run to completion. W2 and W3 were held behind that bug;
they are now unblocked. That is your job.

## Your assignment

- **W2** — run the 4n Williams + Lynch backtests, populate their
  verdict tables.
- **W3** — confirm the 5a ML data gate.

## The disciplines that are not optional

- **Honest verdicts.** If the Williams or Lynch backtest comes back
  weak — the signal does not beat its baseline — **report that
  plainly.** A signal that does not work is a real, valuable finding,
  not a failure to hide. The Lynch backtest keeps its look-ahead-bias
  caveat banner. A flattering number presented as clean is a negative
  deliverable.
- **Diagnose before fixing.** If a run stalls, diagnose it — do not
  guess. (The reinvoke is fixed, but be alert.)

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4rw2w3@tradeiq.local"
git config user.name "Executor 4r-W2W3"

npm ci    # if it fails on cross-platform optional deps, fall back to: npm install
npx tsc --noEmit
npm test
npm run build

git checkout -b phase-4r-w2w3-backtests-and-gate
```

If baseline fails, STOP and report. Bump APP_VERSION one patch only if
you make a code change. MODEL_VERSION unchanged.

**Environment note:** if commits fail from `/home/claude/TradeIQ`, the
signing server may expect commits from `/home/user/TradeIQ` (or a
`/tmp` path) — relocate the repo and commit from there.

Read `briefs/phase-4r-brief.md` (PART IV W2/W3) and
`reports/phase-4n/runbook.md` before starting.

**Secrets:** GitHub PAT (write-scoped) in the clone URL. The backtests
run **server-side on Netlify**, which has the Polygon/Finnhub/Firebase
credentials — you fire runs by `curl`-ing trigger endpoints and poll
the status endpoints. You do not need local API keys.

---

# PART 2 — REPO ORIENTATION

- `netlify/functions/backtest-runs-trigger.ts` — server-side trigger
  for non-portfolio backtests (the Williams/Lynch runs go here).
- `netlify/functions/run-backtest-background.ts` — the cursor-driven
  background worker (checkpoint-resume — now reliable per W1b).
- `configs/williams-sp500-2018-2024-weekly-top20.json`,
  `configs/lynch-sp500-2018-2024-quarterly-top20.json` — the 4n run
  configs (confirm exact filenames in `configs/`).
- `reports/phase-4n/williams-backtest.md`, `lynch-backtest.md` — verdict
  tables to populate (currently `__` placeholders).
- `reports/phase-4n/runbook.md` — the documented run procedure;
  `pit-integrity-attestation.md` — the Lynch look-ahead-bias caveat
  source.
- `/api/backtest-status` — diagnostic; poll run state here.
- For W3: the 5a-prep machinery — a full sp500 / monthly / 7-year
  backtest emits per-candidate `mlTraining` rows. `reports/phase-5a-prep/`
  has the prior context; the 5a data gate is **≥10k rows across ≥5
  runs**.

**Files you may touch:** `reports/phase-4n/*`, `reports/phase-4r/*`,
`src/App.jsx` (only if a code change is needed), `ORCHESTRATOR.md`, and
any backtest file ONLY if a genuine fix is required to complete a run.
**Do not** touch the composite scoring, the desktop layout, the
Williams/Lynch signal logic, or the reinvoke code (W1b owns it).

---

# PART 3 — THE WORK

## W2 — Run the Williams + Lynch backtests

1. Fire both backtests **server-side** via `backtest-runs-trigger`
   using the two `configs/` files. Poll `/api/backtest-status` to
   completion.
2. Populate the verdict tables in `reports/phase-4n/williams-backtest.md`
   and `lynch-backtest.md` with **real numbers** — total return, excess
   vs SPY, Sharpe, max drawdown, win rate; for Williams,
   target-hit-before-stop.
3. Run the **score-ranked baseline** (runbook step 4 — the same configs
   without `discreteSignalOnly`). Report the delta: BUY-verdict-only vs
   score-ranked. That delta is the answer to "does the discrete signal
   add value over the raw score."
4. **Keep the Lynch look-ahead-bias caveat banner** on the populated
   Lynch verdict — the PIT attestation classifies Lynch as "PIT-correct
   on filing dates, residual restatement risk." Report the number
   honestly *with* its caveat.
5. State the verdicts plainly in the hand-off — including if a signal
   underperforms.

## W3 — Confirm the 5a ML data gate

1. Confirm — or re-fire — the 5a-prep acceptance run (a full sp500 /
   monthly / 7-year backtest; per-candidate ML-row emission → ~42k rows
   expected).
2. Verify the gate: **≥10k `mlTraining` rows across ≥5 runs.**
3. If the gate is met, report that Phase 5a (PR #24) is unblocked.
   *Running the 5a ML-discovery pipeline is NOT part of this work.*
4. If the row generation falls short, **report the shortfall honestly**
   as a finding — do not declare the gate met.

---

# PART 4 — DELIVERABLE

This is mostly run-and-populate. Expect:
- Populated `reports/phase-4n/williams-backtest.md` + `lynch-backtest.md`.
- A `reports/phase-4r/w2-w3-results.md` summary (Williams verdict,
  Lynch verdict + caveat, baseline deltas, 5a gate status).
- A PR with those report commits (and any small code fix that was
  genuinely required). One PR, ready-for-review, not draft.
- If no code changed and only reports were produced, still open the PR
  for the report commits.

```bash
git push -u origin phase-4r-w2w3-backtests-and-gate
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4r W2+W3 - Williams/Lynch backtest verdicts + 5a data gate",
    "head": "phase-4r-w2w3-backtests-and-gate",
    "base": "main",
    "body": "See briefs/phase-4r-brief.md PART IV W2/W3. Williams + Lynch backtests run, verdict tables populated; score-ranked baseline delta reported; Lynch look-ahead-bias caveat retained. 5a ML data gate confirmed/reported."
  }'
```

**Open the PR ready-for-review, NOT a draft.**

---

# PART 5 — HAND-OFF FORMAT

```
PHASE 4r W2+W3 — PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

W2 — Williams backtest: <total return / excess vs SPY / Sharpe / maxDD
     / win rate / target-hit-before-stop>
     Lynch backtest: <numbers> (look-ahead-bias caveat retained)
     Discrete-signal vs score-ranked baseline delta: <finding>
     Verdict in plain words: <does each signal work? honest read>

W3 — 5a data gate: <N mlTraining rows across M runs — MET / SHORT by ...>
     Phase 5a: <unblocked / still blocked — why>

Verification:
- tsc --noEmit: clean / npm test: <N> / npm run build: clean
- code changed: <none — reports only / what>

Acceptance: DEFERRED to orchestrator review + merge.
```

---

# PART 6 — FAILURE MODES TO AVOID

- **Dressing up a weak result.** If a signal underperforms its
  baseline, say so — that is the deliverable working.
- **Dropping the Lynch caveat.** It stays on the populated verdict.
- **Declaring the 5a gate met when it isn't.**
- **Running the 5a pipeline** — out of scope; W3 only confirms the gate.
- **Touching the reinvoke code** — W1b owns it; it is fixed.
- **Opening the PR as a draft.**

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4r W2+W3 of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4r-w2w3-executor.md — that's your full assignment
   — then read briefs/phase-4r-brief.md (PART IV W2/W3) and
   reports/phase-4n/runbook.md.

Everything you need is in those files. Phase 4r W1 + W1b are merged and
verified — the backtest reinvoke machinery is now reliable. Your job is
the two held workstreams: W2 — run the Williams + Lynch backtests
server-side via backtest-runs-trigger (configs in configs/), populate
the reports/phase-4n/ verdict tables with real numbers, run the
score-ranked baseline for comparison, keep the Lynch look-ahead-bias
caveat; W3 — confirm the 5a ML data gate (≥10k mlTraining rows across
≥5 runs). Report all verdicts HONESTLY — if a signal underperforms its
baseline, say so plainly; that's a real finding. The backtests run
server-side on Netlify (it has the credentials) — fire via curl, poll
/api/backtest-status. Running the 5a pipeline itself is NOT in scope.
If commits fail from /home/claude/TradeIQ, relocate to
/home/user/TradeIQ. Open the PR ready-for-review, not a draft. Start
with PART 1 once you've read everything. ~3-4 hour session (much of it
waiting on server-side runs).
