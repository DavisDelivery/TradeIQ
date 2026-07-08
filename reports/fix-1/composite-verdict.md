# FIX-1 W3 — Composite (target board) verdict: pre-committed protocol

**Status: PENDING — runs not yet fired.** This document is committed
BEFORE any numbers exist. The decision rule below is binding and was
written before measurement; nothing in the run spec may be changed
after the first run is dispatched. No tuning during measurement.

Why this document exists: the only composite backtest ever run
(`bt_20260519233423_avaa64`, 2026-05-19) was INVALID — the deployed
engine had no PIT scoring path for board `target`, every candidate
scored null on all 84 rebalances, and the engine still rendered
official metrics. FIX-1 W2 makes that class of run terminate with
`status: 'invalid'` and no metrics. The flagship ten-analyst composite
has therefore NEVER been validly backtested. These are the runs that
answer it.

---

## Run spec (fixed)

Two runs, fired via `POST /api/backtest-runs/start`, identical except
for universe:

| Field | Run A | Run B |
|---|---|---|
| board | `target` | `target` |
| universe | `sp500` | `russell2k` |
| startDate | `2018-01-31` | `2018-01-31` |
| endDate | `2024-12-31` | `2024-12-31` |
| rebalanceFrequency | `monthly` | `monthly` |
| portfolio | top 20 by composite, equal-weight | top 20 by composite, equal-weight |
| discreteSignalOnly | `false` | `false` |
| costs | engine defaults (same model as avaa64): slippage 5 bps/leg sp500, commission 0 | slippage 20 bps/leg russell2k, commission 0 |
| engine benchmark | SPY | IWM |

Launch payloads (post-deploy):

```bash
curl -X POST https://tradeiq-alpha.netlify.app/api/backtest-runs/start \
  -H 'Content-Type: application/json' \
  -d '{"universe":"sp500","board":"target","startDate":"2018-01-31","endDate":"2024-12-31","rebalanceFrequency":"monthly","portfolio":{"topN":20,"weighting":"equal"}}'

curl -X POST https://tradeiq-alpha.netlify.app/api/backtest-runs/start \
  -H 'Content-Type: application/json' \
  -d '{"universe":"russell2k","board":"target","startDate":"2018-01-31","endDate":"2024-12-31","rebalanceFrequency":"monthly","portfolio":{"topN":20,"weighting":"equal"}}'
```

(Field names must match the trigger's schema at run time — verify against
`backtest-runs-trigger.ts` before firing; the spec above is the contract.)

Both runs must complete with `status: 'complete'`. A run ending
`invalid` (W2 guard) or `failed` yields NO verdict — fix the
infrastructure and re-fire the SAME spec. Partial/degraded runs do not
count.

PIT caveats carried into any verdict, per `reports/phase-4t/pit-audit.md`
(binding: PIT-clean factors score live; not-PIT-able factors are excluded
via `_noData`, never faked): fundamentals/EPS restatement risk (larger on
russell2k), news coverage density thin in 2018, STOCK-Act-shifted
political disclosures, patent + macro analysts excluded at weight 0.

## Metrics table (to be filled from the completed runs — no edits above this line after launch)

| Metric | target/sp500 | target/russell2k |
|---|---|---|
| runId | _pending_ | _pending_ |
| Total return (net of costs) | _pending_ | _pending_ |
| Benchmark total return (SPY / IWM) | _pending_ | _pending_ |
| Excess vs SPY (pp) | _pending_ | _pending_ |
| Excess vs QQQ (pp) | _pending_ | _pending_ |
| Sharpe | _pending_ | _pending_ |
| Sharpe − benchmark buy-and-hold Sharpe | _pending_ | _pending_ |
| Information coefficient (IC) | _pending_ | _pending_ |
| Max drawdown | _pending_ | _pending_ |
| Benchmark max drawdown | _pending_ | _pending_ |
| Trade count / turnover | _pending_ | _pending_ |
| Null-candidate rate (must be <90% or run is invalid) | _pending_ | _pending_ |

QQQ comparison: computed offline from QQQ total return over the same
window (the engine benchmarks sp500 against SPY and russell2k against
IWM; QQQ is the additional honesty bar because prophet's MIXED verdict
lost to QQQ by ~58 pp).

### Per-regime breakdown

| Regime | sp500 return vs SPY | russell2k return vs IWM |
|---|---|---|
| risk-on | _pending_ | _pending_ |
| risk-off | _pending_ | _pending_ |
| neutral/chop | _pending_ | _pending_ |

### Rolling consistency (the 4e-1 lesson: full-window numbers hide inconsistency)

| Rolling 2-year window | sp500 beats SPY? | russell2k beats IWM? |
|---|---|---|
| 2018-01 → 2019-12 | _pending_ | _pending_ |
| 2019-01 → 2020-12 | _pending_ | _pending_ |
| 2020-01 → 2021-12 | _pending_ | _pending_ |
| 2021-01 → 2022-12 | _pending_ | _pending_ |
| 2022-01 → 2023-12 | _pending_ | _pending_ |
| 2023-01 → 2024-12 | _pending_ | _pending_ |
| Windows won | _/6 | _/6 |

---

## PRE-COMMITTED DECISION RULE (written before numbers; binding)

**IF** the sp500 run beats SPY after costs out-of-sample over the full
window (excess total return > 0 pp, net of the cost model above), the
composite **stays** as the flagship board. Rolling consistency and the
russell2k result qualify HOW it is presented (e.g. "edge on large caps
only, 4/6 windows"), but the stay/demote call is the SPY-after-costs
line.

**IF NOT** — the composite **demotes to a screener**: target-board
tiers/scores are no longer presented as edge anywhere in the product
(verdict chip flips to NO VALIDATED EDGE with the measured number), the
target board moves out of the flagship position, and **FIX-2
(earnings-as-product) becomes the product**.

There is no third outcome. "Almost", "beats QQQ but not SPY",
"beats in 2020-2021" → demote. A russell2k win with an sp500 loss is
reported honestly but does NOT rescue the flagship claim (restatement
bias is structurally larger on russell2k — the flattering result there
is the LESS trustworthy one; see pit-audit §8).

**No tuning during measurement.** If either run surfaces an
infrastructure bug, fix the bug and re-run the same spec. Any change to
weights, factors, thresholds, or the spec itself voids this protocol
and requires a new pre-committed document BEFORE the re-measurement.

The verdict registry (`netlify/functions/shared/verdicts.ts`) holds
`target: PENDING` until this table is filled; it is updated in the same
commit that fills the table.
