"""Smoke tests for the W6 model lineup.

These tests exercise each model's fit-and-predict path on the
synthetic-data fixture. The goal is API correctness (right shapes,
no exceptions on the standard pipeline), not statistical performance
-- that's W6 metric work against real data.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scripts.ml.models import (
    MODEL_LINEUP,
    fit_and_predict,
    fit_and_predict_model_1,
    fit_and_predict_model_2,
    fit_and_predict_model_3,
    fit_and_predict_model_4,
    fit_and_predict_model_5,
    predict_model_0,
)


def _split(df: pd.DataFrame, train_frac: float = 0.7) -> tuple[pd.DataFrame, pd.DataFrame]:
    dates = sorted(df["asOfDate"].unique())
    cutoff = dates[int(len(dates) * train_frac)]
    train = df[df["asOfDate"] < cutoff].reset_index(drop=True)
    test = df[df["asOfDate"] >= cutoff].reset_index(drop=True)
    return train, test


def test_lineup_has_six_models() -> None:
    assert len(MODEL_LINEUP) == 6
    names = {s.name for s in MODEL_LINEUP}
    assert "model_0_composite_baseline" in names
    assert "model_5_lgbm_ranker_full" in names


def test_predict_model_0_returns_composite(synthetic_df: pd.DataFrame) -> None:
    preds = predict_model_0(synthetic_df)
    pd.testing.assert_series_equal(
        preds.reset_index(drop=True),
        synthetic_df["composite"].reset_index(drop=True),
        check_names=False,
    )


def test_model_1_returns_aligned_series(synthetic_df: pd.DataFrame) -> None:
    train, test = _split(synthetic_df)
    preds = fit_and_predict_model_1(train, test)
    assert len(preds) == len(test)
    assert preds.index.equals(test.index)
    assert np.isfinite(preds.to_numpy()).all()


def test_model_2_returns_aligned_series(synthetic_df: pd.DataFrame) -> None:
    train, test = _split(synthetic_df)
    preds = fit_and_predict_model_2(train, test, inner_n_splits=2)
    assert len(preds) == len(test)
    assert np.isfinite(preds.to_numpy()).all()


def test_model_3_returns_aligned_series(synthetic_df: pd.DataFrame) -> None:
    train, test = _split(synthetic_df)
    preds = fit_and_predict_model_3(train, test)
    assert len(preds) == len(test)
    assert preds.index.equals(test.index)


def test_model_4_proba_in_zero_one(synthetic_df: pd.DataFrame) -> None:
    train, test = _split(synthetic_df)
    preds = fit_and_predict_model_4(train, test)
    assert len(preds) == len(test)
    finite = preds.dropna()
    assert (finite >= 0).all() and (finite <= 1).all()


def test_model_5_returns_aligned_series(synthetic_df: pd.DataFrame) -> None:
    train, test = _split(synthetic_df)
    preds = fit_and_predict_model_5(train, test)
    assert len(preds) == len(test)


def test_dispatch_covers_lineup(synthetic_df: pd.DataFrame) -> None:
    train, test = _split(synthetic_df)
    for spec in MODEL_LINEUP:
        preds = fit_and_predict(spec, train, test)
        assert len(preds) == len(test), f"{spec.name} preds length mismatch"
