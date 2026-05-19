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

### Run outcomes

| Run | Status | Wall-clock | Result |
|---|---|---|---|
| Williams BUY-only | ✅ complete | 91 min, 35 invocations | totalReturn 34.46%, Sharpe 0.6285 |
| Williams baseline (score-ranked) | ❌ **failed** | 44 min, 18 invocations | Firestore 1 MiB doc-size limit at ~50% (see below) |
| Lynch BUY-only | ✅ complete | 12 min | totalReturn 6.92%, Sharpe 0.4189 |
| Lynch baseline (score-ranked) | ✅ complete | 12 min | totalReturn 20.35%, Sharpe 0.6239 |

The W1b reinvoke fix held up under 4 parallel runs — checkpoint-
resume worked for both completed Williams (35 invocations across
~90 min) and both Lynch runs. The Williams-baseline failure is
**not** a reinvoke issue; the error is the run's persisted state
doc exceeding Firestore's 1 MiB per-doc limit after ~50% completion
(the cursor.state grows with each batch's accumulated mlTraining
emission). Separate engine defect, logged below.

### Verdict numbers

Full tables in `reports/phase-4n/williams-backtest.md` and
`reports/phase-4n/lynch-backtest.md`. **Lynch restatement caveat
banner is retained.**

Headline (vs SPY 107.90% over 2018-01-31 → 2024-12-31):

| Run | Total return | Sharpe | Max DD | vs SPY |
|---|---:|---:|---:|---|
| Williams BUY-only | 34.46% | 0.629 | 15.31% | −73.44 pp |
| Lynch BUY-only | 6.92% | 0.419 | 5.68% | −100.98 pp |
| Lynch baseline | 20.35% | 0.624 | 8.49% | −87.55 pp |

### Discrete-signal vs score-ranked delta

**Lynch** — clean A/B (both runs completed):

| Metric | BUY-only | score-ranked | delta |
|---|---:|---:|---|
| Total return | 6.92% | 20.35% | **+13.42 pp** (baseline) |
| Sharpe | 0.419 | 0.624 | **+0.205** (baseline) |
| Max DD | 5.68% | 8.49% | +2.81 pp (worse) |
| Rebalances executed | 3 / ~28 | 5 / ~28 | +2 |
| Trade count | 29 | 53 | +24 |

The Lynch BUY threshold is *too restrictive*: dropping it ranks the
top 20 by composite score, which triples returns and meaningfully
improves Sharpe. **The discrete BUY signal is dropping value rather
than adding it on this config.** Both still catastrophically
underperform SPY though — neither validates Lynch on the S&P 500.

**Williams** — baseline could not complete; the delta is not
measurable on this PR (engine bug noted below). Williams BUY-only
underperforms SPY by 73 pp directly.

### Verdict in plain words — honest read

**Williams — NOT VALIDATED.** 7-year total return 34.46% vs SPY
107.90%. Sharpe (0.629) is essentially even with SPY's
buy-and-hold Sharpe on this window — Sharpe-over-SPY ≈ +0.03,
below the +0.2 bar. Excess return is −73 pp, below the +5% bar.
The strategy traded 1,785 times over 313 rebalances and could not
beat buy-and-hold. The discrete Williams signal does not produce
risk-adjusted alpha vs SPY at this configuration.

**Lynch — NOT VALIDATED.** Two distinct failures: (1) BUY-only sat
in cash 6 of 7 years — only 3 quarterly rebalances had qualifying
candidates, all in 2024. Whatever the signal is supposed to identify
on the S&P 500, it does not fire across 2018-2023. (2) Even when we
relax to the score-ranked baseline (more trades, more rebalances),
total return is still 20.35% — far short of SPY's 107.90%. The
restatement-caveat banner stays on the report regardless; it does
not change the verdict here. The signal as currently calibrated does
not produce a viable Lynch-style portfolio on this universe and
window.

### Engine defect noted (out of scope for 4r W2)

The Williams score-ranked baseline failed at invocation 18 on
2026-05-19T02:28:44 with:

```
3 INVALID_ARGUMENT: Document 'projects/tradeiq-alpha/databases/
(default)/documents/backtestRuns/bt_20260519014434_pbfjtx' cannot
be written because its size (1,086,304 bytes) exceeds the maximum
allowed size of 1,048,576 bytes.
```

The doc-size limit is Firestore's per-doc 1 MiB ceiling. The
cursor's `state` field includes the engine's resume state, which
grows as the run accumulates per-batch metric inputs across the
365-week sp500 cadence. The score-ranked baseline emits ~30× more
mlTraining rows than BUY-only (29,039 vs 929 at the failure point);
the cursor state grew with it.

The reinvoke chain itself worked (W1b's fix held — the run had 18
successful invocations). The failure is upstream of reinvoke, in
the engine's persisted-state shape. Possible fixes for a follow-up:
move the persisted state into a subcollection like `mlTraining`
already uses, or trim non-resumable fields out of the checkpoint
between batches. Either is engine work, not 4r W2 work.

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
