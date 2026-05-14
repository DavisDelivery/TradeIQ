"""W6 metric correctness tests.

The synthetic-data fixture in conftest.py builds a correlated
(forward20dReturn ~ composite) frame so a "perfect predictor" can
hit IC=1.0 deterministically. The random-shuffle test checks IC
collapses to ~0 in expectation.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scripts.ml.metrics import (
    beats_baseline_wilcoxon,
    bonferroni_threshold,
    cross_sectional_pearson_ic,
    cross_sectional_rank_ic,
    decile_spread,
    information_ratio,
    summarize_fold_metrics,
    top_k_hit_rate,
)


def _make_frame_with_signal(strength: float, n_dates: int = 40, n_tk: int = 20) -> pd.DataFrame:
    """A frame where forward20dReturn = strength * pred + noise."""
    rng = np.random.default_rng(0)
    rows = []
    for d_idx in range(n_dates):
        date = f"2020-{(d_idx % 12) + 1:02d}-01"
        # Use distinct dates for distinct months
        date = (pd.Timestamp("2018-01-01") + pd.DateOffset(months=d_idx)).strftime("%Y-%m-%d")
        for t in range(n_tk):
            pred = float(rng.normal(0, 1))
            noise = float(rng.normal(0, 1)) * (1 - abs(strength))
            target = strength * pred + noise
            rows.append(
                {"asOfDate": date, "ticker": f"T{t}", "pred": pred, "forward20dReturn": target}
            )
    return pd.DataFrame(rows)


def test_perfect_predictor_ic_one() -> None:
    df = pd.DataFrame(
        {
            "asOfDate": ["2020-01-01"] * 10,
            "ticker": [f"T{i}" for i in range(10)],
            "pred": np.arange(10, dtype=float),
            "forward20dReturn": np.arange(10, dtype=float),
        }
    )
    mean, per_date = cross_sectional_rank_ic(df, "pred")
    assert per_date.size == 1
    assert np.isclose(mean, 1.0)


def test_inverse_predictor_ic_minus_one() -> None:
    df = pd.DataFrame(
        {
            "asOfDate": ["2020-01-01"] * 10,
            "ticker": [f"T{i}" for i in range(10)],
            "pred": np.arange(10, dtype=float),
            "forward20dReturn": np.arange(10, dtype=float)[::-1],
        }
    )
    mean, _ = cross_sectional_rank_ic(df, "pred")
    assert np.isclose(mean, -1.0)


def test_random_predictor_ic_near_zero() -> None:
    """Average rank-IC across many random predictors should be ~0."""
    rng = np.random.default_rng(7)
    ics: list[float] = []
    for _ in range(40):
        df = pd.DataFrame(
            {
                "asOfDate": ["2020-01-01"] * 20,
                "ticker": [f"T{i}" for i in range(20)],
                "pred": rng.normal(0, 1, size=20),
                "forward20dReturn": rng.normal(0, 1, size=20),
            }
        )
        mean, _ = cross_sectional_rank_ic(df, "pred")
        ics.append(mean)
    avg = float(np.mean(ics))
    assert abs(avg) < 0.10, f"random-IC mean {avg:.3f} not within tolerance"


def test_skips_dates_with_too_few_tickers() -> None:
    df = pd.DataFrame(
        {
            "asOfDate": ["2020-01-01"] * 3 + ["2020-02-01"] * 10,
            "ticker": [f"T{i}" for i in range(13)],
            "pred": np.arange(13, dtype=float),
            "forward20dReturn": np.arange(13, dtype=float),
        }
    )
    _mean, per_date = cross_sectional_rank_ic(df, "pred")
    # Only the second date qualifies (>=5 tickers)
    assert per_date.size == 1


def test_pearson_ic_matches_scipy_on_single_date() -> None:
    from scipy.stats import pearsonr

    rng = np.random.default_rng(11)
    x = rng.normal(size=20)
    y = 0.7 * x + rng.normal(size=20)
    df = pd.DataFrame(
        {
            "asOfDate": ["2020-01-01"] * 20,
            "ticker": [f"T{i}" for i in range(20)],
            "pred": x,
            "forward20dReturn": y,
        }
    )
    mean, _ = cross_sectional_pearson_ic(df, "pred")
    expected = pearsonr(x, y)[0]
    assert np.isclose(mean, expected)


def test_information_ratio_zero_std_is_nan() -> None:
    constant = np.array([0.1, 0.1, 0.1])
    assert np.isnan(information_ratio(constant))


def test_information_ratio_one_when_mean_eq_std() -> None:
    arr = np.array([0.0, 2.0])  # mean=1, std=sqrt(2), IR = 1/sqrt(2) ~= 0.707
    assert np.isclose(information_ratio(arr), 1 / np.sqrt(2))


def test_decile_spread_perfect_predictor_positive() -> None:
    df = _make_frame_with_signal(strength=0.9, n_dates=12, n_tk=20)
    mean, _ = decile_spread(df, "pred")
    assert mean > 0


def test_top_k_hit_rate_bounded() -> None:
    df = _make_frame_with_signal(strength=0.7)
    mean, _ = top_k_hit_rate(df, "pred", k=5)
    assert 0 <= mean <= 1


def test_wilcoxon_detects_better_model() -> None:
    rng = np.random.default_rng(3)
    base = rng.normal(0, 0.05, size=40)
    model = base + 0.03  # consistently higher
    stat, p = beats_baseline_wilcoxon(model, base)
    assert np.isfinite(stat) and p < 0.001


def test_wilcoxon_returns_nan_for_too_few_pairs() -> None:
    base = np.array([0.0, 0.0, 0.0])
    model = np.array([0.0, 0.0, 0.0])  # all zeros after dropping ties = empty
    stat, p = beats_baseline_wilcoxon(model, base)
    assert np.isnan(stat) and np.isnan(p)


def test_wilcoxon_shape_mismatch_raises() -> None:
    import pytest

    with pytest.raises(ValueError, match="shape mismatch"):
        beats_baseline_wilcoxon(np.zeros(5), np.zeros(6))


def test_bonferroni_threshold() -> None:
    assert bonferroni_threshold(0.05, 5) == 0.01
    assert bonferroni_threshold(0.05, 0) == 0.05  # divisor floored at 1


def test_summarize_fold_metrics_bundle(synthetic_df: pd.DataFrame) -> None:
    bundle = summarize_fold_metrics(synthetic_df, "composite")
    expected_keys = {
        "rank_ic_mean",
        "rank_ic_std",
        "rank_ic_per_date",
        "pearson_ic_mean",
        "pearson_ic_std",
        "ir",
        "decile_spread_mean",
        "top_k_hit_rate_mean",
        "n_dates_scored",
    }
    assert set(bundle.keys()) == expected_keys
    assert bundle["n_dates_scored"] > 0
