# Phase 4e-1 — DEMO backtest run

**This is NOT the binding verdict.** The numbers below come from a
deterministic synthetic dataset (GBM-ish per-ticker price series,
seeded PRNG) — they exist only to prove the harness + rule + CLI
pipeline is wired end-to-end. The real verdict lives in
`backtest-validation.md` and requires production credentials.

**Window:** short-demo (2024-01-08 → 2024-04-08)
**Mark days:** 92
**Rebalance days:** 14
**Generated:** 2026-05-13T20:22:05.755Z

## Pipeline output

| Metric                       | Value |
|------------------------------|------:|
| Portfolio return (%)         | 8.5748 |
| SPY return (%)               | -5.5336 |
| Excess vs SPY (pp)           | 14.1084 |
| QQQ return (%)               | 22.5544 |
| IWF return (%)               | -9.9096 |
| Portfolio Sharpe (annualized)| 2.4762 |
| SPY Sharpe (annualized)      | -1.1033 |
| Portfolio max DD (%)         | 3.1548 |
| SPY max DD (%)               | 10.0556 |
| Longest underwater days      | 38 |
| Rebalances                   | 14 |
| Swaps recorded               | 9 |
| Avg hold (days)              | 44.69 |
| Annualized turnover (%)      | 1473.89 |
| Cost drag (%)                | 0.367 |

## What this tells you

- The harness completed end-to-end (no crashes, no missing-price warnings
  beyond what's expected for synthetic data).
- The rebalance decision logic produced swaps when the signal shifted.
- Equity curve and benchmark series wired through to metrics correctly.
- Cost drag is being applied at the basis-point rate from `PortfolioConfig`.

## What this does NOT tell you

- Whether the rule beats SPY in production. The demo signal is random;
  the verdict requires real Prophet snapshots feeding `compositeRankingSignal`.
- Whether any Prophet layer is stub-returning. That's the W0 audit
  (run `scripts/audit-prophet-layers.ts` with production credentials).
- Whether the rule beats QQQ/IWF after style-factor adjustment. Same.

Full JSON: `reports/phase-4e-1/demo-result-short-demo.json`
