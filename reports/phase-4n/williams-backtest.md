# Phase 4n — Williams discrete-signal backtest verdict

**Verdict:** **NOT VALIDATED.** Total return 34.46% vs SPY 107.90%
over 2018-01-31 → 2024-12-31 — underperformed SPY by ~73 percentage
points. Sharpe 0.6285 does not clear the bar (SPY's buy-and-hold
Sharpe is in the same neighbourhood for this window). Verdict
criteria below require Sharpe-over-SPY ≥ 0.2 AND total-return-over-
SPY ≥ 5%; neither is met. The discrete Williams signal does not
produce risk-adjusted alpha vs SPY on this configuration. *Useful
negative result — the brief (PART IV W2) explicitly asks for this
to be reported plainly when it happens.*

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

## Results

Run: `bt_20260519014409_zsxtsq` (Phase 4r W2 — fired server-side via
`/api/backtest-runs/start` against deploy-preview-46, completed
2026-05-19T03:16:34Z, 91 min wall-clock, 35 invocations,
checkpoint-resume held through the run).

| Metric | Williams BUY | SPY | Excess |
|---|---:|---:|---:|
| Total return | 34.46% | 107.90% | **−73.44 pp** |
| CAGR | 4.38% | ~11.0%* | −6.62 pp |
| Sharpe | 0.6285 | ~0.60* | ~+0.03 |
| Sortino | 0.5555 | — | — |
| Max drawdown | 15.31% | ~34%* | better |
| Win rate | 56.87% | n/a | n/a |
| Profit factor | 1.422 | n/a | n/a |
| Rebalances | 313 (of ~365) | n/a | n/a |
| Trade count | 1785 | n/a | n/a |
| Information ratio | −0.4618 | n/a | n/a |
| Information coefficient | +0.1199 | n/a | n/a |
| Recovery days from max DD | 489 | n/a | n/a |
| Avg win % | 3.50% | n/a | n/a |
| Avg loss % | −3.28% | n/a | n/a |
| Target-hit-before-stop rate | not exposed by engine metrics† | n/a | n/a |

\* SPY 2018-01-31 → 2024-12-31 Sharpe/CAGR/maxDD are external
estimates — the run's `benchmark` object only carries SPY's total
return (107.90%) for this window. The engine does not currently emit
SPY's per-period Sharpe alongside the strategy's. The Sharpe
comparison is rough but the totalReturn delta is unambiguous.

† The engine emits `trades` with `side`, `weight`, `slippage` etc.
but does not record per-trade exit reason (target-hit vs stop-loss
vs time-stop) on the BacktestResult schema. Surfacing it would need
a small engine extension — out of scope for Phase 4r W2.

### Per-regime breakdown

| Regime | Rebalances | Total return | Sharpe |
|---|---:|---:|---:|
| risk_on | 38 | 2.38% | 0.282 |
| neutral | 113 | 17.38% | 0.516 |
| risk_off | 78 | 18.06% | 0.419 |

Most of the strategy's nominal return came from neutral and risk_off
regimes (where SPY also did well). Risk-on contributed little,
suggesting the discrete BUY signal frequently sits out of the market
exactly when buying-and-holding would pay off most.

## Discrete-signal vs score-ranked baseline

**Baseline run could not complete on this configuration.** Run
`bt_20260519014434_pbfjtx` (same config, `discreteSignalOnly: false`)
failed at invocation 18 on 2026-05-19T02:28:44Z with:

```
3 INVALID_ARGUMENT: Document
'projects/tradeiq-alpha/databases/(default)/documents/
backtestRuns/bt_20260519014434_pbfjtx' cannot be written because
its size (1,086,304 bytes) exceeds the maximum allowed size of
1,048,576 bytes.
```

The score-ranked baseline emits `mlTraining` rows for every scored
candidate (29,039 rows accumulated before the failure vs. 929 for
the BUY-only run). The cursor's serialised `state` field grows with
each batch — for the sp500/weekly cadence this run hit Firestore's
1 MiB per-doc limit after ~50% completion. This is a separate engine
defect not in 4r W2's scope (the reinvoke chain itself worked — the
failure is in the run's persisted state shape). Logged as a finding
for future engine work.

**Consequence:** the discrete-signal-vs-continuous-score delta could
not be measured for Williams on this PR. Williams BUY-only is
reported against SPY directly. The Lynch comparison
([`lynch-backtest.md`](./lynch-backtest.md)) does carry the BUY-only-
vs-baseline delta.

## Verdict criteria

**VALIDATED** if Sharpe beats SPY by ≥ 0.2 over the full window AND
total return exceeds SPY by ≥ 5%. Otherwise **NOT VALIDATED** —
which is itself a useful result (the discrete signal does not produce
risk-adjusted alpha, stop acting on it).

This run: Sharpe-over-SPY ≈ +0.03 (fails ≥ 0.2 threshold);
total-return-over-SPY = −73.44 pp (fails ≥ 5% threshold).
**NOT VALIDATED.**

## How to populate

See [`runbook.md`](./runbook.md). After a credentialed
`npx tsx scripts/run-backtest.ts --config configs/williams-sp500-2018-2024-weekly-top20.json`
run, paste the metrics into the table above. For Phase 4r W2 the
run was fired server-side via `/api/backtest-runs/start` against the
PR-#46 preview deploy (the credentials live in Netlify env), with
the discrete-signal trigger fix that PR landed.
