# Phase 4n — Williams discrete-signal backtest verdict

**Verdict:** PENDING — wiring landed in this PR; live numbers populate
on the first credentialed run per [`runbook.md`](./runbook.md).

**Signal under test:** the discrete Williams trade signal landed in
Phase 4m, W1 — BUY/SELL/HOLD derived from indicator confluence (%R
reversal + volatility breakout + closing strength + trend gate), with
volatility/ATR-based entry, stop (2× ATR), and target (3R from entry).

**Universe:** S&P 500 (per brief PART X, the cleanest PIT bars).
**Window:** 2018-01-31 → 2024-12-31 (matches the Prophet verdict
backtests for comparability).
**Rebalance:** weekly (Williams' 3–10 day swing horizon).
**Portfolio:** top-20, equal-weighted, BUY-verdict only
(`discreteSignalOnly: true`).
**Costs:** 5 bps slippage per leg, $0 commission.
**Benchmark:** SPY.

## PIT integrity

**PIT-clean.** Williams' inputs are price bars only; daily bars do not
get restated. See [`pit-integrity-attestation.md`](./pit-integrity-attestation.md).
No look-ahead bias caveats apply.

## Results (PENDING)

| Metric | Williams BUY | SPY | Excess |
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
| Target-hit-before-stop rate | __ | n/a | n/a |

## Verdict criteria

**VALIDATED** if Sharpe beats SPY by ≥ 0.2 over the full window AND
total return exceeds SPY by ≥ 5%. Otherwise **NOT VALIDATED** — which
is itself a useful result (the discrete signal does not produce
risk-adjusted alpha, stop acting on it).

## How to populate

See [`runbook.md`](./runbook.md). After a credentialed
`npx tsx scripts/run-backtest.ts --config configs/williams-sp500-2018-2024-weekly-top20.json`
run, paste the metrics into the table above and replace this
"PENDING" line with the verdict line.
