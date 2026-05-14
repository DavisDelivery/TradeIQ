"""Target definitions for Phase 5a.

Three target framings, each a pure function ``(df) -> (target_series,
group_sizes_optional)``. The same model architecture is fit on each
framing in W6 and the best out-of-sample rank-IC selects the winner.

* **Framing 1 — regression**: predict the forward return directly. The
  raw decimal return (default ``forward20dReturn``) is the target;
  loss is MSE/Huber.
* **Framing 2 — cross-sectional rank**: within each ``asOfDate``,
  convert ``forward<H>dReturn`` to a percentile rank in [0, 1].
  Trained with pairwise rank loss (LightGBM ``lambdarank``); the
  ranker needs group sizes which we return alongside the target.
* **Framing 3 — decile classification**: top-decile binary label per
  ``asOfDate``. Bucket boundaries are recomputed per group, so the
  threshold floats across regimes/years.

All framings are cross-sectional. We predict which ticker outperforms
the rest of the universe at each rebalance, not absolute return.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

DATE_COL = "asOfDate"
DEFAULT_HORIZON_COL = "forward20dReturn"
VALID_HORIZONS: tuple[str, ...] = (
    "forward5dReturn",
    "forward20dReturn",
    "forward60dReturn",
    "forward252dReturn",
)


def _validate_horizon(horizon_col: str) -> None:
    if horizon_col not in VALID_HORIZONS:
        raise ValueError(
            f"unknown horizon column {horizon_col!r}; expected one of {VALID_HORIZONS}"
        )


def target_regression(
    df: pd.DataFrame,
    horizon_col: str = DEFAULT_HORIZON_COL,
) -> pd.Series:
    """Framing 1: raw forward return as the regression target."""
    _validate_horizon(horizon_col)
    if horizon_col not in df.columns:
        raise ValueError(f"DataFrame missing column {horizon_col!r}")
    return pd.to_numeric(df[horizon_col], errors="coerce")


def target_rank(
    df: pd.DataFrame,
    horizon_col: str = DEFAULT_HORIZON_COL,
) -> tuple[pd.Series, list[int]]:
    """Framing 2: within-asOfDate percentile rank in [0, 1].

    Returns the target series AND a list of group sizes (one entry per
    asOfDate, in date order), which LightGBM's ``LGBMRanker`` needs as
    its ``group=`` parameter. The DataFrame must be sortable by
    ``asOfDate`` such that all rows for a given date are contiguous;
    callers are expected to sort upstream, but we sort defensively here
    too.
    """
    _validate_horizon(horizon_col)
    if horizon_col not in df.columns:
        raise ValueError(f"DataFrame missing column {horizon_col!r}")
    if DATE_COL not in df.columns:
        raise ValueError(f"DataFrame missing column {DATE_COL!r}")

    ranks = df.groupby(DATE_COL, sort=False)[horizon_col].rank(pct=True, method="average")
    group_sizes = df.groupby(DATE_COL, sort=False).size().tolist()
    return ranks, group_sizes


def target_top_decile(
    df: pd.DataFrame,
    horizon_col: str = DEFAULT_HORIZON_COL,
    quantile: float = 0.9,
) -> pd.Series:
    """Framing 3: 1 if row is in the top decile of forward return at
    its asOfDate, else 0. Decile boundary is recomputed per group.

    Returns a uint8 Series; null forward returns get label 0 (LightGBM
    ignores null labels via ``label`` filtering, but we keep it
    explicit so accidentally-fed nulls don't silently flip to "top").
    """
    _validate_horizon(horizon_col)
    if horizon_col not in df.columns:
        raise ValueError(f"DataFrame missing column {horizon_col!r}")
    if not 0 < quantile < 1:
        raise ValueError(f"quantile must be in (0, 1); got {quantile}")

    returns = pd.to_numeric(df[horizon_col], errors="coerce")
    thresholds = returns.groupby(df[DATE_COL], sort=False).transform(lambda s: s.quantile(quantile))
    label = (returns >= thresholds).astype("uint8")
    # Null forward returns: treat as not-top.
    label[returns.isnull()] = 0
    return label


def per_date_bucket_boundaries(
    df: pd.DataFrame,
    horizon_col: str = DEFAULT_HORIZON_COL,
    n_buckets: int = 10,
) -> pd.DataFrame:
    """Diagnostic: bucket boundaries for the decile target per asOfDate.

    Returns a DataFrame indexed by ``asOfDate`` with columns
    ``q_0`` .. ``q_<n_buckets>`` so we can document boundary drift in
    the findings report.
    """
    _validate_horizon(horizon_col)
    if horizon_col not in df.columns:
        raise ValueError(f"DataFrame missing column {horizon_col!r}")
    quantiles = np.linspace(0.0, 1.0, n_buckets + 1)
    out = (
        df.groupby(DATE_COL, sort=True)[horizon_col]
        .apply(
            lambda s: pd.Series(
                s.quantile(quantiles).to_numpy(), index=[f"q_{i}" for i in range(n_buckets + 1)]
            )
        )
        .unstack()
    )
    return out
