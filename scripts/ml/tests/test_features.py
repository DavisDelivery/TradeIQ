"""W3 feature-engineering tests.

Verifies for each feature set:
* Output row count matches input.
* No future leakage: rank-based features at asOfDate T use only T's rows.
* Null preservation where appropriate.
* Composability via ``build_features`` covers all preset names.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scripts.ml.features import (
    PRESET_NAMES,
    build_features,
    feature_set_a,
    feature_set_b,
    feature_set_c,
    feature_set_d,
    layer_columns,
)


def test_layer_columns_deterministic_order(synthetic_df: pd.DataFrame) -> None:
    cols = layer_columns(synthetic_df)
    assert cols == sorted(cols)
    assert all(c.startswith("layer_") for c in cols)
    assert len(cols) == 7  # matches LAYERS in conftest


def test_set_a_shape_and_rename(synthetic_df: pd.DataFrame) -> None:
    out = feature_set_a(synthetic_df)
    assert len(out) == len(synthetic_df)
    assert all(c.startswith("feat_") for c in out.columns)
    assert "feat_fundamental" in out.columns


def test_set_a_preserves_nulls() -> None:
    df = pd.DataFrame(
        {
            "asOfDate": ["2020-01-01"] * 3,
            "ticker": ["A", "B", "C"],
            "composite": [50.0, 50.0, 50.0],
            "regime": ["neutral"] * 3,
            "layer_x": [1.0, np.nan, 3.0],
        }
    )
    out = feature_set_a(df)
    assert out["feat_x"].isnull().tolist() == [False, True, False]


def test_set_b_no_future_leakage(synthetic_df: pd.DataFrame) -> None:
    """Ranks at date T must use ONLY rows at T (no peeking forward or back)."""
    full = feature_set_b(synthetic_df)
    # Compute rank for a single date using only that date's rows;
    # full should match for those rows.
    first_date = synthetic_df["asOfDate"].iloc[0]
    sub = synthetic_df[synthetic_df["asOfDate"] == first_date]
    sub_ranks = feature_set_b(sub)
    # Indices match because feature_set_b preserves input index
    pd.testing.assert_frame_equal(full.loc[sub.index], sub_ranks, check_names=False)


def test_set_b_rank_range_and_size(synthetic_df: pd.DataFrame) -> None:
    out = feature_set_b(synthetic_df)
    assert len(out) == len(synthetic_df)
    # All values in [0, 1]
    vals = out.to_numpy().flatten()
    finite = vals[np.isfinite(vals)]
    assert (finite >= 0).all() and (finite <= 1).all()


def test_set_c_residual_definition(synthetic_df: pd.DataFrame) -> None:
    out = feature_set_c(synthetic_df)
    layers = layer_columns(synthetic_df)
    # For a sampled row, check residual = layer - composite
    row = synthetic_df.iloc[0]
    for layer in layers:
        expected = row[layer] - row["composite"]
        resid_col = "feat_resid_" + layer.removeprefix("layer_")
        assert resid_col in out.columns
        np.testing.assert_allclose(out.loc[synthetic_df.index[0], resid_col], expected)


def test_set_d_onehot_sums_to_one(synthetic_df: pd.DataFrame) -> None:
    out = feature_set_d(synthetic_df)
    onehot_cols = [c for c in out.columns if c.startswith("feat_regime_")]
    # Exactly one regime per row
    assert (out[onehot_cols].sum(axis=1) == 1).all()


def test_set_d_includes_null_regime() -> None:
    df = pd.DataFrame(
        {
            "asOfDate": ["2020-01-01"] * 3,
            "ticker": ["A", "B", "C"],
            "composite": [50.0] * 3,
            "regime": ["bull_low_vol", None, "bear_high_vol"],
            "layer_x": [1.0, 2.0, 3.0],
        }
    )
    out = feature_set_d(df)
    assert "feat_regime_null" in out.columns
    assert out.loc[1, "feat_regime_null"] == 1


def test_set_d_interaction_zero_when_regime_off() -> None:
    """interaction_<layer>_<regime> must be zero whenever that row's regime != <regime>."""
    df = pd.DataFrame(
        {
            "asOfDate": ["2020-01-01"] * 2,
            "ticker": ["A", "B"],
            "composite": [50.0, 50.0],
            "regime": ["bull_low_vol", "bear_high_vol"],
            "layer_x": [10.0, 20.0],
        }
    )
    out = feature_set_d(df)
    # Row 0 is bull_low_vol; the bear_high_vol interaction must be 0
    assert out.loc[0, "feat_x_x_bear_high_vol"] == 0
    # Row 1's bull_low_vol interaction must be 0
    assert out.loc[1, "feat_x_x_bull_low_vol"] == 0
    # Each row's own-regime interaction equals the layer value
    assert out.loc[0, "feat_x_x_bull_low_vol"] == 10.0
    assert out.loc[1, "feat_x_x_bear_high_vol"] == 20.0


def test_build_features_all_presets(synthetic_df: pd.DataFrame) -> None:
    for preset in PRESET_NAMES:
        out = build_features(synthetic_df, preset)
        assert len(out) == len(synthetic_df), f"preset {preset} row count mismatch"
        assert out.shape[1] > 0, f"preset {preset} produced empty feature frame"


def test_build_features_rejects_unknown() -> None:
    import pytest

    df = pd.DataFrame(
        {"layer_x": [1.0], "composite": [50.0], "regime": ["x"], "asOfDate": ["2020-01-01"]}
    )
    with pytest.raises(ValueError, match="unknown preset"):
        build_features(df, "Z")
