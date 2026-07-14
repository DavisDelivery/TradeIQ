# FABLE-2 exploration log (TRAIN window only: 2018-01-01 → 2023-12-31)

Budget: ≤20 configuration runs (protocol.md §3). Source of truth is the
`fable2Explorations` Firestore collection (every run auto-logged,
success or failure, clamp recorded); this file mirrors it for the repo
record. NO run may touch the holdout — the runner hard-clamps.

| runId | universe | config delta vs DEFAULT_POLICY_CONFIG | net % | SPY % | excess pp | IC63 | IC126 | trades | costs % | note |
|---|---|---|---|---|---|---|---|---|---|---|
| fbl2_01_base_policy | sp500 | DEFAULT | — | — | — | — | — | — | — | FAILED: fable2 insider fetch failed ABT@2019-06-28: rate-limit exhau |
| fbl2_01b_base | sp500 | DEFAULT | 61.53 | 76.85 | -15.32 | 0.0266 | 0.0284 | 395 | 4.11 |  |
| fbl2_02_alpha0 | sp500 | sizeAlpha=0 | 58.58 | 76.85 | -18.26 | 0.0266 | 0.0284 | 435 | 4.48 |  |
| fbl2_03_regime_none | sp500 | regimeMode=none | 67.52 | 76.85 | -9.33 | 0.0266 | 0.0284 | 422 | 5.00 |  |
| fbl2_04_regime_cash | sp500 | regimeMode=cash | 61.53 | 76.85 | -15.32 | 0.0266 | 0.0284 | 395 | 4.11 |  |
| fbl2_05_alpha2 | sp500 | sizeAlpha=2; regimeMode=none | 66.20 | 76.85 | -10.65 | 0.0266 | 0.0284 | 311 | 4.13 |  |
| fbl2_06_enter80 | sp500 | enterPctl=80; regimeMode=none | 59.01 | 76.85 | -17.84 | 0.0266 | 0.0284 | 605 | 5.38 |  |
| fbl2_07_stop12 | sp500 | stopPct=0.12; regimeMode=none | 69.87 | 76.85 | -6.97 | 0.0266 | 0.0284 | 410 | 4.94 |  |
| fbl2_08_combo | sp500 | enterPctl=80; stopPct=0.12; sizeAlpha=2; regimeMode=none | 40.57 | 76.85 | -36.27 | 0.0266 | 0.0284 | 427 | 4.23 |  |
| fbl2_09_s12a15 | sp500 | stopPct=0.12; sizeAlpha=1.5; regimeMode=none | 68.60 | 76.85 | -8.25 | 0.0266 | 0.0284 | 360 | 4.52 |  |
| fbl2_10_s15 | sp500 | stopPct=0.15; regimeMode=none | 66.66 | 76.85 | -10.19 | 0.0266 | 0.0284 | 409 | 4.85 |  |
| fbl2_11_exit40 | sp500 | exitPctl=40; stopPct=0.12; regimeMode=none | 71.69 | 76.85 | -5.16 | 0.0266 | 0.0284 | 392 | 4.73 |  |
| fbl2_12_noband | sp500 | exitPctl=0; stopPct=0.12; regimeMode=none | 78.02 | 76.85 | 1.18 | 0.0266 | 0.0284 | 373 | 4.62 |  |
| fbl2_13_conc | sp500 | stopPct=0.12; maxPositionPct=0.15; maxPositions=20; regimeMode=none | 96.41 | 76.85 | 19.57 | 0.0266 | 0.0284 | 370 | 5.92 |  |
| fbl2_14_conc_noband | sp500 | exitPctl=0; stopPct=0.12; maxPositionPct=0.15; maxPositions=20; regimeMode=none | 118.77 | 76.85 | 41.92 | 0.0266 | 0.0284 | 316 | 5.45 |  |
| fbl2_15_conc_a15 | sp500 | stopPct=0.12; sizeAlpha=1.5; maxPositionPct=0.15; maxPositions=20; regimeMode=none | 114.25 | 76.85 | 37.40 | 0.0266 | 0.0284 | 320 | 5.67 |  |
| fbl2_16_conc_deep | sp500 | stopPct=0.12; maxPositionPct=0.2; maxPositions=15; regimeMode=none | 139.72 | 76.85 | 62.88 | 0.0266 | 0.0284 | 324 | 6.78 |  |
| fbl2_17_cand_sub1 | sp500 | stopPct=0.12; maxPositionPct=0.2; maxPositions=15; regimeMode=none; endDate=2020-12-31 | 49.47 | 39.11 | 10.36 | 0.0080 | -0.0207 | 181 | 2.32 |  |
| fbl2_18_cand_sub2 | sp500 | stopPct=0.12; maxPositionPct=0.2; maxPositions=15; regimeMode=none; startDate=2021-01-01 | 33.92 | 28.88 | 5.04 | 0.0410 | 0.0722 | 149 | 2.57 |  |

## R2 reading (2026-07-14, exploration CLOSED at 19 runs of 20)

Direction was coherent across waves, mechanically explicable, and
matches the ex-ante RSP/SPMO diagnosis — hold leaders longer, interrupt
less, concentrate:

1. The board's ACTUAL discipline alone (vs v1's monthly-rotation proxy
   harness): −15.3pp on train vs v1's −73pp over 2018-2024. The proxy
   was the largest single destroyer.
2. rank-IC at the DESIGN horizon is +0.027 (63d) / +0.028 (126d) —
   positive, vs −0.017 measured at 1 month in v1. The composite does
   rank returns at the horizon it was designed for.
3. The 200dma entry gate cost ~6pp (whipsaw around 2020); regime 'none'
   won every head-to-head. 8%→12% stop: +2.3pp (noise-stop churn).
   Wider entry funnel (80th pctl) and kitchen-sink combos HURT.
4. Concentration is a smooth ridge, not a knife-edge: 30pos/10% −7.0 →
   20pos/15% +19.6 → 15pos/20% +62.9pp (t 0.93, Sharpe 0.92, maxDD
   22.5% vs SPY ~34%).
5. CANDIDATE (frozen pending insider-live confirmation):
   enter≥90 / exit<60 banding, maxHold 126td, stop 12%, sizeAlpha 1.0
   (63d median dollar-volume proxy), maxPositions 15, maxPositionPct
   0.20, regimeMode none, 20bps RT. Sub-window stability: 2018-2020
   +10.4pp, 2021-2023 +5.0pp — both halves positive.

Honesty notes, pre-holdout: train t-stat 0.93 is NOWHERE near the
combined ≥2.5 bar on its own — the holdout must contribute. Deeper
concentration winning monotonically is exactly what a mega-cap-bull
window rewards; if 2024-2026 broke that regime, the holdout will say
NO and the verdict machinery will print it. Remaining budget: run #20 =
insider-live confirmation of the candidate (after the warm-up sweep).
