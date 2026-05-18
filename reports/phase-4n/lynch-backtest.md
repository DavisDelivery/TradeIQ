# Phase 4n — Lynch discrete-signal backtest verdict

> ⚠️ **Restatement caveat applies.** This backtest's filing-date filter
> is PIT-correct, but Polygon may serve restated fundamentals for past
> filings. Numbers in this report are indicative; magnitudes are
> potentially optimistic. See
> [`pit-integrity-attestation.md`](./pit-integrity-attestation.md) for
> the full attestation. Do **not** treat these as clean PIT until the
> fundamentals snapshot store ships.

**Verdict:** PENDING — wiring landed in this PR; live numbers populate
on the first credentialed run per [`runbook.md`](./runbook.md).

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

## Results (PENDING)

| Metric | Lynch BUY | SPY | Excess |
|---|---|---|---|
| Total return | __ | __ | __ |
| CAGR | __ | __ | __ |
| Sharpe | __ | __ | __ |
| Sortino | __ | __ | __ |
| Max drawdown | __ | __ | __ |
| Win rate | __ | n/a | n/a |
| Profit factor | __ | n/a | n/a |
| Rebalances | __ | n/a | n/a |
| Trade count | __ | n/a | n/a |
| Avg holding period | __ | n/a | n/a |
| % candidates inside fair-value band | __ | n/a | n/a |

## Verdict criteria

**VALIDATED (with restatement caveat)** if Sharpe beats SPY by ≥ 0.2
over the full window AND total return exceeds SPY by ≥ 5%, AND the
result holds after a sensitivity check (recomputing with the most
recent 2 years dropped — those are the years most likely to still
get restated). The caveat stays printed at the top of this file
regardless of the verdict, until the snapshot store closes the
residual risk.

**NOT VALIDATED** if either threshold fails — a useful negative
result. The discrete Lynch signal is unproven, stop acting on it.

## How to populate

See [`runbook.md`](./runbook.md). After a credentialed
`npx tsx scripts/run-backtest.ts --config configs/lynch-sp500-2018-2024-quarterly-top20.json`
run, paste the metrics into the table above and replace this
"PENDING" line with the verdict line. **Keep the restatement caveat
banner at the top regardless of the result.**
