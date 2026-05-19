# Backtest engine — honest limitations

Phase 4a delivers a walk-forward backtest engine with PIT integrity by
construction. It is not a perfect simulation of trading reality. This
document enumerates the residual limitations a serious user must
understand before acting on backtest output.

If your backtest result conflicts with your real-money intuition, the
honest first hypothesis is that **the limitation is biting you**, not
that you've found alpha.

## 1. Earliest start date is hardcoded to 2018-01-01

Polygon's plan tier does not reach pre-2018 reliably (fundamentals depth
in particular). The engine rejects any `startDate < 2018-01-01` outright
in `validateConfig`. There is no workaround in Phase 4a.

## 2. SP500 and NDX universes are current-seed only

The `UNIVERSE_HISTORY` table has a single snapshot per universe for
`sp500` and `ndx`, both stamped at the seed date (2026-05-07 / 2026-05-11
respectively in the Phase 3 build). **A backtest on these universes is
survivorship-biased.** Every result record carries a
`universeSurvivorshipCorrected: { corrected: false, ... }` stamp; the
engine emits a warning; the Phase 4b UI must gate the run with an
explicit disclosure.

Dow has 101 monthly snapshots (2018-01-31 through 2026-04-30) and is
fully survivorship-corrected over its window.

Russell 2000 has 52 monthly snapshots (2022-01-31 onward) and is
survivorship-corrected from then.

The Phase 3 runbook (`docs/UNIVERSE_HISTORY_RUNBOOK.md`) explains how to
extend SP500/NDX coverage when egress restrictions allow. Until then,
treat SP500/NDX backtest output as descriptive of the current universe
only.

## 3. Polygon ticker reference returns CURRENT sector / marketCap

Phase 3 marked sector and marketCap as not-as-of in the audit doc. Phase
4a uses the current sector for the sector-cap math, accepting drift as
a small residual (sectors change rarely; reclassifications are a few per
year across the SP500). MarketCap bucketing is stubbed to `null` in
`MLTrainingRow` rather than risk-inferring a wrong bucket from current
data — Phase 5 ML can read whatever's available.

## 4. Polygon fundamentals restatement drift

Companies restate prior periods (10-K/A, 10-Q/A). Polygon serves the
latest known restatement, not the as-of original. Phase 3 documented
this; Phase 4a inherits it. Magnitude is usually small but can matter
for outlier earnings or accounting fraud cases.

## 5. Quiver congressional STOCK Act 45-day forward-shift — handled

The engine routes every political-data fetch through
`getPoliticalActivityForBacktest(ticker, lookbackDays, asOfDate)` which
shifts `asOfDate` back by `STOCK_ACT_LAG_DAYS = 45` before calling the
provider. A trade with `TransactionDate = 2023-01-01` first becomes
visible at `asOfDate >= 2023-02-15`. This is the conservative worst-case
shift; actual filing delays vary but never exceed 45 days under the Act.

The Phase 4a integrity tests verify this against the brief's exact
synthetic scenario.

## 6. Finnhub recommendation history depth

The live recommendations endpoint returns roughly 4 months of history.
PIT before that depends on Phase 1's snapshot accumulation, which began
recently. Backtests longer than that for boards that lean on
recommendation history will see thin signal early in the window.

## 7. Transaction costs are modeled, not measured

The `costs.ts` slippage model is a flat basis-point cost per leg
(dow=3, sp500/ndx=5, russell2k=20). Real fills depend on participation
rate, ADV, intraday liquidity, and market impact curves none of which
Phase 4a simulates. The point is to make per-trade drag *visible*; a
high-turnover strategy that looks profitable before costs may not
survive realistic slippage. Round-trip drag on Russell positions runs
~40bps which is significant.

## 8. Daily bars only — no intraday execution

The engine marks equity at daily closes. Trade triggers at
`rebalanceDate` are assumed to execute at the same day's close (the bar
already in the dataset at that date). A more accurate model would
execute at next-day open with appropriate slippage; Phase 4a simplifies
to close-on-rebalance-day. The slippage model partially absorbs the
difference but not perfectly.

## 9. Long-only V1, no shorting

Long-only by design. Adding a short side requires borrow cost modeling,
hard-to-borrow detection, and Reg SHO restrictions — out of scope for
Phase 4a.

## 10. Multi-board scoring path

Phase 4a originally supported the **prophet** board only.
Phase 4m+4n (PR #41) added PIT-correct **williams** and **lynch**
scorers in `score-at-date.ts`. **Phase 4t W1** added the ten-analyst
composite (**target**) — see `reports/phase-4t/pit-audit.md` for the
per-factor PIT classification (5 PIT-clean, 3 PIT-with-caveat —
fundamentals + earnings-history restatement, news-coverage density;
2 excluded by weight=0 — patents and macro-regime, per the Phase 4f
no_upstream audit). The `backtest-runs-trigger` endpoint accepts
prophet, williams, lynch, and target. **catalyst** and **insider**
boards still return `null` from the per-ticker scorer and the trigger
rejects them with 400 to prevent silently biased results.

## 11. No meta-ranker / model in this phase

Phase 5 will train an ML model on the `mlTraining` subcollection
captured per run. Phase 4a captures the data shape (composite + layers
+ forward returns at multiple horizons + regime + sector) so Phase 5
doesn't need to re-run anything; it just reads from
`backtestRuns/{runId}/mlTraining/`.

## 12. No options, no futures, no FX

Equities only. Brief explicitly out-of-scope.

## 13. Cache assumes PIT data is immutable

Phase 3 establishes that PIT data is immutable by definition. The
`pit-cache.ts` Firestore-backed cache has no TTL. If a vendor changes
PIT semantics retroactively (e.g. Quiver re-keys their dataset), the
cache will serve stale values. Mitigation: set `PIT_CACHE_BYPASS=1`
env when verifying provider behavior; if a change is detected, manually
invalidate `pitCache` collection in Firestore.

## 14. Slow first run

A first-run Russell 2k 4-year backtest hits providers thousands of
times and will be slow regardless of concurrency limit. After cache
warms, subsequent runs of the same window are minutes. Plan first runs
overnight or with `scoringConcurrency` tuned for Polygon plan tier.
