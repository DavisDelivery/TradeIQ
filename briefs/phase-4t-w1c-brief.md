# Phase 4t W1c — chronic-silent analysts (earnings + insider) PIT defect

> **For the executor:** this brief is your full assignment. Read it
> end-to-end before any code. The companion kickoff at
> `kickoffs/phase-4t-w1c-executor.md` is your paste-and-go boot prompt.

## TL;DR

The 4t composite sp500 backtest just completed (`bt_20260519233423_avaa64`).
A coverage-trend analysis on its 1,662 attribution rows revealed two
distinct problems:

- **Historical cliffs** on fundamental (silent 2018-2021, active 2022+) and
  news (silent 2018-2020, active 2021+). These are real provider-archive
  limits — Polygon's historical coverage matured at those dates.
- **Chronic 100%/95% silence** on **earnings** and **insider** in EVERY
  year of the backtest — including years where the same analysts return
  rich rationales when called *live*. This is not a coverage problem.
  It is a code or wiring defect in the PIT path that the live path does
  not hit.

W1c diagnoses and fixes the chronic silence. Earnings is the higher
prize (100% silent across 7 years on a critical signal that
demonstrably works live). Insider second (chronic 70-98% silent).

This phase exists because the "ten-analyst composite" has never been
tested at full strength — in practice the sp500 backtest ran on 3
active factors (2018-2021) or 5 (2022-2024). The negative-IC verdict
was measured on a crippled composite. Fixing W1c's targets brings the
2022-2024 window to 7 active factors — a meaningfully different test.

---

## Context

### What's already shipped

- **Phase 4t W1** (PR #48, merged): added the PIT scoring path for the
  ten-analyst target composite. The PIT audit at
  `reports/phase-4t/pit-audit.md` classified each analyst's expected
  PIT behavior. All four chronic/erratic analysts here (earnings,
  insider, political, macro) were classified as PIT-clean or
  PIT-with-caveat — i.e., the agent expected them to work.
- **Phase 4t-recovery** (PR #51, merged): made the backtest engine
  reliable (jitter, telemetry, stuck-run sweep).
- **Phase 4q** (PR #50, merged): added the on-demand per-ticker
  rationale endpoint `/api/target-rationale?ticker=X`. **This is the
  diagnostic tool you will use most.** It calls the same analyst
  modules as the backtest but with `asOfDate = now` (live).

### What's NOT this phase

- **Phase 4t W1b** (PR #52 open, draft, in another agent's hands):
  russell2k UNIVERSE_HISTORY coverage gap. Different bug. **Do not
  touch.** The russell2k backtest is currently dead at idx 48; that
  agent is fixing the universe-resolution refusal.
- **Fundamental and news historical cliffs** — those are real provider
  archive limits (Polygon's data simply didn't exist before ~2021/2022
  for those classes). Not a code bug. Out of scope.
- **Patents** — intentionally `weight = 0` per the 4f audit
  (`no_upstream`). Working as designed.
- **Political** — chronic-erratic (49-88% silent across years) but
  driven by Quiver coverage + STOCK Act 45-day shift. Different
  pattern; out of scope for W1c.
- **Macro** — erratic across years (25-85% silent depending on the
  regime that year). Market-wide signal; behaves differently. Out of
  scope.
- **The 4t verdict report**, **the russell2k backfill decision**, and
  **Phase 4v (earnings factor *overhaul*)** are all separate
  workstreams. W1c is *specifically* fixing the existing PIT path so
  it behaves like the live path; it is NOT redesigning the earnings
  analyst.

---

## The evidence

### Silence rate by year, per analyst (from sp500 backtest attribution)

```
analyst              2018    2019    2020    2021    2022    2023    2024
─────────────────────────────────────────────────────────────────────────
technical             0%      0%      2%      0%      1%      0%      1%
sector-rotation       7%      3%      5%      6%      3%      2%      5%
flow                 12%     11%     13%     10%     10%     14%     11%
fundamental         100%*   100%*   100%*    89%*    47%.    14%     18%      ← historical cliff (out of scope)
news                100%*   100%*    87%*    37%.    24%     18%     30%.     ← historical cliff (out of scope)
macro                58%.    42%.    25%     75%.    24%     85%*    83%*     ← out of scope
political            78%.    88%*    80%.    68%.    49%.    64%.    62%.     ← out of scope
─────────────────────────────────────────────────────────────────────────
earnings            100%*   100%*   100%*   100%*   100%*   100%*   100%*     ← TARGET #1 — chronic
insider              92%*    98%*    70%.    95%*    87%*    88%*    90%*     ← TARGET #2 — chronic
─────────────────────────────────────────────────────────────────────────
patents             100%*   100%*   100%*   100%*   100%*   100%*   100%*     ← intentional weight=0, out of scope

* = ≥80% silent  . = 30-80% silent  blank = <30% silent
```

The diagnostic signal: earnings and insider are **not** historical-cliff
patterns (which would show a transition year). They are **uniformly
silent** across all 7 years. That cannot be a provider archive issue —
the data exists for these years.

### Live-coverage evidence (provider data IS available)

Probing the `/api/target-rationale?ticker=X` endpoint across 23 sp500
tickers showed (today, 2026-05-20):

| analyst | live `_noData` rate | sample live scores |
|---|---|---|
| **earnings** | 26% (mostly real data) | NVDA score=45 short — "earnings in 0d, de-rated, 4/4 beats" |
| **insider** | 0% | NVDA score=40 — "$163.7M net sells"; AAPL score=40 |
| fundamental | 0% | NVDA score=88; AAPL score=70 |
| news | 0% | NVDA score=57; AAPL score=50 |
| technical | 0% | (working) |

The same analyst modules, called with `asOfDate = now`, produce rich
signals. The same modules called with `asOfDate = a historical date`
produce `_noData` for ~all rows. **This is the diagnostic signal**:
live works, PIT doesn't.

### The PIT code path (target board, score-at-date.ts:524 `scoreTargetAtDate`)

```typescript
// Excerpt — full file at netlify/functions/shared/backtest/score-at-date.ts
const [
  fundamentals,
  news,
  upcoming,
  history,
  insiderActivity,
  patentActivity,
  politicalActivity,
  contractActivity,
] = await Promise.all([
  pitCacheWrap<unknown>(
    { provider: 'polygon', dataClass: 'fundamentals', ticker, asOfDate, extra: 'target' },
    () => getFundamentals(ticker, { asOfDate }).catch(() => null),
  ).then(...),
  pitCacheWrap<unknown>(
    { provider: 'polygon', dataClass: 'upcoming_earnings', ticker, asOfDate, extra: 'ahead=45' },
    () => getUpcomingEarnings(ticker, 45, { asOfDate }).catch(() => null),
  ).then(...),
  pitCacheWrap<unknown>(
    { provider: 'finnhub', dataClass: 'earnings_history', ticker, asOfDate, extra: 'lb=4:target' },
    () => getEarningsHistory(ticker, 4, { asOfDate }).catch(() => []),
  ).then(...),
  pitCacheWrap<unknown>(
    { provider: 'finnhub', dataClass: 'insider', ticker, asOfDate, extra: 'lb=90' },
    () => getInsiderActivity(ticker, 90, { asOfDate }).catch(() => null),
  ).then(...),
  // ...
]);

// Then:
const earn = runEarnings(upcoming, history);
const ins: AnalystOutput = insiderActivity
  ? runInsider(insiderActivity)
  : { score: 50, ..., signals: { _noData: true, _reason: 'no_data' } };
```

**The chain:** if `getUpcomingEarnings()` and `getEarningsHistory()`
both return null/empty, `runEarnings` produces `_noData`. If
`getInsiderActivity()` returns null, the wrapper produces `_noData`
without even calling `runInsider`.

**Key suspect: the `.catch(() => null)` on every fetch.** Errors
(rate-limit, timeout, malformed response, provider 4xx/5xx) are
silently turned into null. We cannot tell which silences are "no data
available" versus "transient or systematic provider error."

### The live code path (analyst-runner.ts → `runAnalystsForTicker`)

The live path goes through `runAnalystsForTicker` which the 4q endpoint
exposes via `/api/target-rationale?ticker=X`. It calls the same
analyst modules (`runEarnings`, `runInsider`) but with `asOfDate = now`.
The contrast: live ~100% non-null, PIT ~5-30% non-null for the same
analyst modules. The bug is upstream of the analyst itself — in the
data fetches or the PIT cache or the provider call shape.

### Run identifiers for direct evidence access

- Completed sp500 run: **`bt_20260519233423_avaa64`**
- Run detail endpoint (returns attribution, dailyEquity, trades, etc.):
  `GET /api/backtest-runs/bt_20260519233423_avaa64`
- mlTraining subcollection: `backtestRuns/bt_20260519233423_avaa64/mlTraining/{seqId}` in Firestore. No public read endpoint exists today — if you need to query it, the cleanest move is to add a small read endpoint as part of W1's diagnostic work (or use a one-shot admin SDK script).

### Two specific PIT (ticker, date) targets for your repro

These are sanity-check pairs where data is known to exist:

- **NVDA on 2020-06-30**: NVDA reported FY20 Q1 earnings 2020-05-21 and had FY20 Q2 earnings on 2020-08-19. Both 4-quarter history AND 45-day-forward upcoming should fire. NVDA also had insider Form 4 activity in this window. The earnings analyst should return non-`_noData`. The insider analyst should return non-`_noData`. If they return `_noData`, you've reproduced the bug.
- **AAPL on 2022-03-31**: AAPL Q1 FY22 reported 2022-01-27; Q2 FY22 on 2022-04-28. Same logic.

---

## Workstreams

### W1 — Diagnose (THE GATE; ships as its own PR with diagnosis-only)

You write NO fix code until W1 produces a named root cause and the
orchestrator authorises W2. PR #51 shipped a hypothesis and was wrong;
W1b is on this branch model for the same reason; W1c follows the same
discipline.

#### W1.a — Reproduce the bug for earnings (named ticker, named date)

Pick the NVDA / 2020-06-30 target pair (or another verified pair —
you may use the live endpoint to find one). Call into the earnings
PIT path *somehow* (you decide: a local script importing the module
directly, or a tiny diagnostic addition to the live endpoint that
accepts `?asOfDate=YYYY-MM-DD`, or an admin-SDK Firestore probe of the
existing mlTraining row for that ticker-date).

Document, in the diagnosis report:
- Exact call to `getUpcomingEarnings('NVDA', 45, { asOfDate: '2020-06-30' })` — return value and any thrown error.
- Exact call to `getEarningsHistory('NVDA', 4, { asOfDate: '2020-06-30' })` — return value.
- Exact return from `runEarnings(upcoming, history)` with those inputs.

#### W1.b — Reproduce the bug for insider

Same exercise for `getInsiderActivity('NVDA', 90, { asOfDate: '2020-06-30' })`.

#### W1.c — Trace the difference between live and PIT for both analysts

For each affected analyst, what does the live path do differently?
Live calls `runAnalystsForTicker(ticker)` which internally fetches
data without `asOfDate`. PIT calls the same fetches with `asOfDate`.
Read the provider implementations:

- `netlify/functions/shared/data-provider.ts` → `getFundamentals`, `getEarningsHistory`, `getUpcomingEarnings`, `getNews`
- `netlify/functions/shared/earnings-intel.ts`
- `netlify/functions/shared/insider-provider.ts` → `getInsiderActivity`

Quote the actual code path in each: how does the function build the
request when `opts.asOfDate` is passed vs not? Does it actually apply
the filter on the provider side, or only client-side? Does it return
empty on the same dates the live call returns data for? Where exactly
does the diverge happen?

#### W1.d — Probe the `.catch(() => null)` swallow

For at least one of the two analysts, temporarily replace the catch
with logging (locally or via a one-shot endpoint that doesn't ship)
and run a small batch of PIT calls. Are the providers throwing? If
so, with what error? Or are they returning empty without throwing?
This distinguishes "code bug in the provider" from "provider returns
empty" from "transient API failure."

#### W1 deliverable

`reports/phase-4t-w1c/diagnosis.md` with this structure:

```markdown
# Phase 4t W1c — diagnosis

## Summary (one paragraph; named root cause for earnings + insider separately, or
## a shared root cause if they share one)

## Earnings — evidence
- Repro (ticker, date, return values)
- Provider trace (what `getUpcomingEarnings` does with asOfDate vs not)
- Provider trace (what `getEarningsHistory` does with asOfDate vs not)
- Where the divergence happens (file, line, function)
- Root cause (named)

## Insider — evidence
- Repro
- Provider trace (`getInsiderActivity`)
- Where divergence happens
- Root cause (named)

## Are the two related?
(Could be one shared bug, e.g. a missing asOfDate parameter wiring;
could be two distinct bugs. Say so honestly.)

## Proposed fix
- For earnings: 1-2 specific named changes
- For insider: 1-2 specific named changes
- Estimated diff size

## Confidence
(High / medium / low + what could still be wrong)

## Things to verify before W2 lands
(your own pre-W2 checklist)
```

Open the W1 PR as a draft on branch
`phase-4t-w1c-chronic-silent-analysts`. Hand off. **Wait for
orchestrator review before any W2 work.**

### W2 — Fix (only after W1 review)

Smallest diff per the named root cause. Constraints:

- **Earnings + insider only.** Do NOT touch other analysts' fetch
  paths or scoring logic.
- Do NOT touch the W1b russell2k path or any universe-resolution code.
- Do NOT touch the recovery / reinvoke / sweep code (PR #51 territory).
- Do NOT modify the analyst scoring math (`runEarnings`, `runInsider`).
  This phase fixes the data path that *feeds* them.
- If a fix surfaces that would affect any other analyst's behavior,
  STOP and surface to the orchestrator before merging.
- The `.catch(() => null)` swallow: if you need to keep silencing for
  release-safety, at minimum log the error (Sentry breadcrumb,
  structured warning to the rebalance warnings) so future incidents
  are diagnosable. The 4t-recovery PR established the
  "always-stamp-telemetry" pattern; mirror that discipline here.

### W3 — Test

Regression test(s) that:

- Call the earnings analyst's PIT path for a (ticker, date) pair where
  data is known to exist (NVDA 2020-06-30 or equivalent) and assert
  non-`_noData` output.
- Same for insider.
- Mock the data providers if needed — use the actual provider
  contracts; the test is for the *PIT path wiring*, not the network.
- Test(s) MUST fail without the W2 fix and pass with it. Mirror the
  4t-recovery PR's instrumentation test pattern (7/8 fail without
  fix).
- Existing tests must all still pass.

---

## Acceptance criteria

- W1 diagnosis report on disk; reviewed and authorised before W2.
- W2 fix is surface-only on earnings + insider data paths.
- W3 regression tests fail without the fix and pass with it.
- All existing tests still pass.
- `tsc --noEmit` clean; build clean.
- APP_VERSION bumped one patch on the final fix PR. The W1
  diagnosis-only PR does NOT bump.
- Final fix PR opened ready-for-review (NOT draft).

**Post-merge orchestrator verification** (not the executor's job):
re-fire the sp500 composite backtest. Expect earnings silence to drop
from 100% to <30% in years 2020+; expect insider silence to drop from
>85% to <40% in years 2020+. If silence rates are unchanged, the fix
is wrong and we go back to W1.

---

## Out of scope (explicit)

- Phase 4t W1b's russell2k UNIVERSE_HISTORY work (different agent, in
  flight on PR #52 / branch `phase-4t-w1b-russell2k-pit-defect`).
- Fundamental and news historical cliffs (real provider archive
  limits; not a code bug).
- Patents (intentional weight=0).
- Political and macro analysts (different patterns; not the chronic
  bug this phase targets).
- The 4t verdict report.
- Phase 4v earnings *overhaul* (separate planned phase that
  redesigns the earnings analyst's scoring math; pending 4t verdict).
  **W1c only fixes the existing PIT data path. Do not redesign.**
- New analyst data sources, new external API integrations.

---

## Disciplines

- **Diagnose-before-fix is non-negotiable.** W1 ships as a
  diagnosis-only PR. No fix code in the same hand-off as the
  diagnosis.
- **Honest reporting.** If a hypothesis you try fails, document it.
  If the bug looks different from "PIT data fetch broken" once you
  actually trace the code, say so and the orchestrator re-scopes.
- **Surface-only constraint.** Earnings and insider only. If a fix
  candidate touches anything else, surface it.
- **Test-pin the fix.** Without the regression test, the fix can
  silently regress.
- **Match live behavior as the success criterion.** "PIT call for
  (NVDA, 2020-06-30) returns the same shape as a live call for NVDA
  would today, scaled to the historical date" is the target. Live is
  the contract.
- **In-flight work is untouched.** The sp500 backtest is COMPLETE so
  there's no live run to disturb. But PR #52 (W1b) is on a separate
  branch from a separate agent — do not interact with it.

---

## Reference state

### Phase status this brief assumes

- 4t W1 (PIT path): MERGED, PR #48
- 4t-recovery: MERGED, PR #51
- 4t W2/W3 (configs + analysis script): PR #49 open, in orchestrator hands
- 4t W1b (russell2k coverage gap): PR #52 draft, separate agent
- 4q (clickable rationale): MERGED + VERIFIED, PR #50
- 4u (engine robustness + cursor): MERGED
- 4v (earnings factor overhaul): PLANNED, pending 4t verdict, NOT
  this phase's scope

### Files most likely involved (read-only unless your diagnosis names them as the fix site)

- `netlify/functions/shared/backtest/score-at-date.ts` — `scoreTargetAtDate` (line 524)
- `netlify/functions/shared/data-provider.ts` — `getEarningsHistory`, `getUpcomingEarnings`
- `netlify/functions/shared/earnings-intel.ts`
- `netlify/functions/shared/insider-provider.ts` — `getInsiderActivity`
- `netlify/functions/shared/analyst-runner.ts` — for the live path comparison
- `netlify/functions/analysts/core.ts` — `runEarnings`
- `netlify/functions/analysts/insider.ts` — `runInsider`
- `reports/phase-4t/pit-audit.md` — the original PIT classification
- `netlify/functions/shared/backtest/pit-cache.ts` (or wherever `pitCacheWrap` lives) — verify cache key shape

### Specific evidence anchors

- Completed sp500 run: `bt_20260519233423_avaa64`
- Live endpoint that works: `GET /api/target-rationale?ticker=NVDA`
- Pattern of silence (from attribution): 100% silent earnings every
  year; 70-98% silent insider every year (table above)

### Live endpoint behaviour for the verification

`GET /api/target-rationale?ticker=NVDA` today returns:
- `earnings-analyst: score=45 direction=short rationale="earnings in 0d, de-rated, 4/4 beats"`
- `insider-analyst: score=40 direction=neutral rationale="$163.7M net sells"`

Your fix's success looks like: the same scoring shape for an NVDA PIT
call on a historical date where data is known to exist.

---

## Session size estimate

W1 (diagnosis): 3-5 hours. The bug is upstream of the analyst (in the
data fetch / provider / PIT cache layer); tracing it requires reading
the provider modules and probing the actual fetch behavior.

W2 + W3 (fix + test): 1-3 hours depending on what W1 surfaces.

If W1 surfaces a cause that needs >150 lines of fix code, stop and
surface to the orchestrator before writing — it may need re-scoping.
