# Track 1 — Analyst/Scoring Layer (netlify/functions)

24 findings: 2 critical, 8 major, 14 minor. Paths relative to
`netlify/functions/`.

## A. CRITICAL — real bugs that materially corrupt scores

**[C1] Earnings "reactions" are measured around fiscal-period-end, not report
dates — poisons the whole earnings board.**
`shared/scan-earnings.ts:208-220`, `shared/data-provider.ts:873`,
`shared/earnings-intel.ts:128-135`
getEarningsHistory maps `date: r.period` — Finnhub's `period` is the fiscal
quarter END (e.g. 2025-03-31), not the announcement date (which lags 2-8
weeks). scan-earnings then finds the bar nearest h.date and takes the
T-1→T+1 move as the "earnings reaction". So priorMoves / avgPriorMove /
moveRatio / historicalEdge / the postPrint PEAD+reversal classification
(surprise paired with lastMove at scan-earnings.ts:255-270) are all computed
on price windows ~1 month away from the actual print — essentially random
2-day moves. Same root cause makes earnings-intel.postEarningsDrift
(daysSince period-end in [3,14]) fire at the wrong time or never: 3-14 days
after quarter end the report usually isn't even out. Fix: source
announcement dates (Finnhub earnings calendar keeps them), or persist report
dates alongside surprises; never window on `period`.

**[C2] technical analyst's ema200 degenerates to "latest close" — trend term
is sign-INVERTED in every production target scan.**
`analysts/technical.ts:14,30-31,67-73`; `shared/analyst-runner.ts:25-28`
ema() falls back to `xs.at(-1)` when xs.length < period. fetchBarCache
fetches 220 CALENDAR days ≈ 150 trading bars, so ema200 == latest close
always. The check `if (ema50 > ema200) raw += 10; else raw -= 10` becomes
`if (ema50 > latestClose)` — i.e. +10 when price is BELOW its 50-EMA and −10
when above. A 20-point swing (raw is ±100 → ±10 score points) applied
backwards on every ticker, every scan. Rationale "uptrend intact" is also
near-unreachable. Fix: have ema() return null on insufficient data and skip
the term, and/or fetch ≥300 calendar days.

## B. MAJOR — wrong outputs, dead signal paths, methodological breaks

**[M1] topSignals/rationale pick the WEAKEST evidence for shorts.**
`shared/analyst-runner.ts:211-215, 384-389`
For direction 'short' the aligned contributions are sorted `b.score - a.score`
(descending). On a 0-100 bullishness scale the most bearish analyst has the
LOWEST score, so shorts surface their least convincing contributors and quote
those rationales. Sort ascending when direction === 'short'.

**[M2] Earnings vol-play classification is an artifact of daysUntil, and "IV"
contains no implied vol.**
`shared/scan-earnings.ts:196-203, 222-224, 272-298`
expectedMove = rv20×100×sqrt(horizonDays/365): (a) mixes √252 trading-day
annualization with calendar-day scaling; (b) horizonDays is days UNTIL the
report, so expectedMove is the move over the waiting period, while
avgPriorMove ([C1] aside) is a 2-day event move. The comparison
movesBig/movesContained therefore flips with event distance: far-out events
systematically classify short_volatility, imminent ones long_volatility.
Also ivr is realized-vol rank, not IV — "sell premium, IV rich"
recommendations are emitted with zero options data. Fix: compare event-window
moves to an event-horizon expected move (rv20/√252 × √2), and rename/replace
ivr with real IV (Polygon options snapshot exists in this repo under
institutional-flow/).

**[M3] 'reversal' play emits short-side triggers for long-side setups.**
`shared/scan-earnings.ts:266-269, 503-511, 600-615`
reversal fires when sign(lastMove) != sign(surprise) — includes
gap-DOWN-on-beat, where the fade is a LONG. computeTriggers/reversalSteps
hardcode the short direction (stop = price×1.04, targets below, "SHORT
shares"). Half the reversal candidates get inverted trade instructions.

**[M4] Two of seven technical setups can never fire in catalyst scans.**
`shared/technical-setups.ts:79,119-145,152-161`; `shared/scan-catalyst.ts:92`
multi_tf_aligned and oversold_bounce require ema200 (bars.length>=200), but
the catalyst scan fetches 220 calendar days (~150 bars). Both are permanently
dead → hasStackedSetup and the 0.30-weight setup component in catalyst-scorer
run on a 5-setup deck while the comments/weights assume 7.

**[M5] Lynch PEG uses uncapped single-quarter YoY EPS growth.**
`styles/lynch.ts:63`; `shared/data-provider.ts:478-481`;
`styles/lynch-signal.ts:159-169`
epsGrowthYoY is latest-quarter vs year-ago-quarter. A base-effect rebound
(+300% off a depressed comp) gives PEG≈0 → automatic +40 "cheap for growth",
and the fair-value band becomes ttmEps × 300 (fair P/E 300). Lynch's rule
assumes a sustainable multi-year growth rate. Fix: use TTM-vs-prior-TTM EPS
(both already computed in data-provider:461-472) or a multi-year CAGR, and
clamp the growth rate used for PEG/fair-PE to ~10-40%.

**[M6] macro-regime is computed, piped, and then multiplied by zero.**
`shared/scan-target.ts:166-167`; `shared/analyst-runner.ts:80,176-184`
scan-target calls computeRegime()/regimeToMacroBias() on every scan and
threads macroBias through, but ANALYST_WEIGHTS['macro-regime']=0, so it never
affects the composite. Wasted upstream calls plus a misleading "risk-on
tailwind" analyst row. Also note composeTarget puts zero-weight analysts
(macro, patent) into scoredAnalysts (only _noData is excluded) — the UI's
"scored" list overstates what actually contributed.

**[M7] Imminent earnings is encoded as a bearish directional vote.**
`analysts/core.ts:138-139,164-168`
"earnings in ≤5d" → raw −30 → direction 'short', confidence up to 0.7. Event
risk is not direction: it produces phantom short votes that flip
conflictLevel to moderate/severe and cap tiers on coherent bullish names.
Better: keep score 50/neutral and cut confidence (or expose a separate risk
flag), reserving direction for the beats-history signal.

**[M8] Provider failures are scored as genuine neutral data.**
`shared/insider-provider.ts:157`; `shared/political-provider.ts:169-171`;
`shared/govcontracts-provider.ts:117-119`; `shared/scan-catalyst.ts:101-108`
All three providers catch every error and return the `empty` activity object,
so the analyst-runner's _noData branch (which checks for null) and
scan-catalyst's `if (!insider || ...)` guard are dead. A Quiver/Finnhub
outage silently becomes "no insider activity, conf 0.1" instead of
weight-rescaled no-data — exactly the stub-score problem Phase 4f was built
to eliminate. Fix: return null (or a status envelope) on transport errors;
reserve `empty` for verified-empty responses.

## C. MINOR

- [m1] `analysts/technical.ts:19` — bbPos divides by (upper−mid)=2σ; flat
  tape (σ=0) → Infinity/NaN propagates into raw/score (Math.round(NaN)).
- [m2] `analysts/core.ts:76-82` — flow concordance loop has 19 samples but
  normalizes by 20 (off-by-one, mild downward bias).
- [m3] `analysts/core.ts:177-178,201-202` — substring sentiment keywords:
  'contract' (bullish) matches "contraction", 'miss' matches "dismissal".
  Use word boundaries.
- [m4] `analysts/insider.ts:11-12` + `insider-provider.ts:245-257` — max
  negative raw is −10 → min score 40, so the 'short' branch (score<40) is
  unreachable; insider can never dissent bearish in conflict counting.
  Dollar thresholds ($250K/$1M/$5M) are absolute — a $1M buy means very
  different things for a $300M small-cap vs AAPL; normalize by market cap.
- [m5] `shared/scan-target.ts:204-213,292-316` — pass-1 preScore is long-only
  and filters score>0, so the target board structurally cannot surface shorts
  even though composeTarget supports them; "52w high" is actually a ~150-bar
  window (slice(-252) of a 220-calendar-day fetch) and sma200 is always null
  there too.
- [m6] `shared/scan-lynch.ts:110`, `shared/scan-williams.ts:98` — side =
  score >= 0 ? 'long' : 'short': a 0 score (no data) is labeled long.
- [m7] `styles/lynch.ts:159-185` + `scan-lynch.ts:92-94` — market-cap bias
  and the "insider-buying proxy" branches are dead in production (inputs
  always undefined). Ironically Lynch is the one board NOT consuming the real
  insider provider this repo already has.
- [m8] `shared/technical-setups.ts:80,266` — dead locals (bbNow, recent);
  :301-313 — neutral setups add 0.5×pts to BOTH longPts and shortPts, which
  cancels exactly in net: compression has zero effect on scoreSetups despite
  the comment claiming amplification.
- [m9] `styles/williams.ts:86-90` — "first 3 trading days of month"
  implemented as calendar day ≤ 3; comment at :111 says "halve" but code
  ×0.4. `score-breakdown.ts:60-66` — seasonality nominal weight 13 exceeds
  the max achievable tilt (11). Presentation-only but drifts from reality.
- [m10] `shared/earnings-intel.ts:184-194` — docstring weights diverge from
  code (+30 doc vs +25 code, etc.); drift comment says 3-10 trading days,
  code uses 3-14 calendar.
- [m11] `shared/insider-provider.ts:180-214` — greedy non-overlapping 14d
  cluster windows anchored at the first buy can split a real cluster in two.
- [m12] `shared/scan-insider.ts:481-499` — filterRowsToWindow reuses
  scan-time daysSince against the caller's `now`, and topBuyer falls back to
  a buyer whose filings may be outside the re-filtered window.
- [m13] `analysts/sector-rotation.ts:54-59` — rel() aligns by array index,
  not date; tickers with missing bars (halts/IPOs) compare misaligned windows
  against the ETF/SPY series.
- [m14] `shared/analyst-runner.ts:336-337` — double clamp is harmless but
  rawComposite (50 + signedNet×1.5) caps at 125/−25 pre-clamp; asymmetric
  headroom is intentional-looking but undocumented.

## D. ALGORITHM-DESIGN ASSESSMENT

- **composeTarget** (analyst-runner.ts): conceptually sound post-4s — signed
  confidence-weighted deviation, conflict dampening, tier caps. Weak spots:
  hand-set weights with no validation loop (the 4f audit pruned dead analysts
  but never fit the survivors' weights to forward returns); confidence scales
  are analyst-specific and unnormalized (flow caps 0.85, others 1.0), so a
  weight×confidence product silently re-weights analysts. Improvement:
  z-score each analyst's raw signal cross-sectionally per scan, then
  fit/shrink weights on the W1-audit observation set instead of asserting
  them.
- **Williams** (styles/williams.ts + williams-signal.ts): internally
  consistent and the confluence-gated discrete layer is good practice. The
  %R "turn" uses a single-day jump (−70→−50) — very noisy; require 2-day
  confirmation or smooth %R. Volatility breakout uses today's intraday high
  vs yesterday's trigger — by the time the nightly scan publishes, the entry
  is stale; publish the trigger LEVEL for tomorrow instead of a fired flag.
- **Lynch** (styles/lynch.ts): right pillars, wrong growth input ([M5]);
  also earnings "consistency" from 4 quarters of beats is analyst-game
  noise, not Lynch's 5-year steadiness — TTM EPS series slope/variance would
  be closer.
- **Insider** (insider-provider.ts): excluding code 'A' awards and
  clustering 'P' buys is the right call and matches the literature. Add
  market-cap scaling ([m4]) and weight by buyer role now that EDGAR
  enrichment exists.
- **Catalyst** (catalyst-scorer.ts): weight redistribution after the patent
  403 is documented and sane; but confidence multiplies every component
  except setup (:99), giving the technical timing layer an effective
  outsized share when fundamentals confidence is low — multiply setup by a
  strength-derived confidence too.
- **Political** (political-provider.ts): direction from net trade COUNT
  ignores disclosed dollar ranges except the single whale bonus;
  amount-weighted net flow would be more faithful to the Ziobrowski-style
  evidence. The 45-day STOCK Act disclosure lag is documented for backtests
  but the LIVE path also treats trades as known at transaction date —
  congress trades from the last 45d may not have been public when scored.

## E. TESTS REVIEW

- Good: `shared/__tests__/analyst-runner-composite.test.ts` genuinely pins
  the O-I Glass directional regression, dampening monotonicity, no-data
  rescale. compose-weights.test.ts math is solid. styles/__tests__/
  lynch-signal & williams-signal tests are behavioral and correct (ATR
  hand-check, confluence gates, trend veto). core-analysts-no-data.test.ts
  and earnings-intel-beats.test.ts assert the right contracts. No test found
  asserting WRONG behavior in this layer.
- Caveats: compose-weights.test.ts uses non-production base weights (macro
  0.07/patent 0.06), so the production zero-weight path is untested.
  score-breakdown test's "components sum exactly to score" only holds
  because the dead Lynch branches ([m7]) never fire. earnings-intel test
  fixtures use `date` values that read like report dates, baking in the
  period-end confusion of [C1] without catching it.
- Coverage gaps map exactly onto the buggiest code: NO tests for
  runTechnical (would have caught [C2]), technical-setups/scoreSetups
  ([M4], [m8]), catalyst-scorer, scan-earnings classification/triggers
  ([C1],[M2],[M3]), insider/political/contract scoring functions, or
  sector-rotation.

## F. SUMMARY

Architecture is genuinely good for this layer: pure scoring functions,
shared scan orchestrators, honest no-data/weight-rescaling machinery, and
the tested parts (composite math, discrete signals) are the strongest.
Quality is two-tier: code covered by Phase-4s/4m tests is correct; code
without tests carries serious defects. Recurring failure modes to fix
systemically: (1) silent fallbacks (ema → last value, provider error →
empty activity) instead of explicit nulls; (2) calendar-days vs trading-days
conflation (220d fetch vs 200-bar indicators, vol scaling); (3)
hand-asserted weights/thresholds with no validation harness. Recommended
order: C1, C2, M3, M1, M8, then the methodology items.
