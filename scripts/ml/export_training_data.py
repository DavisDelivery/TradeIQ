"""Export mlTraining rows from Firestore to a local Parquet file.

Reads ``backtestRuns/{runId}/mlTraining/*`` subcollections for every
run with ``status == 'complete'`` and writes a single normalized
Parquet at ``data/ml-training.parquet`` with a sidecar
``data/ml-training.parquet.meta.json`` containing row count, SHA-256
of the Parquet file, and provenance.

Required env::

    GOOGLE_APPLICATION_CREDENTIALS=/path/to/.secrets/firebase-sa.json

CLI flags::

    --max-runs N       Limit to N most recent runs (default: all).
    --since YYYY-MM-DD Only include rows whose asOfDate >= this date.
    --out PATH         Output Parquet path (default data/ml-training.parquet).
    --dry-run          Print summary; do not write any file.

Row-level transformations applied here (one source of truth, motivated
in ``briefs/phase-5a-schema-notes.md``):

* Drop always-null columns: ``marketCapBucket``, ``exitPrice``,
  ``realizedPnl``. They carry no information in the current engine.
* Flatten the ``layers`` dict into per-layer columns named
  ``layer_<key>`` (e.g. ``layer_fundamental``). Missing keys remain
  NaN per row, which downstream feature code handles correctly.
* Add provenance columns ``_runId``, ``_runConfigHash``,
  ``_runConfigSummary``, ``_completedAt``.
* Dedupe on ``(_runConfigHash, asOfDate, ticker)`` keeping the
  latest ``_completedAt`` (resolves true-duplicate re-launches; does
  NOT collapse distinct configs that share an asOfDate × ticker).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# gRPC ignores SSL_CERT_FILE / REQUESTS_CA_BUNDLE and only consults
# GRPC_DEFAULT_SSL_ROOTS_FILE_PATH. On systems with a custom CA bundle
# (e.g. sandbox egress proxies), propagate the standard env var to
# gRPC's so Firestore connections don't fail TLS verification. No-op
# on systems without a system-level CA env var (e.g. macOS).
if "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH" not in os.environ:
    for _env in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"):
        _val = os.environ.get(_env)
        if _val and Path(_val).is_file():
            os.environ["GRPC_DEFAULT_SSL_ROOTS_FILE_PATH"] = _val
            break

import firebase_admin  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from firebase_admin import credentials, firestore  # noqa: E402

random.seed(42)
np.random.seed(42)

# Columns we drop unconditionally — engine writes these as always-null;
# they carry no information. See briefs/phase-5a-schema-notes.md.
ALWAYS_NULL_COLUMNS: tuple[str, ...] = (
    "marketCapBucket",
    "exitPrice",
    "realizedPnl",
)

# Fields of BacktestConfig that participate in _runConfigHash. Intentionally
# excludes scoringConcurrency (perf-only), clockOverride (test-only), and
# initialCapital (does not affect mlTraining rows).
CONFIG_HASH_FIELDS: tuple[str, ...] = (
    "universe",
    "startDate",
    "endDate",
    "rebalanceFrequency",
    "board",
    "portfolio",
    "costs",
)


def _canonical(obj: Any) -> Any:
    """Sort-recursive normalization so dict ordering doesn't change the hash."""
    if isinstance(obj, Mapping):
        return {k: _canonical(obj[k]) for k in sorted(obj)}
    if isinstance(obj, list):
        return [_canonical(v) for v in obj]
    return obj


def _config_hash(config: Mapping[str, Any]) -> str:
    keyed = {k: _canonical(config.get(k)) for k in CONFIG_HASH_FIELDS}
    blob = json.dumps(keyed, sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()[:12]


def _config_summary(config: Mapping[str, Any]) -> str:
    portfolio = config.get("portfolio") or {}
    top_n = portfolio.get("topN", "?")
    return (
        f"{config.get('universe', '?')}/"
        f"{config.get('rebalanceFrequency', '?')}/"
        f"top{top_n}/"
        f"{config.get('startDate', '?')}->{config.get('endDate', '?')}"
    )


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _normalize_row(raw: Mapping[str, Any]) -> dict[str, Any]:
    """One Firestore document -> one DataFrame row.

    Drops always-null columns and flattens ``layers`` into ``layer_*``
    columns. Layer keys vary by run, so we don't fix the schema here;
    pandas will union them on DataFrame construction.
    """
    row = {k: v for k, v in raw.items() if k not in ALWAYS_NULL_COLUMNS}
    layers = row.pop("layers", None) or {}
    if isinstance(layers, Mapping):
        for k, v in layers.items():
            row[f"layer_{k}"] = v
    return row


def _print_summary(df: pd.DataFrame) -> None:
    print(f"\nTotal rows: {len(df):,}")
    print(f"Distinct runs: {df['_runId'].nunique()}")
    print(f"Distinct configs: {df['_runConfigHash'].nunique()}")
    print()
    print("Rows per config:")
    print(
        df.groupby("_runConfigSummary").size().sort_values(ascending=False).to_string()
    )
    print()
    if "regime" in df.columns:
        print(f"Regime counts: {df['regime'].fillna('null').value_counts().to_dict()}")
    print(
        "Year counts: "
        f"{pd.to_datetime(df['asOfDate']).dt.year.value_counts().sort_index().to_dict()}"
    )
    print("Top 20 tickers by row count:")
    print(df["ticker"].value_counts().head(20).to_string())
    print()
    print("Null rates per field (pct):")
    print((df.isnull().mean() * 100).round(1).sort_values(ascending=False).to_string())
    print()
    layer_cols = [c for c in df.columns if c.startswith("layer_")]
    if layer_cols:
        print("Layer summary (mean / std / null%):")
        summary = pd.DataFrame(
            {
                "mean": df[layer_cols].mean(),
                "std": df[layer_cols].std(),
                "null_pct": df[layer_cols].isnull().mean() * 100,
            }
        ).round(2)
        print(summary.to_string())


def _sanity_check(df: pd.DataFrame) -> list[str]:
    """Return a list of warning strings. Empty list = clean."""
    warnings: list[str] = []
    if df.empty:
        warnings.append("dataset is empty")
        return warnings

    # asOfDate parses
    try:
        pd.to_datetime(df["asOfDate"], errors="raise")
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"asOfDate parse failure: {exc}")

    # composite distribution sanity — brief: must not be a single spike at 50
    if "composite" in df.columns:
        comp = pd.to_numeric(df["composite"], errors="coerce").dropna()
        if not comp.empty:
            near_50 = ((comp - 50).abs() < 0.5).mean()
            if near_50 > 0.5:
                warnings.append(
                    f"composite distribution: {near_50:.1%} of rows within 0.5 of 50 -- "
                    "scorer normalization may be compressing scores; see brief"
                )

    # forward returns: should be finite where present
    for col in ("forward5dReturn", "forward20dReturn", "forward60dReturn", "forward252dReturn"):
        if col in df.columns:
            vals = pd.to_numeric(df[col], errors="coerce")
            inf_count = int(np.isinf(vals.fillna(0)).sum())
            if inf_count > 0:
                warnings.append(f"{col}: {inf_count} non-finite values")

    # forward20dReturn null rate -- this is the default target
    if "forward20dReturn" in df.columns:
        null_rate = df["forward20dReturn"].isnull().mean()
        if null_rate > 0.2:
            warnings.append(
                f"forward20dReturn null rate {null_rate:.1%} > 20% -- "
                "default ML target may be sparse"
            )

    return warnings


def fetch_rows(
    db: firestore.Client,
    max_runs: int | None,
    since: str | None,
) -> pd.DataFrame:
    """Stream complete runs and their mlTraining subcollections into a DataFrame."""
    runs_query = db.collection("backtestRuns").where("status", "==", "complete")
    if max_runs is not None:
        runs_query = runs_query.limit(max_runs)

    rows: list[dict[str, Any]] = []
    dropped_pre_since = 0
    for run in runs_query.stream():
        run_data = run.to_dict() or {}
        config = run_data.get("config", {}) or {}
        cfg_hash = _config_hash(config)
        cfg_summary = _config_summary(config)
        completed_at = run_data.get("completedAt")

        for ml_doc in run.reference.collection("mlTraining").stream():
            raw = ml_doc.to_dict() or {}
            if since is not None and (raw.get("asOfDate") or "") < since:
                dropped_pre_since += 1
                continue
            normalized = _normalize_row(raw)
            normalized["_runId"] = run.id
            normalized["_runConfigHash"] = cfg_hash
            normalized["_runConfigSummary"] = cfg_summary
            normalized["_completedAt"] = completed_at
            rows.append(normalized)

    if dropped_pre_since:
        print(f"Skipped {dropped_pre_since:,} rows with asOfDate < {since}")

    if not rows:
        return pd.DataFrame()

    return pd.DataFrame(rows)


def deduplicate(df: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """Drop true duplicates ((_runConfigHash, asOfDate, ticker) collisions).

    Distinct-config rows that share asOfDate × ticker are NOT touched.
    """
    if df.empty:
        return df, 0

    before = len(df)
    # Sort so the most-recently-completed run wins on tie-break
    deduped = (
        df.sort_values("_completedAt", ascending=False, na_position="last")
        .drop_duplicates(subset=["_runConfigHash", "asOfDate", "ticker"], keep="first")
        .reset_index(drop=True)
    )
    return deduped, before - len(deduped)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-runs", type=int, default=None)
    parser.add_argument(
        "--since",
        type=str,
        default=None,
        help="YYYY-MM-DD; only include rows whose asOfDate >= this date",
    )
    parser.add_argument(
        "--out", type=str, default="data/ml-training.parquet",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not cred_path:
        print(
            "FATAL: GOOGLE_APPLICATION_CREDENTIALS not set; "
            "expected path to firebase-sa.json",
            file=sys.stderr,
        )
        return 2

    if not firebase_admin._apps:  # type: ignore[attr-defined]
        firebase_admin.initialize_app(credentials.Certificate(cred_path))
    db = firestore.client()

    print(f"Fetching from project={firebase_admin.get_app().project_id} ...")
    df = fetch_rows(db, args.max_runs, args.since)
    if df.empty:
        print("No rows fetched; aborting.")
        return 1

    print(f"Collected {len(df):,} rows from {df['_runId'].nunique()} runs")
    df, n_dupes = deduplicate(df)
    if n_dupes:
        rate = n_dupes / (n_dupes + len(df))
        marker = "WARN" if rate > 0.1 else "info"
        print(f"[{marker}] Dropped {n_dupes:,} true duplicates ({rate:.1%})")

    _print_summary(df)

    warnings = _sanity_check(df)
    if warnings:
        print("\nSANITY WARNINGS:")
        for w in warnings:
            print(f"  - {w}")
    else:
        print("\nSanity checks: clean.")

    if args.dry_run:
        print("\n--dry-run; no Parquet written.")
        return 0

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_path, compression="snappy", index=False)
    parquet_hash = _sha256_file(out_path)

    meta_path = out_path.with_suffix(out_path.suffix + ".meta.json")
    meta = {
        "row_count": int(len(df)),
        "asOfDate_min": str(df["asOfDate"].min()),
        "asOfDate_max": str(df["asOfDate"].max()),
        "unique_runs": int(df["_runId"].nunique()),
        "unique_configs": int(df["_runConfigHash"].nunique()),
        "config_summaries": (
            df.groupby("_runConfigSummary").size().sort_values(ascending=False).to_dict()
        ),
        "duplicate_rows_dropped": int(n_dupes),
        "parquet_sha256": parquet_hash,
        "exported_at": datetime.now(UTC).isoformat(),
        "warnings": warnings,
    }
    meta_path.write_text(json.dumps(meta, indent=2, default=str))
    print(f"\nWrote {out_path} ({len(df):,} rows; sha256={parquet_hash[:12]})")
    print(f"Wrote sidecar {meta_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
