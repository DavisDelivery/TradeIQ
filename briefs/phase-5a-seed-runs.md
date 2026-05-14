# Phase 5a — seed-run configs (Dow re-spec)

**Status as of 2026-05-14.** The original 5 sp500-based seed configs
(below in "Original plan — unrunnable") were proven unrunnable when
the baseline `sp500/monthly/top50/2018-2024` config fired and
"completed" in 5 seconds with 0 trades, 0 rows. Root cause: PIT
universe-history coverage for sp500 only extends back to 2026-05-07
(probed: ndx coverage starts 2026-05-11; both ~1 week old). The
backtest engine iterates rebalance dates and emits a "universe pool
empty (no PIT snapshot covers date)" warning for every date before
coverage starts; 0 tickers scored → 0 mlTraining rows written.

**Confirmed-working universe:** **Dow** (30 names). Two prior dow
runs from 2026-05-11 produced 314 and 350 trades respectively with
no coverage warnings; PIT history extends back to 2018-01.

**Probably-working but unconfirmed:** **russell2k** (probe run
`bt_20260514102312_3tyufi` was still in flight as of writing — no
coverage warning issued, which is the good sign). If russell2k probe
completes with trades > 0, add a configs block (this doc) using
russell2k for richer training-data diversity.

**Permanently broken for historical backtests until backfilled:**
**sp500** and **ndx**. Lifting this is the scope of a new Phase
0a-2 brief (TBD; not in 5a scope).

---

## The six Dow configs

Hash-distinct across `topN`, `minComposite`, and `rebalanceFrequency`.
All include `allowParallel: true` so they fire back-to-back without
409s (per PR #25 `9ef72e3`).

| # | Universe | Cadence | topN | minComposite | Expected rows |
|---|----------|---------|-----:|-------------:|--------------:|
| 1 | dow      | monthly | 20   | 50           | ~1,680        |
| 2 | dow      | monthly | 20   | 60           | ~1,400        |
| 3 | dow      | monthly | 10   | 50           | ~840          |
| 4 | dow      | monthly | 25   | 50           | ~2,100        |
| 5 | dow      | quarterly | 20 | 50           | ~560          |
| 6 | dow      | weekly  | 15   | 55           | ~5,500        |

**Total expected rows: ~12,080.** Above the 10,000 / 5-run gate.

Common config:
- `board: 'prophet'`, `startDate: '2018-01-01'`, `endDate: '2024-12-31'`
- `weighting: 'equal'`, `maxPositionPct: 0.10`, `maxSectorPct: 0.50`, `cashSleeve: 0.00`
- `costs.slippageBps.dow: 10`, `costs.commission: 0`
- `initialCapital: 100000`, `allowParallel: true`

(`maxPositionPct: 0.10` and `maxSectorPct: 0.50` are looser than the
sp500 configs reflected — Dow's 30-name universe needs them.)

---

## Operational risks acknowledged

- **Dow is small.** 30 names. Limits training-data diversity. ML
  models trained on this will be optimizing within a narrow large-cap
  blue-chip universe — generalization to sp500-scale data is not
  guaranteed. Phase 5a's findings will need to note this in the
  "Limitations" section.
- **The structural limitation (`engine.ts:489` writes only top-N picks)**
  still applies — all rows are `inPortfolio = True` by construction.
  Phase 4a-2 is the long-term lift.
- **Hash collisions across the 6 configs are possible but unlikely.**
  Verify via `python export_training_data.py --dry-run` after launch.

---

## Original plan — unrunnable (historical record)

The original seed-runs.md (commit `a6ecc48`) specified five
sp500-based configs. Run #1 (`bt_20260514094547_548uox`) fired and
"completed" in 5 seconds with 0 trades — all 84 monthly rebalance
dates emitted "universe pool empty" warnings. Probe of ndx with the
same dates (`bt_20260514102311_w8e72m`) had identical failure mode.

The sp500/ndx PIT coverage gap is a real product issue. Phase 0a-2
(TBD) backfills universe-history from a static source like
Wikipedia's historical sp500 membership tables joined with Polygon's
historical ticker activity. Out of scope for this seed-runs work —
Dow gets us across the 5a data gate today.
