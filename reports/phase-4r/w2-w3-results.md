# Phase 4r W2/W3 — combined results

PR #46. Williams + Lynch backtests run server-side via
`/api/backtest-runs/start` against the PR-#46 preview deploy. 5a ML
data gate confirmed against the prod `backtestRuns` collection.

---

## W2 — Williams + Lynch discrete-signal backtests

### Configurations fired

| Run | Config | discreteSignalOnly | runId |
|---|---|---|---|
| Williams BUY-only | `configs/williams-sp500-2018-2024-weekly-top20.json` | `true` | `bt_20260519014409_zsxtsq` |
| Williams score-ranked baseline | same, `discreteSignalOnly: false` | `false` | `bt_20260519014434_pbfjtx` |
| Lynch BUY-only | `configs/lynch-sp500-2018-2024-quarterly-top20.json` | `true` | `bt_20260519014419_litbxp` |
| Lynch score-ranked baseline | same, `discreteSignalOnly: false` | `false` | `bt_20260519014435_71ak9q` |

All four dispatched with `allowParallel: true` (W2-W4) so they could
run concurrently. The shared S&P 500 PIT bar cache means earlier runs
warm the cache for later runs, but the four runs ran in parallel
against the same Netlify deploy.

### Verdict numbers

*(populated when polling completes — see hand-off message.)*

Verdict tables also populated in
`reports/phase-4n/williams-backtest.md` and `lynch-backtest.md` per
the runbook step 5 instructions. **The Lynch restatement caveat
banner is retained on the populated Lynch verdict** —
`pit-integrity-attestation.md` classifies Lynch as "PIT-correct on
filing dates, residual restatement risk"; that caveat does not
disappear once a number lands.

### Discrete-signal vs score-ranked delta

The delta measures how much of the backtest's value comes from the
*discrete* BUY/HOLD/AVOID verdict vs. just ranking by the
*continuous* composite score. A signal whose BUY-only run beats its
score-ranked baseline has signal in the threshold itself; a signal
whose BUY-only matches or underperforms the baseline does not.

*(delta populated in hand-off.)*

### Verdict in plain words

*(populated in hand-off — honest read, including if a signal
underperforms its baseline; per the brief PART IV W2, a flattering
number presented as clean is a negative deliverable.)*

---

## W3 — 5a ML data gate

Queried prod `/api/backtest-runs` + per-run
`/api/backtest-runs/{runId}` to pull `mlTrainingCount` for every
completed run. Snapshot taken at this PR's open time.

### Per-run breakdown

| runId | mlTrainingCount | status | universe | board | frequency | topN |
|---|---:|---|---|---|---|---:|
| `bt_20260516230959_shw535` | **16,263** | complete | sp500 | prophet | monthly | 50 |
| `bt_20260516010323_xanxpf` | 210 | complete | sp500 | prophet | monthly | 50 |
| `bt_20260514102751_fccj7m` | 16 | complete | dow | prophet | weekly | 15 |
| `bt_20260514102751_fy4zla` | 28 | complete | dow | prophet | monthly | 25 |
| `bt_20260514102750_amaf00` | 26 | complete | dow | prophet | monthly | 20 |
| `bt_20260514102751_yf4zru` | 24 | complete | dow | prophet | monthly | 10 |
| `bt_20260514102750_av10rv` | 1 | complete | dow | prophet | monthly | 20 |
| `bt_20260514102751_7w1ucq` | 12 | complete | dow | prophet | quarterly | 20 |
| `bt_20260514102311_w8e72m` | 0 | complete | ndx | prophet | monthly | 10 |
| `bt_20260514094547_548uox` | 0 | complete | sp500 | prophet | monthly | 50 |
| `bt_20260511185505_ala21n` | 183 | complete | dow | prophet | monthly | 20 |
| `bt_20260511155722_eg0gv5` | 206 | complete | dow | prophet | monthly | 20 |
| `bt_20260511143016_rblp3x` | 0 | complete | dow | prophet | monthly | 20 |
| **Total** | **16,969** | | | | | |

13 runs total; 10 with `mlTrainingCount > 0`.

### Gate verdict

The Phase 5a data gate is **≥10,000 mlTraining rows across ≥5 runs**
(brief PART IV W3).

| Metric | Threshold | Actual | Status |
|---|---|---|---|
| Total mlTraining rows | ≥ 10,000 | **16,969** | ✅ PASS |
| Runs with rows > 0 | ≥ 5 | **10** | ✅ PASS |

**Gate: MET.** Phase 5a (PR #24) is unblocked from the 4r W3 data
side; running the ML-discovery pipeline itself is its own phase.

### Honest read

The headline 16,969 is *dominated* by a single run
(`bt_20260516230959_shw535` — full sp500/monthly/7-year/topN=50,
completed 2026-05-16, 16,263 rows ≈ 96% of the total). Without that
run the dataset is 706 rows across 9 small runs — well under the
gate.

The brief estimated ~42k rows for a "full sp500 / monthly / 7-year"
acceptance run; the actual yield is 16,263. The discrepancy reflects
the realised per-candidate emission rate at this config's
`minComposite: 50` filter, not a defect — and the gate as written
(≥10k across ≥5 runs) is met regardless. The orchestrator may want
to log this as context for 5a's training-data diversity discussion,
since the data is one-strategy-heavy rather than evenly mixed across
the 10 runs.

---

## Code change (small, required)

`backtest-runs-trigger.ts` previously gated `board === 'prophet'` —
a Phase 4a guard from when only prophet had PIT-correct scoring.
Phase 4m+4n (PR #41) shipped `scoreWilliamsAtDate` +
`scoreLynchAtDate`; the guard was never updated, so a server-side
fire of the W2 configs returned 400. Fix is one line plus the
matching error message: trigger now allows `{prophet, williams,
lynch}`; `catalyst / insider / target` stay blocked.
`docs/BACKTEST_LIMITATIONS.md` §10 updated. APP_VERSION 0.19.3 →
0.19.4.
