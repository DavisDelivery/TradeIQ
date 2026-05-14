"""End-to-end smoke test for the W9 orchestrator.

Writes the conftest synthetic_df to a temp Parquet, runs run_all.main
against it, and verifies a findings.md was produced with all the
required sections. Doesn't make any claim about IC numbers; it just
checks the plumbing.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
from scripts.ml.run_all import main as run_all_main


def test_run_all_end_to_end(synthetic_df: pd.DataFrame, tmp_path: Path) -> None:
    parquet_path = tmp_path / "ml-training.parquet"
    synthetic_df.to_parquet(parquet_path)

    out_path = tmp_path / "findings.md"
    exit_code = run_all_main(
        [
            "--parquet",
            str(parquet_path),
            "--out",
            str(out_path),
            "--n-splits",
            "3",
            "--hold-days-default",
            "20",
            "--rebalance-freq",
            "monthly",
        ]
    )
    assert exit_code == 0, f"orchestrator returned {exit_code}; expected 0"
    assert out_path.exists()
    text = out_path.read_text()

    # Required sections (brief W9)
    for header in (
        "# Phase 5a — ML Discovery Findings",
        "## 1. Executive summary",
        "## 2. Data",
        "## 3. Methodology",
        "## 4. Results",
        "## 5. Limitations",
        "## 6. Recommendations",
    ):
        assert header in text, f"missing section: {header}"

    # Pipeline metadata stamped
    assert "Input Parquet SHA-256" in text
    assert "Random seed" in text
    assert "Decision path" in text
