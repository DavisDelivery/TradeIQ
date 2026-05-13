# Phase 4e-1 — Backtest Validation Findings

**Verdict:** PENDING LIVE-DATA RUN

**Layers active:** unknown (audit pending; see § 0)

This PR lands the Prophet Portfolio engine modules, the rebalance rule
(v1, per `briefs/phase-4e-1-brief.md`), the backtest harness, the daily
mark-to-market function, the read endpoint, and the decisionLog
forward-return populator — all dormant. The binding verdict against
SPY 2018–2026 cannot be produced from this executor session because the
production credentials needed for the W0 layer audit and the W4
historical backtest were not available (per kickoff §1.2, no Polygon /
Firebase SA JSON in this session). The verdict is therefore held in
PENDING state until a follow-up run with credentials populates §0–§5.

**Generated:** 2026-05-13 (executor session)
**Engine commit:** 46aa7b814e01ab236e8f44d4b664d70f4a09be4a (baseline)
**Rule version:** v1 (per briefs/phase-4e-1-brief.md § "The rebalance rule")
**Costs applied (when run):** 10 bps slippage per side, $0 commission

Per the brief's fallback path ("If verdict is DON'T SHIP, this file is
not created and the PR lands the engine modules + backtest findings
without a scheduled function") — the same posture applies to a
PENDING verdict: the live `scan-prophet-portfolio-rebalance.ts`
scheduled function is intentionally NOT shipped in this PR (W5
skipped). APP_VERSION is held at `0.16.1-alpha` to reflect the engine
landing without the live manager active.

---

## How to populate this report (live-data run procedure)

The CLI is `scripts/run-portfolio-backtest.ts`. End-to-end procedure:

```bash
# 1. Set credentials (DO NOT commit these)
export FIREBASE_SERVICE_ACCOUNT="$(cat ~/path/to/tradeiq-alpha-sa.json)"
export POLYGON_API_KEY="<polygon key>"

# 2. Layer activity audit (run before backtest)
#    A small one-off script that samples 90 days of Prophet largecap
#    snapshots and computes per-layer mean/stdev/% exactly-50. Populate
#    § 0 table below from its output. (Audit script can be added in a
#    follow-up commit; W0 audit requires the same Firestore read access
#    as the backtest itself.)

# 3. Full window + half-window + stress windows
for W in full half-2018 half-2022 covid rate-hikes; do
  npx tsx scripts/run-portfolio-backtest.ts --window "$W"
done

# 4. Rolling 1-year windows
for YEAR in 2018 2019 2020 2021 2022 2023 2024 2025; do
  npx tsx scripts/run-portfolio-backtest.ts --window "rolling-${YEAR}"
done

# 5. Populate the tables in §1–§5 below from the JSON outputs under
#    reports/phase-4e-1/result-*.json. The harness emits all of:
#    portfolioReturnPct, spyReturnPct, qqqReturnPct, iwfReturnPct,
#    excessReturnPct, sharpe, spySharpe, maxDDPct, spyMaxDDPct,
#    longestUnderwaterDays, swapCount, avgHoldDays, turnoverPct,
#    costDragPct, rebalanceCount.

# 6. Update the verdict line at the top:
#    - All numbers fill in
#    - If full-window excess > 0 AND ≥ 5/8 rolling windows beat SPY
#      AND portfolio beats SPY by clearly more than QQQ does → SHIP
#    - If SHIP but with caveats (e.g. fragile to stress windows) →
#      SHIP WITH CAVEATS
#    - Else → DON'T SHIP, and write §6 "What broke" + §7 with a
#      proposed v2 rule revision.
```

If the verdict flips to SHIP or SHIP WITH CAVEATS in the follow-up,
create `netlify/functions/scan-prophet-portfolio-rebalance.ts` (W5)
in a separate PR and bump APP_VERSION to `0.17.0-alpha`. The brief's
W5 spec covers schedule + body shape.

---

## 0. Layer activity audit (W0 step 7, run BEFORE backtest)

Sample: target 90 days of Prophet largecap snapshots, distinct
(asOfDate, ticker) rows.

| Layer            | Mean | StDev | % exactly 50 | Verdict |
|------------------|-----:|------:|-------------:|---------|
| structure        |    — |     — |            — | pending |
| momentum         |    — |     — |            — | pending |
| volume           |    — |     — |            — | pending |
| volatility       |    — |     — |            — | pending |
| relativeStrength |    — |     — |            — | pending |
| fundamental      |    — |     — |            — | pending |
| catalyst         |    — |     — |            — | pending |

A layer is "live" if stdev > 5 AND ≤25% of rows are exactly 50; else
"stub-returning." If ANY layer is stub, the backtest must run TWO
scenarios:

- **Scenario A (as-is):** composite computed with all 7 layers including
  stubs (what the live system currently produces).
- **Scenario B (active-only):** composite recomputed using only live
  layers, stub weights redistributed proportionally across the live
  ones.

Per Chad's screenshot of the ON ticker showing 5 of 10 Target analysts
returning exactly 50, the precondition for this audit is non-skippable.

---

## 1. Summary table — Scenario A (composite as-is)

| Window                  | Port %   | SPY %   | Excess   | Port Sharpe | SPY Sharpe | Port Max DD | SPY Max DD | Swaps |
|-------------------------|---------:|--------:|---------:|------------:|-----------:|------------:|-----------:|------:|
| 2018-01-01 → 2026-01-01 |        — |       — |        — |           — |          — |           — |          — |     — |
| 2018-01-01 → 2022-01-01 |        — |       — |        — |           — |          — |           — |          — |     — |
| 2022-01-01 → 2026-01-01 |        — |       — |        — |           — |          — |           — |          — |     — |
| 2020-02-01 → 2020-09-01 |        — |       — |        — |           — |          — |           — |          — |     — |
| 2022-01-01 → 2022-12-31 |        — |       — |        — |           — |          — |           — |          — |     — |

## 2. Summary table — Scenario B (active layers only, if applicable)

Only populated if § 0 identifies ≥ 1 stub-returning layer.

| Window                  | Port %   | SPY %   | Excess   | Port Sharpe | SPY Sharpe | Port Max DD | SPY Max DD | Swaps |
|-------------------------|---------:|--------:|---------:|------------:|-----------:|------------:|-----------:|------:|
| same rows               |        — |       — |        — |           — |          — |           — |          — |     — |

## 3. Rolling 1-year windows (Scenario A; Scenario B if applicable)

| Start (Jan)  | Scen A Port % | Scen A SPY % | Scen A Excess | Beat SPY (A)? | Scen B Excess | Beat SPY (B)? |
|--------------|--------------:|-------------:|--------------:|:-------------:|--------------:|:-------------:|
| 2018         |             — |            — |             — |       —       |             — |       —       |
| 2019         |             — |            — |             — |       —       |             — |       —       |
| 2020         |             — |            — |             — |       —       |             — |       —       |
| 2021         |             — |            — |             — |       —       |             — |       —       |
| 2022         |             — |            — |             — |       —       |             — |       —       |
| 2023         |             — |            — |             — |       —       |             — |       —       |
| 2024         |             — |            — |             — |       —       |             — |       —       |
| 2025         |             — |            − |             — |       —       |             — |       —       |

**Rolling 1-year windows that beat SPY (Scenario A):** —/8
**Rolling 1-year windows that beat SPY (Scenario B):** —/8

## 4. Style-factor decomposition (full window 2018-2026, Scenario A)

| Series   | Total Return | Annualized | vs SPY  |
|----------|-------------:|-----------:|--------:|
| Portfolio|            — |          — |   ref   |
| SPY      |            — |          — |   0%    |
| QQQ      |            — |          — |       — |
| IWF      |            — |          − |       — |

**Style-factor check:** Does the portfolio beat SPY by clearly more
than QQQ does? [YES → alpha. NO → factor exposure, not edge.]
**Answer:** pending

## 5. Position-level diagnostics (full window, Scenario A)

- Total swaps executed: —
- Average hold days per position: —
- Annual turnover: —%
- Total cost drag (slippage): —%
- Best contributor: —
- Worst contributor: —

## 6. What broke (if anything)

Pending the live-data run. The rule (v1) as specified in the brief is:

- weekly rebalance to top-10 composite from Prophet largecap;
- 30-day min-hold to suppress noise flip-flops;
- max 3 swaps per rebalance (turnover ceiling);
- sector cap 4 (concentration ceiling);
- earnings-quality gate is binding (`layers.fundamental.pass===true`
  required for additions, and `false` forces exit regardless of hold
  duration);
- 10 bps slippage per side, $0 commission, $100,000 initial capital.

The rule was encoded literally in `netlify/functions/shared/prophet-
portfolio/rebalance.ts` and unit-tested across all cases enumerated in
the brief (10 tests, all green). The harness in `backtest-harness.ts`
walks the rule against any injected `RankingSignal` + `PriceSource`.
What the rule does on real 2018–2026 Prophet snapshots vs SPY is
exactly the question this report exists to answer — and it will not be
honestly answerable until § 0 and § 1–§ 5 are populated from a live run.

## 7. Recommendation

Hold the engine dormant. Re-run this report with production
credentials. Apply the decision tree in the "How to populate" section
above. If verdict flips to SHIP / SHIP WITH CAVEATS, ship the live
scheduled function (W5) in a follow-up PR and bump APP_VERSION to
`0.17.0-alpha`. If verdict is DON'T SHIP, propose a specific v2 rule
revision here (e.g., raise `minComposite` from 50 to 60; loosen
`maxSwapsPerRebalance`; tighten `sectorCap`) and file a `4e-1-fix`
brief.

---

## Why this verdict is PENDING and not DON'T SHIP

DON'T SHIP would imply the brief's W4 was executed and the rule was
disqualified by data. Neither happened in this session. Marking it
DON'T SHIP would mis-represent the cause: the rule was never tested,
and the brief is explicit that the verdict line is binding. PENDING
preserves the fidelity that "the rule has not yet been put to its
test"; future commits to this file will replace it with the real call
once the run completes.

The engine landing dormant in either case is consistent with the
brief's fallback: "If verdict is DON'T SHIP, this file is not created
and the PR lands the engine modules + backtest findings without a
scheduled function." Same treatment applies to PENDING.
