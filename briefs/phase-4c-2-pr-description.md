# Phase 4c-2 — Russell sieve + earnings-priority Prophet

Closes two of Chad's complaints in one phase per his 2026-05-13 direction:

1. **Coverage** — "It doesn't scan, you know, like 40 or 50 of them, and then it quits." Pre-4c-2 the russell scheduled scanner exhausted the 14-min container budget around ~600 tickers; the live `/api/prophet-picks` was even tighter (18s) and only got ~100. Both shipped a partial slice as if it were the universe.

2. **Scoring philosophy** — "I want Prophet to have a heavy focus on earnings ... earnings growth, multiple expansion, margin improvement. I wanna make sure that Prophet is really considering that."

**Target:** `0.16.0-alpha`. MODEL_VERSION `2026.02.0`. Tests **397 → 427** (+30 new).

---

## What ships

### 1. Three-stage Russell sieve

`netlify/functions/shared/prophet-sieve/` — five files, single entrypoint `runProphetSieve`.

- **Stage 1** (`stage1.ts`, ~2 min budget, concurrency 20, bars-only): every Russell ticker (~2037) gets scored on five cheap signals — trend qualifier (close > sma20/50/200), 20d momentum (percentile-ranked), 5/20 volume surge, 20d realized volatility (inverted — Prophet's strategy is stable trending names), and 52-week-low margin. Composite 0–100, equal-weight default. Top 20% by composite survive, clamped to [300, 600] with a `minComposite` floor.

- **Stage 2** (`stage2.ts`, ~4 min budget, concurrency 8): Stage 1 survivors get fundamentals (Polygon) + earnings intel (Finnhub) + RS-vs-SPY (60d return diff). Composite = `0.4 × Stage 1 + 0.6 × earnings quality`. Survival requires **passing the earnings-quality gate AND clearing the composite threshold**. Top 25%, clamped to [60, 120].

- **Stage 3** (existing `runProphetScan` via new `explicitTickers` opt): full 7-layer scoring on Stage 2 survivors. Picks stamp `_sieve_stage_max: 3` for telemetry. Existing snapshot pipeline; existing narrate-all from 4c-1.

Total budget: ~14 min, fits inside Netlify's 15-min background container with 60s of slack. Survival counts written into the snapshot as `sieve.stage{1,2,3}` metadata and surfaced to the UI.

### 2. Earnings-priority scoring (applies to ALL universes, not just Russell)

Chad's complaint about earnings focus is universe-agnostic. The fundamental layer changes apply to largecap + all + russell scans alike.

**New signals on `FundamentalsSnapshot`:**
- `priorGrossMarginYoY`, `priorOperatingMarginYoY` — 4-quarter-ago baselines for YoY margin trend.

**New signals on `FundInput`** (computed at the scan boundary from existing bars + priorEps):
- `pe1yAgo` — P/E approximately 1 year ago.
- `peExpansion` — `(pe - pe1yAgo) / pe1yAgo`. Positive = market paying more per dollar of earnings.
- `operatingMarginTrendPp` — YoY operating margin change in percentage points.
- `grossMarginTrendPp` — same for gross.

**`layerFundamental` rework:**
- Margin trend scoring band (+12/+7/+3/-5/-10) for operating margin YoY (Q/Q kept as fallback).
- Gross margin trend scoring band (+8/+4/-6).
- Multiple expansion scoring band (+10/+6/+2/-3/-8).
- New `earnings_quality_gate` detail — failures stamp a `gate_failed:<reason>` flag.

**Earnings-quality gate** — a ticker must clear this to PASS the fundamental layer (which counts toward the 5/7-layer-pass qualifier). Lenient on missing data; strict on clearly weak signal sets:
- EPS contraction worse than -15% → fail, regardless of other signals.
- EPS growth absent → pass (let composite decide).
- EPS growth below 5% → fail UNLESS at least one of: op margin expanding >1pp, multiple expanding >5%, growth accelerating >5pp, beats streak ≥3/4. Single offset is enough.

### 3. Composite reweight

Pre-4c-2:
```
catalyst 26%  fundamental 20%  structure 13%  volume 12%  momentum 11%  RS 11%  volatility 7%
```
Post-4c-2:
```
catalyst 30%  fundamental 25%  structure 11%  volume 10%  momentum 9%  RS 9%  volatility 6%
```

Earnings stack (fundamental + catalyst) now drives **55%** of the composite, up from **46%**. Technicals still matter for ranking among earnings-quality candidates, but they no longer drive selection alone.

### 4. UI

- **`SieveCoverageStrip`** — renders only when `data.sieve` is present (Russell snapshots). Shows the `2,037 names → s1: 412 → s2: 87 → 23 ranked` ladder. Turns amber + adds a `partial · Stage N budget` marker when any stage stamped `partial: true`.
- **Row chip strip** — new chips on Prophet rows when the signals are non-trivial:
  - `▲ X.Xpp op marg` (emerald) or `▼ X.Xpp op marg` (rose) when |trend| ≥ 0.5pp.
  - `▲ XX% P/E` (sky) or `▼ XX% P/E` (amber) when |multiple expansion| ≥ 5%.

These chips give Chad the at-a-glance "where's the growth" view he asked for.

### 5. Model versioning

`MODEL_VERSION` bumped `2026.01.0 → 2026.02.0`. Composite weights and the new fundamental signals change scoring math, so historical replay must remain on the old version. Phase 4 backtest already filters by version; this is the standard bump pattern.

---

## Tests

**+30 tests, 427 total.**

- `netlify/functions/shared/prophet-sieve/__tests__/stage1.test.ts` (11) — preconditions, trend qualifier, momentum sign, volume surge detection, 52w-low margin extremes.
- `netlify/functions/shared/prophet-sieve/__tests__/stage2-gate.test.ts` (9) — the earnings-quality gate contract: hard stop on severe contraction, leniency on missing data, anemic-EPS-with-each-offset paths, anemic-without-offsets, healthy-EPS path.
- `netlify/functions/shared/__tests__/prophet-layers.test.ts` (+5) — new signals (op margin trend, multiple expansion, gate behaviors).
- `src/__tests__/SieveCoverageStrip.test.jsx` (6) — null sieve, full ladder, three partial-marker cases, missing universeSize.

Run `npm test` — should report `427 passed`.

---

## Risk + rollback

**Existing largecap and "all" universes are unaffected by the sieve.** They still call `runProphetScan` directly. Only Russell's scheduled scanner switched to `runProphetSieve`. Live `/api/prophet-picks?universe=russell` will still hit the live partial-scan path while the next Russell snapshot is being built; it serves whatever the snapshot store has, which after this PR is a sieve-produced snapshot.

**Composite reweight affects all universes.** Existing picks ranked on the old weights are now ranked on the new weights. Cached snapshots from `2026.01.0` continue to be served by the live endpoint until they age out (30-min freshness budget on Prophet); by then the next scheduled scan writes a `2026.02.0` snapshot.

**Earnings-quality gate is strict.** A ticker that previously passed the fundamental layer on price action + flat EPS will now fail the gate. Expected effect: noticeable drop in qualifying ticker count on largecap and all (~20-30% fewer picks, by guess). This is the intended behavior — Chad explicitly asked for earnings focus to drive selection. If the drop is too extreme, the gate's anemic-EPS branch (the `eps < 0.05` path) is the lever; relaxing the threshold or accepting weaker offsets are the safe knobs.

**Stage 2 bar cache.** The orchestrator pre-fetches bars for Stage 1 survivors so Stage 2 reuses them. Polygon bar-cache layer already deduplicates within a process, but this explicit cache avoids the request-count for double-cold tickers. No correctness impact.

**Rollback.** Revert the merge commit. `prophet-sieve/` modules are new files; removing them with the merge revert is clean. Russell scanner reverts to single-pass. Composite weights revert. MODEL_VERSION reverts to `2026.01.0`. The earnings-priority chips disappear with the UI revert.

---

## Files changed

```
netlify/functions/shared/prophet-sieve/index.ts                       NEW  +148
netlify/functions/shared/prophet-sieve/stage1.ts                      NEW  +220
netlify/functions/shared/prophet-sieve/stage2.ts                      NEW  +260
netlify/functions/shared/prophet-sieve/types.ts                       NEW  +60
netlify/functions/shared/prophet-sieve/budgets.ts                     NEW  +35
netlify/functions/shared/prophet-sieve/__tests__/stage1.test.ts       NEW  +110
netlify/functions/shared/prophet-sieve/__tests__/stage2-gate.test.ts  NEW  +85
src/components/SieveCoverageStrip.jsx                                 NEW  +65
src/__tests__/SieveCoverageStrip.test.jsx                             NEW  +75

netlify/functions/shared/data-provider.ts          edit  ~25   (priorGrossMargin + YoY baselines)
netlify/functions/shared/prophet-layers.ts         edit  ~140  (new signals + earnings-quality gate + reweight)
netlify/functions/shared/scan-prophet.ts           edit  ~50   (compute new signals, explicitTickers option, propagate to pick.earnings)
netlify/functions/shared/snapshot-store.ts         edit  +8    (sieve metadata field)
netlify/functions/shared/__tests__/prophet-layers.test.ts  edit  +75   (new signal + gate tests)
netlify/functions/shared/model-version.ts          edit  1     (2026.02.0)
netlify/functions/scan-prophet-russell.ts          edit  ~60   (uses runProphetSieve)
netlify/functions/prophet-picks.ts                 edit  +3    (pass sieve metadata through)
src/ProphetView.jsx                                edit  ~30   (SieveCoverageStrip + new row chips)
src/App.jsx                                        edit  1     (APP_VERSION → 0.16.0-alpha)
ORCHESTRATOR.md                                    edit         (4c-2 row done; production line updated)
```

~17 files, ~1900 lines net.

---

## Verification before merge

1. `npx tsc --noEmit` — clean ✓
2. `npm test` — 427 passing ✓
3. `npm run build` — clean ✓
4. Deploy preview smoke test (manual):
   - Open Prophet board, switch to **Russell 2K**. While the sieve snapshot is being built (first scheduled scan after merge), the live endpoint serves a partial. Once the snapshot lands, the SieveCoverageStrip should render with the `2,037 names → s1 → s2 → ranked` ladder, no partial marker.
   - Confirm the strip is **absent** on largecap and all (no sieve metadata on those universes).
   - Spot-check pick chips: tickers with strong margin trend should show `▲ Xpp op marg`; multiple-expanding tickers show `▲ X% P/E`.
   - Expand a pick with weak EPS growth — the fundamental layer's pass/fail badge should reflect the earnings-quality gate; the `details` strip should include `earnings_quality_gate: true/false` and the related new signals (`op_margin_trend_pp`, `gross_margin_trend_pp`, `pe_expansion_pct`).

Smoke gate (Lesson #8): the new sieve runs only inside the russell background function which can only be invoked via cron. The first post-merge cron tick (next `:00` or `:30` between 9a-5p ET M-F) produces the first sieve snapshot. Watch Netlify logs for `sieve_complete` with the stage counts.
