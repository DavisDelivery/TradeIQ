# Phase 4s W3 — Verification

> Acceptance criteria from `briefs/phase-4s-brief.md` PART VII, plus
> the new regression test results and baseline parity check.

## Acceptance criteria — status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | O-I Glass profile (~5 bearish + 1 strongly bullish) → composite < 50, tier ≠ A, direction ≠ long | **PASS** — composite **40**, tier **C**, direction **short**, signedNet -6.54, conflictLevel mild |
| 2 | Composite is directional across full range — coherent bull high+A+long, coherent bear low+short, neutral ≈ 50 | **PASS** — see "coherently bullish", "coherently bearish", "neutral" regression tests |
| 3 | `severe`/`moderate` `conflictLevel` cannot present as a confident A | **PASS** — severe-conflict test asserts tier capped at C; moderate-conflict test asserts tier capped at B |
| 4 | `direction` correct as a consequence of corrected `signedNet` | **PASS** — direction derived from `signedNet > 4 ? long : signedNet < -4 ? short : neutral`, unchanged in shape but now sign-correct |
| 5 | MODEL_VERSION bumped; regression tests cover OI + coherent profiles | **PASS** — MODEL_VERSION 2026.04.0 → 2026.05.0; 9 regression tests in `analyst-runner-composite.test.ts` |
| 6 | `tsc --noEmit` clean, full suite green, `npm run build` clean | **PASS** — tsc clean, 986/986 tests pass (was 977/977 baseline), build clean |
| 7 | `reports/phase-4s/contract.md` documents the score/direction contract the fix was built against | **PASS** — see `reports/phase-4s/contract.md` |

## OI exact trace

The headline regression. Inputs match the per-analyst scores Chad
observed on the live OI Glass detail panel (Technical 28, Sector 16,
Fundamental 28, Flow 45, News 28, Insider 100). Earnings, macro,
patents, political marked no-data so the weights rescale to the live
seven-analyst surface area.

```
Inputs:
  technical:    score=28, direction=short, confidence=0.7
  sector:       score=16, direction=short, confidence=0.7
  fundamental:  score=28, direction=short, confidence=0.7
  flow:         score=45, direction=short, confidence=0.7
  news:         score=28, direction=short, confidence=0.7
  insider:      score=100, direction=long, confidence=0.7
  earnings/macro/patents/political: no-data (excluded by composeWeights)

Outputs (post-4s):
  composite:    40
  tier:         C
  direction:    short
  conflictLevel: mild      (1 disagreer: insider — only it stayed long)
  signedNet:    -6.54
```

Pre-4s output for the same inputs was 92 / A / LONG / severe (per the
brief's reproduction). Net change for OI: composite −52, tier
A→C, direction LONG→SHORT.

Note on `conflictLevel`: under the pre-4s buggy direction, OI's direction
resolved to LONG and the five bearish analysts all counted as disagreers
→ severe. Under the post-4s correct direction (SHORT), only the lone
bullish insider analyst counts as a disagreer → mild. Both are correct
descriptions of "five-to-one bearish": the analysts agree, with one
outlier. The bug wasn't that conflict was severe — it was that the
direction the runner labeled as the consensus was the opposite of what
the analysts actually said.

## Baseline parity

| Check | Baseline (main) | After 4s |
|-------|-----------------|----------|
| `npx tsc --noEmit` | clean | clean |
| `npm test` | 977 passed (103 files) | 986 passed (104 files) — +9 new regression tests |
| `npm run build` | clean (986KB JS) | clean (986KB JS) |
| MODEL_VERSION | 2026.04.0 | 2026.05.0 |
| APP_VERSION | 0.19.1-alpha | 0.19.2-alpha |

## What the fix changes for downstream surfaces

- **Every target-board pick re-scores on the next scan.** Stored
  snapshots remain (the fix does not retroactively rewrite Firestore);
  MODEL_VERSION bump + post-merge re-scan publishes corrected ones.
- **Real SHORT picks will appear** on a board that previously had none
  (a coherently-bearish stock used to score high under the magnitude
  composite; now it scores low and flips to direction=short).
- **Far fewer A tiers.** Severe/moderate-conflict picks now cap at C/B
  respectively; bearish picks that used to grade A on magnitude alone
  now grade C with the correct direction.
- **`topSignals`, `buildRationale` self-correct** once `direction` is
  right — they consume the pick direction, no code change needed.
- **No backtest or Prophet impact.** `composeProphet` (the backtest +
  Prophet board scorer) is a separate weighted-layer formula and was
  never affected.

## Post-merge orchestrator checklist

(Out of scope for this PR but flagged in the PR description.)

1. Confirm Netlify deploy lands `MODEL_VERSION: 2026.05.0`.
2. Re-run the target-board scans (largecap, russell2k, sp500) so
   corrected snapshots publish.
3. Open OI Glass detail panel: composite < 50, tier ≠ A, direction
   ≠ LONG.
4. Spot-check 5-10 other picks for sanity (the board distribution
   should shift toward lower averages with real shorts appearing).
