# Phase 4n — Backtest runbook

How to populate the verdict tables in `williams-backtest.md` and
`lynch-backtest.md`. Requires Polygon + Finnhub + Firebase service-
account credentials.

## 1. Set credentials

```bash
export POLYGON_API_KEY="<polygon key>"
export FINNHUB_API_KEY="<finnhub key>"
export FIREBASE_SERVICE_ACCOUNT="$(cat ~/path/to/tradeiq-alpha-sa.json)"
```

The Polygon plan must include `/vX/reference/financials` with
`filing_date.lte` support (paid tier). The Firebase SA needs Firestore
write for the PIT cache. Without it the runs are still possible but
every per-(ticker, date) score is recomputed from scratch.

## 2. Run the Williams backtest

```bash
npx tsx scripts/run-backtest.ts \
  --config configs/williams-sp500-2018-2024-weekly-top20.json
```

Notes:
- The config has `discreteSignalOnly: true` so only BUY-verdict
  candidates form the portfolio. Without this flag the engine ranks
  topN by composite score, which is a different (still interesting)
  signal-strength test.
- Weekly rebalance matches Williams' 3–10 day swing horizon.
- Expected wall clock: ~30–45 minutes on a warm cache, 2–3 hours
  cold (one fundamentals fetch per ticker per quarter + bars per
  rebalance week × ~500 tickers).

## 3. Run the Lynch backtest

```bash
npx tsx scripts/run-backtest.ts \
  --config configs/lynch-sp500-2018-2024-quarterly-top20.json
```

Notes:
- `discreteSignalOnly: true` filters to BUY-verdict GARP candidates.
- Quarterly rebalance matches Lynch's 6–24 month investment horizon
  (one decision per filing cycle).
- The fundamentals-restatement caveat applies — `lynch-backtest.md`
  prints it at the top of the verdict.
- Expected wall clock: ~20–30 minutes on a warm cache.

## 4. Run the baseline (score-ranked) version for comparison

Same configs, drop the `--no-discrete` flag from the JSON or use
`--config <file>` and pass nothing extra. Without `discreteSignalOnly`
the engine picks topN by composite score across all candidates
(including HOLD-verdict ones with high scores). The delta between
"score-ranked" and "BUY-only" runs measures how much of the value
is in the *discrete signal* versus just the *continuous score*.

## 5. Populate the verdict files

Each `--config` run prints to stdout and writes a `BacktestResult`
document to Firestore. Paste the metrics block into the relevant
`*-backtest.md` file:

```
Total return:  __%
CAGR:          __%
Sharpe:        __
Max DD:        __%
Win rate:      __%
SPY return:    __%
SPY Sharpe:    __
Excess:        __%
```

Then commit:

```bash
git add reports/phase-4n/williams-backtest.md
git add reports/phase-4n/lynch-backtest.md
git commit -m "phase-4n: populate verdict numbers from <date> run"
```

## 6. Verdict criteria (per brief PART VIII)

The point of these backtests is to surface whether the signals work,
not to ship a flattering number. A signal is reported as **VALIDATED**
when it beats SPY on a risk-adjusted basis (Sharpe > SPY Sharpe by a
non-trivial margin) over the full window. Otherwise it is reported
as **NOT VALIDATED**, and the report says so — that is a useful
result, not a failure.

For Lynch, even a "VALIDATED" verdict carries the restatement caveat
until the fundamentals snapshot store lands (separate phase).
