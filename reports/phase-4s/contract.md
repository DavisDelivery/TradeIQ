# Phase 4s W1 — Analyst score/direction contract

> Source-of-truth read of `netlify/functions/analysts/*.ts` and the
> upstream `netlify/functions/shared/*-provider.ts` scorers, so that the
> W2 composite formula can be derived (not guessed) from the actual
> shape of analyst output.

## TL;DR

- **`score` is a 0–100 bullishness scale, 50 = neutral.** Every analyst
  in the live battery emits its score as either `Math.round(50 + raw/2)`
  (technical, sector-rotation, fundamental, flow, earnings, news) or
  `Math.round(50 + raw)` with the raw component itself bounded into a
  bullishness deviation (insider, patents, political). The UI matches
  this contract: 28 renders red, 100 green, 50 grey.
- **`direction` is a thresholded summary of bullishness, not an
  independent axis.** It is derived directly from the same `raw` (or
  from `score`) the analyst already used to emit its score. `direction`
  and `score` cannot contradict each other on the bull-bear axis;
  `direction` may collapse to `'neutral'` inside a narrow band around
  50 while `score` continues to carry a signed deviation.
- **Implication for the composite.** A bearish analyst (`score < 50`)
  *always* corresponds to `direction ∈ {short, neutral}`, never
  `'long'`. Conversely, a bullish analyst (`score > 50`) is always
  `'long'` or `'neutral'`. The natural signed contribution is therefore
  **`signed = score − 50`** for every analyst, regardless of direction
  label — that places every analyst on a single bull-bear axis with a
  bearish analyst pulling the net negative.

## Per-analyst breakdown

All paths verified by reading the source; no behaviour inferred.

### technical (`analysts/technical.ts`)
```ts
raw = clamp(...trend/ROC/bands/volume contributions..., -100, 100);
direction = raw > 10 ? 'long' : raw < -10 ? 'short' : 'neutral';
score = Math.round(50 + raw / 2);          // 0..100
```
- `direction === 'long'` ⟹ `raw > 10` ⟹ `score > 55`
- `direction === 'short'` ⟹ `raw < -10` ⟹ `score < 45`
- `direction === 'neutral'` ⟹ `score ∈ [45, 55]` (approx)

### fundamental (`analysts/core.ts → runFundamental`)
Same shape: `raw` ∈ [-100, 100] from growth/margin/leverage; `score =
50 + raw/2`; `direction` thresholded at ±10. Same sign-locking.

### flow (`analysts/core.ts → runFlow`)
Same shape: concordance + advance/decline + close-strength → `raw` ∈
[-100, 100]; `score = 50 + raw/2`; `direction` thresholded at ±10.

### earnings (`analysts/core.ts → runEarnings`)
Same shape: upcoming/history → `raw` ∈ [-100, 100]; `score = 50 +
raw/2`; `direction` thresholded at ±5 (slightly narrower). When neither
branch contributes, the analyst returns `score: 50` with the
`_noData` flag so the composite-weight rescale excludes it.

### news-sentiment (`analysts/core.ts → runNewsSentiment`)
Same shape: keyword sentiment + age decay → `raw` ∈ [-100, 100]; `score
= 50 + raw/2`; `direction` thresholded at ±10. Empty news → `_noData`.

### sector-rotation (`analysts/sector-rotation.ts`)
Same shape: `raw ∈ [-100, 100]`; `score = 50 + raw/2`; `direction`
thresholded at ±10.

### insider (`analysts/insider.ts` + `shared/insider-provider.ts`)
```ts
raw = clamp(...cluster + leadership + net-dollars..., -50, 50);
score = Math.round(50 + raw);              // 0..100
// direction wrapped in the analyst:
direction = score > 60 ? 'long' : score < 40 ? 'short' : 'neutral';
```
- `score > 60` ⟹ `'long'`; `score < 40` ⟹ `'short'`; `score ∈ [40, 60]`
  ⟹ `'neutral'`. Sign-locked.

### patent (`analysts/patents.ts` + `shared/patent-provider.ts`)
```ts
raw = clamp(..., -20, 50);
score = Math.round(50 + raw);              // 30..100
direction = score > 60 ? 'long' : 'neutral';
```
- Bullish-biased by design: no `'short'` outcome. With `signed = score −
  50`, a low patent score (raw -20 → score 30) contributes −20, but
  this analyst is currently **weighted 0 in `ANALYST_WEIGHTS`** in
  `analyst-runner.ts` (Phase 4f-finish removal: `no_upstream`), so it
  has no effect on the live composite. Score/direction divergence here
  is therefore moot for the live composite; if the analyst is ever
  re-weighted, `score = 50` for "no recent patents" keeps its
  contribution at 0 by construction, and a low score is a real
  bear-signal because raw can in fact reach `-20` when velocity is
  collapsing.

### political (`analysts/political.ts`)
```ts
combinedDev = (pol.score-50)*pol.conf*0.6 + (con.score-50)*con.conf*0.4;
score = Math.round(clamp(50 + combinedDev * 2, 0, 100));
direction = score > 60 ? 'long' : score < 40 ? 'short' : 'neutral';
```
Same sign-locked pattern; score ∈ [0,100], direction thresholded.

### macro-regime (synthesized in `analyst-runner.ts`)
```ts
score = Math.round(50 + macroBias * 20);
direction = macroBias > 0.2 ? 'long' : macroBias < -0.2 ? 'short' : 'neutral';
```
Weight pinned to 0; same shape regardless.

## Can `score` and `direction` diverge?

Yes — but only in the "neutral band" sense, never in the contradictory
sense:

- An analyst can emit `direction: 'neutral'` while `score ≠ 50` (the
  signed deviation is within the analyst's `'neutral'` threshold band).
  Example: insider `score = 55` lands in `[40, 60]` → `'neutral'`.
- An analyst **cannot** emit `direction: 'long'` with `score < 50`, or
  `direction: 'short'` with `score > 50`. The thresholds gate on the
  same raw the score is derived from.
- The patent analyst clips its direction (never `'short'`) but score
  can still go below 50 — this is a controlled "bullish-only" axis,
  not a contradiction. Weight = 0 in production today.

## Implication for the W2 composite

The buggy formula in `analyst-runner.ts` (~line 233):
```ts
const signed = a.direction === 'long' ? a.score - 50
            : a.direction === 'short' ? -(a.score - 50)
            : 0;
```
…produces the wrong sign for bearish analysts: `direction === 'short'`
implies `score < 50`, so `-(score - 50)` is **positive**. A bearish
analyst then contributes a *bullish* push to `signedNet`. Combined
with the `Math.abs(signedNet) * 1.5` magnitude composite, every
broadly-disliked stock can grade as a confident A LONG. This is the
O-I Glass symptom Chad surfaced.

The fix that is **provably consistent with the contract above**:

```ts
const signed = a.score - 50;               // -50..+50 bullishness deviation
netRaw += signed * w * a.confidence;
confTotal += w * a.confidence;
// signedNet ∈ [-50, +50] after weighted average
const rawComposite = 50 + signedNet * 1.5; // directional, no abs()
```

Direction (`signedNet > 4 ? 'long' : signedNet < -4 ? 'short' :
'neutral'`) is unchanged in shape — it self-corrects once `signedNet`
carries the right sign.

Conflict treatment (Chad's decision: dampen + cap) is applied as a
post-processing step on the directional composite/tier; see W2 in
`analyst-runner.ts` for the implementation.

## Files read for this contract

- `netlify/functions/analysts/technical.ts`
- `netlify/functions/analysts/sector-rotation.ts`
- `netlify/functions/analysts/core.ts` (fundamental, flow, earnings, news)
- `netlify/functions/analysts/insider.ts`
- `netlify/functions/shared/insider-provider.ts` (scorer)
- `netlify/functions/analysts/patents.ts`
- `netlify/functions/shared/patent-provider.ts` (scorer)
- `netlify/functions/analysts/political.ts`
- `netlify/functions/shared/analyst-runner.ts` (macro synth + composite block)
- `netlify/functions/shared/types.ts` (`AnalystOutput`, `Direction`, `Tier`, `ConflictLevel`)
