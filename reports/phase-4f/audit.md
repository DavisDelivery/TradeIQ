# Phase 4f — Stub-Analyst Audit

**Generated:** 2026-05-15T10:23:04.637Z
**Sample window:** last 30 days

Total analysts/layers reviewed: 24 (across 4 quadrants)
Live: 14
Stub: 5
Degraded: 5

**Stub list:**
- target-board × russell2k: earnings-analyst
- target-board × russell2k: insider-analyst
- target-board × russell2k: macro-regime
- target-board × russell2k: patent-analyst
- target-board × russell2k: political-analyst

---

### Target Board — largecap

Snapshots scanned: 0.  Observations: 0.  Verdicts: 0 live · 0 stub · 0 degraded.

| Analyst/Layer        |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|

### Target Board — russell2k

Snapshots scanned: 19.  Observations: 36000.  Verdicts: 2 live · 5 stub · 3 degraded.

| Analyst/Layer        |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|
| earnings-analyst     |    50.06 |     0.98 |        98.89 |    0.00 |         0.00 |           6 | stub |
| flow-analyst         |    54.41 |     3.93 |         7.44 |    0.00 |         0.00 |          22 | degraded |
| fundamental-analyst  |    55.32 |    16.79 |         8.33 |    0.00 |         0.00 |          43 | live |
| insider-analyst      |    50.02 |     1.97 |        99.00 |    0.00 |         0.00 |           9 | stub |
| macro-regime         |    50.00 |     0.00 |       100.00 |    0.00 |         0.00 |           1 | stub |
| news-sentiment       |    54.85 |    12.52 |        47.50 |    0.00 |         0.00 |          37 | degraded |
| patent-analyst       |    50.00 |     0.00 |       100.00 |    0.00 |         0.00 |           1 | stub |
| political-analyst    |    50.01 |     1.51 |        98.53 |    0.00 |         0.00 |           7 | stub |
| sector-rotation      |    64.51 |    14.47 |         2.47 |    0.00 |         0.00 |          51 | live |
| technical-analyst    |    71.24 |     3.20 |         0.00 |    0.00 |         0.00 |          18 | degraded |

### Prophet — largecap

Snapshots scanned: 42.  Observations: 4942.  Verdicts: 6 live · 0 stub · 1 degraded.

| Analyst/Layer        |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|
| catalyst             |    36.17 |     4.84 |         0.00 |    0.00 |        93.06 |          24 | degraded |
| fundamental          |    53.42 |    19.12 |         0.99 |    0.00 |        11.19 |          44 | live |
| momentum             |    57.27 |     9.41 |        18.27 |    0.00 |        16.29 |          13 | live |
| relativeStrength     |    97.28 |     6.17 |         0.00 |    0.00 |         6.09 |          13 | live |
| structure            |    82.05 |    12.29 |         0.00 |    0.00 |        24.79 |          13 | live |
| volatility           |    60.11 |    13.10 |        10.20 |    0.00 |        13.03 |           7 | live |
| volume               |    67.58 |     9.43 |         0.14 |    0.00 |         0.71 |          10 | live |

### Prophet — russell2k

Snapshots scanned: 3.  Observations: 2282.  Verdicts: 6 live · 0 stub · 1 degraded.

| Analyst/Layer        |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|
| catalyst             |    29.08 |     6.48 |         0.00 |    0.00 |        98.77 |          11 | live |
| fundamental          |    42.14 |    21.16 |         4.29 |    0.00 |         7.06 |          47 | live |
| momentum             |    60.94 |    11.77 |         7.36 |    0.00 |        11.66 |          16 | live |
| relativeStrength     |    95.57 |     8.83 |         0.00 |    0.00 |         2.15 |          20 | live |
| structure            |    78.80 |    12.81 |         1.84 |    0.00 |        51.84 |          21 | live |
| volatility           |    61.03 |    16.98 |        34.66 |    0.00 |         9.20 |          10 | degraded |
| volume               |    67.66 |     9.52 |         5.83 |    0.00 |         0.92 |          11 | live |

---

## § 2 — Per-stub diagnosis (W2, 4f-finish PR)

**Audit caveat:** the 30-day sample window includes snapshots written
before PR #27 (the partial 4f PR) merged on 2026-05-15. PR #27 added
`signals._noData` flags at the analyst-runner wrapper level for
insider/patent/political when their upstream is null. Snapshots written
post-merge correctly emit those flags; pre-merge snapshots still have
`score=50` for the same conditions. Verdicts below distinguish between
"shipped fix; future audits will reclassify" and "additional repair
needed in this PR".

Sorted by composite weight (largest first).

### insider-analyst (Target Board, 14% weight)

**Verdict:** Stub (stdev 1.97, 99.00% exactly 50, 9 unique scores across 3600 obs)
**Root cause:** `null_default` — already addressed by PR #27 at
`netlify/functions/shared/analyst-runner.ts:111-119` (wraps
`runInsider(insiderActivity)` to emit `signals._noData = true` when
`insiderActivity` is null).

**Evidence:**
- File: `netlify/functions/shared/analyst-runner.ts`
- Lines: 111-119 (fix shipped)
- Audit window pre-dates the deploy of PR #27; russell2k Quiver insider
  coverage is sparse, so most pre-merge snapshots returned `score=50`
  via the stale handler. Finnhub-backed insider-provider (the new
  source after Quiver tier-gate) per `insider-provider.ts:1-20` still
  has uneven russell2k coverage but PR #27's wrapper correctly emits
  `_noData` when the provider yields no rows.

**Resolution path:** No additional code action in this PR. Re-run the
audit on a 30-day window starting 2026-06-15 (one month post-PR #27
deploy) to reclassify; expect % exactly 50 to drop to ~5% (the share
of russell2k tickers Finnhub doesn't cover) and stdev to rise above 5.

**Predicted post-repair stdev:** > 5 (already shipped); confirm with
follow-up audit run.

### political-analyst (Target Board, 10% weight)

**Verdict:** Stub (stdev 1.51, 98.53% exactly 50, 7 unique scores)
**Root cause:** `null_default` — already addressed by PR #27 at
`netlify/functions/shared/analyst-runner.ts:132-143` (emits `_noData`
when both `politicalActivity` AND `contractActivity` are null).

**Evidence:**
- File: `netlify/functions/shared/analyst-runner.ts`
- Lines: 132-143 (fix shipped)
- Quiver's congressional + lobbying datasets cover the actively-traded
  large-caps well but russell2k coverage is < 5%. The pre-merge handler
  returned `score=50` for the ~95% of russell2k tickers with no
  political activity. Post-merge those tickers correctly emit `_noData`
  and are skipped by `composeWeights`.

**Resolution path:** No additional code action in this PR. Same
reclassification expectation as insider-analyst.

**Predicted post-repair stdev:** > 5 (already shipped).

### news-sentiment (Target Board, 10% weight)

**Verdict:** Degraded (stdev 12.52, 47.50% exactly 50, 37 unique scores)
**Root cause:** `null_default` — **NOT YET addressed.** PR #27 fixed
the screenshot-flagged wrappers (insider/patent/political) but the
core `runNewsSentiment(news)` handler in
`netlify/functions/analysts/core.ts:148-184` still returns
`{ score: 50, direction: 'neutral', confidence: 0 }` when `news` is
empty. About 47% of russell2k tickers have no recent Polygon news
within the 15-item / 7-day default window, hence the pile at 50.

**Evidence:**
- File: `netlify/functions/analysts/core.ts`
- Lines: 148-151 (early-return on `news.length === 0`)
- Caller `analyst-runner.ts:106` invokes `runNewsSentiment(news)`
  unconditionally; no `_noData` flag is set even when the upstream is
  empty.

**Resolution path:** Add `signals._noData = true, signals._reason = 'no_data'`
to the `news.length === 0` early-return in `runNewsSentiment`. The
existing `composeWeights` path will then correctly skip the analyst
for tickers with no news rather than pulling their composite toward 50.

**Predicted post-repair stdev:** ~14-15 (the 47% mass at 50 should
redistribute to "no contribution" / null-skipped, leaving the
non-zero-news observations whose distribution already has real
variance).

### earnings-analyst (Target Board, 7% weight)

**Verdict:** Stub (stdev 0.98, 98.89% exactly 50, 6 unique scores)
**Root cause:** `threshold_misconfig` — `runEarnings` in
`core.ts:111-140` produces `raw=0` (mapping to `score=50`) when both
of the threshold gates fail:
- `upcoming?.date` exists AND `daysUntilEarnings ≤ 21` → contributes
- `history.length >= 2` AND `beats <= 1` (with `history.length >= 4`) → contributes

For russell2k tickers, Finnhub's `/calendar/earnings` typically only
returns calls in the next 90 days; if the next reporting date is
> 21 days away, the timing branch contributes 0. Finnhub's
`/stock/earnings` returns ≤ 4 quarters but for many russell2k names
the array is shorter (newer issuers, gaps in coverage). The
intersection of "no upcoming within 21d AND insufficient history" is
~98% of russell2k.

**Evidence:**
- File: `netlify/functions/analysts/core.ts`
- Lines: 111-140 (full body); 116-122 (upcoming branch); 124-129
  (history branch); 130-138 (final return)
- Sample: any russell2k ticker whose next earnings are > 21 days out
  AND has < 4 quarters of history returns `score = round(50 + 0/2) = 50`,
  `direction = 'neutral'`, `confidence = 0.4`. The audit's 98.89% mass
  at 50 is consistent.

**Resolution path:** When the threshold gates produce `raw === 0` AND
neither branch contributed meaningful data (no upcoming within window
AND history.length < 2), emit `signals._noData = true,
signals._reason = 'no_actionable_data'`. Tickers with > 21d to earnings
and ≥ 4 quarters of clean history (none beat/missed enough to
contribute) legitimately score 50 and should continue to do so; only
the no-actionable-data branch is null.

**Predicted post-repair stdev:** ~7-10 (the bulk of the 50-pile is
no-data; once `_noData` is set the surviving distribution preserves
its existing variance among tickers that DO have signal).

### macro-regime (Target Board, 7% weight)

**Verdict:** Stub (stdev 0.00, 100.00% exactly 50, 1 unique score across 3600 obs)
**Root cause:** `no_upstream` — the analyst computes
`score = round(50 + macroBias * 20)` (`analyst-runner.ts:146`), but
`macroBias` defaults to 0 (`analyst-runner.ts:70`) and is never set
by any current caller. The macro signal source the parameter was
designed to consume was never wired in. Score is therefore literally
constant at 50 for every observation in every snapshot.

**Evidence:**
- File: `netlify/functions/shared/analyst-runner.ts`
- Lines: 70 (default param `macroBias = 0`), 146-154 (compute), 77
  (destructure with default).
- Audit confirms: 3600 observations, 1 unique value, stdev 0. There is
  no condition under which this analyst can produce a non-50 score on
  the current call path.

**Resolution path:** Permanent removal. Set
`ANALYST_WEIGHTS['macro-regime'] = 0` in `analyst-runner.ts`. The
freed 7% redistributes proportionally to the remaining 9 analysts via
`composeWeights`. A future Phase 4g can re-introduce a real macro
regime signal (e.g., from a regime classifier reading SPY/VIX/yield
curve at scan time) if the design intent for this slot is to come back.

**Predicted post-repair state:** REMOVED from composite; UI shows
struck-through "REMOVED" badge.

### patent-analyst (Target Board, 6% weight)

**Verdict:** Stub (stdev 0.00, 100.00% exactly 50, 1 unique score across 3600 obs)
**Root cause:** `no_upstream` for russell2k. The Quiver Patents dataset
(`patent-provider.ts:1-15` — covers USPTO grants mapped to public
tickers) is empirically empty for ~all russell2k names. Russell 2000
constituents are mostly small-cap operating companies that don't file
many patents or aren't covered by Quiver's ticker mapping. The
audit's 1 unique value across the russell2k slice is consistent with
"upstream returns empty array for every ticker".

PR #27 added the `_noData` wrapper at `analyst-runner.ts:120-128`,
so post-merge snapshots will correctly null-skip these tickers and the
% exactly 50 will drop to near 0 in russell2k. But composite weight
of 6% still flows toward zero-data tickers via the rescale, and the
analyst is functionally a null for russell2k.

**Evidence:**
- File: `netlify/functions/shared/analyst-runner.ts` (wrapper at 120-128)
- File: `netlify/functions/shared/patent-provider.ts:1-15` (Quiver
  ticker-mapped coverage notes)
- Largecap target audit had 0 observations sampled (`Snapshots scanned: 0`)
  so largecap coverage is unverified; Quiver patents *should* cover
  S&P 500 names but this audit can't confirm it.

**Resolution path:** Per the kickoff prompt's explicit instruction
("macro-regime and patent-analyst are strong candidates"), set
`ANALYST_WEIGHTS['patent-analyst'] = 0` for permanent removal. This is
a deliberate over-correction relative to per-universe optimal because:
(a) russell2k empirically has no upstream signal; (b) the audit lacks
largecap data to defend keeping it; (c) `composeWeights` rescale costs
~6% of largecap composite which the other analysts absorb cleanly;
(d) follow-up Phase 4g can reintroduce a per-universe weight table if
largecap patent signal is recovered.

**Predicted post-repair state:** REMOVED from composite.

### flow-analyst (Target Board, 10% weight)

**Verdict:** Degraded (stdev 3.93, 7.44% exactly 50, 22 unique scores)
**Root cause:** `threshold_misconfig` — `runFlow` in `core.ts:57-106`
produces a real signal (`raw = concScore + advScore + closeScore` with
component ranges ±25/±12/±20), but the final mapping
`score = round(50 + raw/2)` compresses the output: typical russell2k
values cluster `raw ∈ [-20, +20]` → scores 40-60, yielding stdev ~4.

**Evidence:**
- File: `netlify/functions/analysts/core.ts:57-106`
- Lines: 70 (`concScore = (conc / 20) * 25`), 75-76 (`advScore` ±12),
  82 (`closeScore = (closeStr - 0.5) * 40`), 95 (`score = 50 + raw/2`).
- Mean 54.41 confirms a slight bullish bias but compressed distribution.
- The signal IS being computed (low % exactly 50, 22 unique values);
  it's just visually quiet.

**Resolution path:** **Deferred to Phase 4g.** A retune of the score
mapping (e.g., `50 + raw`, no division) would expand stdev but also
change the composite calibration. Backtest comparison would be needed
to validate the new scale doesn't hurt rank correlation — exactly the
work the W6 step is blocked on by 4e-1's bg-function dispatch bug.
Documented here as `threshold_misconfig` so the follow-up phase has
the diagnosis it needs.

**Predicted post-repair stdev:** ~7-8 with `score = 50 + raw` (not
applied in this PR).

### technical-analyst (Target Board, 15% weight)

**Verdict:** Degraded (stdev 3.20, 0% exactly 50, 18 unique scores)
**Root cause:** `threshold_misconfig` — similar compression pattern
to flow-analyst. The technical layer produces real continuous signal
(0 mass at exactly 50 confirms no fall-through to the default) but
the range is compressed to ~71 ± 3 across russell2k. Low-cap technicals
are genuinely less differentiated (smaller swings on the same
indicator scale), so this is a calibration issue rather than a
handler defect.

**Resolution path:** **Deferred to Phase 4g** alongside flow-analyst.
Both need a coordinated retune against a backtest sanity check, which
is gated on W6 being unblocked.

**Predicted post-repair stdev:** ~6-8.

### catalyst (Prophet × largecap, 30% weight)

**Verdict:** Degraded (mean 36.17, stdev 4.84, 0% exactly 50, **93.06% pctFailing**)
**Root cause:** Not a defect — this is **expected behavior**. The
catalyst layer (`prophet-layers.ts:855-923`) starts at `score = 30`
and only adds bonuses when concrete catalysts fire (insider clusters,
political flow, gov contracts, patent bursts, post-earnings drift,
etc.). The `pass = score >= 40 && ...earnings>3d` gate means a ticker
needs a catalyst stack worth ≥10 bonus points to pass — by design,
93% of large-caps don't have actively firing catalysts on any given
day. Mean 36 + stdev ~5 reflects the realistic catalyst distribution.

**Evidence:**
- File: `netlify/functions/shared/prophet-layers.ts`
- Lines: 855-859 (base score), 919-922 (pass gate)
- The 0% exactly 50 confirms the layer is computing real signal;
  the 93% pctFailing reflects a deliberately selective catalyst gate.

**Resolution path:** **No action.** Re-classify as Live with intent
notes in the post-merge audit. The audit's degraded verdict is from
the % failing threshold which the layer is calibrated to exceed.
Flagging this clearly so the next phase doesn't try to "fix" it.

**Predicted post-repair stdev:** Unchanged; the layer is correct.

### volatility (Prophet × russell2k, 6% weight)

**Verdict:** Degraded (stdev 16.98, 34.66% exactly 50, 10 unique scores)
**Root cause:** `threshold_misconfig` — `layerVolatility` in
`prophet-layers.ts:500-548` uses thresholds calibrated to large-cap
ATR ranges (1.5%-4% ATR = sweet spot, >6% = penalized). For russell2k
tickers with low daily liquidity and ATR% < 1.5%, the layer subtracts
10 from base 50, producing score 40 + other modifiers. Various
combinations of modifiers can sum to exactly 50:
- `atrPct ∈ [1.5, 4]` (+15) + `volRatio > 1.5` (-15) → 50
- `atrPct < 1.5` (-10) + `recentSqueeze` (+15) + `volRatio > 1.5` (-15) → 40
  (only the first combination hits exactly 50)

Several other near-50 cancellations are possible. The 34.66% mass at
50 indicates russell2k's volatility regime frequently triggers the
``+15 vol sweet spot ... -15 vol_ratio expanding'' offsetting pattern.

**Evidence:**
- File: `netlify/functions/shared/prophet-layers.ts:500-548`
- Lines: 536-545 (score adjustments)
- stdev 16.98 confirms substantial real signal; the issue is the
  pile-at-50 from cancellation.

**Resolution path:** **Deferred to Phase 4g.** Retuning vol thresholds
for the russell2k regime is a non-trivial calibration that needs the
W6 backtest comparison to validate. Documented here so the next phase
inherits the diagnosis. (Possible fix: scale the +15/-15 modifiers
asymmetrically so cancellation produces a slightly off-neutral score,
preserving the directional information.)

**Predicted post-repair stdev:** ~14-15 with cleaner mid-bucket
distribution.

---

## § 3 — Actions taken in this PR (4f-finish)

**W3 repairs applied:**
1. `runNewsSentiment` in `analysts/core.ts` — adds `signals._noData`
   when `news.length === 0` (was returning `score=50, confidence=0`
   silently). Classification: `null_default` extension beyond PR #27.
2. `runEarnings` in `analysts/core.ts` — adds `signals._noData` when
   neither the upcoming-earnings nor history-based branches
   contribute (raw stays 0 due to no actionable data, not due to
   real neutral signal). Classification: `threshold_misconfig` /
   `null_default` hybrid.
3. `runFundamental` in `analysts/core.ts` — adds `signals._noData`
   when `f === null` (was returning `score=50, confidence=0`).
4. `runFlow` in `analysts/core.ts` — adds `signals._noData` when
   `bars.length < 30` (was returning `score=50, confidence=0`).

**W5 permanent removals (set weight to 0):**
- `macro-regime` — `no_upstream`, score never deviates from 50.
- `patent-analyst` — `no_upstream` for russell2k (the dominant audit
  slice); largecap unverified but the per-ticker `_noData` wrapper
  from PR #27 means the rescale absorbs the loss cleanly.

**W5 UI:** added `src/components/AnalystContributions.jsx` with
LIVE / NO DATA / REMOVED badge logic, consumed by `TargetBoardView`.

**Options-unusual wiring:** `scan-institutional-flow-largecap.ts` now
calls `computeOptionsFlowSignal` per ticker with a Polygon
snapshot-derived `OptionsTickWindow`. See § 4 for the partial-data
caveat (tick-level trades remain a follow-up; OI-spike signal lands
immediately).

**W6 (backtest pre/post comparison):** **SKIPPED**, gated on
Phase 4e-1-finish's background-function dispatch bug being resolved.
The backtest harness CLI (`scripts/run-portfolio-backtest.ts`) and
`/api/portfolio-backtest/start` endpoint are unable to dispatch
runs as of 4f-finish commit time; without that infra a meaningful
pre/post IC comparison is impossible to produce. The W6 deliverable
moves to a follow-up PR once 4e-1-finish lands. The kickoff explicitly
authorizes this skip ("W6 is a sanity check, not a gate"); the
shipped W3/W5 changes are honest about no-data conditions even
without a backtest delta to validate the IC direction.

## § 4 — Options-unusual wiring caveat

`computeOptionsFlowSignal`'s composite is the average of three
sub-scores: direction (premium-derived), flow_intensity
(sweep+block counts), and oi_intensity (OI-spike strike count).
The Polygon `/v3/snapshot/options/{underlying}` endpoint provides
the per-strike open interest and the day's volume, which is what
the OI-spike + heuristic detection consume. Per-contract tick
trades (needed to detect sweeps and aggressive blocks accurately)
are deferred to a follow-up that builds the per-contract trade
fetcher. Until then, sweepCount and blockCount in the cached
signal will be 0 by construction, and unusualScore is OI- and
direction-dominated.

This is a known partial state. The scan still writes a real signal
to Firestore daily; consumers should treat the OI-spike component
as the live channel and the trade-derived components as
forthcoming.

## § 5 — Re-audit plan

A second audit run scheduled for ~2026-06-15 (one month post 4f-finish
deploy) should reclassify:
- insider, political, news-sentiment, earnings, fundamental, flow
  → Live (stdev > 5, % exactly 50 < 25%) for the no-data tickers
  now correctly null-skipped.
- macro-regime, patent-analyst → REMOVED (weight 0 in BASE_WEIGHTS).
- catalyst (Prophet × largecap) → expect to re-classify as Live with
  intent notes once the audit framework distinguishes "selective by
  design" from "broken".
- technical (Target × russell2k), volatility (Prophet × russell2k),
  flow (Target × russell2k) → remain Degraded pending threshold
  retunes in Phase 4g.

