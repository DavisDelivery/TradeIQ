"""Purged walk-forward cross-validation with embargo.

This is the load-bearing piece of Phase 5a methodology. Five mandatory
unit tests live in ``tests/test_cv.py`` and ALL must pass; if any
fails, the brief is blocked because every downstream metric is
unreliable.

The scheme (brief W5):

1. Sort rows by ``asOfDate``. Define ``n_splits`` folds (default 5).
2. For fold ``i``:

   * Train = rows with ``asOfDate <= train_end[i]``
   * Test = rows with ``test_start[i] <= asOfDate < test_end[i]``
   * Purge: drop training rows whose forward-return window overlaps
     with the test fold (``asOfDate + holdDays > test_start[i]``).
   * Embargo: ``test_start[i] = train_end[i] + E`` for ``E >=
     embargo_rebalances`` rebalance periods.
3. Train sets are CUMULATIVE — fold ``i+1``'s train is a superset of
   fold ``i``'s. (Walk-forward, not rolling.)

Engine note (see ``briefs/phase-5a-schema-notes.md``): ``holdDays`` is
always null in the current engine. Callers should pass the forward-
return horizon (in trading days) as a scalar via ``hold_days_default``;
the purge converts trading days to calendar days using a 1.4 ratio.
"""

from __future__ import annotations

from collections.abc import Iterator

import numpy as np
import pandas as pd

REBALANCE_CALENDAR_DAYS: dict[str, int] = {
    "daily": 1,
    "weekly": 7,
    "monthly": 30,
    "quarterly": 91,
}

# Approximation used to convert ``holdDays`` interpreted as trading days
# into calendar days for purge math. 5 trading days ~ 7 calendar days,
# 20 ~ 28, 60 ~ 84, 252 ~ 365.
TRADING_TO_CALENDAR = 7 / 5


def _calendar_days_per_rebalance(freq: str) -> int:
    if freq not in REBALANCE_CALENDAR_DAYS:
        raise ValueError(
            f"unknown rebalance_freq {freq!r}; expected one of {sorted(REBALANCE_CALENDAR_DAYS)}"
        )
    return REBALANCE_CALENDAR_DAYS[freq]


def _resolve_hold_days(
    as_of_date: pd.Series,
    hold_days: pd.Series | int | None,
    hold_days_default: int,
) -> pd.Series:
    """Return a per-row hold-days Series, falling back to the default when null.

    Accepts either a Series aligned to ``as_of_date`` (typical), a
    scalar (every row gets the same hold window), or None (use the
    default). The output is always a Series.
    """
    if hold_days is None:
        return pd.Series(hold_days_default, index=as_of_date.index)
    if np.isscalar(hold_days):
        return pd.Series(int(hold_days), index=as_of_date.index)
    if not isinstance(hold_days, pd.Series):
        hold_days = pd.Series(hold_days)
    resolved = pd.to_numeric(hold_days, errors="coerce").fillna(hold_days_default)
    return resolved.astype(int)


def purged_walkforward_cv(
    as_of_date: pd.Series,
    hold_days: pd.Series | int | None = None,
    n_splits: int = 5,
    embargo_rebalances: int = 3,
    rebalance_freq: str = "monthly",
    hold_days_default: int = 20,
) -> Iterator[tuple[np.ndarray, np.ndarray]]:
    """Yield ``(train_indices, test_indices)`` for each of ``n_splits`` folds.

    Guarantees (asserted by ``tests/test_cv.py``):

    * For every fold, ``set(train asOfDate) & set(test asOfDate)`` is
      empty (no date overlap).
    * For every fold,
      ``min(test asOfDate) - max(train asOfDate) >= embargo_rebalances
      * calendar_days_per_rebalance``.
    * For every fold, no training row's forward-return window
      (``asOfDate + holdDays_in_calendar_days``) reaches the test
      fold's first asOfDate.
    * Folds tile the time axis chronologically (no test-set overlap).
    * Train sets are nested: ``train[i] subset of train[i+1]``.

    The yielded indices are positional (``np.intp``); align with the
    input Series's ``.iloc`` not ``.loc``.

    Parameters
    ----------
    as_of_date : pd.Series
        ISO-date strings or datetimes. One entry per row of the
        underlying mlTraining DataFrame.
    hold_days : pd.Series | int | None
        Per-row hold-days, scalar (broadcast to all rows), or None
        (use ``hold_days_default``). The engine writes ``holdDays``
        always-null, so most callers pass the forward-return horizon
        in trading days here (e.g. 20 for ``forward20dReturn``).
    n_splits : int
        Number of test folds. Each fold consumes one chunk of the
        unique-asOfDate axis; the axis is sliced into ``n_splits + 1``
        chunks, the first one is the initial training pool.
    embargo_rebalances : int
        Gap (in rebalance periods) between the last training asOfDate
        and the first test asOfDate. Protects against any feature
        serial correlation the purge doesn't already handle.
    rebalance_freq : str
        One of ``daily/weekly/monthly/quarterly``. Used to convert the
        embargo count into calendar days.
    hold_days_default : int
        Forward-return horizon when ``hold_days`` is None or null per
        row. Conventionally 20 for monthly-cadence runs.
    """
    if not isinstance(as_of_date, pd.Series):
        as_of_date = pd.Series(as_of_date)
    if n_splits < 1:
        raise ValueError(f"n_splits must be >= 1; got {n_splits}")
    if embargo_rebalances < 0:
        raise ValueError(f"embargo_rebalances must be >= 0; got {embargo_rebalances}")

    rebalance_cd = _calendar_days_per_rebalance(rebalance_freq)
    embargo_days = embargo_rebalances * rebalance_cd

    parsed_dates = pd.to_datetime(as_of_date, errors="coerce")
    if parsed_dates.isnull().any():
        bad = as_of_date[parsed_dates.isnull()].head(3).tolist()
        raise ValueError(f"asOfDate parse failure on rows {bad!r}")

    hold_resolved = _resolve_hold_days(parsed_dates, hold_days, hold_days_default)
    forward_calendar = (hold_resolved * TRADING_TO_CALENDAR).round().astype(int)
    forward_end = parsed_dates + pd.to_timedelta(forward_calendar, unit="D")

    unique_dates = pd.Series(sorted(parsed_dates.unique()))
    chunk_size = len(unique_dates) // (n_splits + 1)
    if chunk_size == 0:
        raise ValueError(
            f"not enough unique asOfDates ({len(unique_dates)}) for {n_splits} splits "
            "(need >= n_splits + 1)"
        )

    for fold_i in range(n_splits):
        test_chunk_start = (fold_i + 1) * chunk_size
        test_chunk_end_exclusive = (
            (fold_i + 2) * chunk_size if fold_i < n_splits - 1 else len(unique_dates)
        )
        if test_chunk_start >= len(unique_dates):
            break

        test_first_date = unique_dates.iloc[test_chunk_start]
        test_last_date = unique_dates.iloc[test_chunk_end_exclusive - 1]

        train_cutoff = test_first_date - pd.Timedelta(days=embargo_days)
        train_mask = parsed_dates <= train_cutoff
        purge_mask = forward_end >= test_first_date
        train_mask = train_mask & ~purge_mask

        test_mask = (parsed_dates >= test_first_date) & (parsed_dates <= test_last_date)

        train_idx = np.where(train_mask.to_numpy())[0]
        test_idx = np.where(test_mask.to_numpy())[0]
        if len(train_idx) == 0 or len(test_idx) == 0:
            continue
        yield train_idx, test_idx


class PurgedWalkForwardCV:
    """Sklearn-compatible adapter for ``purged_walkforward_cv``.

    Sklearn pipelines (``GridSearchCV``, ``cross_val_score``,
    ``RidgeCV(cv=...)``, etc.) expect a CV object with a
    ``.split(X, y, groups)`` method that yields ``(train_idx, test_idx)``
    and a ``.get_n_splits(...)`` method. This class wraps the splitter
    so we can plug into ``RidgeCV(cv=PurgedWalkForwardCV(...))`` in W6.

    The DataFrame passed to ``.split`` MUST contain the
    ``as_of_date_col`` column; ``hold_days_col`` is optional (if
    missing, ``hold_days_default`` is used uniformly).
    """

    def __init__(
        self,
        as_of_date_col: str = "asOfDate",
        hold_days_col: str | None = "holdDays",
        n_splits: int = 5,
        embargo_rebalances: int = 3,
        rebalance_freq: str = "monthly",
        hold_days_default: int = 20,
    ) -> None:
        self.as_of_date_col = as_of_date_col
        self.hold_days_col = hold_days_col
        self.n_splits = n_splits
        self.embargo_rebalances = embargo_rebalances
        self.rebalance_freq = rebalance_freq
        self.hold_days_default = hold_days_default

    def split(
        self,
        X: pd.DataFrame,
        y: pd.Series | None = None,  # noqa: ARG002 — sklearn signature
        groups: pd.Series | None = None,  # noqa: ARG002 — sklearn signature
    ) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        if not isinstance(X, pd.DataFrame):
            X = pd.DataFrame(X)
        if self.as_of_date_col not in X.columns:
            raise ValueError(
                f"X missing required '{self.as_of_date_col}' column; "
                f"got columns {list(X.columns)[:8]}..."
            )
        hold_days: pd.Series | None = None
        if self.hold_days_col and self.hold_days_col in X.columns:
            hold_days = X[self.hold_days_col]
        yield from purged_walkforward_cv(
            X[self.as_of_date_col],
            hold_days=hold_days,
            n_splits=self.n_splits,
            embargo_rebalances=self.embargo_rebalances,
            rebalance_freq=self.rebalance_freq,
            hold_days_default=self.hold_days_default,
        )

    def get_n_splits(
        self,
        X: pd.DataFrame | None = None,  # noqa: ARG002
        y: pd.Series | None = None,  # noqa: ARG002
        groups: pd.Series | None = None,  # noqa: ARG002
    ) -> int:
        return self.n_splits
