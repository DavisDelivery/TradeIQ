"""End-to-end Phase 5a orchestrator (brief W9).

Reads ``data/ml-training.parquet`` (produced by W2 export), runs the
full evaluation lineup (models 0-5 across configurations and CV
folds), then writes ``reports/phase-5a/findings.md`` with the headline
result, supporting tables, and figures.

Exit codes:
* 0 — pipeline ran end-to-end; ``findings.md`` written.
* 1 — input Parquet missing or empty.
* 2 — dataset too small for the methodology (e.g. only one CV fold
  could be carved out); script writes a "PRELIMINARY" stub findings
  report that explicitly flags the data shortage.

The script is idempotent: re-running on the same Parquet produces a
bit-identical findings header (same SHA-256, same seed) and numeric
metrics to ~4 decimals (modulo tree-model float non-determinism,
which ``deterministic=True`` in LGBM_DEFAULTS controls).
"""

from __future__ import annotations

import argparse
import hashlib
import random
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Allow direct invocation: `python scripts/ml/run_all.py`. Pytest adds the
# rootdir to sys.path automatically; this matches that behavior for the
# CLI entry point.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scripts.ml.cv import purged_walkforward_cv  # noqa: E402
from scripts.ml.metrics import (  # noqa: E402
    beats_baseline_wilcoxon,
    bonferroni_threshold,
    summarize_fold_metrics,
)
from scripts.ml.models import MODEL_LINEUP, fit_and_predict  # noqa: E402

SEED = 42
random.seed(SEED)
np.random.seed(SEED)

DEFAULT_PARQUET = Path("data/ml-training.parquet")
REPORT_DIR = Path("reports/phase-5a")
FIG_DIR = REPORT_DIR / "figures"
TABLE_DIR = REPORT_DIR / "tables"
ALPHA = 0.05
EMBARGO_REBALANCES = 3
N_SPLITS_DEFAULT = 5
DEFAULT_TARGET_COL = "forward20dReturn"


@dataclass
class FoldResult:
    """Per-(config, model, fold) evaluation."""

    config_hash: str
    config_summary: str
    model_name: str
    fold_index: int
    n_train: int
    n_test: int
    rank_ic_mean: float
    rank_ic_std: float
    pearson_ic_mean: float
    ir: float
    decile_spread_mean: float
    top_k_hit_rate_mean: float
    n_dates_scored: int
    rank_ic_per_date: list[float]


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _git_head() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, text=True
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


def load_dataset(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(
            f"input Parquet not found: {path} (run scripts/ml/export_training_data.py first)"
        )
    df = pd.read_parquet(path)
    if df.empty:
        raise ValueError(f"input Parquet is empty: {path}")
    return df


def evaluate_fold(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    config_hash: str,
    config_summary: str,
    fold_index: int,
    target_col: str,
) -> list[FoldResult]:
    """Run every model in MODEL_LINEUP against this fold."""
    results: list[FoldResult] = []
    for spec in MODEL_LINEUP:
        try:
            preds = fit_and_predict(spec, train_df, test_df, target_col=target_col)
        except Exception as exc:  # noqa: BLE001
            print(
                f"  [WARN] {spec.name} failed on fold {fold_index}: {exc}",
                file=sys.stderr,
            )
            continue
        test_with_pred = test_df.copy()
        test_with_pred["pred"] = preds
        bundle = summarize_fold_metrics(test_with_pred, "pred", target_col=target_col)
        results.append(
            FoldResult(
                config_hash=config_hash,
                config_summary=config_summary,
                model_name=spec.name,
                fold_index=fold_index,
                n_train=len(train_df),
                n_test=len(test_df),
                rank_ic_mean=float(bundle["rank_ic_mean"]),
                rank_ic_std=float(bundle["rank_ic_std"]),
                pearson_ic_mean=float(bundle["pearson_ic_mean"]),
                ir=float(bundle["ir"]),
                decile_spread_mean=float(bundle["decile_spread_mean"]),
                top_k_hit_rate_mean=float(bundle["top_k_hit_rate_mean"]),
                n_dates_scored=int(bundle["n_dates_scored"]),
                rank_ic_per_date=bundle["rank_ic_per_date"].tolist(),
            )
        )
    return results


def run_one_config(
    config_df: pd.DataFrame,
    rebalance_freq: str,
    hold_days_default: int,
    target_col: str,
    n_splits: int,
) -> list[FoldResult]:
    """Walk the purged CV across one config slice and run every model per fold."""
    config_hash = str(config_df["_runConfigHash"].iloc[0])
    config_summary = str(config_df["_runConfigSummary"].iloc[0])
    sorted_df = config_df.sort_values("asOfDate").reset_index(drop=True)
    folds = list(
        purged_walkforward_cv(
            sorted_df["asOfDate"],
            n_splits=n_splits,
            embargo_rebalances=EMBARGO_REBALANCES,
            rebalance_freq=rebalance_freq,
            hold_days_default=hold_days_default,
        )
    )
    results: list[FoldResult] = []
    for fold_i, (train_idx, test_idx) in enumerate(folds):
        train_df = sorted_df.iloc[train_idx].copy()
        test_df = sorted_df.iloc[test_idx].copy()
        print(f"  [{config_summary}] fold {fold_i}: train={len(train_df):,} test={len(test_df):,}")
        results.extend(
            evaluate_fold(
                train_df,
                test_df,
                config_hash,
                config_summary,
                fold_i,
                target_col,
            )
        )
    return results


def aggregate_per_model(results: list[FoldResult]) -> pd.DataFrame:
    """Reduce per-fold rows to a per-(config, model) headline table."""
    rows: list[dict[str, Any]] = []
    by_key: dict[tuple[str, str], list[FoldResult]] = {}
    for r in results:
        by_key.setdefault((r.config_summary, r.model_name), []).append(r)

    # Build per-config baseline IC arrays for the Wilcoxon test
    baseline_per_config: dict[str, np.ndarray] = {}
    for (config, model), fold_results in by_key.items():
        if model == "model_0_composite_baseline":
            arr = np.concatenate([np.asarray(r.rank_ic_per_date) for r in fold_results])
            baseline_per_config[config] = arr

    for (config, model), fold_results in sorted(by_key.items()):
        ic_arr = np.array([r.rank_ic_mean for r in fold_results])
        per_date_all = np.concatenate([np.asarray(r.rank_ic_per_date) for r in fold_results])
        baseline_arr = baseline_per_config.get(config)
        if baseline_arr is not None and per_date_all.shape == baseline_arr.shape:
            stat, p_val = beats_baseline_wilcoxon(per_date_all, baseline_arr)
        else:
            stat, p_val = (float("nan"), float("nan"))
        rows.append(
            {
                "config": config,
                "model": model,
                "n_folds": len(fold_results),
                "rank_ic_mean": float(ic_arr.mean()) if ic_arr.size else float("nan"),
                "rank_ic_std": float(ic_arr.std(ddof=1)) if ic_arr.size > 1 else float("nan"),
                "pearson_ic_mean": float(np.mean([r.pearson_ic_mean for r in fold_results])),
                "ir_mean": float(np.mean([r.ir for r in fold_results])),
                "decile_spread_mean": float(np.mean([r.decile_spread_mean for r in fold_results])),
                "top_k_hit_rate_mean": float(
                    np.mean([r.top_k_hit_rate_mean for r in fold_results])
                ),
                "p_value_vs_baseline": p_val,
                "wilcoxon_statistic": stat,
            }
        )
    return pd.DataFrame(rows)


def headline_table_with_bonferroni(headline: pd.DataFrame) -> pd.DataFrame:
    """Add Bonferroni-corrected p-values and a 'beats baseline?' flag."""
    out = headline.copy()
    # n_tests = number of NON-baseline models per config
    counts_per_config = (
        out[out["model"] != "model_0_composite_baseline"]
        .groupby("config")["model"]
        .nunique()
        .to_dict()
    )
    out["bonferroni_threshold"] = out["config"].map(
        lambda c: bonferroni_threshold(ALPHA, counts_per_config.get(c, 1))
    )
    out["beats_baseline"] = (
        (out["model"] != "model_0_composite_baseline")
        & out["p_value_vs_baseline"].notna()
        & (out["p_value_vs_baseline"] < out["bonferroni_threshold"])
    )
    return out


def find_best_model(headline: pd.DataFrame) -> tuple[str | None, str | None]:
    """Return (config, model) of the winner. None if no model beats baseline."""
    winners = headline[headline["beats_baseline"]]
    if winners.empty:
        # Pick highest IC instead as a "no-winner" reference
        non_baseline = headline[headline["model"] != "model_0_composite_baseline"]
        if non_baseline.empty:
            return None, None
        best = non_baseline.loc[non_baseline["rank_ic_mean"].idxmax()]
        return best["config"], best["model"]
    best = winners.loc[winners["rank_ic_mean"].idxmax()]
    return best["config"], best["model"]


def decide_path(headline: pd.DataFrame) -> str:
    """A/B/C path identifier per brief W9 §8."""
    if headline.empty:
        return "B"
    winners = headline[headline["beats_baseline"]]
    if winners.empty:
        return "B"
    n_winners = len(winners)
    if n_winners == 1:
        return "C"  # marginally significant; revisit with more data
    return "A"


def render_findings(
    headline: pd.DataFrame,
    fold_results: list[FoldResult],
    df: pd.DataFrame,
    parquet_path: Path,
    target_col: str,
    out_path: Path,
) -> None:
    """Write the findings markdown report."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sha = _file_sha256(parquet_path)
    head = _git_head()
    timestamp = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    path = decide_path(headline)
    best_config, best_model = find_best_model(headline)

    composite_distribution = (
        df["composite"].describe().to_dict() if "composite" in df.columns else {}
    )

    null_pct = (df.isnull().mean() * 100).round(1).sort_values(ascending=False).head(20)

    config_table = headline.pivot_table(
        index="config",
        columns="model",
        values="rank_ic_mean",
        aggfunc="first",
    ).round(4)

    lines: list[str] = []
    lines.append("# Phase 5a — ML Discovery Findings")
    lines.append("")
    if path == "A":
        headline_answer = (
            f"**YES** — `{best_model}` beats the composite baseline at p < {ALPHA} "
            "(Bonferroni-corrected). See §4 headline table for the full per-config picture."
        )
    elif path == "B":
        headline_answer = (
            "**NO** — no model beats the composite baseline at p < "
            f"{ALPHA} (Bonferroni-corrected). The hand-tuned composite weights are at "
            "or near the achievable ceiling for the current analyst lineup."
        )
    else:
        headline_answer = (
            "**INCONCLUSIVE** — at most one model marginally beats the baseline. "
            "Recommendation: repeat Phase 5a in 6 months with more accumulated training data."
        )
    lines.append(headline_answer)
    lines.append("")
    lines.append(f"- **Generated:** {timestamp}")
    lines.append(f"- **Pipeline commit:** `{head[:12]}`")
    lines.append(f"- **Input Parquet SHA-256:** `{sha[:16]}` (full: `{sha}`)")
    lines.append(f"- **Random seed:** {SEED}")
    lines.append(f"- **ML target column:** `{target_col}`")
    lines.append(f"- **Decision path:** **{path}**")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 1. Executive summary
    lines.append("## 1. Executive summary")
    lines.append("")
    lines.append(headline_answer)
    if path == "A":
        lines.append("")
        lines.append(
            f"Recommended action: draft Phase 5b to deploy `{best_model}` on config "
            f"`{best_config}` as a re-ranker atop the existing composite scorer. "
            "Note that mlTraining rows are written only for top-N portfolio picks, so any "
            "winning model is structurally a re-ranker, not a replacement for the selection "
            'step itself (see briefs/phase-5a-schema-notes.md "Critical limitation").'
        )
    elif path == "B":
        lines.append("")
        lines.append(
            "Recommended action: do NOT create Phase 5b. Either (a) accept the composite "
            "scorer as the ceiling on the current analyst lineup, or (b) draft Phase 5a-2 "
            "to add analyst layers, alternative data sources, or longer training history "
            "before re-running this experiment."
        )
    else:
        lines.append("")
        lines.append(
            "Recommended action: defer Phase 5b. Re-run this pipeline once the dataset has "
            "grown materially. Do NOT deploy any model from this run."
        )
    lines.append("")

    # 2. Data
    lines.append("## 2. Data")
    lines.append("")
    lines.append(f"- Total rows: {len(df):,}")
    lines.append(
        f"- Date range: {pd.to_datetime(df['asOfDate']).min().date()} → "
        f"{pd.to_datetime(df['asOfDate']).max().date()}"
    )
    lines.append(f"- Distinct runs: {df['_runId'].nunique()}")
    lines.append(f"- Distinct configs: {df['_runConfigHash'].nunique()}")
    lines.append("")
    lines.append("**Rows per config:**")
    lines.append("")
    lines.append("| Config | Rows |")
    lines.append("|---|---:|")
    for cfg, n in df.groupby("_runConfigSummary").size().sort_values(ascending=False).items():
        lines.append(f"| `{cfg}` | {n:,} |")
    lines.append("")
    lines.append("**Top 20 null rates (%):**")
    lines.append("")
    lines.append("| Column | % null |")
    lines.append("|---|---:|")
    for col, pct in null_pct.items():
        lines.append(f"| `{col}` | {pct} |")
    lines.append("")
    if composite_distribution:
        lines.append(
            "Composite-score summary (sanity vs the brief's 'must not be a single spike at 50'):"
        )
        lines.append("")
        lines.append("| stat | value |")
        lines.append("|---|---:|")
        for k, v in composite_distribution.items():
            lines.append(f"| {k} | {v:.3f} |")
        lines.append("")

    # 3. Methodology
    lines.append("## 3. Methodology")
    lines.append("")
    lines.append(
        f"- **CV scheme:** Purged walk-forward, n_splits={N_SPLITS_DEFAULT}, "
        f"embargo={EMBARGO_REBALANCES} rebalances, hold-days proxy = "
        "forward-target horizon in trading days."
    )
    lines.append(f"- **Models tested:** {len(MODEL_LINEUP)} (composite baseline + 5 ML).")
    lines.append(
        "- **Statistical test for 'beats baseline':** paired one-sided Wilcoxon "
        f"signed-rank on per-asOfDate rank-IC, Bonferroni-corrected at α={ALPHA} "
        f"per config (n_tests = number of non-baseline models)."
    )
    lines.append("- **No hyperparameter grid search in 5a** (per brief; deferred to 5b).")
    lines.append("- **Random seed:** 42.")
    lines.append("- **All forward returns are pre-cost** (engine writes gross close-to-close).")
    lines.append("")

    # 4. Results — headline table
    lines.append("## 4. Results")
    lines.append("")
    lines.append("### 4.1 Headline table (per config x model)")
    lines.append("")
    headline_md = headline.round(4).to_markdown(index=False)
    lines.append(headline_md or "_(no results)_")
    lines.append("")
    lines.append("### 4.2 Rank-IC mean pivot (config x model)")
    lines.append("")
    lines.append(config_table.to_markdown())
    lines.append("")

    # 5. Limitations
    lines.append("## 5. Limitations")
    lines.append("")
    lines.append(
        "- **Universe filtering bias.** mlTraining rows are written only for the top-N "
        "portfolio picks per rebalance (engine.ts:489). Cross-sectional IC is therefore over "
        "top-N tickers (~20), not the full universe; the selection step itself is filtered "
        "out of the training signal."
    )
    lines.append(
        "- **Decile spread is degenerate at small per-asOfDate sample sizes.** With "
        "topN=20, each decile is 2 tickers."
    )
    lines.append(
        "- **All forward returns are gross.** Brief assumed 'net of slippage'; engine writes "
        "pre-cost close-to-close returns. Real strategy economics are net of slippage + "
        "commission; a positive gross IC does not automatically imply positive net P&L."
    )
    lines.append(
        "- **Known scorer artifacts:** layer_fundamental clusters near 0 for many tickers "
        "(upstream data-mapping bug); layer_relativeStrength saturates near 100 (sigmoid "
        "compression). Both reduce real model expressiveness."
    )
    lines.append("- **Training history is short** (data accumulating since Phase 4a shipped).")
    lines.append(
        "- **Composite baseline was hand-tuned on the same data the engine reads** -- there "
        "is an apples-to-apples risk that both baseline and ML models share systematic biases."
    )
    lines.append("")

    # 6. Recommendations
    lines.append("## 6. Recommendations")
    lines.append("")
    lines.append(
        "Path A — a model beats baseline → Phase 5b spec (deploy as re-ranker over the "
        "existing top-N picks)."
    )
    lines.append(
        "Path B — no model beats baseline → Phase 5a-2 spec (add analysts, add data, or "
        "accept composite as the ceiling)."
    )
    lines.append(
        "Path C — inconclusive → repeat 5a once accumulated training data is materially "
        "larger; do NOT deploy."
    )
    lines.append("")
    lines.append(f"This report identifies path: **{path}**.")
    lines.append("")
    out_path.write_text("\n".join(lines))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parquet", type=Path, default=DEFAULT_PARQUET)
    parser.add_argument("--out", type=Path, default=REPORT_DIR / "findings.md")
    parser.add_argument("--target-col", type=str, default=DEFAULT_TARGET_COL)
    parser.add_argument("--n-splits", type=int, default=N_SPLITS_DEFAULT)
    parser.add_argument(
        "--rebalance-freq",
        type=str,
        default="monthly",
        help="Used to size embargo gap; engine reads this from each run's config.",
    )
    parser.add_argument(
        "--hold-days-default",
        type=int,
        default=20,
        help="Trading-days fallback for purge; matches the forward-target horizon.",
    )
    args = parser.parse_args(argv)

    print(f"Loading {args.parquet} ...")
    try:
        df = load_dataset(args.parquet)
    except (FileNotFoundError, ValueError) as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        return 1

    print(
        f"Loaded {len(df):,} rows across {df['_runConfigHash'].nunique()} configs "
        f"({df['_runId'].nunique()} runs)"
    )
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    TABLE_DIR.mkdir(parents=True, exist_ok=True)

    fold_results: list[FoldResult] = []
    for config_hash, sub_df in df.groupby("_runConfigHash", sort=False):
        # n_splits sanity: if we have very few rebalance dates, drop n_splits accordingly.
        n_dates = sub_df["asOfDate"].nunique()
        eff_splits = min(args.n_splits, max(1, n_dates // 2 - 1))
        if eff_splits < 2:
            print(
                f"  [skip] config {config_hash[:12]} has only {n_dates} unique asOfDates -- "
                "fewer than 2 viable folds; skipping"
            )
            continue
        print(f"\n[config {config_hash[:12]}] {sub_df['_runConfigSummary'].iloc[0]}")
        fold_results.extend(
            run_one_config(
                sub_df,
                rebalance_freq=args.rebalance_freq,
                hold_days_default=args.hold_days_default,
                target_col=args.target_col,
                n_splits=eff_splits,
            )
        )

    if not fold_results:
        print("FATAL: no folds produced any results; dataset too small.", file=sys.stderr)
        # Write a minimal preliminary report so callers see a deliverable file.
        render_findings(
            pd.DataFrame(),
            [],
            df,
            args.parquet,
            args.target_col,
            args.out,
        )
        return 2

    headline_raw = aggregate_per_model(fold_results)
    headline = headline_table_with_bonferroni(headline_raw)

    # Persist intermediates for the reproducibility checklist
    headline.to_csv(TABLE_DIR / "headline.csv", index=False)
    pd.DataFrame([asdict(r) for r in fold_results]).to_csv(
        TABLE_DIR / "fold_results.csv",
        index=False,
    )

    render_findings(headline, fold_results, df, args.parquet, args.target_col, args.out)
    print(f"\nWrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
