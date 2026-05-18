# Phase 4s — composite scoring integrity fix

Fixes the board-wide bug Chad surfaced on the O-I Glass detail panel:
**Composite 92, Tier A, LONG** with 5 of 7 active analysts bearish on
the name. The composite was being computed as a *magnitude*, not a
*bullishness*, so the target board couldn't tell a stock the analysts
loved from one they hated.

## Root cause (three compounding defects in `analyst-runner.ts` ~228-241)

1. `composite = 50 + Math.abs(signedNet) * 1.5` — the `abs()` discarded
   direction. A coherent bull (`signedNet +40`) and a coherent bear
   (`signedNet -40`) both scored ~100.
2. `signed = direction==='long' ? score-50 : direction==='short' ?
   -(score-50) : 0` — bearish analyst (`direction:'short', score:28`)
   produced `-(28-50) = +22`, a *bullish* push. Five bearish analysts
   then stacked `signedNet` positive, the `abs()` kept it large, and
   the pick graded A LONG.
3. `tier` ignored `conflictLevel`. The runner correctly detected OI as
   severe-conflict and then applied zero penalty.

## What changed (one file: `netlify/functions/shared/analyst-runner.ts`)

W1 — established the analyst score/direction contract from the analyst
implementations (`reports/phase-4s/contract.md`): every analyst emits
`score` on a 0-100 bullishness scale (50 neutral) and gates `direction`
from the same underlying raw, so `direction` and `score` never
contradict each other on the bull-bear axis.

W2 — directional + conflict-aware composite, built against that
contract:
- `signed = score - 50` for every analyst (was: sign-from-direction —
  flipped bearish analysts positive).
- `rawComposite = 50 + signedNet * 1.5` (was: `50 + abs(signedNet) *
  1.5`).
- Conflict treatment per Chad's settled decision: BOTH dampen the
  composite toward 50 AND cap the tier. Severe (≥3 disagree) → factor
  0.5, tier cap C. Moderate (=2) → factor 0.75, tier cap B. Mild/none
  → no penalty.
- `direction` derivation unchanged in shape but now sign-correct.
- Extracted the math into a pure `composeTarget(allAnalysts,
  baseWeights)` helper so it's unit-testable without spinning up the
  data providers.

W3 — `MODEL_VERSION` 2026.04.0 → 2026.05.0 (cache invalidator;
existing snapshots were computed under the broken formula),
`APP_VERSION` 0.19.1 → 0.19.2, 9 regression tests in
`analyst-runner-composite.test.ts` (OI anchor, coherent bull, coherent
bear, neutral, severe conflict, moderate conflict, abs regression,
no-data exclusion, all-no-data).

## OI before/after

|              | Pre-4s         | Post-4s |
|--------------|----------------|---------|
| composite    | 92             | **40** |
| tier         | A              | **C**   |
| direction    | LONG           | **short** |
| conflictLevel| severe         | mild (only insider disagrees with the now-correct net direction) |
| signedNet    | strongly +ve   | **−6.54** |

## Test delta

| Check | Baseline | Post-4s |
|-------|----------|---------|
| `npx tsc --noEmit` | clean | clean |
| `npm test` | 977 / 977 (103 files) | **986 / 986** (104 files) — +9 new regression tests |
| `npm run build` | clean | clean |

## Scope discipline

- **Did NOT** touch the individual analysts — the bug was in the
  composite that blends them, not in the per-analyst scoring. The
  contract document confirms each analyst's score/direction contract
  matches the new formula.
- **Did NOT** touch `composeProphet` / `score-at-date.ts` / the
  backtest scorer — those use a completely different layer-weighted
  formula and were never affected. Verified via `grep` for
  `Math.abs(signedNet)` shape (single hit).
- **Did NOT** touch `composeWeights` (the no-data rescaler, correct
  already) or the UI.

## Post-merge — orchestrator owns

The fix changes every pick's score; stored snapshots do not
retroactively rewrite. After Netlify deploy lands MODEL_VERSION
2026.05.0, the target-board scans (largecap / russell2k / sp500) must
re-run for corrected snapshots to publish. The orchestrator then
confirms OI on the live board is no longer 92/A/LONG.

**Expected board shift after the re-scan, not a regression:** far
fewer A tiers (severe/moderate conflicts now cap at C/B), real SHORT
direction picks appearing (coherently-bearish stocks used to score
high on magnitude; now they score low and flip to short).

See `reports/phase-4s/contract.md` for the analyst contract and
`reports/phase-4s/verification.md` for the full acceptance trace.
