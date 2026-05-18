# Phase 4s — Composite scoring integrity fix

**Author:** orchestrator (CTO + CFO combined voice — house style)
**Target version:** patch bump; **MODEL_VERSION must bump** — this
changes every pick's score.
**Priority:** HIGH. The live target board's core output is wrong.
**Dependencies:** none blocking. Surgical fix in one function.
**Parallel-with:** does not share files with 4r — can run alongside it.
But the fix itself should ship FAST; it is small.
**Estimated effort:** one executor agent session, ~2–3 hours — most of
it in W1 (getting the contract right) and W3 (verification), not lines
of code.

---

## Executive summary — the decision and the ask

Chad opened the O-I Glass (OI) detail panel and asked the right
question: *"How does this score a 92 with all these that bad?"*

He is correct, and it is not a display glitch. OI is rated **Composite
92, Tier A, Direction LONG** while **5 of its 7 active analysts are
bearish on it** (Technical 28, Sector 16, Fundamental 28, Flow 45,
News 28 — versus Insider 100). An honest weighted blend of those
contributions lands near **42**, not 92.

The cause is a real bug in the composite-scoring math in
`analyst-runner.ts`, and because that function scores **every** target-
board pick, the entire board's composite, A/B/C tier, and LONG/SHORT
label are unreliable. A stock the models hate is being presented
identically to one they love.

Phase 4s fixes it. The change is small and surgical — roughly ten lines
in one function — but it must be done with care, because getting the
directional math right depends on the analyst score/direction contract.
The cost of *not* fixing it is that TradeIQ's core product output is
wrong. Approve, and ship it ahead of slower work.

---

# PART I — THE PROBLEM

### What Chad saw

The OI detail panel: Composite **92**, Tier **A**, **LONG**, conflict
not surfaced. Contributions: Technical 28, Sector 16, Fundamental 28,
Flow 45, News 28 (all red — bearish), Earnings 50 (no data), Insider
100 (green — bullish), Political 50 (neutral), Macro/Patents removed.

Five of the seven contributing analysts are bearish. One (Insider) is
strongly bullish. The honest read of that profile is *mildly bearish to
neutral* — certainly not a 92/A/LONG.

### The bug — `netlify/functions/shared/analyst-runner.ts` (~lines 228-241)

```js
const signed = a.direction === 'long'  ? a.score - 50
             : a.direction === 'short' ? -(a.score - 50)
             : 0;
netRaw += signed * w * a.confidence;
...
const signedNet = confTotal > 0 ? netRaw / confTotal : 0; // -50..+50
const composite = Math.round(Math.min(100, Math.max(0,
                    50 + Math.abs(signedNet) * 1.5)));
const tier = composite >= 85 ? 'A' : composite >= 70 ? 'B' : 'C';
```

**Three compounding defects:**

1. **`Math.abs(signedNet)`** — the composite discards the sign of the
   net signal. A coherently bullish stock (`signedNet ≈ +40`) and a
   coherently bearish stock (`signedNet ≈ -40`) both yield `composite ≈
   100`. The composite measures *conviction magnitude*, not
   *bullishness*.

2. **The `signed` formula.** Analyst scores are a 0–100 bullishness
   scale — 50 neutral, high = bullish, low = bearish (the UI confirms
   it: 28 renders red, 100 green, 50 grey). For a bearish analyst —
   `direction: 'short'`, low score — the formula computes `-(28 − 50) =
   +22`, a *positive* contribution. So bearish analysts push `signedNet`
   *toward long*. OI's five bearish analysts and its one bullish analyst
   all push `signedNet` the same way; it stacks to a large value and the
   `abs()` keeps it large.

3. **`tier` ignores conflict.** `tier` is derived purely from the
   (magnitude) `composite`. The code *correctly* computes
   `conflictLevel` — OI is `'severe'` (5 analysts disagree with the net
   direction) — but that flag applies no penalty to tier or composite.
   A severe-conflict stock sails through as an A.

Net result for OI: `signedNet` resolves positive, `composite = 50 +
|signedNet|×1.5 ≈ 92`, `direction = long`, `tier = A`. Every one of
those is wrong. The only thing the code gets right is detecting the
severe conflict — and then it ignores its own finding.

---

# PART II — CURRENT-STATE ASSESSMENT (CTO)

- The defect is entirely inside the composite block of
  `netlify/functions/shared/analyst-runner.ts` (~lines 228-241):
  the per-analyst `signed` formula, the `Math.abs()`, and the `tier`
  derivation.
- `direction` (the pick's overall long/short, ~line 240) is derived
  from `sign(signedNet)`. Once defect 2 is fixed and `signedNet`
  carries the correct sign, this line becomes correct *for free* — but
  it must be re-verified.
- `topSignals` and `buildRationale` consume the pick `direction`; they
  self-correct once `direction` is right. No separate fix.
- `conflictLevel` is computed correctly already — the fix is to make
  the composite/tier *respond* to it.
- **The analyst score/direction contract is the crux.** The fix is only
  correct if it matches what the analysts actually emit — see PART IV
  W1 and PART V.

---

# PART III — FINANCIAL ANALYSIS (CFO)

Short, because the economics are one-sided.

- **No run cost, no tokens.** This is a math fix in existing code.
- **Build cost:** one agent session, ~2–3 hours.
- **The cost of the bug:** the target board is TradeIQ's primary
  surface. Right now it can rate a broadly-disliked stock as a
  top-tier A LONG. Acting on that output — logging a trade, sizing a
  position — is acting on a wrong signal. There is no scenario where
  this is not worth fixing immediately.

Approve; expedite.

---

# PART IV — PROPOSED SOLUTION (CTO)

One PR. Three workstreams, order **W1 → W2 → W3**.

### W1 — Establish the analyst score/direction contract

Before changing the formula, **confirm what the inputs mean.** Read the
analyst implementations (`netlify/functions/analysts/*.ts` and any
style scorers feeding the composite) and document precisely:

- What does an analyst's `score` represent — bullishness on a 0–100
  scale (50 neutral)? Or conviction strength in the called direction?
  The UI coloring (28 red, 100 green, 50 grey) and the radar strongly
  indicate **bullishness**, but confirm it in the code.
- What does `direction` represent, and **can `score` and `direction`
  diverge** for a given analyst (e.g. a score of 60 with
  `direction: 'neutral'`)? The correct formula depends on this.
- Record the finding in a short `reports/phase-4s/contract.md`. The W2
  formula must be provably consistent with it.

### W2 — Make the composite directional and conflict-aware

Given the W1 contract, fix the three defects so the composite is an
honest directional score:

- **The composite must be directional** — bullish picks score high,
  bearish picks score low, a genuinely neutral pick sits near 50.
  Remove the `Math.abs()`. With a correctly-signed `signedNet`,
  `composite = clamp(50 + signedNet × k, 0, 100)` yields the full
  0–100 directional range.
- **`signed` must place every analyst on one bull-bear axis** — a
  bearish analyst contributes negative, a bullish analyst positive,
  regardless of its `direction` label. If the W1 contract confirms
  `score` is bullishness, `signed = score − 50` for every analyst is
  the natural form (direction stops gating the sign). If W1 finds a
  different contract, derive the formula to match it — but the outcome
  is non-negotiable: bearish analysts must drag the composite *down*.
- **Conflict must affect the result.** A pick with `conflictLevel`
  `severe` (or `moderate`) must not present as a confident A. Apply a
  conflict treatment — cap the tier and/or dampen the composite toward
  neutral (see PART IX for the decision). A board full of analysts
  disagreeing with each other is not an A.
- **Re-verify `direction`** (~line 240) — once `signedNet` is correctly
  signed, confirm long/short/neutral comes out right.

### W3 — MODEL_VERSION bump, regression test, verification

- **Bump MODEL_VERSION** — the fix changes every pick's score; the
  version bump is what makes the snapshot/cache layer invalidate
  correctly. Bump APP_VERSION one patch too.
- **Add a regression test** anchored on OI's exact profile: a pick with
  ~5 bearish analysts and 1 strongly-bullish analyst must produce a
  composite **below 50**, a tier that is **not A**, and a direction
  that is **not long**. This locks the bug shut.
- Also test a coherently-bullish profile (composite high, tier A,
  long) and a coherently-bearish one (composite low, direction short)
  to confirm the full directional range works.
- Note in the PR that after merge + deploy, the target-board scans must
  re-run for the corrected scores to appear on the board (the fix does
  not retroactively rewrite stored snapshots) — the orchestrator
  handles the re-scan and the live OI check at acceptance.

---

# PART V — ARCHITECTURE & SCOPE DETAIL (CTO)

### The contract is the crux — diagnose before formula

Do not guess the formula. The symptom is unambiguous (bearish stock →
high composite) and the required outcome is unambiguous (directional
composite), but the *exact* formula depends on the score/direction
contract. W1 establishes it; W2 implements to it. This is the same
diagnose-before-fix discipline used on the russell2k scan chain.

### Blast radius — every pick, and a required re-scan

This changes the composite, tier, and direction of every target-board
pick. Stored snapshots were computed with the broken formula and are
all wrong; they do not self-correct. The MODEL_VERSION bump invalidates
caches, and the target-board scans must re-run post-deploy to publish
corrected snapshots. The orchestrator drives that re-scan at acceptance.

### Check for a duplicated formula

Confirm the composite formula is not copy-pasted into another scoring
path — in particular, check whether `score-at-date.ts` (the backtest
point-in-time scorer) or any other module reuses the same
`50 + abs(...)` shape. If it does, fix it there too, consistently. If
the backtest path is a separate scorer (Prophet has its own layers),
4s is target-board-only — but verify, don't assume.

### Out of scope

- How the board *displays* SHORT-direction picks once they start
  appearing honestly (the fix will produce real SHORT picks and far
  fewer A's — that is the fix working, not a regression). Display
  treatment of shorts is a separate follow-up.
- The analyst scoring logic itself — the individual analysts are not in
  question here; the composite that blends them is.

---

# PART VI — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Formula fixed without confirming the score/direction contract | Medium | A different wrong formula | W1 establishes the contract first; W2 must be provably consistent with it. |
| R2 | The fix is mistaken for a regression — board looks very different (fewer A's, SHORT picks appear) | High | Confusion | This is the fix working. Note it explicitly in the PR; the regression tests assert the new, correct behavior. |
| R3 | The buggy formula is duplicated elsewhere and only one copy is fixed | Medium | Inconsistent scores | W2/PART V: grep for the formula shape; fix all copies. |
| R4 | MODEL_VERSION not bumped → stale cached snapshots keep showing wrong scores | Medium | Bug appears unfixed | W3 bumps MODEL_VERSION; orchestrator re-scans at acceptance. |
| R5 | Conflict treatment is arbitrary | Low–Medium | Tier still feels off | PART IX decision; regression test on the OI severe-conflict profile. |

---

# PART VII — ACCEPTANCE CRITERIA

1. **The OI test:** a pick with OI's profile (~5 bearish analysts +
   1 strongly-bullish analyst) produces a composite **< 50**, a tier
   **≠ A**, and a direction **≠ long**.
2. The composite is directional across the full range — a coherently
   bullish pick scores high (tier A, long); a coherently bearish pick
   scores low (direction short); a neutral pick sits near 50.
3. A `severe`/`moderate` `conflictLevel` pick cannot present as a
   confident A (per the PART IX conflict treatment).
4. `direction` (long/short/neutral) is correct as a consequence of the
   corrected `signedNet`.
5. MODEL_VERSION bumped; regression tests cover the OI profile and the
   coherent bullish/bearish profiles.
6. `tsc --noEmit` clean, full suite green, `npm run build` clean.
7. `reports/phase-4s/contract.md` documents the score/direction
   contract the fix was built against.

**Orchestrator post-merge:** re-run the target-board scans; confirm OI
on the live board is no longer 92/A/LONG.

---

# PART VIII — ROLLOUT PLAN

1. One PR (ready-for-review, not draft) — W1 contract + W2 fix + W3
   version/tests. Orchestrator reviews; the specific review focus is
   that the formula is consistent with the documented contract and the
   OI test genuinely fails the old behavior.
2. Merge (confirm `merged: True` before branch delete). Netlify
   deploys.
3. Orchestrator re-runs the target-board scans so corrected snapshots
   publish; verifies OI live (no longer A/LONG/92) and spot-checks a
   few other picks.
4. ORCHESTRATOR.md — 4s done.

Rollback: a normal revertible PR. (Reverting restores the broken
scores, so the bar for the fix being right is the regression tests +
the live OI check.)

---

# PART IX — OPEN DECISIONS FOR CHAD

One real decision; the rest of the fix outcome is determined.

1. **How should analyst conflict affect the score?** When
   `conflictLevel` is `severe` (≥3 analysts disagree with the net
   direction) or `moderate` (2):
   - (a) **Cap the tier** — severe → max C, moderate → max B; leave
     the composite number alone.
   - (b) **Dampen the composite** — pull it toward 50 by a
     conflict-scaled factor, so the tier follows naturally.
   - (c) **Both** — dampen the composite *and* cap the tier.
   *Recommendation: (c). A stock with five analysts fighting each other
   is genuinely low-conviction; both the number and the grade should
   say so. (a) alone leaves a misleadingly high composite next to a
   capped tier.*

(Whether the board should prominently surface SHORT-direction picks,
now that the fix will produce real ones, is a separate product
question — noted as a follow-up, not part of 4s.)

---

*End of brief. Phase 4s fixes a real, board-wide scoring-integrity bug:
the composite is being computed as a magnitude, so the target board
cannot tell a stock the analysts love from one they hate. The fix is
small and surgical — but it must be built against the confirmed
analyst contract, and it changes every score on the board.
Recommendation: approve and expedite.*
