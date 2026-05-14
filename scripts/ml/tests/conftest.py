"""Shared pytest fixtures for the Phase 5a ML pipeline.

Provides a deterministic synthetic ``mlTraining``-shaped DataFrame so
unit tests don't depend on real Firestore data. The shape mirrors the
post-export Parquet exactly (see briefs/phase-5a-schema-notes.md):
``layer_*`` columns, ``composite``, ``regime``, ``forward*Return``,
``asOfDate`` strings, etc.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

LAYERS = (
    "structure",
    "momentum",
    "catalyst",
    "relativeStrength",
    "volume",
    "volatility",
    "fundamental",
)


def _make_synthetic_frame(
    n_dates: int = 60,
    tickers_per_date: int = 20,
    seed: int = 42,
    regimes: tuple[str, ...] = ("bull_low_vol", "bear_high_vol", "neutral"),
) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2018-01-31", periods=n_dates, freq="MS")
    tickers = [f"TKR{i:03d}" for i in range(tickers_per_date)]

    rows: list[dict] = []
    for d in dates:
        regime = regimes[rng.integers(0, len(regimes))]
        for tkr in tickers:
            row: dict = {
                "asOfDate": d.strftime("%Y-%m-%d"),
                "ticker": tkr,
                "regime": regime,
                "sector": "tech",
                "entryPrice": float(rng.uniform(20, 500)),
                "holdDays": None,
            }
            # Layer scores 0..100 with some structure
            for layer in LAYERS:
                row[f"layer_{layer}"] = float(rng.uniform(0, 100))
            # Composite = mean of layers + small noise; not exactly the
            # production formula but close enough for tests.
            layer_mean = float(np.mean([row[f"layer_{l}"] for l in LAYERS]))
            row["composite"] = layer_mean + float(rng.normal(0, 1))
            # Forward returns -- some correlation with composite for
            # tests that need a meaningful signal.
            base = (row["composite"] - 50) / 1000.0
            row["forward5dReturn"] = base + float(rng.normal(0, 0.02))
            row["forward20dReturn"] = base * 4 + float(rng.normal(0, 0.04))
            row["forward60dReturn"] = base * 12 + float(rng.normal(0, 0.08))
            row["forward252dReturn"] = base * 50 + float(rng.normal(0, 0.25))
            # Provenance
            row["_runId"] = "synthetic_run"
            row["_runConfigHash"] = "synth00hashx"
            row["_runConfigSummary"] = "synth/monthly/top20/2018-01-31->2024-12-31"
            row["_completedAt"] = "2024-12-31T00:00:00Z"
            rows.append(row)

    return pd.DataFrame(rows)


@pytest.fixture
def synthetic_df() -> pd.DataFrame:
    """Deterministic synthetic mlTraining frame: 60 dates x 20 tickers = 1200 rows."""
    return _make_synthetic_frame()


@pytest.fixture
def small_synthetic_df() -> pd.DataFrame:
    """Smaller deterministic frame for fast iteration: 30 dates x 10 tickers = 300 rows."""
    return _make_synthetic_frame(n_dates=30, tickers_per_date=10, seed=43)
