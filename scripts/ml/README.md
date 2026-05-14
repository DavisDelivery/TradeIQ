# Phase 5a — ML training pipeline

This directory holds the Phase 5a ML discovery pipeline. The
deliverable is `reports/phase-5a/findings.md`, written by
`run_all.py` after end-to-end evaluation of six models against the
mlTraining rows persisted by the Phase 4a engine.

This is **research code**. Nothing in this directory is imported by
the production Netlify functions or the React app; the data
exchange medium is Firestore (read) and a markdown report (write).
Phase 5b is where any winning model would propagate back into the
TypeScript scorer.

## What's here

| File | Workstream | Purpose |
|------|------------|---------|
| `export_training_data.py` | W2 | Stream `backtestRuns/*/mlTraining` from Firestore, dedupe true duplicates, write `data/ml-training.parquet` + sidecar metadata. |
| `features.py` | W3 | Four feature sets (`A`/`B`/`C`/`D`) + composable presets (`AB`, `ABCD`, `BD`). |
| `targets.py` | W4 | Three target framings: regression, rank, top-decile classification. |
| `cv.py` | W5 | Purged walk-forward CV with embargo. Sklearn-compatible adapter `PurgedWalkForwardCV`. |
| `models.py` | W6 | Six-model lineup: Model 0 (composite baseline) + Models 1–5. |
| `metrics.py` | W6 | Cross-sectional rank-IC, Pearson IC, IR, decile spread, top-K hit rate, paired Wilcoxon, Bonferroni. |
| `regime_analysis.py` | W7 | Global vs per-regime Model 3 comparison. |
| `interpretability.py` | W8 | LightGBM importance, permutation importance, SHAP, partial dependence, correlation heatmaps. |
| `run_all.py` | W9 | End-to-end orchestrator. Produces `reports/phase-5a/findings.md`. |
| `tests/` | W5/W6 etc. | 50 unit + integration tests. |

## Quickstart

### 1. Python toolchain

```bash
# From repo root. uv is preferred; pip also works.
uv venv --python 3.11 .venv
source .venv/bin/activate
uv pip install -r scripts/ml/requirements.lock
```

Python 3.11 is pinned via `.python-version`.

### 2. Firebase service-account credentials

Drop a service-account JSON at `.secrets/firebase-sa.json`. The
`.secrets/` directory is gitignored. The JSON must be the
**service-account JSON** (downloaded from Firebase Console →
Project Settings → Service accounts → "Generate new private key"),
**not** the public web-app config and **not** a `AIzaSy...` API key.

Then export the env var that `firebase-admin` reads:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/.secrets/firebase-sa.json"
```

On systems behind a TLS-inspecting proxy, also set:

```bash
export GRPC_DEFAULT_SSL_ROOTS_FILE_PATH="$SSL_CERT_FILE"  # or REQUESTS_CA_BUNDLE
```

The export script auto-propagates this env var when present; this
manual step is only needed if you bypass the script.

### 3. Run the pipeline

```bash
# 3a. Export mlTraining rows from Firestore -> Parquet
python scripts/ml/export_training_data.py
# -> data/ml-training.parquet + data/ml-training.parquet.meta.json

# 3b. Run the full evaluation pipeline
python scripts/ml/run_all.py
# -> reports/phase-5a/findings.md
# -> reports/phase-5a/tables/{headline,fold_results}.csv
# -> reports/phase-5a/figures/*.png  (when --interpret is enabled)
```

### 4. Run the test suite

```bash
python -m pytest scripts/ml/tests/ -v
ruff check scripts/ml/
```

Five mandatory CV tests are in `tests/test_cv.py` and must all
pass before any report is considered trustworthy.

## Data-availability gate

The brief requires **≥ 10,000 mlTraining rows** across **≥ 5
distinct complete runs** before the pipeline produces a binding
finding. If the export script reports fewer, do not generate a
"findings" report — the Wilcoxon test has insufficient power, and
any IC numbers are noise. Launch more backtests via the Phase 4b-2
launcher and re-export.

Suggested seed configs (covers the brief's intended cross-section
of regimes, cadences, and universes):

- `dow / 2018-01-01 → 2024-12-31 / monthly / topN=20`
- `dow / 2018-01-01 → 2024-12-31 / weekly / topN=20`
- `sp500 / 2018-01-01 → 2024-12-31 / monthly / topN=20`
- `sp500 / 2018-01-01 → 2024-12-31 / monthly / topN=50`
- `ndx / 2018-01-01 → 2024-12-31 / monthly / topN=20`

## Interpreting `findings.md`

The report's headline reads as one of three "decision paths":

- **A** — at least one model beats the composite baseline at p < 0.05
  (Bonferroni-corrected). Recommended: draft Phase 5b to deploy the
  winner as a **re-ranker** over the existing top-N picks.
- **B** — no model beats the baseline. The composite weights are at
  or near the achievable ceiling for the current analyst lineup.
  Recommended: either accept the ceiling or draft Phase 5a-2 to add
  analysts / alternative data / longer history.
- **C** — exactly one model marginally beats; results are
  inconclusive. Recommended: repeat in ~6 months with more data; do
  NOT deploy anything from this run.

The brief is explicit that **path B is a perfectly valid outcome**.
Ugly results that hold up are more valuable than pretty results that
don't.

## Critical limitations (verbatim from `phase-5a-schema-notes.md`)

- **Universe filtering happens before ML sees the data.** The Phase 4a
  engine writes mlTraining rows only inside the `for (const p of
  target)` loop — i.e., only top-N portfolio picks contribute. Models
  trained here are structurally **re-rankers within the composite's
  top-N**, not replacements for the selection step itself. Phase 6+
  engine work could change this; Phase 5a does not.
- **All forward returns are pre-cost.** The brief assumed `forwardReturn`
  was net of slippage; the engine writes gross close-to-close returns at
  4 horizons (`forward{5,20,60,252}dReturn`). Phase 5a default target
  is `forward20dReturn` (closest to monthly rebalance cadence).
- **`holdDays` is always null** in the current engine. The CV purge
  substitutes the chosen forward-return horizon as the proxy purge
  window (20 trading days ≈ 28 calendar days for the default target).
- **`composite` not `compositeScore`; `layers` not `layerScores`.**
  Field names in the brief's example schema do not match the engine's
  actual writes. See `briefs/phase-5a-schema-notes.md` for the full diff.

## Known data-quality artifacts

- `layer_fundamental` mean ~7 on the live data (seen during W2 dry
  run). Upstream data-mapping bug; affects more tickers than the
  brief's V/NKE/CVX list. Use the `--sensitivity-drop-fundamental-bug`
  flag (TODO 5b) or filter in pandas before re-running.
- `layer_relativeStrength` saturates near 100. Sigmoid normalization
  has compressed away discriminative power on the upper end.
- The composite-score histogram is not exactly a single spike at 50,
  but it's narrower than ideal. Real artifact, not a bug.

## Reproducibility

Every output stamps:

- The input Parquet's SHA-256 hash (in `findings.md` header and the
  `.meta.json` sidecar).
- The git HEAD at run time.
- The random seed (`42`, set at module-load for `random`, `numpy`,
  and via LightGBM's `random_state` + `deterministic=True`).

Re-running on the same Parquet must produce a `findings.md` whose
numeric IC values match to ~4 decimals (modulo tree-model float
non-determinism, which is bounded by `deterministic=True` and
`n_jobs=1` in `LGBM_DEFAULTS`).

## Out of scope (deferred)

- Hyperparameter grid search (5b).
- Deploying winning models into the TypeScript scorer (5b).
- Online learning / continuous retraining (5c).
- Multi-horizon meta-models (5c+).
- Adding new analyst layers (Phase 6+).
- Real-time inference (5c+).
