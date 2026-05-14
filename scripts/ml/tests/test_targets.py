"""W4 target-framing tests."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from scripts.ml.targets import (
    DEFAULT_HORIZON_COL,
    per_date_bucket_boundaries,
    target_rank,
    target_regression,
    target_top_decile,
)


def test_regression_passes_through_values(synthetic_df: pd.DataFrame) -> None:
    out = target_regression(synthetic_df)
    assert len(out) == len(synthetic_df)
    pd.testing.assert_series_equal(
        out.reset_index(drop=True),
        pd.to_numeric(synthetic_df[DEFAULT_HORIZON_COL]).reset_index(drop=True),
        check_names=False,
    )


def test_regression_rejects_unknown_horizon(synthetic_df: pd.DataFrame) -> None:
    with pytest.raises(ValueError, match="unknown horizon"):
        target_regression(synthetic_df, horizon_col="forward7dReturn")


def test_rank_in_zero_one(synthetic_df: pd.DataFrame) -> None:
    ranks, groups = target_rank(synthetic_df)
    assert len(ranks) == len(synthetic_df)
    assert (ranks.dropna() >= 0).all() and (ranks.dropna() <= 1).all()
    assert sum(groups) == len(synthetic_df)


def test_rank_group_sizes_match_dates(synthetic_df: pd.DataFrame) -> None:
    _, groups = target_rank(synthetic_df)
    # Each date should appear with the expected fixture tickers count
    counts = synthetic_df.groupby("asOfDate", sort=False).size().tolist()
    assert groups == counts


def test_rank_perfect_signal_recovers_order() -> None:
    df = pd.DataFrame(
        {
            "asOfDate": ["2020-01-01"] * 5,
            "ticker": list("ABCDE"),
            "forward20dReturn": [0.01, 0.02, 0.03, 0.04, 0.05],
        }
    )
    ranks, _ = target_rank(df)
    # Strictly increasing ranks for strictly increasing returns
    assert list(ranks) == sorted(ranks.tolist())


def test_top_decile_threshold_per_date() -> None:
    df = pd.DataFrame(
        {
            "asOfDate": ["2020-01-01"] * 10 + ["2020-02-01"] * 10,
            "ticker": [f"T{i}" for i in range(20)],
            "forward20dReturn": list(np.linspace(0, 1, 10)) + list(np.linspace(0, 0.5, 10)),
        }
    )
    label = target_top_decile(df)
    # Exactly the top-decile-equivalent rows should be flagged per group;
    # with n=10 the quantile interpolates between rows 8 and 9, so the
    # "top decile" label captures the maximum row in each group.
    assert label.iloc[9] == 1  # max of group 1
    assert label.iloc[19] == 1  # max of group 2


def test_top_decile_null_returns_to_zero() -> None:
    df = pd.DataFrame(
        {
            "asOfDate": ["2020-01-01"] * 4,
            "ticker": list("ABCD"),
            "forward20dReturn": [0.1, np.nan, 0.3, 0.4],
        }
    )
    label = target_top_decile(df)
    assert label.tolist()[1] == 0  # null -> 0


def test_bucket_boundaries_per_date(synthetic_df: pd.DataFrame) -> None:
    out = per_date_bucket_boundaries(synthetic_df, n_buckets=4)
    # One row per asOfDate, columns q_0..q_4 (i.e., 5 columns for 4 buckets)
    assert out.shape[0] == synthetic_df["asOfDate"].nunique()
    assert out.shape[1] == 5
    # Each row's quantiles should be non-decreasing
    rows = out.dropna(how="any")
    for _, row in rows.iterrows():
        assert (row.diff().dropna() >= -1e-9).all()
