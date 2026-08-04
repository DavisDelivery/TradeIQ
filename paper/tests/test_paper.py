"""Tests for the forward paper-tracker.

These pin the four properties that make forward tracking worth anything.
If any of them breaks, the forward record becomes as contaminated as the
backtest it exists to replace:

  1. Entry is strictly AFTER the scan date (no look-ahead).
  2. Marks are append-only — a second `mark()` never rewrites a mark.
  3. Every signal gets matched random controls from the same day's universe,
     reproducibly.
  4. Stored inputs are frozen — later code changes cannot alter them.
"""
import datetime as dt
import json
import sqlite3

import pandas as pd
import pytest

from tradeiq import paper


# --- fixtures ---------------------------------------------------------------

UNIVERSE = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"]
RUN_DATE = "2026-01-05"          # a Monday


def _row(ticker, sas, sat=20.0, conv=2):
    return {
        "ticker": ticker, "company": f"{ticker} Inc", "theme": "test",
        "sas": sas, "saturation": sat, "consumer_z": 1.4, "investor_z": -0.2,
        "convergence": conv, "sources_used": 3, "price": 100.0,
        "avg_vol": 1_000_000, "event_risk": False, "action": "EARLY",
    }


def _scan(equity=25000, verbose=False):
    rows = [_row("AAA", 92.0), _row("BBB", 88.0)]
    rows += [_row(t, 30.0, sat=80.0, conv=0) for t in UNIVERSE[2:]]
    return {"rows": rows, "equity": equity}


def _flat_series(start="2025-06-02", n=400, base=100.0, slope=0.0):
    idx = pd.bdate_range(start=start, periods=n)
    return pd.Series([base + slope * i for i in range(n)], index=idx)


@pytest.fixture(autouse=True)
def isolated_db(tmp_path, monkeypatch):
    """Isolate BOTH the database and every module that writes artifacts.

    broker.build_tickets writes tickets.json to its own OUT_DIR, so without
    patching it too a test run silently overwrites the real out/ directory
    with fixture data.
    """
    from tradeiq import broker as broker_mod
    db = tmp_path / "paper.db"
    monkeypatch.setattr(paper, "DB_PATH", db)
    monkeypatch.setattr(paper, "OUT_DIR", tmp_path)
    monkeypatch.setattr(broker_mod, "OUT_DIR", tmp_path)
    yield db


@pytest.fixture
def fake_prices(monkeypatch):
    """Every ticker rises 1/day; SPY and XLY are flat, so excess == ret."""
    def series(ticker, range_="2y"):
        if ticker in paper.BENCHMARKS:
            return _flat_series()
        return _flat_series(slope=1.0)
    monkeypatch.setattr(paper, "_series", series)
    return series


# --- tests ------------------------------------------------------------------

def test_open_creates_signals_and_matched_controls():
    res = paper.open_run(scan_fn=_scan, run_date=RUN_DATE)
    assert res["signals"] == 2
    assert res["controls"] == 2 * paper.CONTROLS_PER_SIGNAL

    with paper._db() as c:
        pos = c.execute("SELECT * FROM paper_positions").fetchall()
    sig = [p for p in pos if p["cohort"] == "signal"]
    ctl = [p for p in pos if p["cohort"] == "control"]

    assert {p["ticker"] for p in sig} == {"AAA", "BBB"}
    # Controls must come from the scanned universe but never be a signal.
    assert {p["ticker"] for p in ctl}.isdisjoint({"AAA", "BBB"})
    assert {p["ticker"] for p in ctl} <= set(UNIVERSE)
    # Every control is attributed to the signal it mirrors.
    assert all(p["matched_to"] in {"AAA", "BBB"} for p in ctl)
    # Drawn without replacement across the run.
    assert len({p["ticker"] for p in ctl}) == len(ctl)


def test_control_draw_is_reproducible_and_date_dependent():
    a = paper.open_run(scan_fn=_scan, run_date=RUN_DATE, dry_run=True)
    b = paper.open_run(scan_fn=_scan, run_date=RUN_DATE, dry_run=True)
    c = paper.open_run(scan_fn=_scan, run_date="2026-02-09", dry_run=True)

    names = lambda r: [p["ticker"] for p in r["positions"] if p["cohort"] == "control"]
    assert names(a) == names(b), "same date must reproduce the same control draw"
    assert names(a) != names(c) or len(UNIVERSE) < 4


def test_entry_is_strictly_after_the_scan_date(fake_prices):
    paper.open_run(scan_fn=_scan, run_date=RUN_DATE)
    paper.mark(today="2026-12-31", verbose=False)

    with paper._db() as c:
        pos = c.execute("SELECT ticker, run_date, entry_date FROM paper_positions").fetchall()
    assert pos
    for p in pos:
        assert p["entry_date"] is not None
        assert p["entry_date"] > p["run_date"], (
            f"{p['ticker']} entered on its own scan date — that is the "
            "look-ahead that invalidated the backtest"
        )


def test_marks_are_append_only(fake_prices):
    paper.open_run(scan_fn=_scan, run_date=RUN_DATE)
    first = paper.mark(today="2026-12-31", verbose=False)
    assert first["marked"] > 0

    with paper._db() as c:
        before = c.execute(
            "SELECT position_id, horizon, px, marked_at FROM paper_marks ORDER BY 1,2"
        ).fetchall()
        snapshot = [tuple(r) for r in before]

    second = paper.mark(today="2026-12-31", verbose=False)
    assert second["marked"] == 0, "a second mark pass must write nothing"

    with paper._db() as c:
        after = [tuple(r) for r in c.execute(
            "SELECT position_id, horizon, px, marked_at FROM paper_marks ORDER BY 1,2"
        ).fetchall()]
    assert after == snapshot, "existing marks must be byte-identical after remarking"


def test_horizon_does_not_mark_before_it_matures(fake_prices):
    paper.open_run(scan_fn=_scan, run_date=RUN_DATE)
    # Only ~8 sessions after entry: 1w (5 sessions) matures, 4w (20) does not.
    paper.mark(today="2026-01-16", verbose=False)
    with paper._db() as c:
        horizons = {r["horizon"] for r in c.execute("SELECT horizon FROM paper_marks").fetchall()}
    assert "1w" in horizons
    assert "4w" not in horizons and "12w" not in horizons


def test_inputs_are_frozen_against_later_code_changes(fake_prices):
    paper.open_run(scan_fn=_scan, run_date=RUN_DATE)
    with paper._db() as c:
        row = c.execute(
            "SELECT inputs_json, inputs_hash, sas FROM paper_positions "
            "WHERE ticker='AAA' AND cohort='signal'"
        ).fetchone()
    stored = json.loads(row["inputs_json"])
    assert stored["sas"] == 92.0
    assert row["sas"] == 92.0
    assert row["inputs_hash"] == paper._hash(_row("AAA", 92.0))

    # Re-open the same run with a DIFFERENT score: the original must survive.
    def rescored(equity=25000, verbose=False):
        out = _scan(equity, verbose)
        out["rows"][0]["sas"] = 10.0
        return out

    paper.open_run(scan_fn=rescored, run_date=RUN_DATE)
    with paper._db() as c:
        again = c.execute(
            "SELECT sas FROM paper_positions WHERE ticker='AAA' AND cohort='signal'"
        ).fetchall()
    assert all(r["sas"] == 92.0 for r in again), "history must not be rewritten"


def test_report_is_honest_when_nothing_has_matured():
    paper.open_run(scan_fn=_scan, run_date=RUN_DATE)
    out = paper.report(verbose=False)
    assert out["horizons"] == {}
    assert "No matured marks yet" in out["note"]


def test_report_separates_cohorts_and_reports_the_difference(fake_prices):
    paper.open_run(scan_fn=_scan, run_date=RUN_DATE)
    paper.mark(today="2026-12-31", verbose=False)
    out = paper.report(verbose=False)

    block = out["horizons"]["4w"]["SPY"]
    assert block["signal"]["n"] == 2
    assert block["control"]["n"] == 2 * paper.CONTROLS_PER_SIGNAL
    # In this fixture every name follows the identical path, so the signal
    # provides no edge over the control and the difference must be ~0.
    assert block["signal_minus_control_pp"] == pytest.approx(0.0, abs=1e-6)


def test_clustered_se_is_wider_than_naive_when_returns_repeat_per_name():
    # Six observations but only two distinct names: the honest N is 2, not 6.
    df = pd.DataFrame({
        "ticker": ["AAA", "AAA", "AAA", "BBB", "BBB", "BBB"],
        "excess_SPY": [5.0, 5.0, 5.0, -1.0, -1.0, -1.0],
    })
    st = paper._clustered_stats(df, "excess_SPY")
    assert st["n"] == 6
    assert st["clusters"] == 2
    assert st["n_eff"] < st["n"], "clustering must shrink the effective sample"


def test_observations_are_logged_without_opening_a_position():
    paper.log_observation("smart jump rope", ticker="XYZ", run_date=RUN_DATE)
    with paper._db() as c:
        obs = c.execute("SELECT * FROM paper_observations").fetchall()
        pos = c.execute("SELECT * FROM paper_positions").fetchall()
    assert len(obs) == 1
    assert obs[0]["phrase"] == "smart jump rope"
    assert pos == [], "discovery proposals must never open a position"


def test_no_signals_still_records_the_run(fake_prices):
    def nothing(equity=25000, verbose=False):
        return {"rows": [_row(t, 20.0, sat=90.0, conv=0) for t in UNIVERSE], "equity": equity}

    res = paper.open_run(scan_fn=nothing, run_date=RUN_DATE)
    assert res["signals"] == 0 and res["controls"] == 0
    with paper._db() as c:
        run = c.execute("SELECT * FROM paper_runs").fetchone()
    # A day with no signal is data, not a gap. The run row must still exist
    # so the denominator of "how often does this fire" stays honest.
    assert run["scanned"] == len(UNIVERSE)
    assert "no signal" in (run["note"] or "")


def test_degraded_scan_is_refused_not_recorded():
    """A throttled data source must not be recorded as a normal quiet day.

    Google Trends 429s are routine (pytrends is archived; robots.txt
    disallows the path). On a bad day the scan comes back with most themes
    stripped of consumer data and almost nothing passing the gates — which
    is indistinguishable, after the fact, from a genuinely quiet market.
    Recording it would poison the forward record with fake quiet days.
    """
    def throttled(equity=25000, verbose=False):
        rows = [_row(t, 40.0) for t in UNIVERSE]
        for r in rows[2:]:            # 75% lost their consumer data
            r["sources_used"] = 0
        return {"rows": rows, "equity": equity}

    with pytest.raises(paper.DegradedScan, match="refusing to record"):
        paper.open_run(scan_fn=throttled, run_date=RUN_DATE)

    with paper._db() as c:
        assert c.execute("SELECT COUNT(*) n FROM paper_runs").fetchone()["n"] == 0
        assert c.execute("SELECT COUNT(*) n FROM paper_positions").fetchone()["n"] == 0

    # ...but an explicit force still records it, with the coverage stamped
    # on the run so it can be filtered out later.
    paper.open_run(scan_fn=throttled, run_date=RUN_DATE, force=True)
    with paper._db() as c:
        run = c.execute("SELECT params FROM paper_runs").fetchone()
    assert json.loads(run["params"])["coverage"] == pytest.approx(0.25)


def test_too_few_rows_is_also_refused():
    def tiny(equity=25000, verbose=False):
        return {"rows": [_row("AAA", 90.0)], "equity": equity}

    with pytest.raises(paper.DegradedScan):
        paper.open_run(scan_fn=tiny, run_date=RUN_DATE)


# --- regression: the mark() self-deadlock -----------------------------------
#
# mark() used to hold one write connection open for its whole loop while
# calling _series() inside it. In production _series -> prices.history ->
# store.cache_put opens a SECOND connection to the same file and writes, so
# SQLite raised "database is locked" on the very first ticker and every mark
# run died there. The ledger sat at 4 positions / 0 marks for a day before
# anyone ran it by hand.
#
# The existing fake_prices fixture patches paper._series wholesale, so it
# never touches the cache and never reproduced the fault. This fixture keeps
# the real write behaviour and is the reason the bug is now covered.

@pytest.fixture
def caching_prices(monkeypatch, tmp_path):
    """A _series that writes to the cache DB, exactly as the real one does."""
    from tradeiq import store as store_mod
    monkeypatch.setattr(store_mod, "DB_PATH", tmp_path / "paper.db")
    monkeypatch.setattr(store_mod, "_schema_ready", False)

    def series(ticker, range_="2y"):
        # The real path caches every fetch. This is the write that used to
        # collide with mark()'s open transaction.
        store_mod.cache_put(f"px:{ticker}", {"ticker": ticker})
        if ticker in paper.BENCHMARKS:
            return _flat_series()
        return _flat_series(slope=1.0)

    monkeypatch.setattr(paper, "_series", series)
    return series


def test_mark_does_not_deadlock_when_price_fetch_writes_to_the_db(caching_prices):
    """mark() must not hold a write txn open across the price fetch."""
    paper.open_run(scan_fn=_scan, run_date=RUN_DATE)
    # Before the fix this raised sqlite3.OperationalError: database is locked.
    res = paper.mark(today="2026-03-02")
    assert res["filled"] > 0, "entries should be filled once prices resolve"
    assert res["skipped"] == 0


def test_mark_is_still_append_only_after_the_deadlock_fix(caching_prices):
    """Splitting the read/write phases must not let a mark be written twice."""
    paper.open_run(scan_fn=_scan, run_date=RUN_DATE)
    first = paper.mark(today="2026-03-02")
    second = paper.mark(today="2026-03-02")
    assert second["marked"] == 0, "a second mark run must write nothing new"
    assert first["marked"] >= 0


def test_positions_read_before_prices_survive_as_plain_dicts(caching_prices):
    """Rows are detached from the cursor, so closing the connection is safe.

    sqlite3.Row is bound to its connection; mark() now closes that connection
    before the price loop, so the rows must already be plain dicts or the
    loop would fail on a closed cursor.
    """
    paper.open_run(scan_fn=_scan, run_date=RUN_DATE)
    res = paper.mark(today="2026-03-02")
    assert isinstance(res, dict)
