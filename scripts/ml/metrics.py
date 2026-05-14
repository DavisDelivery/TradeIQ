"""Evaluation metrics for Phase 5a.

Headline metric is **cross-sectional rank-IC**: for each ``asOfDate``
in a test fold, the Spearman correlation between the model's
predicted score and the realized forward return across all tickers
scored at that date. The strategy economically cares about ranking
the right tickers at each rebalance; this metric mirrors that.

All metrics return both a scalar summary (mean across asOfDates) and
the underlying per-date array so callers can run statistical tests
(see ``beats_baseline_wilcoxon``).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import pearsonr, spearmanr, wilcoxon

DATE_COL = "asOfDate"
DEFAULT_TARGET_COL = "forward20dReturn"

# Spearman/Pearson are unreliable with very few points per group.
MIN_GROUP_SIZE_FOR_IC = 5
# Decile-spread requires at least 10 tickers per group (one per decile).
# With topN-only data we frequently have ~20 tickers, so the "decile"
# is really a 2-ticker bucket; the report flags this explicitly.
MIN_GROUP_SIZE_FOR_DECILE = 10


def _per_date_correlation(
    df: pd.DataFrame,
    pred_col: str,
    target_col: str,
    date_col: str,
    method: str,
) -> np.ndarray:
    """Per-asOfDate Spearman or Pearson correlation across tickers."""
    if method not in ("spearman", "pearson"):
        raise ValueError(f"method must be 'spearman' or 'pearson'; got {method!r}")
    corr_fn = spearmanr if method == "spearman" else pearsonr
    per_date: list[float] = []
    for _date, group in df.groupby(date_col, sort=True):
        if len(group) < MIN_GROUP_SIZE_FOR_IC:
            continue
        pred = pd.to_numeric(group[pred_col], errors="coerce")
        tgt = pd.to_numeric(group[target_col], errors="coerce")
        mask = pred.notna() & tgt.notna()
        if mask.sum() < MIN_GROUP_SIZE_FOR_IC:
            continue
        if pred[mask].nunique() < 2 or tgt[mask].nunique() < 2:
            continue
        try:
            rho = corr_fn(pred[mask].to_numpy(), tgt[mask].to_numpy())[0]
        except Exception:  # noqa: BLE001
            continue
        if np.isfinite(rho):
            per_date.append(float(rho))
    return np.asarray(per_date, dtype=float)


def cross_sectional_rank_ic(
    df: pd.DataFrame,
    pred_col: str,
    target_col: str = DEFAULT_TARGET_COL,
    date_col: str = DATE_COL,
) -> tuple[float, np.ndarray]:
    """Spearman rank-IC across asOfDates. Returns (mean, per-date array)."""
    per_date = _per_date_correlation(df, pred_col, target_col, date_col, "spearman")
    mean = float(per_date.mean()) if per_date.size else float("nan")
    return mean, per_date


def cross_sectional_pearson_ic(
    df: pd.DataFrame,
    pred_col: str,
    target_col: str = DEFAULT_TARGET_COL,
    date_col: str = DATE_COL,
) -> tuple[float, np.ndarray]:
    """Pearson IC across asOfDates. Returns (mean, per-date array)."""
    per_date = _per_date_correlation(df, pred_col, target_col, date_col, "pearson")
    mean = float(per_date.mean()) if per_date.size else float("nan")
    return mean, per_date


def information_ratio(per_date_ic: np.ndarray) -> float:
    """IC mean divided by IC std across asOfDates.

    A high-IC strategy with high std is less reliable than a moderate
    IC with low std. NaN if fewer than 2 dates or zero-std.
    """
    arr = np.asarray(per_date_ic, dtype=float)
    if arr.size < 2:
        return float("nan")
    std = arr.std(ddof=1)
    # Tolerance handles floating-point noise (e.g. constant 0.1 array
    # produces std ~ 1e-17 due to fp representation).
    if std < 1e-12:
        return float("nan")
    return float(arr.mean() / std)


def decile_spread(
    df: pd.DataFrame,
    pred_col: str,
    target_col: str = DEFAULT_TARGET_COL,
    date_col: str = DATE_COL,
) -> tuple[float, np.ndarray]:
    """Mean across asOfDates of (top-decile mean - bottom-decile mean) on target.

    Economic interpretation: per-rebalance long-short return if the
    strategy went long the top decile and short the bottom decile by
    predicted score. With small per-asOfDate group sizes (e.g. topN=20),
    each "decile" is only 2 tickers; the W9 report footnotes the
    sampling caveat.
    """
    per_date: list[float] = []
    for _date, group in df.groupby(date_col, sort=True):
        if len(group) < MIN_GROUP_SIZE_FOR_DECILE:
            continue
        sorted_g = group.sort_values(pred_col).dropna(subset=[pred_col, target_col])
        if len(sorted_g) < MIN_GROUP_SIZE_FOR_DECILE:
            continue
        bucket = max(1, len(sorted_g) // 10)
        top = sorted_g.tail(bucket)[target_col].mean()
        bot = sorted_g.head(bucket)[target_col].mean()
        per_date.append(float(top - bot))
    arr = np.asarray(per_date, dtype=float)
    mean = float(arr.mean()) if arr.size else float("nan")
    return mean, arr


def top_k_hit_rate(
    df: pd.DataFrame,
    pred_col: str,
    target_col: str = DEFAULT_TARGET_COL,
    date_col: str = DATE_COL,
    k: int = 20,
    top_quantile: float = 0.2,
) -> tuple[float, np.ndarray]:
    """Mean across asOfDates of (fraction of top-K predicted that land in the
    top ``top_quantile`` of realized return at the same asOfDate).

    With small per-asOfDate samples, K may exceed group size; we
    automatically cap K at floor(group_size / 2).
    """
    per_date: list[float] = []
    for _date, group in df.groupby(date_col, sort=True):
        clean = group.dropna(subset=[pred_col, target_col])
        if len(clean) < MIN_GROUP_SIZE_FOR_IC:
            continue
        k_eff = min(k, max(1, len(clean) // 2))
        top_pred = clean.nlargest(k_eff, pred_col)
        return_threshold = clean[target_col].quantile(1 - top_quantile)
        hit_rate = float((top_pred[target_col] >= return_threshold).mean())
        per_date.append(hit_rate)
    arr = np.asarray(per_date, dtype=float)
    mean = float(arr.mean()) if arr.size else float("nan")
    return mean, arr


def beats_baseline_wilcoxon(
    model_per_date_ic: np.ndarray,
    baseline_per_date_ic: np.ndarray,
) -> tuple[float, float]:
    """Paired one-sided Wilcoxon signed-rank test.

    H0: median(model_ic - baseline_ic) <= 0
    H1: median(model_ic - baseline_ic) > 0

    Returns ``(statistic, p_value)``. Length mismatch raises; ties
    (zero differences) are dropped per Wilcoxon convention. Fewer than
    5 non-zero differences returns ``(nan, nan)`` — too few points for
    the test to have power.
    """
    model = np.asarray(model_per_date_ic, dtype=float)
    base = np.asarray(baseline_per_date_ic, dtype=float)
    if model.shape != base.shape:
        raise ValueError(
            f"shape mismatch: model={model.shape} vs baseline={base.shape}; "
            "Wilcoxon needs paired observations on the SAME asOfDates"
        )
    finite = np.isfinite(model) & np.isfinite(base)
    diff = model[finite] - base[finite]
    diff = diff[diff != 0]
    if diff.size < 5:
        return (float("nan"), float("nan"))
    stat, p = wilcoxon(diff, alternative="greater")
    return float(stat), float(p)


def bonferroni_threshold(alpha: float, n_tests: int) -> float:
    """Bonferroni-corrected significance threshold for ``n_tests`` comparisons."""
    if alpha <= 0 or alpha >= 1:
        raise ValueError(f"alpha must be in (0, 1); got {alpha}")
    return alpha / max(1, n_tests)


def summarize_fold_metrics(
    df: pd.DataFrame,
    pred_col: str,
    target_col: str = DEFAULT_TARGET_COL,
    date_col: str = DATE_COL,
    k: int = 20,
) -> dict[str, float | np.ndarray]:
    """Single-fold metric bundle: mean / std / per-date arrays for IC family
    plus IR, decile spread, top-K hit rate.

    Returned dict keys (mean/std are floats; per-date keys are arrays):
        rank_ic_mean, rank_ic_std, rank_ic_per_date,
        pearson_ic_mean, pearson_ic_std,
        ir, decile_spread_mean, top_k_hit_rate_mean
    """
    rank_mean, rank_arr = cross_sectional_rank_ic(df, pred_col, target_col, date_col)
    pear_mean, pear_arr = cross_sectional_pearson_ic(df, pred_col, target_col, date_col)
    ds_mean, _ds_arr = decile_spread(df, pred_col, target_col, date_col)
    hr_mean, _hr_arr = top_k_hit_rate(df, pred_col, target_col, date_col, k=k)
    return {
        "rank_ic_mean": rank_mean,
        "rank_ic_std": float(rank_arr.std(ddof=1)) if rank_arr.size > 1 else float("nan"),
        "rank_ic_per_date": rank_arr,
        "pearson_ic_mean": pear_mean,
        "pearson_ic_std": (float(pear_arr.std(ddof=1)) if pear_arr.size > 1 else float("nan")),
        "ir": information_ratio(rank_arr),
        "decile_spread_mean": ds_mean,
        "top_k_hit_rate_mean": hr_mean,
        "n_dates_scored": int(rank_arr.size),
    }
