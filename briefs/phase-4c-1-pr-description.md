# Phase 4c-1 — Prophet detail completeness + EPS bug

Closes the two bugs from Chad's PWR screenshot: most Prophet picks shipped without an AI thesis, and every pick without surprise data rendered as "0/4 beats" (a false claim of 4 misses).

**Target:** `0.15.1-alpha` (was `0.15.0-alpha`). Tests: **367 → 397** (+30 new).

---

## What ships

### 1. AI Thesis now reaches every pick — three layered strategies

Previously, only the top ~5 picks per response had a narrative because `narrateTopN` ran inline with a tight time budget. Mid-pack picks silently lost the thesis block entirely. The fix is three-pronged:

**W4 — Scheduled scans pre-narrate every qualified pick** before writing the snapshot, so the snapshot ships with theses inline. Each scanner has its own narration budget guard (largecap 3 min, all 2 min, russell 90 s) so the worst case is "some picks ship without a thesis", not "the container times out". Russell is on the tight end because today it's already pressing the 15-min container limit — 4c-2's sieve will free room.

**W2 — On-demand endpoint** `POST /api/prophet-narrate` regenerates a single pick's thesis when the snapshot didn't cover it (e.g. picks beyond the scanner's narration budget, or older pre-4c-1 snapshots still cached). Per-IP rate limit 30 / hour as defense in depth. Anthropic budget cap was dropped 2026-05-12 — this endpoint emits spend telemetry but never refuses on cost grounds.

**W1 — UI honesty.** `ProphetDetail` now renders three states: thesis present (emerald block, unchanged), thesis missing (muted placeholder with **→ Generate AI thesis** button), and in-flight (spinner). The user always sees something explaining the state; no more "the top pick has AI but the others mysteriously don't."

**W3 — `useGenerateNarrative` mutation hook** wires the button to W2 and patches every prophet query in the cache on success, so the narrative renders inline on the next tick without a refetch.

### 2. EPS-beats now distinguishes "no data" from "real zero" (W5)

Root cause: `earnings-intel.ts` did `surprises.filter(s => s > 0).length` and emitted `0` whenever Finnhub returned an empty or unparseable surprise history (common for small-caps and IPOs). The UI rendered that as **"0/4 beats"** — a false statement that the company missed all four quarters when reality was "we don't have the data."

Fix:
- `beatsLast4: number | null` — `null` means "no usable surprise data," not "we know they missed."
- New `beatsLast4Quarters?: number` — honest denominator (0–4). For a ticker IPO'd 6 months ago the UI now shows `1/2 beats` instead of misleading `1/4 beats`.
- `scoreEarningsQuality` treats `null` as "no signal" (was `!== undefined`, now `!= null`).
- `scan-prophet.ts` and `backtest/score-at-date.ts` coerce null → undefined when handing off to the fundamental layer's `epsSurpriseBeats` input (same no-signal semantics).
- UI renders muted **— / 4 beats** chip when `null`, and `{n}/{quarters} beats` with color logic when a real number.

### 3. Refactor — shared narrative module

`prophet-picks.ts` had a private narrative cache + prompt-builder + `narrateTopN`. Extracted into:
- `netlify/functions/shared/narrative-cache.ts` — in-memory cache keyed by `{ticker}:{compositeBand}` with 6 h TTL.
- `netlify/functions/shared/narrative-generator.ts` — `generateNarrative` (single pick), `narrateTopN` (live endpoint), `narrateAll` (scheduled scanner). The Opus 4.7 prompt is unchanged.

`prophet-picks.ts` is now ~150 lines down from 253; behavior is identical (verified by the unchanged 367-test baseline).

---

## Spend awareness (Anthropic budget cap was dropped)

Per Chad's decision 2026-05-12, the budget cap was explicitly dropped. The existing `anthropic-budget.ts` infra still tracks daily spend and trips the circuit breaker on repeated upstream errors — we did not touch it. The new code paths emit warning logs but never refuse on cost grounds.

Expected ceiling, written down honestly so anomalies are detectable:
- Largecap (~60 qualified picks × 16 scans/day × $0.002) ≈ **$2/day**
- All (~100 qualified picks × 16 scans/day × $0.002) ≈ **$3/day**
- Russell (~80 picks fit within the 90 s narration budget at concurrency 4 × 16 scans/day × $0.002) ≈ **$2.50/day**
- On-demand `/api/prophet-narrate` is bounded by user click frequency + per-IP rate limit, expected <$1/day

Daily worst-case across all paths: **~$10/day** = ~$300/month. Compare against Anthropic dashboard weekly. If it climbs sharply, the most likely cause is a regression in the cache-hit path (band quantization broken, cache module not shared) or russell narration budget being too generous after 4c-2's sieve frees scan time.

---

## Tests

**+30 tests, 397 total.**

- `netlify/functions/shared/__tests__/narrative-cache.test.ts` (7) — band quantization, round-trip, TTL constants, reset.
- `netlify/functions/shared/__tests__/earnings-intel-beats.test.ts` (5) — the W5 contract: null on no data, real number on full window, honest denominator on partial window, fallback to `safeSurprise` when `surprisePct` missing.
- `netlify/functions/__tests__/prophet-narrate.test.ts` (12) — method gating, input validation, happy path, cache pass-through, upstream null → 500, missing API key → 500, per-IP rate limit (limit, isolation across IPs, window reset).
- `src/hooks/__tests__/useGenerateNarrative.test.jsx` (4) — POST body shape, multi-query cache patch, rate_limit error surface, generic error surface.

Run `npm test` — should report `397 passed`.

---

## Risk + rollback

**Backward compatibility.** Existing snapshots written before this PR contain picks where `pick.narrative` is `undefined` and `pick.earnings.beatsLast4` is `0` or a real count. The new UI:
- `narrative` undefined → falls through to the W1 "Generate AI thesis" placeholder (the previous behavior was to show nothing — strict improvement).
- `beatsLast4 === 0` from an old snapshot still renders as `0/N beats`. Users will see slightly misleading values for tickers cached pre-fix; next scheduled scan refreshes the snapshot and the muted em-dash chip appears.

**Rollback.** Revert the merge commit. The shared narrative modules are new files (no overwrite); reverting cleanly restores the prior `prophet-picks.ts`. The scheduled-scanner narration is gated on `process.env.ANTHROPIC_API_KEY` so a missing key short-circuits the new code path without breaking the snapshot write.

**Spend regression.** If pre-narrate goes wrong in a way the budget guard misses, the most defensive lever is to set `ANTHROPIC_DAILY_BUDGET_USD=5` in Netlify env — the existing `preflightBudget` will then short-circuit Anthropic calls, picks ship without narratives, and the UI surfaces the W1 placeholder. No code change needed.

---

## Files changed

```
netlify/functions/prophet-narrate.ts                              NEW    +117
netlify/functions/shared/narrative-cache.ts                       NEW    +49
netlify/functions/shared/narrative-generator.ts                   NEW    +179
netlify/functions/__tests__/prophet-narrate.test.ts               NEW    +189
netlify/functions/shared/__tests__/narrative-cache.test.ts        NEW    +85
netlify/functions/shared/__tests__/earnings-intel-beats.test.ts   NEW    +110
src/hooks/useGenerateNarrative.js                                 NEW    +78
src/hooks/__tests__/useGenerateNarrative.test.jsx                 NEW    +151

netlify/functions/prophet-picks.ts                                edit   ~100  (extraction; behavior preserved)
netlify/functions/scan-prophet-largecap.ts                        edit   +40
netlify/functions/scan-prophet-russell.ts                         edit   +40
netlify/functions/scan-prophet-all.ts                             edit   +40
netlify/functions/shared/earnings-intel.ts                        edit   ~15   (W5 root-cause fix)
netlify/functions/shared/scan-prophet.ts                          edit   ~10   (pass beatsLast4Quarters, allow null)
netlify/functions/shared/backtest/score-at-date.ts                edit   1     (null coercion)
netlify.toml                                                      edit   +8    (prophet-narrate redirect)
src/ProphetView.jsx                                               edit   ~60   (three-state AI Thesis + honest beats)
src/App.jsx                                                       edit   1     (APP_VERSION → 0.15.1-alpha)
ORCHESTRATOR.md                                                   edit         (4c-1 row done; production line updated)
```

---

## Verification before merge

1. `npx tsc --noEmit` — clean ✓
2. `npm test` — 397 passing ✓
3. `npm run build` — clean ✓
4. Deploy preview smoke test (manual):
   - Open Prophet board, large cap. Top pick should have AI thesis as before.
   - Expand a mid-rank pick (rank 8+ typically). Without a fresh snapshot, the W1 placeholder + "→ Generate AI thesis" button should appear.
   - Tap the button. Spinner shows; within ~3 s the narrative replaces the placeholder.
   - Look for tickers with sparse earnings history (small-caps, recent IPOs). The earnings chip should render `— / 4 beats` muted, NOT `0/4 beats`.
   - On a freshly-scheduled-scan snapshot (after the next 30-min cron tick), all picks should have narratives inline — no button.

Manual smoke is the last gate per Lesson 8 — the redirect layer can do things unit tests don't catch.
