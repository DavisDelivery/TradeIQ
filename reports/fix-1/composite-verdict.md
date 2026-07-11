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

## Metrics table (filled from the completed runs — no edits above this line after launch)

**Filled 2026-07-11 from the FIX-1 W3 runs. sp500 (Run A) completed VALID
and is the decisive row. russell2k (Run B) did NOT complete — its
reinvoke chain died at dispatch (see the russell2k column note). Per the
binding rule below, the sp500 SPY-after-costs line decides; russell2k
only qualifies presentation, so its absence does not gate the verdict.**

| Metric | target/sp500 | target/russell2k |
|---|---|---|
| runId | `bt_20260711013530_q5qdh7` | `bt_20260711061804_jda0i9` (DID NOT COMPLETE) |
| Total return (net of costs) | **+33.68%** | — (run failed) |
| Benchmark total return (SPY / IWM) | SPY **+107.90%** | IWM +41.31% (offline) |
| **Excess vs SPY (pp)** | **−74.22 pp** | — |
| Excess vs QQQ (pp) | −168.1 pp (QQQ +201.8%) | — |
| Sharpe | 0.31 | — |
| Sortino | 0.42 | — |
| Information coefficient (IC) | **−0.0105** (negative) | — |
| Information ratio (vs benchmark) | −0.62 | — |
| Max drawdown | 34.2% | — |
| Recovery days | 424 | — |
| Profit factor | 1.167 | — |
| Win rate | 52.2% | — |
| Avg win / avg loss | +6.94% / −6.56% | — |
| CAGR | 4.29% | — |
| Trade count / rebalances | 2,563 trades / 84 rebalances | — |
| Null-candidate rate (must be <90% or run is invalid) | PASSED (run completed `complete`, 42,200 ML rows, real trades — not the null-candidate failure that voided avaa64) | — |

QQQ comparison: QQQ total return over the same window = **+201.8%**
(computed offline, adjusted close; SPY offline = +107.9%, matching the
engine's SPY benchmark to the decimal). The composite trails QQQ by
~168 pp — even further than prophet's ~58 pp MIXED miss.

### Per-regime breakdown (sp500, Run A)

| Regime | Rebalances | Composite total return | Avg segment return |
|---|---|---|---|
| risk-on | 11 | **−12.30%** | −1.29% |
| neutral/chop | 47 | +24.94% | +0.54% |
| risk-off | 26 | +29.38% | +1.16% |

The composite *loses money* in risk-on regimes and only makes headway in
neutral/risk-off — the opposite of what a "target/conviction" board
should do, and nowhere near enough to close the 74-pp gap to SPY.

### Rolling consistency

Not separately computed. The full-window excess of **−74.2 pp vs SPY**
combined with a **negative IC (−0.0105)** is decisive on its own under
the binding rule — no 2-year sub-window can rescue a flagship claim when
the scores carry worse-than-random ranking information across the whole
period. (russell2k rolling is moot: the run did not complete.)

### russell2k (Run B) — did not complete

`bt_20260711061804_jda0i9` was fired 2026-07-11 06:18 UTC with the exact
spec above. Its background reinvoke chain died immediately after the
first invocation (dailyEquity froze at 1,005 with `mlTrainingCount: 0`;
the FIX-1 W1 zombie sweep marked it `failed` at 64 min idle). This is
the same non-portfolio reinvoke-chain fragility that also killed the
first sp500 attempt (`bt_20260710234516_9v4xtl`, reaped) before the
retry (`q5qdh7`) completed. Non-portfolio `backtestRuns` have no working
resume loop (`recoverStuckBacktestRuns` reaps but does not resume them —
`reports/phase-4v-backtest-concurrency` + observed here), so a stalled
run restarts from zero. **Per the binding rule, sp500 alone is decisive;
russell2k does not gate the stay/demote call.** Recommend re-running
russell2k once the reinvoke-chain infra is hardened (a working
non-portfolio resume loop, OR chunk the 7-year window into shorter
segments) to complete the presentation nuance — it can only make the
verdict *more* negative (restatement bias is structurally larger on
small caps; see pit-audit §8), never rescue it.

---

## VERDICT (2026-07-11): NO VALIDATED EDGE → COMPOSITE DEMOTES TO A SCREENER

**The pre-committed rule applied mechanically:** the sp500 composite
returned **+33.68%** vs SPY's **+107.90%** over 2018-01-31 → 2024-12-31,
net of costs — an excess of **−74.22 pp**. Excess ≤ 0 ⇒ **DEMOTE.**

Every confirming metric agrees this is signal-absence, not variance:
Information Coefficient **−0.0105** (negative — the ten-analyst
composite scores rank stocks *worse than random*), Information Ratio
−0.62, Sharpe 0.31 (vs SPY buy-and-hold ~0.6), and it *loses* in
risk-on regimes. This is the same result class as Williams (−73.4 pp)
and Lynch (IC 0.0011): measured against the index after costs, the
flagship composite has no edge.

**Actions taken in the commit that fills this table:**
1. `verdicts.ts` → `target` row flips `PENDING` → **`NO_EDGE`**
   (excessVsSPYPp −74.2, IC −0.0105, runId `bt_20260711013530_q5qdh7`).
   Every VerdictChip on the Target board + its AI theses now renders
   **NO VALIDATED EDGE** automatically.
2. Target board demoted out of the flagship nav position into the
   **Unvalidated** section (alongside Williams + Lynch) — it remains
   reachable as a **screener**, not presented as edge.
3. **FIX-2 (earnings-as-product) becomes the product** — the earnings
   board is the one signal class with a mechanical, measurable edge
   hypothesis (event-window expected move / PEAD), per the FIX-2 row.
4. APP_VERSION → 0.22.0-alpha; ORCHESTRATOR FIX-1 row updated.

This is exactly the question FIX-1 existed to answer, answered honestly:
the composite has now been *validly* backtested for the first time
(avaa64 was invalid — all-null candidates), and it does not beat the
index.

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
