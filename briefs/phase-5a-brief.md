# Phase 5a — ML Training Pipeline (Discovery)

**Author:** orchestrator
**Target version:** No frontend changes — `APP_VERSION` stays at `0.15.0-alpha`.
**Dependencies:** Phase 4a (engine writes `mlTraining` rows on every run) ✓ merged; Phase 4b-1 + 4b-2 (run viewer + launcher) ✓ merged. At least 5–10 backtest runs with populated `mlTraining` subcollections must exist in Firestore before training begins — Chad runs these via the new 4b-2 launcher as part of W0.
**Status when this brief is written:** main = `2c29c8f` + PR #17 + #18 merged, 367 tests passing, bundle 259.68 kB gzipped, production at v0.15.0-alpha.

---

## Why this exists

The Phase 4a engine has been quietly writing one row per (asOfDate, ticker) pair to `backtestRuns/{runId}/mlTraining/{rowId}` since it shipped. Each row is a point-in-time observation: at rebalance date `T`, for ticker `X`, the analyst layer scores AND the realized forward return from `T` to the next rebalance. That's training data. It's been accumulating; nothing consumes it.

Phase 5a asks a single question: **does any ML model beat the existing hand-tuned composite scorer by a statistically meaningful margin, using methodology that holds up to scrutiny?**

If the answer is yes, Phase 5b deploys the winner into the scorer and Phase 5c handles retraining cadence + monitoring. If the answer is no — and "no" is a perfectly valid outcome — we know the analyst layers themselves are the ceiling, and the next research direction is adding analysts or improving the underlying signals, not re-weighting.

This is research, not production. The deliverable is a report. No model goes anywhere near the live scorer in 5a.

## The dishonesty trap (read this first)

ML on financial data is the easiest place in the world to fool yourself. Phase 4a built its whole identity around honesty (universe survivorship stamps, point-in-time data layer, purged caches). Phase 5a inherits that thesis. The classic ways to lie:

- **k-fold cross-validation** on time-series data → label leakage from future rows into past training folds. Result: gorgeous IC numbers that evaporate live.
- **TimeSeriesSplit without embargo** → leakage through serial correlation in features (today's score depends on yesterday's data, which already informed the last training row). Result: looks honest, isn't.
- **Hyperparameter search on the same data the model is evaluated on** → grid search picks the lucky configuration; report shows that configuration's score. Result: in-sample IC reported as out-of-sample.
- **Cherry-picked time window** → "the model works in 2020–2023" with no mention of why 2018 and 2024 were excluded. Result: backtest that doesn't generalize.
- **Multiple-testing without correction** → train 50 models, pick the one with highest IC, report it. Result: random noise reported as edge.
- **Reporting only the winning regime** → "Model 3 IC=0.08 in bull_low_vol" with no comparable result for other regimes. Result: claims an edge that only exists in a 30% slice of history.
- **Composite baseline conveniently omitted** → "Model 3 IC=0.05" reads as great until you mention the composite scorer's IC is 0.06 on the same data. Result: model that's strictly worse, reported as a win.

Every protocol below exists to prevent one of these. Don't relax the protocols because the early results look ugly. Ugly results that hold up are infinitely more valuable than pretty results that don't.

## Operational context

- Repo: `DavisDelivery/TradeIQ`
- Firebase project: `tradeiq-alpha`
- `GITHUB_PAT`: `<read-only-PAT, provided per session>` — for `git` operations. Chad provides a fresh write-scoped PAT per session.
- `FIREBASE_SERVICE_ACCOUNT`: `<JSON, provided per session>` — Python `firebase-admin` needs this to read Firestore. Store under `.secrets/firebase-sa.json`; the directory must be `.gitignore`'d.
- `NETLIFY_TOKEN`: not used in Phase 5a. No Netlify function changes.
- Training is offline. The Netlify function tier is for hot-path inference and has 15-min caps; ML training is batch work that runs locally in the agent sandbox (or on Chad's Mac via Cowork).
- Mobile-first does not apply — Phase 5a produces no frontend.

### A note on adding Python to the repo

Phase 5a introduces the first Python code in TradeIQ (`scripts/ml/`). Rationale: the ML ecosystem (pandas, scikit-learn, LightGBM, SHAP, statsmodels) is mature in Python and primitive in JS/TS. Re-implementing LightGBM in TypeScript is a non-starter. Phase 5a accepts the polyglot cost. Phase 5b will face the harder question — "how do we deploy a Python-trained model back into the TS scorer?" — but that's not 5a's problem.

Python tooling decisions:
- **Dependency manager:** `uv` if available (faster, modern), else plain `pip` with a pinned `requirements.txt`. Both work; pick `uv`. Lock file committed.
- **Python version:** 3.11. Pinned in `.python-version`.
- **Test runner:** `pytest`. Tests live in `scripts/ml/tests/`.
- **Linter:** `ruff` for both lint and format. Single tool, fast.
- **Reproducibility:** every script sets `random.seed(42)`, `np.random.seed(42)`, `torch.manual_seed(42)` (if torch is used). The input data is hashed (SHA-256 of the Parquet file) and the hash is stamped into every output report.

## W0 — Preconditions

Run these before writing any code. If any of them fail, stop and report to Chad.

1. `git fetch origin && git log --oneline -3 origin/main` — confirm main is at `2c29c8f` or later (i.e., 4b-1 + 4b-2 + the PAT secrets-scan fix all merged).
2. `npm ci && npm test` — confirm 367 tests passing as the JS-side baseline. Untouched in 5a, but a regression here means main was poisoned by something else.
3. `npm run build` — confirm clean build. Bundle size unchanged from 259.68 kB gzipped.
4. **Check the training dataset.** Hit `/api/backtest-runs?limit=20`. There must be ≥ 5 runs. For each run, examine `mlTrainingCount` via `/api/backtest-runs/<runId>`. Sum the counts across all runs. **Minimum dataset for Phase 5a: 10,000 rows.** If less than 10,000, agent stops and tells Chad to launch more backtests via the 4b-2 launcher before proceeding. Suggested seed runs to ask for:
   - `dow / 2018-01-01 → 2024-12-31 / monthly / topN=20` (the existing smoke-test run)
   - `dow / 2018-01-01 → 2024-12-31 / weekly / topN=20`
   - `sp500 / 2018-01-01 → 2024-12-31 / monthly / topN=20`
   - `sp500 / 2018-01-01 → 2024-12-31 / monthly / topN=50`
   - `ndx / 2018-01-01 → 2024-12-31 / monthly / topN=20`
5. Read `netlify/functions/shared/backtest/engine.ts` end-to-end. Locate the `mlTraining` persistence calls. Document the exact row shape (W1 output).
6. Read `netlify/functions/shared/backtest/types.ts` — find any `MLTrainingRow` type or analogous. If it exists, copy its definition into `briefs/phase-5a-schema-notes.md` (W1).

## W1 — Inspect the `mlTraining` schema

Output: `briefs/phase-5a-schema-notes.md`, doc-only, committed straight to main on a single hygiene commit.

Read the engine code. For every field written into `mlTraining` rows, document:
- Field name (exact, case-sensitive)
- TypeScript type
- Always-present vs optional
- Units / encoding (decimal? percent? timestamp ms vs ISO string?)
- Whether the field is post-cost or pre-cost (for `forwardReturn`)
- Whether the value is point-in-time or includes any future information

The brief's assumed shape (verify, don't trust):
```ts
type MLTrainingRow = {
  runId: string;                  // parent run identifier
  asOfDate: string;               // ISO date 'YYYY-MM-DD', the scoring date
  ticker: string;
  layerScores: {
    fundamental?: number;         // 0-100
    momentum?: number;
    technical?: number;
    insider?: number;
    sentiment?: number;
    // ... whatever analysts the scorer has
  };
  compositeScore: number;         // 0-100, post-weight + post-normalize
  regime: string;                 // 'bull_low_vol' | 'bear_high_vol' | etc.
  forwardReturn: number;          // decimal, e.g. 0.0234 for +2.34%; net of slippage
  forwardReturnRaw?: number;      // optional, pre-cost
  holdDays: number;               // calendar days until next rebalance
  inPortfolio: boolean;           // was this ticker actually held by the strategy
};
```

If the actual shape differs, the schema-notes doc is the authoritative source for downstream features/training code. Discrepancies must be called out — silently adapting to the wrong field name is how layer scores end up in the wrong columns and IC magically goes to zero.

**Known scorer issues from prior phases that affect this work:**
- Composite scores cluster at 50 across many tickers (post-sigmoid normalization compression). This is a real artifact, not a data bug. ML on raw layers may extract information that the composite squashed.
- Fundamental layer returns 0 for NKE, V, CVX (and possibly others) due to a data-mapping bug. Flag any ticker with `fundamental === 0` across multiple asOfDates as suspect; exclude in W3 sensitivity check.
- Quiver lobbying + patents are noisy upstream. The `insider` layer (which depends on Quiver) may have systematic gaps in 2018–2019. Flag any layer with > 30% null rate in any year.

## W2 — Export training data

File: `scripts/ml/export-training-data.py`

Responsibilities:
1. Initialize `firebase_admin` with the service account JSON. Project must match `tradeiq-alpha`.
2. Iterate over all docs in `backtestRuns` (filter by `status == 'complete'` to skip failed/cancelled runs; do this server-side via a `where` clause so we don't pull failed runs into memory).
3. For each run, stream `backtestRuns/{runId}/mlTraining` subcollection. Stream means `.stream()` with no `.get()` materializing the whole subcollection — for 100k+ rows this matters.
4. Append every row to a list of dicts. Add provenance columns:
   - `_runId` — parent run identifier.
   - `_runConfigHash` — first 12 chars of SHA-256 over canonical-JSON-encoded `run.config` (universe + cadence + topN + startDate + endDate). Stable identifier for "same config." Two runs of the same config produce the same hash; two runs that differ in any tracked field produce different hashes.
   - `_runConfigSummary` — human-readable string like `"dow/monthly/top20/2018-01-01→2024-12-31"` for log and report rendering.
   - `_completedAt` — used for ordering when deduplicating true duplicates (see Deduplication section below).
5. Convert to a `pandas.DataFrame`.
6. Write to `data/ml-training.parquet` with `compression='snappy'`. Mark the file with a sidecar `data/ml-training.parquet.meta.json` containing: row count, asOfDate min/max, unique runIds, SHA-256 of the parquet file, export timestamp.
7. Print a summary table to stdout:
   - Total rows
   - Rows per universe (`dow` / `sp500` / `ndx` / `russell2k`)
   - Rows per regime
   - Rows per year
   - Unique tickers (top 20 by row count)
   - Null counts per field
   - Per-layer mean, std, min, max, % null

CLI flags:
- `--max-runs N` — limit to N most recent runs (default: all)
- `--since YYYY-MM-DD` — only include runs whose `asOfDate` is after this date
- `--out PATH` — override default parquet path
- `--dry-run` — print summary only, no parquet write

Run it once. Confirm output passes sanity:
- All `forwardReturn` values are finite floats (no inf, no NaN).
- All `asOfDate` values parse as valid dates.
- Layer scores are within [0, 100] (or whatever range the scorer uses — check schema notes).
- `compositeScore` distribution: histogram should NOT be a single spike at 50. If it is, the layer scores aren't being normalized into the composite correctly — flag and stop.

### Deduplication and config grouping

Two kinds of duplicates exist; handle them differently.

**True duplicates** — same `_runConfigHash` AND same `(asOfDate, ticker)`. These arise whenever Chad re-launches the same config (4b-2 makes this trivial). The layer scores are deterministic given config + asOfDate + ticker, so the second run produces row-for-row identical data. Naive pooling double-counts these in every downstream metric: each duplicate gets two votes in IC, two members in the rank-loss group, two contributions to the Wilcoxon test, etc.

Resolution: dedupe on `(_runConfigHash, asOfDate, ticker)`, keeping the row with the latest `_completedAt`. Log the count of dropped duplicates to stdout AND stamp it into the sidecar metadata JSON. If `dropped_duplicates / total_rows > 0.1`, surface a warning — that much duplication suggests something unexpected happened upstream.

**Different-config rows that share `(asOfDate, ticker)`** — these are NOT duplicates and must NOT be deduped. The same ticker scored at the same date under different configs produces:

- Same `layerScores` and `compositeScore` — these are config-independent at point-in-time.
- DIFFERENT `forwardReturn`, `holdDays`, `inPortfolio` — these depend on the rebalance cadence and portfolio selection rule of the run that produced them.

Pooling monthly and weekly rows blindly inflates the dataset and pools incomparable labels (a monthly `forwardReturn` covers ~21 trading days; a weekly one covers ~5). Two paths forward, both honest; agent picks one and documents the choice in the schema notes:

- **Path 1 (preferred):** treat each `_runConfigHash` as its own dataset for training and evaluation. The pipeline runs once per config; the headline table has one row per (model × config). A pooled-across-configs row is reported separately, clearly labeled "POOLED — different cadences, interpret with care."
- **Path 2:** restrict the entire pipeline to a single cadence (monthly is the canonical choice — most runs use it). Drop other-cadence rows at the export stage. Simpler to write up, throws away data.

If the dataset coming out of W0 has only one config represented, this is moot — note it in the schema notes and proceed without the per-config dimension.

The export script writes all surviving rows (true duplicates removed, distinct-config rows preserved) to the Parquet. The decision about how to group/segment for training happens in `run-all.py` (W11) based on what configs actually exist in the data.

## W3 — Feature engineering

File: `scripts/ml/features.py`

Produce four feature sets. Each is a pure function: `(raw_df) -> features_df`. No file I/O. No globals.

### Feature set A — Raw layer scores
- All `layerScores.*` fields, one column each.
- One row per (asOfDate, ticker) — same granularity as input.
- Null handling: leave nulls in place. Tree models handle them natively; linear models will need imputation in W6.
- Output columns: `feat_fundamental`, `feat_momentum`, `feat_technical`, `feat_insider`, `feat_sentiment`, ...

### Feature set B — Cross-sectional ranks
- For each `asOfDate`, rank tickers within universe on each layer score.
- Convert to percentile rank in [0, 1] using `pandas.DataFrame.rank(pct=True)`.
- Handles non-stationarity in the raw layer outputs (a fundamental score of 70 in 2018 may mean something different than 70 in 2024).
- Output: `feat_fundamental_rank`, `feat_momentum_rank`, ...

### Feature set C — Composite-relative residuals
- Each layer score minus the composite score, per row.
- Captures the information that the composite discarded by averaging.
- Output: `feat_fundamental_resid`, `feat_momentum_resid`, ...

### Feature set D — Regime-conditional
- One-hot encode `regime`.
- For each layer × regime pair, add an interaction column: `feat_fundamental_x_bull_low_vol`, etc.
- Useful for tree models to learn regime-specific splits without us telling them where to look.

Combinable feature sets:
- AB: A + B
- ABCD: A + B + C + D (full)
- BD: B + D (cross-sectional ranks + regime, no raw magnitudes)

Document each in `scripts/ml/features.py` with a docstring and a unit test.

**Constraint:** no future information. Verify per-feature:
- A cross-sectional rank uses only same-`asOfDate` rows → OK.
- A regime indicator at time T uses the engine-stamped regime at T → OK.
- A rolling mean over the prior N rebalances uses only data with `asOfDate <= T` → OK in principle, but **don't add rolling features in 5a**. They're a temptation to lookahead. 5b can revisit.

## W4 — Target definitions

File: `scripts/ml/targets.py`

Three target framings. The same model architecture is trained on each; we pick the framing that yields best out-of-sample IC.

### Framing 1: Regression
- Target: `forwardReturn` directly (decimal).
- Loss: MSE for linear models; Huber for tree models (robust to outliers).
- Predictions interpreted as expected return.

### Framing 2: Cross-sectional rank
- Target: within each `asOfDate`, rank tickers by `forwardReturn`, convert to percentile in [0, 1].
- Loss: pairwise rank loss (LambdaRank in LightGBM via `objective='lambdarank'`, group by `asOfDate`).
- Predictions interpreted as relative rank within a rebalance cohort.

### Framing 3: Decile classification
- Target: within each `asOfDate`, bin `forwardReturn` into 10 buckets. Top decile = 1, others = 0.
- Loss: binary cross-entropy.
- Predictions interpreted as probability of being in the top decile.
- Threshold for class label is the 90th percentile of `forwardReturn` within `asOfDate`. Document the bucket boundaries per fold (they will differ).

**Critical:** for all three framings, the target is computed within each `asOfDate` group. Cross-sectional. We are predicting which ticker outperforms the rest of the universe at each rebalance, not predicting absolute return.

The IC metric we care about is **cross-sectional rank-IC**: for each `asOfDate`, the Spearman correlation between the model's predicted score and the realized `forwardReturn` across all tickers scored at that date. This single metric is what the strategy economically cares about: "at each rebalance, did my ranking put the eventual winners at the top?"

## W5 — Time-series cross-validation

File: `scripts/ml/cv.py`

This is the load-bearing piece of methodology. Get it wrong and every result downstream is fiction.

### Scheme: Purged Walk-Forward CV with Embargo

Sort all rows by `asOfDate`. Define N folds (default 5). For fold `i`:
- **Train:** all rows with `asOfDate <= train_end[i]`
- **Test:** all rows with `test_start[i] <= asOfDate < test_end[i]`
- **Purge:** drop training rows whose forward-return window overlaps with the test fold (i.e., training rows with `asOfDate + holdDays > test_start[i]`).
- **Embargo:** `test_start[i] = train_end[i] + E` where `E` is at least 3 rebalances (configurable). Embargo protects against any serial correlation in features that the purge doesn't catch.

```python
def purged_walkforward_cv(
    asOfDate: pd.Series,
    holdDays: pd.Series,
    n_splits: int = 5,
    embargo_rebalances: int = 3,
    rebalance_freq: str = 'monthly',
) -> Iterator[tuple[np.ndarray, np.ndarray]]:
    """
    Yield (train_indices, test_indices) for each fold.

    Guarantees:
      - For every fold, max(train asOfDate + holdDays) < min(test asOfDate).
      - For every fold, gap >= embargo_rebalances rebalance periods.
      - Folds tile the time axis chronologically — no overlap of test sets.
      - Train sets are CUMULATIVE (each fold's train includes all prior data
        up to the embargo). This is walk-forward, not rolling.

    The embargo is expressed in rebalances rather than calendar days because
    the engine's rebalance schedule is the natural unit of "next event."
    For a monthly cadence with embargo=3, that's ~63 trading days.
    """
```

Implementation:
1. Discretize the timeline into rebalance windows. The `asOfDate` column is already on the rebalance grid (each value is a rebalance date). Get unique sorted rebalance dates.
2. Split the rebalance dates into N+1 contiguous chunks (n_splits=5 → 6 chunks). Each fold uses one chunk as test, all earlier chunks (minus embargo) as train.
3. For each row in the test chunk, mark it. For each row in earlier chunks, mark it as train candidate. Then purge: drop train rows where `asOfDate + holdDays * trading_day_factor` falls inside or after the test chunk's first date.

### Unit tests (mandatory)

`scripts/ml/tests/test_cv.py` — at minimum:

1. **No overlap test:** assemble a synthetic DataFrame with 1000 rows across 50 asOfDates. Run the splitter. For every fold, assert `set(train_dates) & set(test_dates) == empty`.
2. **Embargo test:** for every fold, `min(test asOfDate) - max(train asOfDate) >= embargo_rebalances * approx_period`.
3. **Purge test:** construct a fold where a training row's `forwardReturn` window extends into the test set's first asOfDate. Assert that row is purged.
4. **Walk-forward test:** assert that for folds 0..N-1, `train[i] ⊆ train[i+1]` (train sets are nested).
5. **Sklearn compatibility test:** the splitter should plug into sklearn pipelines that expect `.split(X, y)`. Provide a thin sklearn-compatible wrapper class.

If any of these fail, stop. CV correctness is non-negotiable.

## W6 — Baseline models

File: `scripts/ml/models.py`

For each (model, feature_set, target_framing) combination, train under the CV scheme and compute fold-wise metrics. Then aggregate.

### Model 0: Existing composite scorer (BASELINE)
- No training. Use `compositeScore` column from the raw data directly as the predicted score.
- Compute cross-sectional rank-IC per fold (against test rows only).
- This is the bar everything else must clear.

### Model 1: Linear regression with raw layers
- Features: Feature set A
- Target framing: 1 (regression on `forwardReturn`)
- Library: `sklearn.linear_model.LinearRegression`
- Imputation: `SimpleImputer(strategy='median')` for nulls. Fit imputer per fold on train, apply to test (avoid leakage from full-data imputation).

### Model 2: Ridge regression
- Features: Feature set A
- Target framing: 1
- Library: `sklearn.linear_model.RidgeCV` with alphas `[0.01, 0.1, 1.0, 10.0, 100.0]`
- **Nested CV:** RidgeCV's internal CV must also be time-aware. Pass `cv=TimeSeriesSplit(n_splits=3)` so alpha selection doesn't leak. (Yes, you have to fight sklearn to do CV correctly here.)

### Model 3: LightGBM ranker
- Features: Feature set B (cross-sectional ranks)
- Target framing: 2 (rank within asOfDate)
- Library: `lightgbm.LGBMRanker` with `objective='lambdarank'`
- Group: `asOfDate`. The ranker needs `group=` parameter listing group sizes; each group is one asOfDate cohort.
- Defaults: `n_estimators=200`, `learning_rate=0.05`, `num_leaves=31`, `min_data_in_leaf=20`, `reg_lambda=1.0`. No grid search in 5a — defaults are deliberately reasonable; grid search is 5b.
- Categorical handling: regime is one-hot encoded into Feature set B; LightGBM also supports native categorical via `categorical_feature=` — use that for any string-typed columns.

### Model 4: LightGBM binary classifier (top decile)
- Features: Feature set A
- Target framing: 3 (binary classification, top decile per asOfDate)
- Library: `lightgbm.LGBMClassifier`, `objective='binary'`
- Score for ranking: `predict_proba(X)[:, 1]` — probability of being in the top decile.

### Model 5: LightGBM ranker on full feature set
- Features: Feature set ABCD (everything)
- Target framing: 2
- Same hyperparameters as Model 3
- Primary purpose: does more data hurt? If Model 5 IC < Model 3 IC, we've found that some features are noise.

### Metrics computed per fold per model

In `scripts/ml/metrics.py`:

- **Cross-sectional rank-IC:** for each `asOfDate` in the test fold, Spearman correlation between predicted score and realized `forwardReturn`. Report mean across asOfDates as the fold's IC. (Sometimes called "rank IC" or just "IC".)
- **Cross-sectional Pearson IC:** same but Pearson. Reported alongside rank-IC.
- **IR (Information Ratio):** IC mean / IC std across asOfDates within the fold. A high-IC strategy with high std is less reliable than a moderate-IC strategy with low std.
- **Decile spread:** at each asOfDate, sort tickers by predicted score, take top decile and bottom decile, compute (top mean `forwardReturn`) − (bottom mean `forwardReturn`). Report the mean across asOfDates. Economic interpretation: long-short return per rebalance.
- **Top-K hit rate:** at each asOfDate, take the top K=20 predicted tickers. Compute fraction whose realized `forwardReturn` is in the top 20% of the universe at that asOfDate. Report mean across asOfDates.

Aggregate per model: mean ± std across folds for every metric.

### Per-config IC reporting (mandatory when multiple configs survive W2)

If the deduped dataset contains more than one `_runConfigHash`, every metric above (rank-IC, Pearson-IC, IR, decile spread, top-K hit rate) must be reported BOTH:

- **Per-config:** one row per (model × config) in the headline table. This is the honest view — different configs have different label distributions (a weekly-cadence `forwardReturn` and a monthly one are not on the same scale), and pooling biases the metric toward whichever config contributes more rows.
- **Pooled:** one row per model marked `POOLED`, footnoted with the list of configs included and an explicit warning about cadence-mismatch effects on `forwardReturn` magnitude. Acceptable as a summary line; not acceptable as the basis for the statistical test below.

If only one config survives W2, the per-config dimension collapses and metrics are reported only at the model level. Note this in the report.

### Statistical test for "beats baseline"

For each model AND each config (or just per model if only one config exists), compare its per-asOfDate rank-IC distribution to Model 0's per-asOfDate rank-IC distribution using a **paired one-sided Wilcoxon signed-rank test** (paired because the same asOfDates appear in both). Report p-value. A model is declared to "beat the baseline" on a given config if p < 0.05 with a Bonferroni correction for the number of models tested **within that config** (5 models → adjusted threshold p < 0.01). Each config is its own analysis with its own correction — a model that beats the baseline on monthly/dow but loses on weekly/sp500 is informative, and pooling the multiple comparisons across configs would mask that.

The Wilcoxon is right because IC distributions are not normal. Don't use a paired t-test.

## W7 — Regime-conditional analysis

File: `scripts/ml/regime_analysis.py`

For Model 3 (LightGBM ranker, the most flexible model in the lineup):

1. Train one global model on all training data. Compute test IC stratified by regime (i.e., compute IC separately within each regime label using the global model's predictions).
2. Train one model per regime: for each regime label, train on training rows where `regime == label`, evaluate on test rows where `regime == label`. Compare per-regime IC to the global model's per-regime IC.
3. Report:
   - Global model IC per regime
   - Per-regime model IC per regime
   - Difference (per-regime gain)
   - Sample count per regime (small regimes may have unreliable estimates — flag if `n_train < 500`)

Interpretation: if per-regime models beat the global model in `bull_low_vol` but lose in `bear_high_vol`, the optimal production strategy is regime-conditional. If they tie everywhere, regime isn't an information dimension worth modeling separately.

## W8 — Feature importance + interpretability

File: `scripts/ml/interpretability.py`

For the best model (decided post-hoc as whichever beats the baseline by the largest statistically significant margin; if no model beats the baseline, the best is whichever has the highest mean IC):

1. **LightGBM built-in feature importance** — both `importance_type='gain'` and `importance_type='split'`. Bar chart, top 20 features.
2. **Permutation importance** — use `sklearn.inspection.permutation_importance` on the test fold. More robust than built-in. Mean ± std across 10 permutations.
3. **SHAP** — `shap.TreeExplainer(model).shap_values(X_test_sample)` on a stratified 1000-row sample of the test set. Beeswarm plot.
4. **Partial dependence plots** for the top 5 features by SHAP magnitude.
5. **Feature correlation matrix** — Pearson and Spearman, heatmap. Identifies redundancy.

Output: PNG figures under `reports/phase-5a/figures/`. Each figure also saved as an interactive HTML (Plotly) so Chad can pan/zoom on mobile.

## W9 — Report generation

File: `reports/phase-5a/findings.md` (output, not source — but committed to the repo so the next phase brief can reference it).

Required sections, in order:

### 1. Executive summary (≤ 200 words)
- Did any model beat the baseline by a statistically significant margin?
- If yes: which one, by how much, in which regimes, and what's the recommended action.
- If no: state plainly. Recommended action is Phase 5a-2 ("more data / new features") or accept the composite as ceiling and move to adding analysts.

### 2. Data
- Total rows, date range, universes, regimes, runs included.
- SHA-256 of the input Parquet.
- Per-layer null rates.
- Composite score distribution histogram. Confirm it's not a single spike at 50; if it is, abort report and re-check the scorer.

### 3. Methodology
- CV scheme (purged walk-forward, n_splits=5, embargo=3 rebalances).
- Models tried (5 + baseline).
- Feature sets used per model.
- Target framings used per model.
- Statistical test for "beats baseline" with Bonferroni correction.
- Hyperparameters used (table). Acknowledge no grid search in 5a.

### 4. Results
- **Headline table:** model × config × metric grid. If multiple configs survive W2 dedupe, the table has one row per (model, config) pair, with the config in the leftmost column. Columns: rank-IC mean ± std, Pearson-IC mean ± std, IR, decile spread, top-20 hit rate, p-value vs baseline (Bonferroni-corrected within config). If only one config exists, the per-config dimension collapses and the table is model × metric.
- **Pooled summary row:** at the bottom of the headline table, add a `POOLED` row per model showing pooled-across-configs metrics. Footnote names the configs and warns about cadence-mismatch effects on `forwardReturn` magnitude. Pooled p-values are NOT reported — the test runs per-config only.
- **Per-fold IC chart:** boxplot or strip plot, one box per model. If multiple configs exist, facet by config (one subplot per config).
- **Per-regime IC chart:** model 3 global vs per-regime, one bar per regime.
- **Decile spread time series:** for the best model, plot the cumulative decile spread over the test windows. Tells you if the alpha is steady or front-loaded into a single year.

### 5. Feature importance
- SHAP beeswarm for the best model.
- Top 10 features by SHAP magnitude. Interpret each: does the direction make economic sense? (E.g., if `feat_momentum_rank` is the top feature and the SHAP direction says high momentum → high predicted score, that's intuitive. If `feat_insider_rank` is top and the direction says high insider selling → high predicted score, that's surprising — flag for review.)
- Feature correlation heatmap. Note any feature pair with |r| > 0.7 as a redundancy candidate for 5b.

### 6. Sensitivity checks
- Remove the highest-IC fold. Re-aggregate. Does the conclusion change? If yes, the result is fragile.
- Remove the suspect tickers (NKE, V, CVX with fundamental=0). Does IC change materially? If yes, the data bug matters.
- Restrict to `inPortfolio == True` rows only (the strategy's actual holdings). IC on the realized portfolio is the most economically relevant number; it should be ≥ universe-wide IC.

### 7. Limitations
- The training data is itself produced by a backtest on possibly-uncorrected universes. Survivorship bias in the training data → models learn patterns specific to survivors. Acknowledge this.
- Sample size: 10k–50k rows is small for ML. Trees can overfit; report cross-fold IC std as the honest noise floor.
- We're modeling realized historical returns. The future may not behave like 2018–2024. State this. No model survives a regime it never saw.
- The composite baseline was hand-tuned on the same data the engine is reading. There's an apples-to-apples problem: a model trained on the same data has the same potential biases.

### 8. Recommendations
- Path A: a model beat the baseline by enough → Phase 5b spec (deploy this model class with this feature set).
- Path B: no model beat the baseline → Phase 5a-2 spec (add features, add data, or accept ceiling).
- Path C: results are inconclusive (one model marginally beats, others tie) → repeat 5a in 6 months with more accumulated training data; do not deploy.

The report must explicitly identify which path applies. No ambiguity.

## W10 — Tests + docs

### Python tests

`scripts/ml/tests/` — pytest suite. Tests must cover:

1. **CV splitter** (W5) — 5 tests, all must pass.
2. **Feature functions** (W3) — for each feature set, a test that:
   - Verifies output shape (same number of rows as input).
   - Verifies no future leakage (a rank computed at asOfDate T uses only T's rows).
   - Verifies null preservation where expected.
3. **Metrics** (W6) — synthetic test:
   - Construct a perfect predictor (predicted score = forwardReturn). Verify rank-IC = 1.0.
   - Construct a random predictor (predicted score = `np.random.shuffle(forwardReturn)`). Verify rank-IC ≈ 0.0 (within tolerance over many trials).
   - Construct an inverse predictor (predicted score = -forwardReturn). Verify rank-IC = -1.0.
4. **Reproducibility test** — run the full pipeline twice with the same seed. Outputs must be bitwise identical (modulo floating-point rounding in tree models, which is hard to fully control).

### Docs

`scripts/ml/README.md`:
- Install instructions (uv sync or pip install -r requirements.txt)
- Environment setup (`.secrets/firebase-sa.json` placement, `.gitignore` rules)
- How to run the full pipeline: `python scripts/ml/run-all.py`
- Individual scripts and their purposes
- How to interpret the findings report
- Known issues (composite cluster, fundamental data bugs)

`scripts/ml/requirements.txt` (or `pyproject.toml`):
- `firebase-admin >= 6.0`
- `pandas >= 2.0`
- `pyarrow >= 14.0`
- `numpy >= 1.26`
- `scikit-learn >= 1.4`
- `lightgbm >= 4.0`
- `shap >= 0.44`
- `matplotlib >= 3.8`
- `plotly >= 5.18`
- `pytest >= 8.0`
- `ruff >= 0.3`

All versions pinned to a known-good range. Lock file via `uv lock` or `pip-compile`.

## W11 — Version + ORCHESTRATOR + PR

- `APP_VERSION` in `src/App.jsx`: no change. 5a has no frontend.
- `ORCHESTRATOR.md`:
  - Phase 5a row: `done` @ no version bump, date set, summary covers methodology + headline finding (which path A/B/C).
  - Phase 5b row: `pending`, blocked-on-finding. Brief description depends on 5a outcome.
  - Phase 5c row: `pending`, blocked-on-5b.
  - Update Phase 0 leftover items (Sentry, vitest coverage, etc.) only if Phase 5a accidentally addresses them (it shouldn't).
- PR description at `briefs/phase-5a-pr-description.md` — same shape as 4b-1/4b-2 PR descriptions. Add a "Decisional output" section pointing at the findings report and which path was taken.

## Verification (must pass before opening the PR)

1. `python -m pytest scripts/ml/tests/` — all pass.
2. `ruff check scripts/ml/` — clean.
3. `python scripts/ml/run-all.py` — full pipeline produces `reports/phase-5a/findings.md` end-to-end. Wall time target: < 30 min on a modern laptop. If > 60 min, profile and report what's slow.
4. The findings report renders cleanly in a markdown viewer. Top 5 features have sensible interpretations.
5. Statistical test results match an independent verification: re-compute the headline rank-IC for the best model and for Model 0 by hand-rolling the Spearman correlation in a notebook. Numbers must match the pipeline output exactly.
6. `git diff --stat` shows roughly the file list below.
7. JS-side `npm test` — still 367 passing. (Should be untouched; this is a sanity check.)
8. `npm run build` — still clean.

## Out of scope (deferred, explicit list)

- **Deploying a trained model into the live scorer.** 5b territory. Requires answering "how do we ship Python-trained model artifacts into a TypeScript Netlify function?" — three options: re-implement inference in TS (only feasible for linear models), export to ONNX and load in a Node runtime, or stand up a separate Python inference service (Cloud Run, Cloud Functions). 5b decides.
- **Hyperparameter grid search.** 5b. Premature optimization in 5a — defaults must already be sensible for the discovery report to be honest.
- **Alternative data sources.** 5c+.
- **Online learning / continuous retraining.** 5c.
- **Multi-horizon predictions.** We predict the next-rebalance return only. Predicting 2-rebalance-ahead is a separate research question.
- **Portfolio construction changes.** 5a doesn't touch the topN selection rule, weighting, or rebalance schedule. Even if Model 3 predicts something better, 5a doesn't act on it.
- **Real-time / live-inference path.** 5c.
- **Composite-scorer source code edits.** 5a observes the composite; doesn't change it.
- **Backfill of new analyst layers.** 5a uses the layers that already exist. Adding analysts is a Phase 6+ conversation.
- **UI changes to surface ML predictions.** 5b territory if Path A is the outcome.

## Files target

```
scripts/ml/export-training-data.py          NEW  ~150 lines
scripts/ml/features.py                      NEW  ~250 lines
scripts/ml/targets.py                       NEW  ~100 lines
scripts/ml/cv.py                            NEW  ~180 lines
scripts/ml/models.py                        NEW  ~350 lines
scripts/ml/metrics.py                       NEW  ~180 lines
scripts/ml/regime_analysis.py               NEW  ~150 lines
scripts/ml/interpretability.py              NEW  ~200 lines
scripts/ml/run-all.py                       NEW  ~120 lines (orchestrator script)
scripts/ml/tests/test_cv.py                 NEW  ~150 lines
scripts/ml/tests/test_features.py           NEW  ~120 lines
scripts/ml/tests/test_metrics.py            NEW  ~100 lines
scripts/ml/tests/test_targets.py            NEW  ~80 lines
scripts/ml/README.md                        NEW  ~150 lines
scripts/ml/requirements.txt                 NEW  ~15 lines
scripts/ml/pyproject.toml                   NEW  ~30 lines
.python-version                             NEW  1 line
.gitignore                                  edit  add data/, .secrets/, reports/phase-5a/figures/
briefs/phase-5a-schema-notes.md             NEW  ~80 lines  (output of W1)
reports/phase-5a/findings.md                NEW  ~600 lines (output of W9)
reports/phase-5a/figures/*.png              NEW  ~10 files
ORCHESTRATOR.md                             edit  5a/5b/5c rows
briefs/phase-5a-pr-description.md           NEW  ~150 lines
```

About 22 files, ~3000 lines net (most of it auto-generated report content + pipeline code, not application code). One sizeable PR.

## Note to the executing agent

The single most important responsibility in this brief is **methodological honesty**. Phase 4a built the project's credibility on honest backtests. Phase 5a inherits and extends it: honest training, honest evaluation, honest reporting. The temptation to massage the methodology until a model "works" is enormous because:

1. The agent who runs this brief will see the early IC numbers before the report is written.
2. If the early numbers look bad (every model around composite-baseline IC), the agent may be tempted to relax embargo, switch CV scheme, add more features, drop "weird" tickers — all the standard ways researchers fool themselves.
3. The report will be the foundation of any 5b deployment decision. Chad will trust it. A dishonest finding here costs real money in 5b.

**The contract is:** run the methodology as specified, report whatever falls out, and write the conclusion section in plain English. If five models lose to the baseline, write "five models lost to the baseline; the composite scorer's hand-tuned weights are at or near the achievable ceiling for the current analyst lineup." That sentence is more valuable than any pretty graph showing an artifact.

If the methodology turns up something genuinely confusing — a feature with sky-high SHAP magnitude but a counter-intuitive direction, an IC that's huge in one regime and negative in another, a fold with 3× the IC of the others — surface it in the report under "Limitations" and "Recommendations" rather than working around it. Phase 5b's brief should be drafted from a position of knowing what's solid and what's noise.

On the polyglot concern (introducing Python): this is a deliberate, scoped decision. Confine all Python to `scripts/ml/`. Do not add Python to the production hot path. Do not import from `netlify/functions/` into Python or vice versa — the data exchange medium is Firestore (read) and the report file (write). 5b will decide how Python-trained models propagate into the TS scorer, if they propagate at all.

On the compute footprint: nothing in this brief requires GPU. LightGBM CPU is fast enough for 50k rows × 20 features × 200 trees × 5 folds in a few minutes. If the pipeline is taking > 30 min on a modern laptop, profile — there's a stupid loop somewhere, not a need for hardware.

On reproducibility: every result in the findings report must be reproducible by running `python scripts/ml/run-all.py` with the same input Parquet. Hash the input. Stamp the hash. If Chad re-runs in two months with new backtest data, the hash will change and the report will note "previous run hash X, current run hash Y" so we know the data set changed.

Ship the report. The report is the deliverable.
