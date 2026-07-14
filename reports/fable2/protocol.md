# FABLE-2 — pre-registered research protocol (written 2026-07-14, before ANY v2 backtest)

Chad's directive: "Go back to the drawing board and figure out a way to
beat the SPY." This document is the drawing board — and the guardrails
that keep the answer honest. It is committed BEFORE any v2 run exists.

## 1. Diagnosis — why v1 (and Target, and Williams) lost by ~73pp

Measured 2018-01-31 → 2024-12-31, same provider series as the engine:

| Structure | Total return | vs SPY |
|---|---|---|
| SPY (cap-weighted 500) | +107.9% | — |
| **RSP (SAME 500 stocks, equal weight, ~zero selection, minimal cost)** | **+66.2%** | **−41.7 pp** |
| MTUM (large-cap momentum factor ETF) | +85.4% | −22.5 pp |
| QQQ (mega-cap growth concentration) | +201.8% | +93.9 pp |
| SPMO (S&P 500 momentum, CAP-WEIGHTED, common window 2016-07→2024-12) | +249.1% | **+78.6 pp vs SPY's +170.5%** |

Reading: FABLE v1's −73.4pp decomposes as ≈ −42pp equal-weighting
headwind (RSP proves this needs NO bad picks — the era's index return
WAS mega-cap concentration) + ≈ −31pp from monthly full-rotation costs,
regime cash during V-recoveries, and selection that added nothing at a
1-month measurement horizon (IC −0.017). The one long-only, unlevered,
large-cap structure that beat SPY was momentum selection with
CAP-WEIGHTED sizing and moderate turnover (SPMO). Concentration was not
the risk this era punished; it was the return source.

Also a measurement defect in v1's own test, fixable without excuses:
the engine forced monthly top-20 equal-weight FULL ROTATION — not the
board's stated discipline (enter ≥90th pctile, exit <60th banding, max
hold 126 trading days, 8% stop). v1 was validated against a proxy
portfolio process, and IC was measured at 1-month despite a 30-170 day
design horizon. v2's engine tests the ACTUAL policy.

## 2. Design directions for v2 (hypotheses, to be explored ONLY on TRAIN)

- H1 sizing: composite×market-cap weighting (or cap-weight among
  qualifiers). Kills the −42pp structural headwind while keeping the
  gate. THE key change suggested by RSP/SPMO.
- H2 turnover: banding + long holds (the board's real 30-170d rules)
  instead of monthly rotation. 2,018 trades → target <600.
- H3 regime: entry-only gating (below 200dma: no NEW entries, but HOLD
  existing positions with their stops) instead of forced cash — keeps
  the V-recoveries (2019, 2020-H2, 2023) that cash-forcing forfeited.
- H4 horizon: rank-IC measured at 63d and 126d forward (design-matched),
  not 21d.
- H5 universe: ndx reported alongside sp500 (where the era's winners
  lived); sp500 remains the decisive universe for the confirmatory run.

## 3. Anti-snooping protocol (BINDING)

- TRAIN window: 2018-01-01 → 2023-12-31. Exploration allowed, hard
  budget of 20 logged configuration runs (every run appended to
  reports/fable2/exploration-log.md with config hash + result — no
  silent discards). Tooling hard-clamps endDate ≤ 2023-12-31 on
  exploration runs.
- HOLDOUT window: 2024-01-01 → 2026-06-30 (~2.5 years, NEVER run during
  exploration; index prices may be read, strategy runs may not touch it).
- After exploration, ONE config is frozen in this file by appendix, then
  ONE confirmatory holdout run executes.
- Confirmatory bar (multiple-testing haircut vs v1's t≥2.0, since this
  is the program's 2nd pre-committed attempt plus ≤20 explorations):
  1. Holdout net total return (20bps RT) > SPY over the holdout;
  2. Holdout 63d rank-IC > 0;
  3. Combined train+holdout monthly active t ≥ 2.5.
  Fail any ⇒ FABLE-2 is NOT promoted; the screener verdict stands.
- Final arbiter regardless of backtest outcome: a 6-month LIVE forward
  paper test (daily snapshot of the shipped board's policy portfolio vs
  SPY, computed by cron, no lookahead). Only after the live test
  confirms does any chip say VALIDATED. Backtests propose; the tape
  disposes.
- No promise is made that any long-only unlevered system beats SPY
  prospectively. The deliverable is the honest attempt with the best
  era-evidence, measured without thumb on scale. (Research tooling for
  Chad's app — not investment advice.)

## 4. Engineering prerequisites (R1, before any exploration)

- Policy-mode backtest engine: banded entry/exit (enter ≥90th pctile of
  gate-passers, exit <60th), per-position max-hold (126 trading days)
  and stop (8%), cap/composite hybrid weighting, entry-only regime
  gating, partial-cash accounting. Event-driven daily loop, not
  monthly snapshot rotation.
- Horizon-matched rank-IC (63d/126d) in run metrics.
- Exploration runner with endDate clamp + auto-append to the log.
- Reuses the PIT caches (bars + insider) already warmed by v1's runs.

---

## APPENDIX A — FROZEN CONFIG (2026-07-14, exploration closed at 20/20)

Chosen: the board AS DESIGNED — insider pillar LIVE — because the
holdout must test the system that would actually ship, not its
best-scoring lab variant. The insider-off twin (fbl2_16, +62.88pp) vs
the identical insider-live run (fbl2_20, +25.26pp) differ by 37pp from
a 0.2-weight pillar: documented FRAGILITY of a 15-slot book to
entry-band reshuffles. The honest train estimate of the shipped system
is fbl2_20's, not fbl2_16's.

```json
{
  "universe": "sp500",
  "insiderMode": "live",
  "config": {
    "startDate": "<window>", "endDate": "<window>",
    "initialCapital": 100000,
    "enterPctl": 90, "exitPctl": 60,
    "maxHoldDays": 126, "stopPct": 0.12,
    "slippageBpsPerLeg": 10,
    "sizeAlpha": 1.0,
    "maxPositionPct": 0.20, "maxPositions": 15,
    "regimeMode": "none"
  }
}
```

Train reference (fbl2_20_cand_insider_live, 2018-01-01→2023-12-29):
net +102.10% vs SPY +76.85% = **+25.26pp**; rank-IC63 +0.029; IC126
+0.029; 333 trades; monthly-active t 0.474; maxDD 20.59%; Sharpe (see
doc). Sub-window stability measured on the insider-off twin (+10.4 /
+5.0pp both positive).

Pre-holdout expectation, stated for the record: with train t at 0.47
(n=71 months), the combined t≥2.5 criterion is nearly unreachable —
the holdout would need ~+3%/month active for 30 straight months. The
bar is doing its job: absent overwhelming evidence, FABLE-2 will NOT
claim validated alpha even if it beats SPY out-of-sample; it would
ship as a screener with measured OOS results noted, and only the
6-month live forward test could change that. No third outcome.

The single confirmatory holdout run (2024-01-01 → 2026-06-30) executes
via a dedicated endpoint with this config HARDCODED. One shot.
