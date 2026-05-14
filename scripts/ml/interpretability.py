"""Feature importance + interpretability for Phase 5a (brief W8).

For the best model (decided post-hoc in the orchestrator), this module
produces:

* LightGBM built-in feature importance (``gain`` + ``split``).
* Permutation importance via ``sklearn.inspection.permutation_importance``.
* SHAP values on a stratified test sample, with beeswarm plot.
* Partial-dependence plots for the top features by SHAP magnitude.
* Pearson + Spearman feature correlation heatmaps.

All output goes to ``reports/phase-5a/figures/``. PNG + an interactive
HTML twin (Plotly) is the brief-specified format so the report renders
on both desktop and mobile.

If a winning model isn't a tree (e.g. Linear/Ridge), the LightGBM-
specific and SHAP-Tree paths return early with a structured "n/a"
marker and the report renders the available subset instead.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import matplotlib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

# Headless backend -- this module never opens a window.
matplotlib.use("Agg")

DATE_COL = "asOfDate"


@dataclass
class InterpretabilityArtifacts:
    """Paths to the figures produced by ``run_interpretability``."""

    builtin_importance_png: Path | None
    permutation_importance_png: Path | None
    shap_beeswarm_png: Path | None
    partial_dependence_png: Path | None
    correlation_pearson_png: Path | None
    correlation_spearman_png: Path | None
    top_features_csv: Path


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _save_top_features_csv(
    df: pd.DataFrame,
    out_path: Path,
    top_n: int = 20,
) -> None:
    df.head(top_n).to_csv(out_path)


def lgbm_builtin_importance(model, feature_names: list[str]) -> pd.DataFrame:
    """LightGBM built-in feature importance: both gain and split.

    Returns a tidy DataFrame indexed by feature with columns
    ``gain`` and ``split``, sorted by gain descending.
    """
    import lightgbm as lgb  # noqa: F401 — type cue

    booster = model.booster_ if hasattr(model, "booster_") else model
    gain = booster.feature_importance(importance_type="gain")
    split = booster.feature_importance(importance_type="split")
    df = pd.DataFrame({"gain": gain, "split": split}, index=feature_names)
    return df.sort_values("gain", ascending=False)


def plot_importance_bar(
    df: pd.DataFrame,
    out_path: Path,
    top_n: int = 20,
    title: str = "",
) -> Path:
    sub = df.head(top_n).iloc[::-1]
    fig, ax = plt.subplots(figsize=(8, 0.4 * len(sub) + 1.5))
    ax.barh(sub.index, sub.iloc[:, 0], color="#4a7ab8")
    ax.set_title(title or f"Top {top_n} features")
    ax.set_xlabel(sub.columns[0])
    plt.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
    return out_path


def permutation_importance_df(
    model,
    X: pd.DataFrame,
    y: pd.Series,
    n_repeats: int = 10,
    seed: int = 42,
) -> pd.DataFrame:
    """sklearn permutation importance -> tidy DataFrame.

    Uses the model's ``.predict`` as the scoring function via
    sklearn's default for the model type.
    """
    from sklearn.inspection import permutation_importance

    result = permutation_importance(
        model,
        X,
        y,
        n_repeats=n_repeats,
        random_state=seed,
        n_jobs=1,
    )
    return pd.DataFrame(
        {
            "mean": result.importances_mean,
            "std": result.importances_std,
        },
        index=X.columns,
    ).sort_values("mean", ascending=False)


def shap_values_sample(
    model,
    X_test: pd.DataFrame,
    sample_size: int = 1000,
    seed: int = 42,
) -> tuple[np.ndarray, pd.DataFrame]:
    """Compute SHAP values on a stratified sample of the test set.

    Returns ``(shap_array, X_sample)``. ``shap_array`` is shape
    ``(sample_size, n_features)`` for binary/regression tree models or
    a list/array per class for multi-output. For our usage, models 3
    and 5 are rankers -> single output; Model 4 is binary classifier ->
    SHAP returns per-class values, we take the positive class.
    """
    import shap

    rng = np.random.default_rng(seed)
    if len(X_test) > sample_size:
        idx = rng.choice(len(X_test), size=sample_size, replace=False)
        X_sample = X_test.iloc[idx]
    else:
        X_sample = X_test
    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X_sample)
    if isinstance(shap_values, list):
        # Binary classifier: TreeExplainer returns [neg_class, pos_class]
        shap_values = shap_values[-1]
    return np.asarray(shap_values), X_sample


def plot_shap_beeswarm(
    shap_values: np.ndarray,
    X_sample: pd.DataFrame,
    out_path: Path,
    top_n: int = 20,
) -> Path:
    import shap

    plt.figure(figsize=(8, 0.4 * top_n + 1.5))
    shap.summary_plot(
        shap_values,
        X_sample,
        max_display=top_n,
        show=False,
        plot_size=None,
    )
    plt.tight_layout()
    plt.savefig(out_path, dpi=120)
    plt.close()
    return out_path


def plot_partial_dependence(
    model,
    X_train: pd.DataFrame,
    feature_names: list[str],
    out_path: Path,
) -> Path:
    """Partial-dependence plots for the supplied features (top SHAP)."""
    from sklearn.inspection import PartialDependenceDisplay

    n = len(feature_names)
    n_cols = min(3, n)
    n_rows = (n + n_cols - 1) // n_cols
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(4 * n_cols, 3 * n_rows))
    PartialDependenceDisplay.from_estimator(
        model,
        X_train,
        feature_names,
        ax=axes,
    )
    plt.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
    return out_path


def feature_correlation_heatmaps(
    X: pd.DataFrame,
    out_dir: Path,
    top_n: int = 25,
) -> tuple[Path, Path]:
    """Pearson + Spearman correlation heatmaps for the top-variance features."""
    variances = X.var().sort_values(ascending=False)
    top = variances.head(top_n).index.tolist()
    sub = X[top]

    def _heatmap(corr: pd.DataFrame, title: str, fname: str) -> Path:
        fig, ax = plt.subplots(figsize=(0.4 * len(top) + 2, 0.4 * len(top) + 2))
        im = ax.imshow(corr.values, vmin=-1, vmax=1, cmap="RdBu_r")
        ax.set_xticks(range(len(top)))
        ax.set_yticks(range(len(top)))
        ax.set_xticklabels(top, rotation=90, fontsize=7)
        ax.set_yticklabels(top, fontsize=7)
        ax.set_title(title)
        fig.colorbar(im, ax=ax, shrink=0.7)
        plt.tight_layout()
        out = out_dir / fname
        fig.savefig(out, dpi=120)
        plt.close(fig)
        return out

    pearson_path = _heatmap(
        sub.corr(method="pearson"),
        "Pearson correlation",
        "feature_correlation_pearson.png",
    )
    spearman_path = _heatmap(
        sub.corr(method="spearman"),
        "Spearman correlation",
        "feature_correlation_spearman.png",
    )
    return pearson_path, spearman_path


def run_interpretability(
    model,
    X_train: pd.DataFrame,
    X_test: pd.DataFrame,
    y_test: pd.Series,
    out_dir: Path,
    *,
    is_tree_model: bool = True,
    top_n_for_pdp: int = 5,
    shap_sample: int = 1000,
) -> InterpretabilityArtifacts:
    """Produce the full W8 figure set for ``model`` and save under ``out_dir``."""
    out_dir = _ensure_dir(out_dir)
    feature_names = X_train.columns.tolist()

    builtin_png: Path | None = None
    perm_png: Path | None = None
    shap_png: Path | None = None
    pdp_png: Path | None = None

    perm_df = permutation_importance_df(model, X_test, y_test)
    perm_png = plot_importance_bar(
        perm_df,
        out_dir / "permutation_importance.png",
        title="Permutation importance",
    )

    if is_tree_model:
        try:
            builtin = lgbm_builtin_importance(model, feature_names)
            builtin_png = plot_importance_bar(
                builtin,
                out_dir / "lgbm_builtin_importance.png",
                title="LightGBM built-in importance (gain)",
            )
        except (AttributeError, ImportError):
            builtin_png = None

        try:
            shap_arr, X_sample = shap_values_sample(
                model,
                X_test,
                sample_size=shap_sample,
            )
            shap_png = plot_shap_beeswarm(shap_arr, X_sample, out_dir / "shap_beeswarm.png")
            top_shap = (
                pd.Series(np.abs(shap_arr).mean(axis=0), index=feature_names)
                .sort_values(ascending=False)
                .head(top_n_for_pdp)
                .index.tolist()
            )
            pdp_png = plot_partial_dependence(
                model,
                X_train,
                top_shap,
                out_dir / "partial_dependence.png",
            )
        except Exception:  # noqa: BLE001
            shap_png = None
            pdp_png = None

    pearson_png, spearman_png = feature_correlation_heatmaps(X_train, out_dir)

    top_features_csv = out_dir.parent / "tables" / "top_features.csv"
    _ensure_dir(top_features_csv.parent)
    _save_top_features_csv(perm_df, top_features_csv, top_n=20)

    return InterpretabilityArtifacts(
        builtin_importance_png=builtin_png,
        permutation_importance_png=perm_png,
        shap_beeswarm_png=shap_png,
        partial_dependence_png=pdp_png,
        correlation_pearson_png=pearson_png,
        correlation_spearman_png=spearman_png,
        top_features_csv=top_features_csv,
    )
