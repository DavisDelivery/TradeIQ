"""W5 — 5 mandatory CV correctness tests.

ALL five must pass. CV correctness is non-negotiable; every result
downstream of a broken splitter is fiction.

Tests in order (brief W5):
1. No train/test asOfDate overlap within any fold.
2. Embargo gap honored: min(test) - max(train) >= embargo * period.
3. Purge drops training rows whose forward window touches test set.
4. Walk-forward: train[i] is a SUBSET of train[i+1] (nested).
5. Sklearn-compatible adapter plugs into pipelines via .split(X, y).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from scripts.ml.cv import (
    REBALANCE_CALENDAR_DAYS,
    PurgedWalkForwardCV,
    purged_walkforward_cv,
)


def _make_synth_dates(
    n_dates: int = 50,
    tickers_per_date: int = 20,
    hold_days: int = 20,
    freq_pandas: str = "MS",
    start: str = "2018-01-01",
) -> pd.DataFrame:
    rng = np.random.default_rng(42)
    dates = pd.date_range(start, periods=n_dates, freq=freq_pandas)
    rows = []
    for d in dates:
        for t in range(tickers_per_date):
            rows.append(
                {
                    "asOfDate": d.strftime("%Y-%m-%d"),
                    "ticker": f"T{t:03d}",
                    "holdDays": hold_days,
                    "feat": float(rng.random()),
                    "forward20dReturn": float(rng.normal(0, 0.05)),
                }
            )
    return pd.DataFrame(rows)


# --- Mandatory test 1 ---------------------------------------------------------


def test_no_overlap_between_train_and_test() -> None:
    df = _make_synth_dates()
    folds_seen = 0
    for train_idx, test_idx in purged_walkforward_cv(
        df["asOfDate"],
        df["holdDays"],
        n_splits=5,
        embargo_rebalances=3,
    ):
        folds_seen += 1
        train_dates = set(df.iloc[train_idx]["asOfDate"])
        test_dates = set(df.iloc[test_idx]["asOfDate"])
        assert train_dates.isdisjoint(test_dates), (
            f"date overlap in fold: {train_dates & test_dates}"
        )
    assert folds_seen >= 1, "splitter yielded zero folds; check synth data sizing"


# --- Mandatory test 2 ---------------------------------------------------------


def test_embargo_gap_honored() -> None:
    df = _make_synth_dates()
    embargo_n = 3
    freq = "monthly"
    expected_gap = embargo_n * REBALANCE_CALENDAR_DAYS[freq]
    for train_idx, test_idx in purged_walkforward_cv(
        df["asOfDate"],
        df["holdDays"],
        n_splits=5,
        embargo_rebalances=embargo_n,
        rebalance_freq=freq,
    ):
        train_last = pd.to_datetime(df.iloc[train_idx]["asOfDate"]).max()
        test_first = pd.to_datetime(df.iloc[test_idx]["asOfDate"]).min()
        gap = (test_first - train_last).days
        assert gap >= expected_gap, f"embargo violated: gap={gap}d < required={expected_gap}d"


# --- Mandatory test 3 ---------------------------------------------------------


def test_purge_drops_overlapping_forward_returns() -> None:
    """When holdDays is large enough that the forward-return window reaches
    into the test set, those training rows must be excluded by the purge."""
    # 90 trading days hold is ~126 calendar days; embargo=3 monthly is
    # only 90 calendar days, so without the purge the longest-hold
    # training rows would reach into the test fold.
    df = _make_synth_dates(hold_days=90)
    for train_idx, test_idx in purged_walkforward_cv(
        df["asOfDate"],
        df["holdDays"],
        n_splits=5,
        embargo_rebalances=3,
        rebalance_freq="monthly",
    ):
        train_rows = df.iloc[train_idx]
        test_first = pd.to_datetime(df.iloc[test_idx]["asOfDate"]).min()
        forward_end_calendar = pd.to_datetime(train_rows["asOfDate"]) + pd.to_timedelta(
            (train_rows["holdDays"] * (7 / 5)).round().astype(int), unit="D"
        )
        assert (forward_end_calendar < test_first).all(), (
            "purge let through a training row whose forward-return window touches the test set"
        )


# --- Mandatory test 4 ---------------------------------------------------------


def test_walk_forward_train_is_nested() -> None:
    """Train sets are cumulative; fold i+1's train must contain all of fold i's."""
    df = _make_synth_dates()
    prev_train: set[int] | None = None
    for train_idx, _test_idx in purged_walkforward_cv(
        df["asOfDate"],
        df["holdDays"],
        n_splits=5,
        embargo_rebalances=3,
    ):
        cur_train = set(train_idx.tolist())
        if prev_train is not None:
            missing = prev_train - cur_train
            assert not missing, (
                f"walk-forward violated: fold lost {len(missing)} train rows that earlier folds had"
            )
        prev_train = cur_train


# --- Mandatory test 5 ---------------------------------------------------------


def test_sklearn_compatibility_adapter_plugs_in() -> None:
    """The PurgedWalkForwardCV adapter must satisfy sklearn's CV protocol."""
    df = _make_synth_dates()
    cv = PurgedWalkForwardCV(
        as_of_date_col="asOfDate",
        hold_days_col="holdDays",
        n_splits=5,
        embargo_rebalances=3,
    )
    splits = list(cv.split(df))
    assert len(splits) >= 1, "adapter yielded zero folds"
    train_idx, test_idx = splits[0]
    assert isinstance(train_idx, np.ndarray)
    assert isinstance(test_idx, np.ndarray)
    assert train_idx.dtype.kind == "i"
    assert test_idx.dtype.kind == "i"
    assert cv.get_n_splits() == 5

    # Smoke: integrates with sklearn cross_val_score via duck-typing
    from sklearn.dummy import DummyRegressor
    from sklearn.model_selection import cross_val_score

    X = df[["feat"]]
    y = df["forward20dReturn"]

    # Wrapping df-with-extra-cols requires the X passed to split() to
    # carry asOfDate/holdDays. Use a tiny shim CV that closes over df.
    class _SplitOverDf:
        def split(self, X_, y_=None, groups=None):  # noqa: ARG002
            return cv.split(df)

        def get_n_splits(self, X_=None, y_=None, groups=None):  # noqa: ARG002
            return cv.get_n_splits()

    scores = cross_val_score(DummyRegressor(), X, y, cv=_SplitOverDf(), scoring="r2")
    assert len(scores) >= 1


# --- Defensive bonus tests ---------------------------------------------------
# Not required by the brief but inexpensive to keep and catch regressions.


def test_raises_when_not_enough_dates() -> None:
    df = _make_synth_dates(n_dates=3)
    with pytest.raises(ValueError, match="not enough unique asOfDates"):
        list(purged_walkforward_cv(df["asOfDate"], df["holdDays"], n_splits=5))


def test_raises_on_unknown_rebalance_freq() -> None:
    df = _make_synth_dates()
    with pytest.raises(ValueError, match="unknown rebalance_freq"):
        list(
            purged_walkforward_cv(
                df["asOfDate"], df["holdDays"], n_splits=2, rebalance_freq="hourly"
            )
        )


def test_test_sets_tile_chronologically() -> None:
    """No two test folds share an asOfDate; folds run forward in time."""
    df = _make_synth_dates()
    prev_test_max: pd.Timestamp | None = None
    for _train_idx, test_idx in purged_walkforward_cv(
        df["asOfDate"], df["holdDays"], n_splits=5, embargo_rebalances=3
    ):
        test_dates = pd.to_datetime(df.iloc[test_idx]["asOfDate"])
        if prev_test_max is not None:
            assert test_dates.min() > prev_test_max, (
                "later fold's test starts before earlier fold's test ends"
            )
        prev_test_max = test_dates.max()
