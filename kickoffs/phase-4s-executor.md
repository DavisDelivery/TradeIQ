# Phase 4s Executor Kickoff — Composite scoring integrity fix

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a new Claude chat. The GitHub PAT is embedded
> inline; no follow-up needed.

---

You are an executor agent. Your single assignment is **Phase 4s** of
the TradeIQ project. The conversation you are reading is your boot
prompt. Read it end-to-end, then read `briefs/phase-4s-brief.md` in the
repo (full diagnosis), then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app` — a React/Vite SPA backed by
TypeScript Netlify functions and Firestore. Its primary surface is the
**target board**: stocks scored by ~10 analysts, blended into a
0–100 **composite**, an A/B/C **tier**, and a **LONG/SHORT** direction.
Owner: Chad Davis.

## The bug you're fixing (full detail in the brief)

The composite score is computed wrong, board-wide. Chad opened the O-I
Glass (OI) detail panel: it shows **Composite 92, Tier A, LONG** while
**5 of its 7 active analysts are bearish on it** (Technical 28, Sector
16, Fundamental 28, Flow 45, News 28 — vs Insider 100). An honest blend
of those contributions is ~42, not 92.

The cause, in `netlify/functions/shared/analyst-runner.ts` (~lines
228-241), is **three compounding defects**:

1. `composite = 50 + Math.abs(signedNet) * 1.5` — the `Math.abs()`
   discards direction. A stock the analysts love and one they hate both
   score high. The composite measures conviction *magnitude*, not
   bullishness.
2. `signed = direction==='long' ? score-50 : direction==='short' ?
   -(score-50) : 0` — analyst scores are a 0–100 bullishness scale
   (50 neutral; the UI renders 28 red, 100 green). For a bearish
   analyst, `-(28-50) = +22` — a *positive* contribution. Bearish
   analysts push `signedNet` *toward long*.
3. `tier` is derived purely from the (magnitude) composite —
   `conflictLevel` is computed correctly but applies no penalty. A
   severe-conflict pick still grades A.

## Your assignment in one sentence

Make the composite an honest directional score — bullish high, bearish
low, ~50 neutral, conflict-aware — built against the *confirmed*
analyst score/direction contract, with a regression test that locks
the bug shut.

## Chad's settled decision (FINAL — do not re-litigate)

**Conflict treatment: option (c) — both.** A `severe`/`moderate`
`conflictLevel` must BOTH dampen the composite toward neutral AND cap
the tier (severe → max C, moderate → max B). A stock with analysts
fighting each other gets an honest number *and* an honest grade.

## The discipline that is not optional

**Confirm the contract before you touch the formula.** The symptom is
unambiguous and the required outcome is unambiguous — but the *exact*
formula depends on what an analyst's `score` and `direction` actually
mean. W1 establishes that from the code; W2 implements to it. No
guessed formula.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4s@tradeiq.local"
git config user.name "Executor 4s"

npm ci    # if it fails on cross-platform optional deps, fall back to: npm install
npx tsc --noEmit
npm test
npm run build
```

If baseline fails, STOP and report. Bump APP_VERSION one patch in
`src/App.jsx`, and **bump MODEL_VERSION** — this fix changes every
pick's score.

**Environment note:** if commits fail from `/home/claude/TradeIQ`, the
signing server may expect commits from `/home/user/TradeIQ` (or a
`/tmp` path) — relocate the repo and commit from there.

Read `briefs/phase-4s-brief.md` before writing code.

**Secrets:** GitHub PAT (write-scoped) in the clone URL — for `git
push` + `POST /pulls`. The re-scan + live OI verification is post-merge
by the orchestrator.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key existing code

- `netlify/functions/shared/analyst-runner.ts` — the composite scorer.
  The defect is the composite block, ~lines 228-241: the per-analyst
  `signed` formula, the `Math.abs()`, the `tier` derivation. `direction`
  (~line 240) is derived from `sign(signedNet)` — it self-corrects once
  defect 2 is fixed, but re-verify it.
- `netlify/functions/analysts/*.ts` — the individual analysts
  (`core.ts`, `technical.ts`, `insider.ts`, `political.ts`,
  `patents.ts`, `sector-rotation.ts`, …). **W1 reads these** to
  establish what `score` and `direction` mean.
- `compose-weights.ts` — the no-data weight rescale (correct; leave it).
- `conflictLevel` is already computed in `analyst-runner.ts` — W2 makes
  the composite/tier *respond* to it.
- `topSignals` / `buildRationale` consume the pick `direction` — they
  self-correct once `direction` is right; no separate fix.
- `model-version.ts` — MODEL_VERSION lives here (or wherever the repo
  keeps it — confirm).

## 2.2 Files you ARE allowed to touch

- `netlify/functions/shared/analyst-runner.ts` — the fix
- `netlify/functions/shared/model-version.ts` (or wherever
  MODEL_VERSION is defined) — the bump
- any OTHER file that turns out to duplicate the buggy composite
  formula — see PART 3 W2 (fix all copies consistently)
- test files for the above
- `src/App.jsx` — APP_VERSION bump
- `reports/phase-4s/contract.md` + `reports/phase-4s/verification.md`
- `briefs/phase-4s-pr-description.md`
- `ORCHESTRATOR.md` — mark 4s done at the end

## 2.3 Files you may NOT touch

- The individual analyst logic in `analysts/*.ts` — you READ them (W1)
  to learn the contract; you do not change them. The analysts are not
  the bug; the composite that blends them is.
- The scan workers, the boards' UI, the backtest engine, the desktop
  layout — unless PART 3 W2's grep finds the buggy formula duplicated
  there, in which case fix only that formula, consistently.
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`

---

# PART 3 — THE WORK (order W1 → W2 → W3)

## W1 — Establish the analyst score/direction contract

Read the analyst implementations and document, precisely:

- What an analyst's `score` represents — bullishness on a 0–100 scale
  (50 neutral)? Or conviction strength in the called direction? The UI
  (28 red, 100 green, 50 grey) and the radar indicate **bullishness** —
  confirm it in the code.
- What `direction` represents, and **whether `score` and `direction`
  can diverge** for a given analyst. The correct formula depends on
  this.
- Write the finding to `reports/phase-4s/contract.md`. W2's formula
  must be provably consistent with it.

## W2 — Make the composite directional and conflict-aware

Given the W1 contract:

- **Directional composite.** Remove `Math.abs()`. With a correctly-
  signed `signedNet` (−50..+50), `composite = clamp(50 + signedNet × k,
  0, 100)` gives the full 0–100 directional range — bullish high,
  bearish low, neutral ~50.
- **`signed` on one bull-bear axis.** Every analyst must land on a
  single axis — bearish negative, bullish positive — regardless of its
  `direction` label. If W1 confirms `score` is bullishness, `signed =
  score − 50` for every analyst is the natural form. If W1 finds a
  different contract, derive the formula to match — but bearish
  analysts MUST drag the composite down.
- **Conflict-aware (Chad's decision: do BOTH).** When `conflictLevel`
  is `severe` (≥3 disagree) or `moderate` (2): dampen the composite
  toward 50 by a conflict-scaled factor, AND cap the tier — severe →
  max C, moderate → max B.
- **Re-verify `direction`** (~line 240) comes out right once
  `signedNet` is correctly signed.
- **Check for a duplicated formula.** Grep for the `50 + abs(`/
  `signedNet` shape elsewhere (e.g. `score-at-date.ts`). If the bug is
  copy-pasted into another scoring path, fix it there too,
  consistently. If that path is a separate scorer, note it and leave
  it.

## W3 — MODEL_VERSION bump + regression tests + verification

- **Bump MODEL_VERSION** (and APP_VERSION one patch). The version bump
  is what invalidates stale snapshot/caches.
- **Regression test — the OI anchor:** a pick with ~5 bearish analysts
  + 1 strongly-bullish analyst produces a composite **< 50**, a tier
  **≠ A**, and a direction **≠ long**.
- Also test a coherently-bullish profile (high composite, tier A, long)
  and a coherently-bearish one (low composite, direction short) — the
  full directional range.
- Test the conflict treatment: a severe-conflict profile is dampened
  toward 50 and tier-capped.
- Write `reports/phase-4s/verification.md`. Note in the PR that the
  target-board scans must re-run post-deploy for corrected scores to
  appear — the orchestrator handles that.

---

# PART 4 — TESTS

- Unit tests for the composite math: the OI profile, coherent bullish,
  coherent bearish, severe/moderate conflict. Mock the analyst outputs;
  no network.
- Report the real test delta; don't pad.

---

# PART 5 — CONVENTIONS

- One commit per workstream + tests + reports. One PR.
- APP_VERSION bumped; **MODEL_VERSION bumped**.
- `strict: true` TypeScript; no `any` without an inline reason.
- Do not rewrite the individual analysts — the fix is the composite.

---

# PART 6 — PR + ACCEPTANCE

```bash
git checkout -b phase-4s-composite-scoring-fix
# ... W1, W2, W3 ...
git push -u origin phase-4s-composite-scoring-fix
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4s - composite scoring integrity fix",
    "head": "phase-4s-composite-scoring-fix",
    "base": "main",
    "body": "See briefs/phase-4s-brief.md and reports/phase-4s/. Fixes the board-wide composite bug: the composite was 50+abs(signedNet)*1.5 (direction discarded) and the signed formula made bearish analysts contribute positively. Now directional + conflict-aware. Bumps MODEL_VERSION. Regression test anchored on the O-I Glass profile."
  }'
```

**Open the PR as ready-for-review, NOT a draft.** If your tooling
defaults to draft, immediately mark it ready.

Acceptance is post-merge by the orchestrator: re-run the target-board
scans, confirm OI on the live board is no longer 92/A/LONG.

---

# PART 7 — HAND-OFF FORMAT

When the PR is mergeable, post one message:

```
PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Contract (W1):
- analyst `score` means: <bullishness 0-100 / other>
- `score`/`direction` divergence: <yes/no — detail>

Fix (W2):
- composite: <new formula>
- signed: <new formula>
- conflict: dampening = <how>, tier cap = severe→C / moderate→B
- duplicated formula found elsewhere: <yes+fixed / no>

Verification (W3):
- OI-profile regression test: composite <new value>, tier <X>, dir <X>
- tsc --noEmit: clean
- npm test: <N> passing (was <baseline>)
- npm run build: clean
- MODEL_VERSION: <old> -> <new>

Acceptance: DEFERRED to post-merge (orchestrator re-scans, checks OI live)
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Fixing only the `Math.abs()`.** The `signed` formula is also broken
  — bearish analysts must go negative. Fix both, or `signedNet` stays
  corrupted.
- **Guessing the formula** without confirming the W1 contract.
- **Forgetting the conflict treatment** — Chad chose BOTH dampen + cap.
- **Forgetting the MODEL_VERSION bump** — without it, stale caches keep
  showing wrong scores and the fix looks broken.
- **Treating the new board appearance as a regression** — far fewer
  A's and real SHORT picks appearing is the fix WORKING. The regression
  tests assert the correct new behavior.
- **Changing the individual analysts.** **Networking in unit tests.**
  **Opening the PR as a draft.**

---

# PART 9 — PARALLEL CONTEXT

Phase 4r (backtest verdict resolution) may be running in parallel — it
is in the backtest engine and shares no file with 4s. 4k/4m/4n are
merged. If you hit an unexpected conflict on `main`, stop and report.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4s of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4s-executor.md — that's your full assignment —
   then read briefs/phase-4s-brief.md for the full diagnosis.

Everything you need is in those two files: a board-wide composite
scoring bug. In analyst-runner.ts the composite is 50+abs(signedNet)*1.5
— the abs() discards direction — and the signed formula makes bearish
analysts contribute positively, so O-I Glass (bearish per 5/7 analysts)
scores 92/A/LONG. W1 establish the analyst score/direction contract
from the code (no guessed formula); W2 make the composite directional
(drop abs, bearish analysts negative on one bull-bear axis) and
conflict-aware — Chad's decision: BOTH dampen the composite toward
neutral AND cap the tier on severe/moderate conflict; W3 bump
MODEL_VERSION + a regression test anchored on the OI profile (5 bearish
+ 1 bullish → composite <50, tier ≠A, direction ≠long). One PR. Do NOT
change the individual analysts — the fix is the composite that blends
them. If commits fail from /home/claude/TradeIQ, relocate to
/home/user/TradeIQ. Open the PR ready-for-review, not a draft. Start
with PART 1 once you've read both. ~2-3 hour session.
