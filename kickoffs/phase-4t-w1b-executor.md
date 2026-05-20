# Phase 4t W1b Executor Kickoff — Russell 2000 composite PIT scoring defect

> **For Chad:** paste the bootstrap block at the end of this file into a
> fresh Claude chat. The PAT is embedded inline. This is its own
> executor agent — not the 4t W2/W3 agent (PR #49) and not a 4t-recovery
> follow-on. The 4t W2/W3 backtests are an orchestrator concern; the
> W1b agent does only the russell2k scoring defect.

---

You are an executor agent. Your single assignment is **Phase 4t W1b**
of the TradeIQ project. The full brief is at
`briefs/phase-4t-w1b-brief.md` in the repo. Read this kickoff
end-to-end, then read the brief, then start with PART 1.

**Scope discipline (read twice):**
- You diagnose and fix the russell2k composite PIT scoring defect and
  nothing else.
- You do NOT touch sp500's scoring path. A composite sp500 backtest
  is **currently in flight** (`bt_20260519233423_avaa64`) and uses
  the deployed code on every reinvoke; a russell2k-only fix should
  not affect it, but verify your fix's blast radius before merging.
- You do NOT modify the analyst scoring formulas (`analysts/*.ts`,
  `analysts/core.ts`).
- You do NOT modify the recovery / reinvoke / sweep code that PR #51
  shipped (`shared/backtest-resume/*.ts`,
  `run-backtest-background.ts` reinvoke section,
  `backtest-runs-trigger.ts` recovery wiring).
- You do NOT change configs on PR #49's branch.
- You do NOT write the 4t verdict report. That's a separate workstream.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app` — a React/Vite SPA backed by
TypeScript Netlify functions and Firestore. The target board scores
stocks with a ten-analyst composite (Technical, Sector, Fundamental,
Flow, News, Earnings, Macro, Insider, Patents, Political). Phase 4t
backtests this composite out-of-sample on sp500 and russell2k for
2018-01-31 → 2024-12-31 monthly to produce a verdict on whether the
composite has an edge. Owner: Chad Davis.

## What Phase 4t W1b is

Two russell2k composite backtests have stalled in **byte-identical
states** — one pre-PR-#51 (`bt_20260519184826_khgy8s`) and one
post-PR-#51 (`bt_20260519233555_2kv7mt`) — both at
`nextRebalanceIndex: 48 / 84` with `tickerAttemptTotal: 0`,
`portfolio: []`, `nav: 100000` (unchanged from initial),
`survivorshipWarned: true`, and 49 logged warnings. **The composite
PIT scoring path is silently producing empty portfolios on russell2k
across every rebalance.** sp500 with the same code/engine/window
works (live: idx 40+, NAV +38%, 20K+ ticker attempts). The defect is
universe-specific.

Phase 4t W1b diagnoses *why*, and fixes it.

## The W1 gate — diagnose-before-fix is non-negotiable

PR #51 (4t-recovery) shipped a *hypothesis* for the russell2k stall
(jitter + telemetry) and the hypothesis was wrong. The orchestrator
will not authorise another hypothesis-only ship. You ship the
diagnosis as a separate PR FIRST — a single committed report at
`reports/phase-4t-w1b/diagnosis.md` with no fix code. Orchestrator
reviews. Only after the diagnosis is reviewed and authorised do you
write W2 (the fix).

If you find yourself wanting to fix something before you've named
the root cause in writing, stop — that's the failure mode this gate
exists to prevent.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -5
git config user.email "executor-4t-w1b@tradeiq.local"
git config user.name "Executor 4t W1b"

npm ci    # if it fails on cross-platform optional deps: npm install
npx tsc --noEmit
npm test
npm run build

git checkout -b phase-4t-w1b-russell2k-pit-defect
```

If baseline fails, STOP and report. Do NOT bump APP_VERSION on the
W1 diagnosis-only PR — it's a report, no code change. APP_VERSION
gets bumped on the W2 fix PR.

**Environment note:** if commits fail from `/home/claude/TradeIQ`,
relocate to `/home/user/TradeIQ` or `/tmp`.

Read `briefs/phase-4t-w1b-brief.md` before doing anything else. The
brief has the full evidence catalog including the byte-identical
state of the two dead russell2k runs, the sp500 control numbers, and
the failure-mode taxonomy.

**Secrets:** GitHub PAT embedded in the clone URL above. Firebase
admin SDK is wired server-side via `getAdminDb()` from
`netlify/functions/shared/firebase-admin.ts` — credentials live in
Netlify env vars, you don't need them locally for read-only
diagnostic work that runs in deployed functions. For local
diagnostic scripts that need Firestore read access, ask the
orchestrator — do NOT paste service-account JSON anywhere.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key files (start here; READ-ONLY unless your diagnosis names them as the fix site)

The bug is in the composite PIT scoring path on russell2k. Likely
suspects, in priority order:

- `netlify/functions/shared/backtest/score-at-date.ts` — the PIT
  scoring entry called per rebalance. **4t W1's main artifact.**
- `netlify/functions/shared/backtest/engine.ts` and
  `engine-batched.ts` — the backtest loop that calls scoring per
  rebalance and accumulates state.
- `netlify/functions/shared/backtest/persistence.ts` — where the
  engine writes warnings to Firestore (the 49 warnings on the dead
  russell2k run live in a subcollection here).
- Universe-resolution / survivorship-bias helper(s). The
  `survivorshipWarned: true` flag is the smoking gun — find the
  function that sets it. Grep `survivorshipWarned` across
  `netlify/functions/shared/backtest/` and follow the call chain
  back to the universe lookup.
- `netlify/functions/shared/analyst-runner.ts` — composite scoring;
  read-only.
- `reports/phase-4t/pit-audit.md` — 4t W1's audit; useful context for
  what was classified as PIT-safe.

## 2.2 Files you may modify (W2; not W1)

W1 (this branch's first PR) commits ONLY:
- `reports/phase-4t-w1b/diagnosis.md` (new)

W2 (only after W1 review):
- The named root cause's file(s) — minimum diff.
- A new test that fails without the fix and passes with it.
- Maybe `scripts/<seed-or-repair>.ts` if the cause is missing data.
- `src/App.jsx` — APP_VERSION bump on the W2 PR (not W1).

## 2.3 Files you may NOT modify (any workstream)

- sp500 composite scoring path (whatever code your diagnosis shows
  sp500 takes and russell2k does not — leave sp500's branch alone).
- The ten analysts (`analysts/*.ts`, `analysts/core.ts`).
- Recovery / reinvoke / stuck-run sweep (PR #51 territory).
- PR #49's configs.
- The 4q rationale endpoint or AnalystContributions UI.
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`.

---

# PART 3 — W1 WORK (diagnosis only; ships as its own PR)

## W1.a — Read the 49 warnings on the dead russell2k run

The dead russell2k cursor has `warningRowCount: 49`. Those warnings
are in a Firestore subcollection. Three viable paths to read them
(pick one, don't escalate scope):

1. **Add a temporary read-only diagnostic endpoint**
   `/api/backtest-runs/:runId/warnings` that returns the subcollection
   contents. **Mark it temporary in the comment** and **remove it
   before the W2 PR opens.** No-op if it survives into a merged PR.
2. **Local diagnostic script** in `scripts/` that uses the admin SDK
   to read the warnings. Do NOT commit credentials. Coordinate with
   the orchestrator for service-account access if needed.
3. **Reproduce the failure locally** by directly invoking the
   composite scoring path for russell2k at a known PIT date and
   inspecting what it returns. May be the cleanest path.

Deliverable: the unique warning messages (with counts) from
`bt_20260519233555_2kv7mt`, quoted into the diagnosis report.

## W1.b — Find where `survivorshipWarned` is set

```bash
grep -rn "survivorshipWarned" netlify/functions/shared/
```

Trace the call site. Identify:
- The function that sets the flag.
- The conditional that gates it.
- The data input that causes the conditional to fire on russell2k.

Quote the exact code lines into the diagnosis report.

## W1.c — Trace rebalance 0 on both universes

You have two known cursor states (working sp500, broken russell2k)
on the same engine. Trace what happens on the **first rebalance**
(idx 0, date 2018-01-31) for each universe:

- For sp500: the universe-resolution returned ~500 tickers. Scoring
  ran. Portfolio was non-empty. What's the path?
- For russell2k: the universe-resolution returned... what? Empty?
  Undefined? A list that then gets filtered to empty? Where?

This may need a small local invocation harness (load the configs,
call into the engine's first-rebalance handler, inspect the
intermediate values). Whatever works fastest to produce a definitive
answer.

## W1 deliverable

`reports/phase-4t-w1b/diagnosis.md` with these sections (use this
exact structure so the orchestrator review is fast):

```
# Phase 4t W1b — diagnosis

## Summary (one paragraph; named root cause)

## Evidence (the 49 warnings, the survivorshipWarned trace, the
rebalance-0 trace for sp500 vs russell2k)

## Root cause (named function + named failure mode + named reason
this fails on russell2k but not sp500)

## Proposed fix (one or two specific named changes, with rough line
counts; do NOT write the fix code in this PR)

## Confidence (your honest read; what could still be wrong)
```

Open the PR as a draft against `phase-4t-w1b-russell2k-pit-defect`
with **only** the diagnosis report committed. Hand off to the
orchestrator. Wait for review.

---

# PART 4 — W2 + W3 WORK (only after W1 review)

After the orchestrator authorises the diagnosis:

## W2 — Fix

Smallest possible diff that addresses the named root cause. If the
cause is missing/seeding data, the fix is a script + a runtime
loud-fail guard so it can't recur silently. If the cause is a code
bug, the fix is the minimal code change.

## W3 — Test

Regression test in `netlify/functions/shared/backtest/__tests__/`
or `__tests__/integration/` that exercises the russell2k composite
scoring path at a specific PIT date and asserts:
- `tickerAttemptTotal > 0` after one scoring call.
- The first-rebalance portfolio is non-empty (positive count).
- (Optional but encouraged) `survivorshipWarned` is `false`.

The test must **fail without the W2 fix** and pass with it. The
4t-recovery PR's instrumentation test (`run-backtest-background.reinvoke-instrumentation.test.ts`)
is the pattern: 7 of 8 fail without the fix.

## After W2+W3

Mark the PR ready-for-review (NOT draft). One commit per workstream
or squashed sensibly. APP_VERSION bumped one patch. Open the PR.

---

# PART 5 — CONVENTIONS

- One branch (`phase-4t-w1b-russell2k-pit-defect`), two PRs in
  sequence (W1 diagnosis → reviewed → W2+W3 fix on the same branch).
  Or: W1 ships as PR-A merged-quickly, then W2+W3 is PR-B from the
  same branch. Either is fine; the orchestrator will direct.
- `strict: true` TypeScript.
- Honest reporting in the diagnosis report — if you're unsure, say
  so. If a hypothesis you tried didn't pan out, document it.
- No new analyst data sources, no new external API integrations.

---

# PART 6 — HAND-OFF FORMAT

After W1 (diagnosis-only PR open):

```
PHASE 4t W1b — W1 diagnosis PR #N open (draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Diagnosis: reports/phase-4t-w1b/diagnosis.md
  Root cause: <one sentence — named function + named failure>
  Evidence:   <bullet list, terse>
  Proposed fix: <one sentence — named changes, rough size>
  Confidence: <high / medium / low + what could still be wrong>

Standing by for orchestrator review. Will NOT proceed to W2 until
the diagnosis is authorised.
```

After W2+W3 (fix PR open):

```
PHASE 4t W1b — fix PR #M open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/M

W2 fix:
  - <named file>: <one-line summary of change>
  - APP_VERSION 0.19.8-alpha → 0.19.9-alpha (or whichever bump)

W3 test:
  - <test file>: <what it asserts>
  - fails-without-fix verified: <N> of <N> assertions fail
  - all existing tests still pass: <count>

Verification: tsc clean / build clean / sp500 in-flight run not
disturbed (verify the fix's scope before announcing).

Acceptance: DEFERRED to orchestrator review + merge + post-merge
russell2k re-fire validation.
```

---

# PART 7 — FAILURE MODES TO AVOID

- **Shipping a fix without naming the root cause first.** This is the
  exact failure mode the W1 gate exists to prevent. PR #51 did this
  and we're now writing a follow-up brief because of it.
- **Touching sp500's path.** The in-flight sp500 run (`bt_..._avaa64`)
  is currently progressing. A russell2k fix that accidentally
  affects sp500's scoring is a serious regression. Verify your fix's
  blast radius before merging.
- **Modifying analyst scoring formulas.** The bug is universe / data
  / availability, not scoring math. Analyst files are read-only.
- **Leaving the temporary diagnostic endpoint in the merged PR.** If
  you add `/api/backtest-runs/:runId/warnings` for diagnosis, remove
  it before W2 ships.
- **Opening the fix PR as a draft.** Final fix PR is
  ready-for-review.
- **Declaring victory inside the agent session.** The orchestrator
  validates the cure via post-merge russell2k re-fire — the
  composite backtest must produce non-empty portfolios on russell2k.
  Don't claim "fixed" until that re-fire confirms it.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4t W1b of the TradeIQ project at
DavisDelivery/TradeIQ. This is its own phase — you do 4t W1b only.
The 4t W2/W3 backtests on PR #49 are an orchestrator concern. The
4t-recovery PR (#51) is merged. A sp500 composite backtest is
currently in flight — you do NOT touch sp500's scoring path.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4t-w1b-executor.md — your full assignment —
   then read briefs/phase-4t-w1b-brief.md (the substance).

Everything you need is in those two files. The summary: two russell2k
composite backtests stalled in BYTE-IDENTICAL states (one pre-PR-#51,
one post-) at idx 48/84 with tickerAttemptTotal 0, empty portfolio,
nav unchanged from initial, survivorshipWarned: true, 49 warnings.
The same code/engine on sp500 works fine (live run progressing, NAV
+38%, 20K+ ticker attempts). The composite PIT scoring path is
silently producing empty portfolios on the russell2k universe. The
bug is deterministic and reproducible.

W1 is diagnosis-only and ships as its own PR (only
`reports/phase-4t-w1b/diagnosis.md` committed). DO NOT write fix
code until the orchestrator reviews the diagnosis — PR #51 shipped a
hypothesis and the hypothesis was wrong; we are not repeating that.
After W1 is authorised, W2 (fix) + W3 (regression test that fails
without the fix) ship on the same branch as a second PR.

Constraints (non-negotiable):
- russell2k path only; do NOT touch sp500 or analyst scoring
  formulas
- do NOT touch recovery/reinvoke/sweep code (PR #51 territory)
- do NOT touch the 10 analyst files or analyst-runner
- if you add a temporary diagnostic endpoint to read the 49
  warnings, remove it before W2 merges
- final fix PR opens ready-for-review, not draft
- the in-flight sp500 backtest (bt_20260519233423_avaa64) uses
  deployed code on each reinvoke — verify your fix's blast radius
  before merging

If commits fail from /home/claude/TradeIQ, relocate to
/home/user/TradeIQ. Start with PART 1 once you've read both files.
~3-7 hour session total (W1 is the gate; pace yourself).
