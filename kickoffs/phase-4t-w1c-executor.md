# Phase 4t W1c Executor Kickoff — chronic-silent analysts (earnings + insider) PIT defect

> **For Chad:** paste the bootstrap block at the end of this file into
> a fresh Claude chat. The PAT is embedded inline. This is its own
> executor agent — NOT the 4t W1b agent (PR #52, russell2k) and NOT
> the 4t W2/W3 PR #49 agent. W1c works on a separate branch and
> separate problem.

---

You are an executor agent. Your single assignment is **Phase 4t W1c**
of the TradeIQ project. The full brief is at
`briefs/phase-4t-w1c-brief.md` in the repo. Read this kickoff
end-to-end, then read the brief, then start with PART 1.

**Scope discipline (read twice):**

- You diagnose and fix two analysts' PIT data paths: **earnings** and
  **insider**. Nothing else.
- You do NOT touch any other analyst's fetch or scoring (technical,
  sector-rotation, flow, fundamental, news, macro, political,
  patents).
- You do NOT touch the russell2k universe-resolution path — PR #52
  (W1b, separate agent) owns that.
- You do NOT touch recovery / reinvoke / sweep code — PR #51
  (4t-recovery) owns that.
- You do NOT redesign the earnings analyst's scoring math
  (`runEarnings`). That's the planned Phase 4v — pending 4t verdict.
  W1c only fixes the existing PIT *data path* so it behaves like the
  live data path.
- You do NOT change configs on PR #49's branch.
- You do NOT write the 4t verdict report.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. A React/Vite SPA backed by
TypeScript Netlify functions and Firestore. The target board scores
stocks with a ten-analyst composite. Phase 4t backtests this composite
out-of-sample to produce a verdict. Owner: Chad Davis.

## What Phase 4t W1c is

A coverage-trend analysis on the completed sp500 backtest run
(`bt_20260519233423_avaa64`, 1,662 attribution rows) revealed that:

- **earnings analyst** is 100% silent in every year 2018-2024
- **insider analyst** is 70-98% silent in every year 2018-2024

The same analysts return rich signals when called *live* via
`GET /api/target-rationale?ticker=X` (NVDA earnings: "earnings in 0d,
de-rated, 4/4 beats"; NVDA insider: "$163.7M net sells"). The bug is
upstream of the analyst scoring math — in the data fetch / provider
call / PIT cache layer that's invoked when `asOfDate` is a historical
date.

This is NOT a provider historical-archive cliff (fundamental and news
have that pattern; W1c is not addressing those). The chronic
year-uniform silence on earnings + insider is a code or wiring defect.

W1c diagnoses and fixes it. The deliverable shape is: earnings PIT
calls return scoring data (not `_noData`) for historical dates where
data is known to exist, matching the live behavior.

## The W1 gate — diagnose-before-fix is non-negotiable

PR #51 (4t-recovery) shipped a hypothesis for russell2k and was wrong.
PR #52 (W1b) is on this branch model for the same reason. W1c follows
the same discipline.

W1 (this branch's first PR) ships only `reports/phase-4t-w1c/diagnosis.md`
with the named root cause. Orchestrator reviews. Only after authorisation
do you write the W2 fix + W3 regression test as a follow-up.

If you find yourself wanting to fix something before you've named the
root cause in writing, stop — that's the failure mode this gate exists
to prevent.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -5
git config user.email "executor-4t-w1c@tradeiq.local"
git config user.name "Executor 4t W1c"

npm ci    # if it fails on cross-platform optional deps: npm install
npx tsc --noEmit
npm test
npm run build

git checkout -b phase-4t-w1c-chronic-silent-analysts
```

If baseline fails, STOP and report. Do NOT bump APP_VERSION on the
W1 diagnosis-only PR — it's a report. APP_VERSION gets bumped on the
W2+W3 fix PR.

**Environment note:** if commits fail from `/home/claude/TradeIQ`,
relocate to `/home/user/TradeIQ` or `/tmp`.

Read `briefs/phase-4t-w1c-brief.md` after this kickoff. The brief
has the full evidence catalog (per-year silence-rate table, code
excerpts of the target board PIT dispatch, live-coverage probe
results, and the two specific repro target pairs).

**Secrets:** GitHub PAT in the clone URL above. The deployed Netlify
functions have the data-provider API keys (Polygon, Finnhub, Quiver).
For local diagnostic scripts that need to hit the providers directly,
ask the orchestrator — do NOT paste service keys anywhere. The
preferred diagnostic path is via deployed endpoints or by inspecting
already-cached Firestore entries.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key files

The bug is in the PIT data path for earnings + insider. Likely
suspects (read-only unless your diagnosis names them as the fix site):

- `netlify/functions/shared/backtest/score-at-date.ts` —
  `scoreTargetAtDate` (line 524). The dispatcher that calls the
  provider fetches with `asOfDate` and then runs the analysts.
- `netlify/functions/shared/data-provider.ts` — `getEarningsHistory`,
  `getUpcomingEarnings`, plus other PIT-aware fetches.
- `netlify/functions/shared/earnings-intel.ts`
- `netlify/functions/shared/insider-provider.ts` — `getInsiderActivity`
- `netlify/functions/shared/analyst-runner.ts` — the *live* path that
  works. Compare against PIT.
- `netlify/functions/analysts/core.ts` — `runEarnings`. Read-only.
- `netlify/functions/analysts/insider.ts` — `runInsider`. Read-only.
- `reports/phase-4t/pit-audit.md` — the 4t W1 agent's PIT classification.
- The pit-cache module wherever `pitCacheWrap` is defined — verify
  cache key shape, look for cache-miss → null silently.

## 2.2 Files you may modify (W2; not W1)

W1 (first PR) commits ONLY:
- `reports/phase-4t-w1c/diagnosis.md` (new)

W2 + W3 (second PR after diagnosis review):
- The named root cause files — minimum diff.
- New regression test(s).
- `src/App.jsx` — APP_VERSION bump (W2 only, not W1).

## 2.3 Files you may NOT modify (any workstream)

- Any analyst OTHER than the earnings + insider data paths.
- `analysts/core.ts` `runEarnings` scoring math (it's correct — live
  proves it).
- `analysts/insider.ts` `runInsider` scoring math (same).
- Recovery / reinvoke / stuck-run sweep (PR #51 territory).
- W1b russell2k path on PR #52 — separate agent.
- PR #49 configs.
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`.

---

# PART 3 — W1 WORK (diagnosis only)

## W1.a — Reproduce the bug for earnings

Pick the **NVDA / 2020-06-30** target pair from the brief, or find
your own verified ticker-date pair where data is known to exist.

For your repro, you may use ANY of the following approaches (pick
one — do not escalate scope):

1. **Local Node script** importing the data-provider modules directly
   and calling them with your repro inputs. Fastest if you have
   credentials in env.
2. **Temporary diagnostic endpoint** — extend
   `/api/target-rationale` to optionally accept `?asOfDate=YYYY-MM-DD`
   and run `scoreTargetAtDate` instead of `runAnalystsForTicker`. **If
   you go this route, mark the new behavior clearly as temporary and
   remove it before W2 merges.** It must NOT ship in the final fix
   PR. Or — alternative — keep it as a permanent, gated diagnostic
   path (orchestrator's call at review time).
3. **Direct Firestore read** via the admin SDK on existing cached
   `pitCache` entries for an existing run.

Document, in the diagnosis report:
- Call: `getUpcomingEarnings('NVDA', 45, { asOfDate: '2020-06-30' })`
  → return value + any thrown error.
- Call: `getEarningsHistory('NVDA', 4, { asOfDate: '2020-06-30' })`
  → return value.
- Call: `runEarnings(upcoming, history)` → output (`score`,
  `direction`, `signals._noData`, `signals._reason`).

## W1.b — Same for insider

Repro: `getInsiderActivity('NVDA', 90, { asOfDate: '2020-06-30' })`.
Document return value and `runInsider` output.

## W1.c — Trace the live vs PIT divergence

For each affected analyst, what does the *live* fetch path do
differently from the PIT fetch path? Read the provider
implementations and quote the exact diverging line(s):

- Does `getUpcomingEarnings` build the request URL differently when
  `asOfDate` is passed vs not?
- Does it apply the filter on the provider side, or only client-side?
- Does the provider return data on the live URL for NVDA today that
  it does NOT return on the PIT URL for NVDA at 2020-06-30 (or
  whatever your repro date is)?
- Same questions for `getInsiderActivity`.

The contract from the live test: `getInsiderActivity('NVDA')` (live,
no asOfDate) returns data that produces score 40. The same call with
`{ asOfDate: <historical> }` returns null/empty.

## W1.d — Probe the `.catch(() => null)` swallow

In `score-at-date.ts:scoreTargetAtDate`, every PIT fetch has
`.catch(() => null)`. This silently turns provider errors (rate
limits, malformed responses, network blips) into null, which then
becomes `_noData`. For at least one of the two analysts, run a small
batch of PIT calls with the catch replaced by logging — are the
providers *throwing* or *returning empty*? This distinguishes a
provider bug from a TradeIQ wiring bug.

The 4t-recovery PR established the always-stamp-telemetry pattern.
The diagnostic equivalent here: when the catch fires, *record what
got swallowed*. Your W2 fix may include keeping this logging
permanently (Sentry breadcrumb or structured warning) so future
incidents are diagnosable.

## W1 deliverable

`reports/phase-4t-w1c/diagnosis.md` with these sections (use this
structure verbatim so the orchestrator review is fast):

```markdown
# Phase 4t W1c — diagnosis

## Summary (one paragraph; named root cause)

## Earnings — evidence
- Repro (ticker, date, return values, thrown errors if any)
- Provider trace (`getUpcomingEarnings`, `getEarningsHistory` —
  with-asOfDate vs without)
- Where the divergence happens (file, line, function)
- Named root cause

## Insider — evidence
- Repro
- Provider trace (`getInsiderActivity` — with-asOfDate vs without)
- Where divergence happens
- Named root cause

## Are the two related?
(Could be a single shared bug, e.g. asOfDate parameter not threaded
to the provider HTTP layer. Or two independent bugs. Say so honestly.)

## Proposed fix
- For earnings: 1-2 specific named changes (file:line + one-sentence
  description)
- For insider: 1-2 specific named changes
- Estimated diff size

## Confidence
(High / medium / low + what could still be wrong)

## Things to verify before W2 lands
(your own pre-W2 checklist)
```

Open the W1 PR as a draft on `phase-4t-w1c-chronic-silent-analysts`
with only the diagnosis report committed. Hand off to the
orchestrator. Wait for review.

---

# PART 4 — W2 + W3 WORK (only after W1 review)

## W2 — Fix

Smallest diff per the named root cause. Constraints:

- Earnings + insider data paths only. If the fix candidate touches
  any other analyst's behavior, STOP and surface to the orchestrator
  before merging.
- Do not modify `runEarnings` or `runInsider` scoring math.
- The `.catch(() => null)` pattern: if you keep silent-fallback for
  release-safety, at minimum log the error (Sentry breadcrumb or a
  structured warning written to the rebalance warnings collection) so
  future incidents are diagnosable. The 4t-recovery PR's
  "always-stamp-telemetry" pattern is the precedent.

## W3 — Test

Regression test(s) in
`netlify/functions/shared/backtest/__tests__/` (or wherever the
analyst tests live):

- Calls the earnings PIT path for a known-good (ticker, date) pair.
  Asserts non-`_noData` output with reasonable score / direction
  values.
- Same for insider.
- Mock the provider HTTP layer if needed — use the real provider
  contracts; the test is for the *wiring*, not the network.
- Test(s) MUST fail without the W2 fix and pass with it. Mirror the
  4t-recovery `run-backtest-background.reinvoke-instrumentation.test.ts`
  pattern (7/8 fail without fix).

## After W2 + W3

Mark the PR ready-for-review (NOT draft). One commit per workstream
or squashed sensibly. APP_VERSION bumped one patch. Open the PR.

---

# PART 5 — CONVENTIONS

- One branch (`phase-4t-w1c-chronic-silent-analysts`), two PRs in
  sequence (W1 diagnosis → reviewed → W2+W3 fix on the same branch).
  Or: W1 ships as PR-A merged quickly, then W2+W3 is PR-B from the
  same branch. Either is fine; orchestrator will direct.
- `strict: true` TypeScript.
- Honest reporting throughout. The diagnosis is a real engineering
  document, not a sales pitch.
- No new analyst data sources, no new external API integrations.

---

# PART 6 — HAND-OFF FORMAT

After W1 (diagnosis-only PR open):

```
PHASE 4t W1c — W1 diagnosis PR #N open (draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Diagnosis: reports/phase-4t-w1c/diagnosis.md
  Earnings root cause:  <one sentence — named function + named failure>
  Insider root cause:   <one sentence — named function + named failure>
  Related? <yes/no + reasoning>

  Proposed fix:
    earnings: <one-line>
    insider:  <one-line>
  Confidence: <high / medium / low + what could still be wrong>

Standing by for orchestrator review. Will NOT proceed to W2 until
the diagnosis is authorised.
```

After W2 + W3 (fix PR open):

```
PHASE 4t W1c — fix PR #M open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/M

W2 fix:
  - earnings: <named file>:<line> — <one-line summary>
  - insider:  <named file>:<line> — <one-line summary>
  - APP_VERSION <current> → <bumped>

W3 test:
  - <test file>: <what it asserts>
  - fails-without-fix verified: <N> of <N> assertions fail
  - all existing tests still pass: <count>

Verification: tsc clean / build clean / no analyst-scoring changes /
no W1b or PR #51 territory touched.

Acceptance: DEFERRED to orchestrator review + merge + post-merge
sp500 re-fire validation.
```

---

# PART 7 — FAILURE MODES TO AVOID

- **Shipping a fix without naming the root cause first.** This is
  exactly the failure mode the W1 gate exists to prevent. PR #51 did
  this on russell2k. PR #52 is following this gate for the same
  reason.
- **Touching analysts other than earnings and insider.** Out of scope
  and high-risk for unrelated regressions.
- **Redesigning `runEarnings` scoring math.** That's the planned
  Phase 4v overhaul (pending 4t verdict). W1c only fixes the data
  feeding it.
- **Leaving a temporary diagnostic endpoint in the merged PR.** If
  you add `?asOfDate=` to `/api/target-rationale` for diagnosis,
  remove it before W2 ships — unless the orchestrator authorises
  keeping it as a permanent gated diagnostic capability.
- **Confusing W1c with Phase 4v.** They share the word "earnings" but
  have different scopes. W1c = fix the existing PIT path to feed the
  existing analyst. 4v = redesign the analyst's scoring math
  (separate phase, separate planning, separate brief — pending 4t
  verdict).
- **Touching PR #52 / russell2k coverage.** That's a separate agent.
- **Opening the W2 fix PR as a draft.** Final fix PR is
  ready-for-review.
- **Declaring victory inside the agent session.** Orchestrator
  validates the cure via post-merge sp500 re-fire — earnings silence
  must drop from 100% to <30% in 2020+ years, and insider from
  >85% to <40%. Don't claim "fixed" until that validation lands.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4t W1c of the TradeIQ project at
DavisDelivery/TradeIQ. This is its own phase — you do 4t W1c only.
The 4t W1b agent is working PR #52 (russell2k universe coverage) on a
separate branch; the 4t W2/W3 PR #49 is in orchestrator hands; you do
not interact with either.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4t-w1c-executor.md — your full assignment —
   then read briefs/phase-4t-w1c-brief.md (the substance).

The summary: the completed sp500 composite backtest
(bt_20260519233423_avaa64) shows the earnings analyst is 100% silent
in EVERY year 2018-2024 and the insider analyst is 70-98% silent
every year — uniform across years, NOT a historical-cliff pattern.
The same analysts return rich rationales when called live via
GET /api/target-rationale?ticker=X (NVDA earnings: "earnings in 0d,
de-rated, 4/4 beats"; NVDA insider: "$163.7M net sells"). The bug
is upstream of the analyst scoring math — in the data fetch / PIT
provider call / cache layer that fires when `asOfDate` is a
historical date. This is NOT a provider historical-archive cliff
(fundamental and news have that pattern; W1c does not address them).
The chronic year-uniform silence is a code or wiring defect.

W1 (this branch's first PR) ships only
`reports/phase-4t-w1c/diagnosis.md` with the named root cause for
each affected analyst. DO NOT write fix code until the orchestrator
reviews the diagnosis — PR #51 shipped a hypothesis and was wrong;
we are not repeating that. After W1 authorisation, W2 (fix) + W3
(regression test that fails without the fix) ship on the same branch
as a second PR.

Constraints (non-negotiable):
- earnings + insider data paths only; do NOT touch other analysts
- do NOT redesign runEarnings or runInsider scoring math (that's
  Phase 4v, pending 4t verdict)
- do NOT touch recovery / reinvoke / sweep code (PR #51 territory)
- do NOT touch the russell2k path or PR #52
- if you add a temporary diagnostic asOfDate param to
  /api/target-rationale, remove it before W2 ships (or surface to
  orchestrator to keep as a permanent gated path)
- final fix PR opens ready-for-review, not draft
- match live behavior as the success criterion — PIT call for
  (NVDA, 2020-06-30) should produce same scoring shape as live
  NVDA call does today

Two specific repro target pairs in the brief:
- NVDA on 2020-06-30 (Q1 FY20 reported 2020-05-21; Q2 FY20 on
  2020-08-19; insider Form 4 activity in window)
- AAPL on 2022-03-31 (Q1 FY22 reported 2022-01-27; Q2 FY22 on
  2022-04-28)

If commits fail from /home/claude/TradeIQ, relocate to
/home/user/TradeIQ. Start with PART 1 once you've read both files.
~4-7 hour session total (W1 is the gate; pace yourself).
