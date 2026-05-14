"""Regime-conditional analysis for Phase 5a (brief W7).

For Model 3 (the most flexible model in the lineup):

1. Train one **global** model on all training data; compute test IC
   stratified by regime label.
2. Train one model **per regime** (training only on rows where
   ``regime == label``, evaluated on test rows where
   ``regime == label``); compute per-regime IC.
3. Compare the two: positive global vs per-regime gap suggests
   per-regime modeling adds value (Phase 5b would deploy a regime-
   gated ensemble); zero gap suggests regime is not an information
   dimension worth modeling separately.

Output: a tidy DataFrame with one row per regime, columns:
``n_train`` / ``n_test`` / ``global_rank_ic`` / ``per_regime_rank_ic`` /
``ic_gain`` / ``unreliable`` (True when ``n_train < min_train_per_regime``).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scripts.ml.metrics import cross_sectional_rank_ic
from scripts.ml.models import fit_and_predict_model_3

DATE_COL = "asOfDate"
REGIME_COL = "regime"
DEFAULT_TARGET_COL = "forward20dReturn"


def regime_conditional_analysis(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    target_col: str = DEFAULT_TARGET_COL,
    min_train_per_regime: int = 500,
) -> pd.DataFrame:
    """Return a per-regime comparison of global-model vs per-regime-model IC.

    Parameters
    ----------
    train_df, test_df : pd.DataFrame
        Both must contain ``regime`` and the model's expected feature/
        target columns. Test set is typically a single CV fold.
    target_col : str
        Forward-return horizon to use as the rank target.
    min_train_per_regime : int
        Threshold below which the per-regime model's IC is flagged as
        ``unreliable`` (small training pools easily overfit).
    """
    if REGIME_COL not in train_df.columns or REGIME_COL not in test_df.columns:
        raise ValueError(f"both train and test must contain '{REGIME_COL}'")

    # 1. Global model: fit once on full train, predict on full test
    global_preds = fit_and_predict_model_3(
        train_df,
        test_df,
        target_col=target_col,
        feature_preset="B",
    )
    test_with_global = test_df.copy()
    test_with_global["pred"] = global_preds

    regimes = sorted(
        {
            *train_df[REGIME_COL].fillna("null").unique(),
            *test_df[REGIME_COL].fillna("null").unique(),
        }
    )
    rows: list[dict] = []
    for regime in regimes:
        train_mask = train_df[REGIME_COL].fillna("null") == regime
        test_mask = test_df[REGIME_COL].fillna("null") == regime
        n_train = int(train_mask.sum())
        n_test = int(test_mask.sum())
        if n_test == 0:
            rows.append(
                {
                    "regime": regime,
                    "n_train": n_train,
                    "n_test": 0,
                    "global_rank_ic": float("nan"),
                    "per_regime_rank_ic": float("nan"),
                    "ic_gain": float("nan"),
                    "unreliable": True,
                }
            )
            continue

        global_ic, _ = cross_sectional_rank_ic(
            test_with_global[test_mask],
            "pred",
            target_col=target_col,
        )

        per_regime_ic: float
        if n_train < min_train_per_regime or n_train == 0:
            per_regime_ic = float("nan")
        else:
            sub_train = train_df[train_mask]
            sub_test = test_df[test_mask]
            sub_preds = fit_and_predict_model_3(
                sub_train,
                sub_test,
                target_col=target_col,
                feature_preset="B",
            )
            sub_test_pred = sub_test.copy()
            sub_test_pred["pred"] = sub_preds
            per_regime_ic, _ = cross_sectional_rank_ic(
                sub_test_pred,
                "pred",
                target_col=target_col,
            )

        gain = (
            per_regime_ic - global_ic
            if np.isfinite(per_regime_ic) and np.isfinite(global_ic)
            else float("nan")
        )
        rows.append(
            {
                "regime": regime,
                "n_train": n_train,
                "n_test": n_test,
                "global_rank_ic": global_ic,
                "per_regime_rank_ic": per_regime_ic,
                "ic_gain": gain,
                "unreliable": n_train < min_train_per_regime,
            }
        )

    return pd.DataFrame(rows).set_index("regime").sort_index()
