# Phase 4n — Lynch discrete-signal backtest verdict

> ⚠️ **Restatement caveat applies.** This backtest's filing-date filter
> is PIT-correct, but Polygon may serve restated fundamentals for past
> filings. Numbers in this report are indicative; magnitudes are
> potentially optimistic. See
> [`pit-integrity-attestation.md`](./pit-integrity-attestation.md) for
> the full attestation. Do **not** treat these as clean PIT until the
> fundamentals snapshot store ships.

**Verdict:** **NOT VALIDATED.** Lynch BUY-only returned 6.92% total
over 2018-01-31 → 2024-12-31 vs SPY 107.90% — the strategy
effectively sat in cash for ~6 of the 7 years. Only 3 of an expected
~28 quarterly rebalances produced any BUY-verdict candidates that
passed the filter; the first executed rebalance was 2024-04-24.
*(The restatement caveat still applies — but the verdict here is not
about restatement risk; the signal simply does not fire on the S&P
500 across 2018-2023.)*

**Signal under test:** the discrete Lynch investment signal landed in
Phase 4m, W2 — BUY/HOLD/AVOID derived from PEG + earnings consistency
+ revenue sweet spot + debt-to-equity, with a fair-value band (PEG
≈ 1.0–1.5) and a fundamental-invalidation list. **No price stop** —
Lynch was a GARP buy-and-hold investor; price stops misrepresent the
strategy.

**Universe:** S&P 500 (per brief PART X — cleanest PIT fundamentals).
**Window:** 2018-01-31 → 2024-12-31.
**Rebalance:** quarterly (matches Lynch's 6–24 month horizon — one
decision per filing cycle).
**Portfolio:** top-20, equal-weighted, BUY-verdict only
(`discreteSignalOnly: true`).
**Costs:** 5 bps slippage per leg, $0 commission.
**Benchmark:** SPY.

## PIT integrity

**PIT-correct on filing dates** — every `getFundamentals` and
`getEarningsHistory` call from the scoring path threads `asOfDate`,
filters server-side via Polygon's `filing_date.lte`, and re-filters
in-memory using the estimated-filing-date fallback when Polygon
omits `filing_date`. Tests in
`netlify/functions/shared/backtest/__tests__/score-at-date-williams-lynch.test.ts`
assert this on every fetch.

**Residual restatement risk** — Polygon's
`/vX/reference/financials` silently incorporates issuer restatements
into past filings. The agent scoring 2021-Q3 today sees 2021-Q3
financials as restated up to today, not as publicly known on
2021-Q3. This is documented in `data-provider.ts`, in
[`pit-integrity-attestation.md`](./pit-integrity-attestation.md),
and surfaced on each Lynch ScoredCandidate via
`metadata.pitCaveat = 'restatement-risk: Polygon may serve restated
fundamentals'`. Constraining to S&P 500 minimizes magnitude (large-
cap restatements are smaller and rarer than small-cap), but cannot
eliminate it without a fundamentals snapshot store.

## Results

Run: `bt_20260519014419_litbxp` (Phase 4r W2 — fired server-side via
`/api/backtest-runs/start` against deploy-preview-46, completed
2026-05-19T01:56:09Z, 12 min wall-clock).

| Metric | Lynch BUY | SPY | Excess |
|---|---:|---:|---:|
| Total return | **6.92%** | 107.90% | **−100.98 pp** |
| CAGR | 0.97% | ~11.0%* | −10.0 pp |
| Sharpe | 0.4189 | ~0.60* | ~−0.18 |
| Sortino | 0.1395 | — | — |
| Max drawdown | 5.68% | ~34%* | better |
| Win rate | 72.22% | n/a | n/a |
| Profit factor | 2.593 | n/a | n/a |
| Rebalances executed | **3 of ~28**† | n/a | n/a |
| Trade count | 29 | n/a | n/a |
| Information ratio | −0.5921 | n/a | n/a |
| Information coefficient | −0.0612 | n/a | n/a |
| Avg win % | 10.79% | n/a | n/a |
| Avg loss % | −10.82% | n/a | n/a |
| Avg holding period | not exposed by engine metrics‡ | n/a | n/a |
| % candidates inside fair-value band | not exposed by engine metrics‡ | n/a | n/a |

\* SPY 2018-2024 Sharpe/CAGR/maxDD are external estimates — the run's
`benchmark` object only carries SPY's total return (107.90%) for this
window.

† **Critical finding.** Across the full 7-year window only **3
quarterly rebalances** produced any BUY-verdict Lynch candidates that
passed the portfolio's `minComposite: 30` filter: 2024-04-24,
2024-07-24, 2024-10-23. For the other ~25 quarterly rebalances
(2018-Q1 through 2024-Q1) the portfolio sat 100% in cash. This is
the dominant signal in the result — small win rate and profit factor
on the executed trades, but the strategy *did not engage* with the
market for 6 of 7 years.

‡ Avg holding period and the fair-value-band candidate share are not
in the standard BacktestResult metrics — they would need engine
extension. Out of scope for Phase 4r W2.

### Per-regime breakdown

| Regime | Rebalances | Total return | Sharpe |
|---|---:|---:|---:|
| neutral | 1 | −3.69% | −2.20 |
| risk_off | 2 | 10.59% | 3.38 |

Only 3 executed rebalances total — bucketed across 2 regimes. The
risk_off bucket's high Sharpe is on a sample of 2; not meaningful.

## Discrete-signal vs score-ranked baseline

Baseline run: `bt_20260519014435_71ak9q` (same config,
`discreteSignalOnly: false`), completed 2026-05-19T01:56:13Z.

| Metric | Lynch BUY-only | Lynch score-ranked | Delta |
|---|---:|---:|---:|
| Total return | 6.92% | 20.35% | +13.42 pp (baseline) |
| Sharpe | 0.4189 | 0.6239 | +0.205 (baseline) |
| Max drawdown | 5.68% | 8.49% | −2.81 pp (BUY-only) |
| Win rate | 72.22% | 71.43% | ~tie |
| Rebalances executed | 3 | 5 | +2 (baseline) |
| Trade count | 29 | 53 | +24 (baseline) |

**The discrete BUY threshold is too restrictive** — dropping it (i.e.
ranking by composite score and taking topN) doubles the executed
rebalances, more than triples the total return, and meaningfully
improves Sharpe. The discrete signal is taking value away rather than
adding it on this configuration.

**Both** the BUY-only and the score-ranked baseline still
catastrophically underperform SPY's 107.90%. The score-ranked
baseline gets 20.35% — better than BUY-only but still nowhere near
the benchmark. The signal as currently calibrated does not produce a
viable Lynch-style portfolio on the S&P 500 across this window.

## Verdict criteria

**VALIDATED (with restatement caveat)** if Sharpe beats SPY by ≥ 0.2
over the full window AND total return exceeds SPY by ≥ 5%, AND the
result holds after a sensitivity check (recomputing with the most
recent 2 years dropped — those are the years most likely to still
get restated). The caveat stays printed at the top of this file
regardless of the verdict, until the snapshot store closes the
residual risk.

This run: Sharpe-over-SPY ≈ −0.18 (fails); total-return-over-SPY =
−100.98 pp (fails). **NOT VALIDATED** — useful negative result. And
since only 3 of 28 quarterly rebalances even produced candidates,
the more honest framing is "**the discrete Lynch signal does not
fire on the S&P 500 across 2018-2023**." That is information.

**NOT VALIDATED** if either threshold fails — a useful negative
result. The discrete Lynch signal is unproven, stop acting on it.

## How to populate

See [`runbook.md`](./runbook.md). After a credentialed
`npx tsx scripts/run-backtest.ts --config configs/lynch-sp500-2018-2024-quarterly-top20.json`
run, paste the metrics into the table above and replace this
"PENDING" line with the verdict line. **Keep the restatement caveat
banner at the top regardless of the result.** For Phase 4r W2 the
run was fired server-side via `/api/backtest-runs/start` against the
PR-#46 preview deploy.
