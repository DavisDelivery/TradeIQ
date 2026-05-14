# Phase 5a — seed-run configs (clearing the data gate)

**Purpose.** Phase 5a's W0 data gate requires ≥10,000 `mlTraining`
rows from ≥5 runs before the discovery pipeline can produce a
binding `findings.md`. Current state: 389 rows from 3 runs. This doc
specifies five hash-distinct backtest configs that, run as a batch,
clear the gate (~20,200 rows total expected) and provide enough
config diversity that any model signal is unlikely to be an artifact
of one config's idiosyncrasies.

**Hash distinctness.** The export script dedupes on
`(_runConfigHash, asOfDate, ticker)`. Each config below varies in
dimensions that affect either picks selected (topN, minComposite,
rebalanceFrequency) or the asOfDate grid, so configs produce
genuinely different rows — not just hash-distinct duplicates.

**Important note on the structural limitation** (per
`briefs/phase-5a-schema-notes.md` "Critical limitation"): the engine
writes `mlTraining` rows only for top-N portfolio picks, not the
full scored universe. All five configs inherit this limitation;
Phase 5a's findings will answer **"can a model re-rank within
composite's picks?"**, not **"should composite have picked
differently?"**. Phase 4a-2 (newly added to ORCHESTRATOR) is the
future engine change that lifts the limitation.

---

## The five configs

| # | Universe | Cadence | topN | minComposite | Expected rows | Hash-distinguishing dim |
|---|----------|---------|-----:|-------------:|--------------:|-------------------------|
| 1 | sp500    | monthly | 50   | 50           | ~4,200        | (baseline) |
| 2 | sp500    | monthly | 50   | 60           | ~3,500–4,000  | stricter gate |
| 3 | sp500    | monthly | 20   | 50           | ~1,680        | concentrated picks |
| 4 | sp500    | quarterly | 50 | 50           | ~1,400        | different asOfDate grid |
| 5 | sp500    | weekly  | 30   | 55           | ~10,950       | weekly cadence (biggest contributor) |

**Total expected rows: ~21,700**. Well above the 10,000 threshold
even after deduplication on the small overlap regions (most rows
are at distinct asOfDates between configs because of cadence
differences).

All configs share:
- `board: 'prophet'` (only board with non-null mlTraining rows in
  current engine — see `briefs/phase-5a-schema-notes.md` § "How rows
  are produced")
- `startDate: '2018-01-01'`, `endDate: '2024-12-31'` (full available
  history)
- `weighting: 'equal'`, `maxPositionPct: 0.05`, `maxSectorPct: 0.40`,
  `cashSleeve: 0.00`
- `costs.slippageBps.sp500: 10`, `costs.commission: 0`
- `initialCapital: 100000`

---

## Launch via `POST /api/backtest-runs/start`

Each config is a self-contained JSON body. Returns `202` with
`{ runId, config }` in <1s; the actual scan runs in a background
function.

### Config 1 — baseline sp500/monthly/top50/minComposite=50

```bash
curl -sS -X POST https://tradeiq-alpha.netlify.app/api/backtest-runs/start \
  -H "Content-Type: application/json" \
  -d '{
    "allowParallel": true,
    "universe": "sp500",
    "startDate": "2018-01-01",
    "endDate": "2024-12-31",
    "rebalanceFrequency": "monthly",
    "board": "prophet",
    "portfolio": {
      "topN": 50,
      "weighting": "equal",
      "maxPositionPct": 0.05,
      "maxSectorPct": 0.40,
      "cashSleeve": 0.00,
      "minComposite": 50
    },
    "costs": {
      "slippageBps": { "sp500": 10 },
      "commission": 0
    },
    "initialCapital": 100000
  }'
```

### Config 2 — stricter gate sp500/monthly/top50/minComposite=60

Same as #1 except `minComposite: 60`.

```bash
curl -sS -X POST https://tradeiq-alpha.netlify.app/api/backtest-runs/start \
  -H "Content-Type: application/json" \
  -d '{
    "allowParallel": true,
    "universe": "sp500",
    "startDate": "2018-01-01",
    "endDate": "2024-12-31",
    "rebalanceFrequency": "monthly",
    "board": "prophet",
    "portfolio": {
      "topN": 50,
      "weighting": "equal",
      "maxPositionPct": 0.05,
      "maxSectorPct": 0.40,
      "cashSleeve": 0.00,
      "minComposite": 60
    },
    "costs": {
      "slippageBps": { "sp500": 10 },
      "commission": 0
    },
    "initialCapital": 100000
  }'
```

### Config 3 — concentrated sp500/monthly/top20/minComposite=50

Same as #1 except `topN: 20`.

```bash
curl -sS -X POST https://tradeiq-alpha.netlify.app/api/backtest-runs/start \
  -H "Content-Type: application/json" \
  -d '{
    "allowParallel": true,
    "universe": "sp500",
    "startDate": "2018-01-01",
    "endDate": "2024-12-31",
    "rebalanceFrequency": "monthly",
    "board": "prophet",
    "portfolio": {
      "topN": 20,
      "weighting": "equal",
      "maxPositionPct": 0.05,
      "maxSectorPct": 0.40,
      "cashSleeve": 0.00,
      "minComposite": 50
    },
    "costs": {
      "slippageBps": { "sp500": 10 },
      "commission": 0
    },
    "initialCapital": 100000
  }'
```

### Config 4 — quarterly sp500/quarterly/top50/minComposite=50

Same as #1 except `rebalanceFrequency: "quarterly"`.

```bash
curl -sS -X POST https://tradeiq-alpha.netlify.app/api/backtest-runs/start \
  -H "Content-Type: application/json" \
  -d '{
    "allowParallel": true,
    "universe": "sp500",
    "startDate": "2018-01-01",
    "endDate": "2024-12-31",
    "rebalanceFrequency": "quarterly",
    "board": "prophet",
    "portfolio": {
      "topN": 50,
      "weighting": "equal",
      "maxPositionPct": 0.05,
      "maxSectorPct": 0.40,
      "cashSleeve": 0.00,
      "minComposite": 50
    },
    "costs": {
      "slippageBps": { "sp500": 10 },
      "commission": 0
    },
    "initialCapital": 100000
  }'
```

### Config 5 — weekly sp500/weekly/top30/minComposite=55

Weekly cadence, slightly tighter gate, smaller topN. Largest
contributor (~11k rows).

```bash
curl -sS -X POST https://tradeiq-alpha.netlify.app/api/backtest-runs/start \
  -H "Content-Type: application/json" \
  -d '{
    "allowParallel": true,
    "universe": "sp500",
    "startDate": "2018-01-01",
    "endDate": "2024-12-31",
    "rebalanceFrequency": "weekly",
    "board": "prophet",
    "portfolio": {
      "topN": 30,
      "weighting": "equal",
      "maxPositionPct": 0.05,
      "maxSectorPct": 0.40,
      "cashSleeve": 0.00,
      "minComposite": 55
    },
    "costs": {
      "slippageBps": { "sp500": 10 },
      "commission": 0
    },
    "initialCapital": 100000
  }'
```

---

## Operational notes

- **`"allowParallel": true` is on each body above** (or use
  `?parallel=1` in the URL). The trigger's default 30-minute
  single-flight guard was added to prevent accidental double-clicks
  (see Phase 4b-2 W3); it blocks back-to-back launches with HTTP
  409. The opt-in bypass was added specifically to support this
  batch — see `netlify/functions/backtest-runs-trigger.ts`. Without
  the flag, only run #1 starts; runs #2-5 return 409 with run #1's
  runId and DO NOT enqueue.

- **Run order doesn't matter.** All five are independent; they can
  fire in parallel without contention beyond Polygon's free-tier
  rate limit. The launcher already has `scoringConcurrency` capped
  appropriately.
- **Each run takes 15–45 min wall-clock** depending on cadence and
  cache warmth (run 1 cold; later runs benefit from PIT data cache).
  Weekly cadence (config 5) is the longest.
- **Track progress** via `GET /api/backtest-runs?status=running` or
  the existing BacktestView UI tab.
- **Failure recovery.** If any run errors mid-flight, the engine
  persists progress per rebalance; rerunning the same config
  resumes. Different config = different hash = different run, so
  retries are safe.

---

## Confirming the data gate is cleared

After all five complete, the Phase 5a executor agent runs:

```bash
cd scripts/ml
export GOOGLE_APPLICATION_CREDENTIALS=$(pwd)/../../.secrets/firebase-sa.json
python export_training_data.py --dry-run
```

Expected dry-run output: total rows ≥ 10,000 across ≥ 5 unique
`_runConfigHash` values. Once confirmed, the actual export step
(without `--dry-run`) writes the canonical parquet and the 5a
pipeline can proceed end-to-end:

```bash
python export_training_data.py
python run_all.py
```

`reports/phase-5a/findings.md` gets populated with real numbers; PR
#24 flips out of draft.

---

## What "good" looks like in the export sanity check

The `export_training_data.py` script's summary block should show:

- Total rows: > 10,000
- Unique runs: 5
- Distinct `_runConfigHash`: 5
- Distinct tickers: > 200 (sp500 plus some entry/exit churn)
- Date range: 2018-01-01 to 2024-12-31 (or within a few days)
- Null rate on `forward20dReturn`: < 5% (only the tail of the date
  range loses 20d forward because end-of-data truncation)
- `regime` distribution: roughly proportional to historical regime
  durations (~60% bull, ~25% neutral, ~15% bear; SPY-derived)

If any of those is materially off, the agent surfaces it before
running `run_all.py` — it's almost certainly a data-quality bug
that needs investigation, not a Phase 5a problem.
