"""Feature engineering for Phase 5a.

Four pure-function feature sets, each ``(raw_df) -> features_df``. No
file I/O, no globals. The full set list comes from the brief:

* **A** — raw layer scores (one column per analyst layer)
* **B** — cross-sectional percentile ranks within each ``asOfDate``
  (more robust to non-stationarity than raw magnitudes)
* **C** — composite-relative residuals (layer minus composite, per row)
* **D** — regime-conditional (one-hot regime + per-layer x regime
  interaction columns; lets tree models learn regime-specific splits)

Composable presets are also defined: ``AB``, ``ABCD``, ``BD``. Each
returns a fresh DataFrame; callers may concat themselves if they need
custom combinations.

**No future leakage by construction.** All transforms operate within a
single ``asOfDate`` group OR are pure row-wise (no rolling, no
cross-date statistics). Rolling features were intentionally deferred
to Phase 5b per the brief.
"""

from __future__ import annotations

import pandas as pd

DATE_COL = "asOfDate"
COMPOSITE_COL = "composite"
REGIME_COL = "regime"
LAYER_PREFIX = "layer_"

FEATURE_PREFIX_A = "feat_"
FEATURE_PREFIX_B = "feat_rank_"
FEATURE_PREFIX_C = "feat_resid_"
FEATURE_PREFIX_D_ONEHOT = "feat_regime_"
FEATURE_PREFIX_D_INTERACT = "feat_x_"


def layer_columns(df: pd.DataFrame) -> list[str]:
    """Return the per-layer columns present in ``df`` (deterministic order)."""
    return sorted(c for c in df.columns if c.startswith(LAYER_PREFIX))


def feature_set_a(df: pd.DataFrame) -> pd.DataFrame:
    """A: raw layer scores.

    Renames ``layer_<name>`` -> ``feat_<name>``. Preserves nulls
    untouched -- tree models handle them natively; linear models will
    impute per-fold in W6 (the imputer must fit on train only).
    """
    layers = layer_columns(df)
    out = df[layers].rename(columns={c: FEATURE_PREFIX_A + c[len(LAYER_PREFIX) :] for c in layers})
    return out


def feature_set_b(df: pd.DataFrame) -> pd.DataFrame:
    """B: cross-sectional percentile ranks within each asOfDate.

    For each layer, ``pandas.DataFrame.rank(pct=True)`` returns the
    percentile rank in [0, 1]. Ties get the average rank by default,
    which is the right behavior for IC-style metrics.

    Nulls are preserved (excluded from rank, re-injected as NaN).
    """
    if DATE_COL not in df.columns:
        raise ValueError(f"feature_set_b requires '{DATE_COL}' column")
    layers = layer_columns(df)
    if not layers:
        return pd.DataFrame(index=df.index)
    ranks = df.groupby(DATE_COL, sort=False)[layers].rank(pct=True, method="average")
    ranks.columns = [FEATURE_PREFIX_B + c[len(LAYER_PREFIX) :] for c in layers]
    return ranks


def feature_set_c(df: pd.DataFrame) -> pd.DataFrame:
    """C: layer minus composite, per row.

    Captures information that the composite discarded by weighted
    averaging. Tree models can pick up "layer X is way above composite"
    as a residual signal even when the raw layer value isn't itself
    informative.
    """
    if COMPOSITE_COL not in df.columns:
        raise ValueError(f"feature_set_c requires '{COMPOSITE_COL}' column")
    layers = layer_columns(df)
    if not layers:
        return pd.DataFrame(index=df.index)
    composite = pd.to_numeric(df[COMPOSITE_COL], errors="coerce")
    out = pd.DataFrame(index=df.index)
    for layer in layers:
        out[FEATURE_PREFIX_C + layer[len(LAYER_PREFIX) :]] = (
            pd.to_numeric(df[layer], errors="coerce") - composite
        )
    return out


def feature_set_d(df: pd.DataFrame) -> pd.DataFrame:
    """D: regime-conditional features.

    Produces:
    * One-hot regime indicators: ``feat_regime_<label>``.
      A null regime becomes ``feat_regime_null``.
    * Layer x regime interactions: ``feat_x_<layer>_<regime>``.
      Each interaction is ``layer_value * regime_indicator``.

    The interaction column count grows as ``num_layers x num_regimes``,
    so this set can be wide. Tree models tolerate that better than
    linear models; the ``ABCD`` preset is intended primarily for
    LightGBM (Models 3/5).
    """
    if REGIME_COL not in df.columns:
        raise ValueError(f"feature_set_d requires '{REGIME_COL}' column")
    regime = df[REGIME_COL].fillna("null")
    regimes_sorted = sorted(regime.unique())
    layers = layer_columns(df)

    onehot = pd.DataFrame(
        {
            FEATURE_PREFIX_D_ONEHOT + label: (regime == label).astype("int8")
            for label in regimes_sorted
        },
        index=df.index,
    )

    interactions = pd.DataFrame(index=df.index)
    for layer in layers:
        layer_values = pd.to_numeric(df[layer], errors="coerce")
        layer_short = layer[len(LAYER_PREFIX) :]
        for label in regimes_sorted:
            interactions[FEATURE_PREFIX_D_INTERACT + f"{layer_short}_{label}"] = layer_values * (
                regime == label
            ).astype("float32")

    return pd.concat([onehot, interactions], axis=1)


PRESET_NAMES: tuple[str, ...] = ("A", "B", "C", "D", "AB", "ABCD", "BD")


def build_features(df: pd.DataFrame, preset: str) -> pd.DataFrame:
    """Compose feature sets by name. See ``PRESET_NAMES``.

    Returns a fresh DataFrame indexed identically to ``df`` (same row
    count, same order). Single-set presets ('A'/'B'/'C'/'D') delegate
    directly; composites concat horizontally.
    """
    preset = preset.upper()
    parts: list[pd.DataFrame] = []
    if preset == "A":
        parts.append(feature_set_a(df))
    elif preset == "B":
        parts.append(feature_set_b(df))
    elif preset == "C":
        parts.append(feature_set_c(df))
    elif preset == "D":
        parts.append(feature_set_d(df))
    elif preset == "AB":
        parts.append(feature_set_a(df))
        parts.append(feature_set_b(df))
    elif preset == "ABCD":
        parts.append(feature_set_a(df))
        parts.append(feature_set_b(df))
        parts.append(feature_set_c(df))
        parts.append(feature_set_d(df))
    elif preset == "BD":
        parts.append(feature_set_b(df))
        parts.append(feature_set_d(df))
    else:
        raise ValueError(f"unknown preset: {preset!r}; expected one of {PRESET_NAMES}")

    if not parts:
        return pd.DataFrame(index=df.index)
    return pd.concat(parts, axis=1)
