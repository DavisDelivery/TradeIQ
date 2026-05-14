"""Phase 5a model lineup (brief W6).

Six models, all evaluated under the same purged walk-forward CV
scheme:

* **Model 0** — baseline: existing composite score (no training).
* **Model 1** — linear regression on raw layers.
* **Model 2** — Ridge regression with nested-CV alpha selection.
* **Model 3** — LightGBM ranker (LambdaRank) on cross-sectional ranks.
* **Model 4** — LightGBM binary classifier on top-decile labels.
* **Model 5** — LightGBM ranker on the full ABCD feature set.

Each ``fit_and_predict_*`` function takes the training/test DataFrames
plus a feature set name and returns a Series of test-fold predictions
aligned to the test DataFrame's index. The W9 orchestrator
(``run-all.py``) iterates models × CV folds × per-config datasets and
assembles the headline table.

Hyperparameters are intentionally fixed at sensible defaults — no
grid search in 5a per the brief; that belongs to 5b. Defaults are
based on standard LightGBM ranker setups for ~10k-50k row financial
datasets.
"""

from __future__ import annotations

import random
import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scripts.ml.cv import PurgedWalkForwardCV
from scripts.ml.features import build_features
from scripts.ml.targets import target_rank, target_regression, target_top_decile

SEED = 42
random.seed(SEED)
np.random.seed(SEED)

DATE_COL = "asOfDate"
COMPOSITE_COL = "composite"
DEFAULT_TARGET_COL = "forward20dReturn"
LGBM_DEFAULTS: dict[str, object] = {
    "n_estimators": 200,
    "learning_rate": 0.05,
    "num_leaves": 31,
    "min_data_in_leaf": 20,
    "reg_lambda": 1.0,
    "random_state": SEED,
    "deterministic": True,
    "force_row_wise": True,
    "n_jobs": 1,
    "verbose": -1,
}


@dataclass(frozen=True)
class ModelSpec:
    """Lightweight description of one model entry in the lineup."""

    name: str
    feature_preset: str | None  # None for Model 0 (uses composite directly)
    target_framing: str  # 'regression' | 'rank' | 'classification' | 'baseline'
    description: str


MODEL_LINEUP: tuple[ModelSpec, ...] = (
    ModelSpec(
        name="model_0_composite_baseline",
        feature_preset=None,
        target_framing="baseline",
        description="Hand-tuned composite score, no training",
    ),
    ModelSpec(
        name="model_1_linear_raw",
        feature_preset="A",
        target_framing="regression",
        description="Linear regression on raw layer scores",
    ),
    ModelSpec(
        name="model_2_ridge",
        feature_preset="A",
        target_framing="regression",
        description="Ridge with nested time-aware alpha selection",
    ),
    ModelSpec(
        name="model_3_lgbm_ranker",
        feature_preset="B",
        target_framing="rank",
        description="LightGBM LambdaRank on cross-sectional ranks",
    ),
    ModelSpec(
        name="model_4_lgbm_classifier",
        feature_preset="A",
        target_framing="classification",
        description="LightGBM binary classifier, top-decile target",
    ),
    ModelSpec(
        name="model_5_lgbm_ranker_full",
        feature_preset="ABCD",
        target_framing="rank",
        description="LightGBM LambdaRank on full ABCD feature set",
    ),
)


# --- Helpers -----------------------------------------------------------------


def _build_features_and_target(
    df: pd.DataFrame,
    preset: str,
    framing: str,
    target_col: str,
) -> tuple[pd.DataFrame, pd.Series, list[int] | None]:
    """Common feature/target construction.

    Returns ``(X, y, group_sizes)``. ``group_sizes`` is non-None only
    for the rank framing (LGBMRanker needs the per-asOfDate group
    sizes for pairwise loss).
    """
    X = build_features(df, preset)
    if framing == "regression":
        y = target_regression(df, horizon_col=target_col)
        return X, y, None
    if framing == "rank":
        y, groups = target_rank(df, horizon_col=target_col)
        return X, y, groups
    if framing == "classification":
        y = target_top_decile(df, horizon_col=target_col)
        return X, y, None
    raise ValueError(f"unknown framing: {framing!r}")


def _impute_median(
    train: pd.DataFrame,
    test: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Impute test-set nulls with TRAIN medians only (no leakage)."""
    medians = train.median(numeric_only=True)
    return train.fillna(medians), test.fillna(medians)


def _drop_target_nulls(
    X: pd.DataFrame,
    y: pd.Series,
    groups: list[int] | None = None,
) -> tuple[pd.DataFrame, pd.Series, list[int] | None]:
    """Drop rows where the target is null. Updates group sizes if provided."""
    if groups is None:
        mask = y.notna()
        return X.loc[mask], y.loc[mask], None
    # For rank framing: y is per-group ranked, so a null in y means
    # the underlying forward return was null. Reconstruct groups
    # post-filter by counting per-asOfDate. We need the date column
    # which the caller embedded in groups -- recompute outside.
    raise NotImplementedError(
        "drop with groups requires date-aware recomputation; "
        "caller must use _filter_rank_nulls instead"
    )


def _filter_rank_nulls(
    df_meta: pd.DataFrame,
    X: pd.DataFrame,
    y: pd.Series,
    date_col: str = DATE_COL,
) -> tuple[pd.DataFrame, pd.Series, list[int]]:
    """Drop rows with null target; rebuild group sizes by counting per-asOfDate
    in the surviving rows. Caller passes ``df_meta`` (rows aligned to X) for
    the date column.
    """
    mask = y.notna()
    X_f = X.loc[mask]
    y_f = y.loc[mask]
    df_f = df_meta.loc[mask]
    new_groups = df_f.groupby(date_col, sort=False).size().tolist()
    return X_f, y_f, new_groups


# --- Model 0 — baseline ------------------------------------------------------


def predict_model_0(test_df: pd.DataFrame) -> pd.Series:
    """Model 0: composite-score baseline. No training, no fitting."""
    if COMPOSITE_COL not in test_df.columns:
        raise ValueError(f"test_df missing '{COMPOSITE_COL}' column")
    return pd.to_numeric(test_df[COMPOSITE_COL], errors="coerce")


# --- Model 1 — linear regression ---------------------------------------------


def fit_and_predict_model_1(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    target_col: str = DEFAULT_TARGET_COL,
) -> pd.Series:
    """Model 1: linear regression on Feature set A (raw layers)."""
    from sklearn.linear_model import LinearRegression

    X_tr, y_tr, _ = _build_features_and_target(train_df, "A", "regression", target_col)
    X_te, _, _ = _build_features_and_target(test_df, "A", "regression", target_col)
    train_mask = y_tr.notna()
    X_tr_clean, X_te_clean = _impute_median(X_tr.loc[train_mask], X_te)
    model = LinearRegression()
    model.fit(X_tr_clean.to_numpy(), y_tr.loc[train_mask].to_numpy())
    preds = model.predict(X_te_clean.to_numpy())
    return pd.Series(preds, index=test_df.index, name="pred")


# --- Model 2 — Ridge with time-aware nested CV --------------------------------


def fit_and_predict_model_2(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    target_col: str = DEFAULT_TARGET_COL,
    inner_n_splits: int = 3,
) -> pd.Series:
    """Model 2: RidgeCV with PurgedWalkForwardCV as the inner CV.

    Sklearn's RidgeCV defaults to leave-one-out CV, which leaks across
    time. We force a time-aware splitter so alpha selection respects
    the same purged structure as the outer evaluation loop.
    """
    from sklearn.linear_model import RidgeCV

    X_tr, y_tr, _ = _build_features_and_target(train_df, "A", "regression", target_col)
    X_te, _, _ = _build_features_and_target(test_df, "A", "regression", target_col)

    train_mask = y_tr.notna()
    X_tr = X_tr.loc[train_mask]
    y_tr = y_tr.loc[train_mask]
    meta_tr = train_df.loc[train_mask, [DATE_COL]].copy()

    X_tr_imp, X_te_imp = _impute_median(X_tr, X_te)

    # Stitch asOfDate back into the matrix that RidgeCV passes through,
    # since the inner CV needs it.
    X_with_date = X_tr_imp.copy()
    X_with_date[DATE_COL] = meta_tr[DATE_COL].values

    inner_cv = PurgedWalkForwardCV(
        as_of_date_col=DATE_COL,
        hold_days_col=None,
        n_splits=inner_n_splits,
        embargo_rebalances=3,
    )
    # RidgeCV will pass X_with_date to inner_cv.split() and to the
    # estimator's fit. The estimator must NOT see the date column.
    # Use a small wrapper: drop the date col before scoring.
    from sklearn.base import BaseEstimator, RegressorMixin

    class _RidgeWithoutDate(BaseEstimator, RegressorMixin):
        def __init__(self, alpha: float = 1.0) -> None:
            self.alpha = alpha

        def fit(self, X, y):  # noqa: ANN001
            from sklearn.linear_model import Ridge

            cols = [c for c in X.columns if c != DATE_COL] if isinstance(X, pd.DataFrame) else None
            X_arr = X.drop(columns=[DATE_COL]).to_numpy() if cols else np.asarray(X)
            self._cols = cols
            self._inner = Ridge(alpha=self.alpha, random_state=SEED).fit(X_arr, y)
            return self

        def predict(self, X):  # noqa: ANN001
            if self._cols is not None and isinstance(X, pd.DataFrame):
                X_arr = X[self._cols].to_numpy()
            else:
                X_arr = np.asarray(X)
            return self._inner.predict(X_arr)

        def score(self, X, y):  # noqa: ANN001
            from sklearn.metrics import r2_score

            return r2_score(y, self.predict(X))

    # Manual alpha search via the inner CV (cleaner than fighting RidgeCV).
    alphas = (0.01, 0.1, 1.0, 10.0, 100.0)
    best_alpha = 1.0
    best_score = -np.inf
    for alpha in alphas:
        scores = []
        for tr_idx, te_idx in inner_cv.split(X_with_date):
            if len(tr_idx) == 0 or len(te_idx) == 0:
                continue
            X_a = X_with_date.iloc[tr_idx]
            X_b = X_with_date.iloc[te_idx]
            y_a = y_tr.iloc[tr_idx]
            y_b = y_tr.iloc[te_idx]
            model = _RidgeWithoutDate(alpha=alpha).fit(X_a, y_a)
            scores.append(model.score(X_b, y_b))
        if scores and float(np.mean(scores)) > best_score:
            best_score = float(np.mean(scores))
            best_alpha = alpha

    final = RidgeCV(alphas=[best_alpha]).fit(X_tr_imp.to_numpy(), y_tr.to_numpy())
    preds = final.predict(X_te_imp.to_numpy())
    return pd.Series(preds, index=test_df.index, name="pred")


# --- Model 3 — LightGBM ranker (cross-sectional ranks, Feature set B) --------


def fit_and_predict_model_3(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    target_col: str = DEFAULT_TARGET_COL,
    feature_preset: str = "B",
) -> pd.Series:
    """Model 3: LightGBM LambdaRank on Feature set B (or whatever preset).

    Shared with Model 5 (which uses the ``ABCD`` preset).
    """
    import lightgbm as lgb

    X_tr_full = build_features(train_df, feature_preset)
    y_tr_full, _ = target_rank(train_df, horizon_col=target_col)

    # LGBMRanker can't accept null targets; filter and rebuild group sizes
    X_tr, y_tr, groups_tr = _filter_rank_nulls(train_df, X_tr_full, y_tr_full)
    if not groups_tr or sum(groups_tr) == 0:
        return pd.Series(np.nan, index=test_df.index, name="pred")

    X_te = build_features(test_df, feature_preset)

    # Sort train by asOfDate so groups line up (LGBMRanker requires
    # contiguous group rows in the order of the group_sizes list).
    sort_idx = train_df.loc[X_tr.index].sort_values(DATE_COL).index
    X_tr = X_tr.loc[sort_idx]
    y_tr_sorted = y_tr.loc[sort_idx]
    groups_tr = train_df.loc[sort_idx].groupby(DATE_COL, sort=False).size().tolist()

    # Convert ranks in [0, 1] to 8 discrete relevance grades (0..7)
    # so LambdaRank treats them as ordered preferences. Standard
    # IR-style relevance is "perfect/excellent/good/...": 8 grades is
    # the conventional setting.
    relevance = (y_tr_sorted * 7).round().clip(0, 7).astype("int32").to_numpy()

    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        ranker = lgb.LGBMRanker(objective="lambdarank", **LGBM_DEFAULTS)
        ranker.fit(X_tr.to_numpy(), relevance, group=groups_tr)

    preds = ranker.predict(X_te.to_numpy())
    return pd.Series(preds, index=test_df.index, name="pred")


# --- Model 4 — LightGBM binary classifier ------------------------------------


def fit_and_predict_model_4(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    target_col: str = DEFAULT_TARGET_COL,
) -> pd.Series:
    """Model 4: LightGBM binary classifier on top-decile labels.

    Prediction is ``predict_proba(X)[:, 1]`` — probability of belonging
    to the top decile at the corresponding asOfDate.
    """
    import lightgbm as lgb

    X_tr = build_features(train_df, "A")
    y_tr = target_top_decile(train_df, horizon_col=target_col)
    X_te = build_features(test_df, "A")

    # Drop rows where the underlying forward return is null (target was
    # forced to 0 by target_top_decile, but training on those is noise).
    valid = pd.to_numeric(train_df[target_col], errors="coerce").notna()
    X_tr = X_tr.loc[valid]
    y_tr = y_tr.loc[valid]

    if y_tr.sum() == 0 or y_tr.sum() == len(y_tr):
        return pd.Series(np.nan, index=test_df.index, name="pred")

    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        clf = lgb.LGBMClassifier(objective="binary", **LGBM_DEFAULTS)
        clf.fit(X_tr.to_numpy(), y_tr.to_numpy())
    proba = clf.predict_proba(X_te.to_numpy())[:, 1]
    return pd.Series(proba, index=test_df.index, name="pred")


# --- Model 5 — LightGBM ranker on full ABCD ----------------------------------


def fit_and_predict_model_5(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    target_col: str = DEFAULT_TARGET_COL,
) -> pd.Series:
    """Model 5: same as Model 3 but with the full ABCD feature set.

    Comparing Model 3 IC vs Model 5 IC answers "does more data hurt?".
    """
    return fit_and_predict_model_3(
        train_df,
        test_df,
        target_col=target_col,
        feature_preset="ABCD",
    )


# --- Dispatch ----------------------------------------------------------------


def fit_and_predict(
    spec: ModelSpec,
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    target_col: str = DEFAULT_TARGET_COL,
) -> pd.Series:
    """Dispatch to the right model function based on spec.name."""
    if spec.name == "model_0_composite_baseline":
        return predict_model_0(test_df)
    if spec.name == "model_1_linear_raw":
        return fit_and_predict_model_1(train_df, test_df, target_col=target_col)
    if spec.name == "model_2_ridge":
        return fit_and_predict_model_2(train_df, test_df, target_col=target_col)
    if spec.name == "model_3_lgbm_ranker":
        return fit_and_predict_model_3(train_df, test_df, target_col=target_col)
    if spec.name == "model_4_lgbm_classifier":
        return fit_and_predict_model_4(train_df, test_df, target_col=target_col)
    if spec.name == "model_5_lgbm_ranker_full":
        return fit_and_predict_model_5(train_df, test_df, target_col=target_col)
    raise ValueError(f"unknown model spec: {spec.name!r}")
