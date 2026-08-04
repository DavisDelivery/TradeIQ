"""Forward paper-tracking — the only evidence source that can settle this.

Every retrospective number this project produced was contaminated: the
universe was hindsight-selected, Google Trends renormalises to the window you
request, entry landed inside the signal week, and the headline cohort split
turned out to be a null-to-zero coercion. Corrected, the edge was ~0.

Forward tracking is immune to all of that, for one reason: the signal is
written down BEFORE the outcome exists. This module's whole job is to protect
that property, so its design is defensive rather than clever:

  APPEND-ONLY          Rows are inserted, never updated or deleted. A mark
                       is written once, when its horizon matures, and is
                       never recomputed. If the scoring code changes
                       tomorrow, yesterday's positions keep yesterday's
                       scores.

  FROZEN INPUTS        Every position stores the full scored row as JSON
                       plus a SHA-256 of it. You can always prove what the
                       system actually saw at entry, not what today's code
                       would have produced.

  RANDOM CONTROL       For every signal position, K controls are drawn from
                       the same universe on the same date with a seeded RNG.
                       This is non-negotiable. Without it the experiment
                       answers "did consumer discretionary go up", which is
                       not the question.

  NO LOOK-AHEAD        A position enters at the close of the first session
                       AFTER the scan, and marks only once the horizon date
                       has actually passed.

  OBSERVE, DON'T TRADE Themes proposed by discovery run through
                       `log_observation` and never open a position, so a
                       discovery track record accrues uncontaminated.

Usage:
    python -m tradeiq.paper open        # scan, snapshot, open signal+control
    python -m tradeiq.paper mark        # mark matured horizons
    python -m tradeiq.paper report      # cohort comparison, clustered stats
    python -m tradeiq.paper status      # what's open, what's pending

Run `open` daily (or weekly) and `mark` daily. Six months of that is worth
more than anything else in this repo.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import random
import sqlite3
import sys
from contextlib import contextmanager

import numpy as np
import pandas as pd

from . import broker, universe
from .config import DB_PATH, OUT_DIR
from .sources import prices

# Trading-day offsets. Marks are taken at the close of the Nth session after
# entry, not N calendar days later.
HORIZONS = {"1w": 5, "4w": 20, "12w": 60, "26w": 130}


class DegradedScan(RuntimeError):
    """Raised when the day's data is too thin to record as a real run."""

BENCHMARKS = ("SPY", "XLY")   # broad market, and consumer discretionary
CONTROLS_PER_SIGNAL = 3
SEED_SALT = "tradeiq-paper-v1"

SCHEMA = """
CREATE TABLE IF NOT EXISTS paper_runs (
    run_id      TEXT PRIMARY KEY,
    run_date    TEXT NOT NULL,
    opened_at   TEXT NOT NULL,
    equity      REAL NOT NULL,
    params      TEXT NOT NULL,
    scanned     INTEGER NOT NULL,
    signals     INTEGER NOT NULL,
    controls    INTEGER NOT NULL,
    note        TEXT
);
CREATE TABLE IF NOT EXISTS paper_positions (
    position_id  TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL,
    run_date     TEXT NOT NULL,
    cohort       TEXT NOT NULL,          -- 'signal' | 'control'
    ticker       TEXT NOT NULL,
    matched_to   TEXT,                   -- control -> the signal it mirrors
    entry_date   TEXT,                   -- NULL until the next session prices
    entry_px     REAL,
    qty          INTEGER,
    notional     REAL,
    stop_px      REAL,
    target_px    REAL,
    sas          REAL,
    saturation   REAL,
    consumer_z   REAL,
    convergence  INTEGER,
    inputs_hash  TEXT NOT NULL,
    inputs_json  TEXT NOT NULL,
    UNIQUE (run_id, cohort, ticker)
);
CREATE TABLE IF NOT EXISTS paper_marks (
    position_id  TEXT NOT NULL,
    horizon      TEXT NOT NULL,
    mark_date    TEXT NOT NULL,
    marked_at    TEXT NOT NULL,
    px           REAL NOT NULL,
    ret_pct      REAL NOT NULL,
    bench_json   TEXT NOT NULL,          -- {"SPY": {...}, "XLY": {...}}
    PRIMARY KEY (position_id, horizon)
);
CREATE TABLE IF NOT EXISTS paper_observations (
    obs_id     TEXT PRIMARY KEY,
    run_date   TEXT NOT NULL,
    source     TEXT NOT NULL,            -- e.g. 'discovery'
    phrase     TEXT NOT NULL,
    ticker     TEXT,
    payload    TEXT NOT NULL,
    logged_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pos_run ON paper_positions(run_id);
CREATE INDEX IF NOT EXISTS ix_pos_entry ON paper_positions(entry_date);
"""


@contextmanager
def _db():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        c.executescript(SCHEMA)
        yield c
        c.commit()
    finally:
        c.close()


def _hash(obj) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]


def _today() -> str:
    return dt.date.today().isoformat()


def _now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# OPEN — snapshot the scan and start positions
# ---------------------------------------------------------------------------

# A run is refused rather than recorded when the scan is this degraded.
# Google Trends throttles hard (pytrends is archived and trends.google.com's
# robots.txt disallows the path it hits), so a scan on a bad day comes back
# with most themes stripped of consumer data and almost nothing passing the
# gates -- which, after the fact, is indistinguishable from a genuinely quiet
# market. Recording it would fill the forward record with fake quiet days.
MIN_ROWS = 8
MIN_SOURCED_FRACTION = 0.60


def coverage(rows):
    """Fraction of scored themes that actually had consumer data."""
    if not rows:
        return 0.0
    return sum(1 for r in rows if (r.get("sources_used") or 0) > 0) / len(rows)


def open_run(equity=25000, scan_fn=None, run_date=None, seed=None, dry_run=False,
             payload=None, force=False):
    """Score the universe, then open signal and matched control positions.

    Entry price is deliberately left NULL. `mark` fills it from the first
    session strictly after the run date, which is the earliest bar a real
    order could have touched. Writing today's close here would rebuild the
    exact look-ahead that invalidated the backtest.

    `payload` accepts an already-computed scan (e.g. out/signals.json) so a
    flaky upstream fetch and the act of recording a run stay separable.
    """
    run_date = run_date or _today()

    if payload is None:
        from .pipeline import scan as default_scan
        scan_fn = scan_fn or default_scan
        payload = scan_fn(equity=equity, verbose=False)
    rows = payload["rows"]

    cov = coverage(rows)
    if not force and (len(rows) < MIN_ROWS or cov < MIN_SOURCED_FRACTION):
        raise DegradedScan(
            f"refusing to record run {run_date}: {len(rows)} rows, "
            f"{cov:.0%} with consumer data (need >={MIN_ROWS} rows and "
            f">={MIN_SOURCED_FRACTION:.0%}). Re-run when the sources recover, "
            "or pass force=True to record it deliberately."
        )
    ticket_payload = broker.build_tickets(rows, equity)
    tickets = ticket_payload["tickets"]
    signal_tickers = {t["ticker"] for t in tickets}

    # Controls are drawn from names that were SCANNED AND SCORED on the same
    # day but did not pass the gates. Same universe, same date, same data
    # availability -- the only difference is the signal itself.
    pool = sorted({r["ticker"] for r in rows} - signal_tickers)
    rng = random.Random(f"{SEED_SALT}:{seed if seed is not None else run_date}")

    by_ticker = {r["ticker"]: r for r in rows}
    run_id = f"pr_{run_date}_{_hash([run_date, sorted(signal_tickers), equity])}"

    positions = []
    for t in tickets:
        r = by_ticker.get(t["ticker"], {})
        positions.append(_position(run_id, run_date, "signal", t["ticker"], None, r, t))

    # Draw without replacement across the whole run so one unlucky name
    # cannot dominate the control cohort.
    drawn = set()
    for t in tickets:
        choices = [p for p in pool if p not in drawn]
        k = min(CONTROLS_PER_SIGNAL, len(choices))
        for c in rng.sample(choices, k) if k else []:
            drawn.add(c)
            positions.append(
                _position(run_id, run_date, "control", c, t["ticker"], by_ticker.get(c, {}), None)
            )

    if dry_run:
        return {"run_id": run_id, "positions": positions, "scanned": len(rows)}

    with _db() as c:
        c.execute(
            "INSERT OR IGNORE INTO paper_runs"
            "(run_id,run_date,opened_at,equity,params,scanned,signals,controls,note)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (run_id, run_date, _now(), equity,
             json.dumps({"controls_per_signal": CONTROLS_PER_SIGNAL,
                         "horizons": HORIZONS, "benchmarks": list(BENCHMARKS),
                         "gates": ticket_payload["rules"],
                         "coverage": round(cov, 3)}),
             len(rows), len(tickets), len(positions) - len(tickets),
             None if tickets else "no signal passed the gates; no controls drawn"),
        )
        for p in positions:
            c.execute(
                "INSERT OR IGNORE INTO paper_positions"
                "(position_id,run_id,run_date,cohort,ticker,matched_to,entry_date,entry_px,"
                " qty,notional,stop_px,target_px,sas,saturation,consumer_z,convergence,"
                " inputs_hash,inputs_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                tuple(p[k] for k in (
                    "position_id", "run_id", "run_date", "cohort", "ticker", "matched_to",
                    "entry_date", "entry_px", "qty", "notional", "stop_px", "target_px",
                    "sas", "saturation", "consumer_z", "convergence",
                    "inputs_hash", "inputs_json")),
            )

    return {
        "run_id": run_id, "run_date": run_date, "scanned": len(rows),
        "signals": len(tickets), "controls": len(positions) - len(tickets),
        "signal_tickers": sorted(signal_tickers),
    }


def _position(run_id, run_date, cohort, ticker, matched_to, row, ticket):
    frozen = json.dumps(row, sort_keys=True, default=str)
    return {
        "position_id": f"{run_id}:{cohort}:{ticker}",
        "run_id": run_id, "run_date": run_date, "cohort": cohort,
        "ticker": ticker, "matched_to": matched_to,
        "entry_date": None, "entry_px": None,
        "qty": ticket["qty"] if ticket else None,
        "notional": ticket["notional"] if ticket else None,
        "stop_px": ticket["stop_loss"] if ticket else None,
        "target_px": ticket["take_profit"] if ticket else None,
        "sas": row.get("sas"), "saturation": row.get("saturation"),
        "consumer_z": row.get("consumer_z"), "convergence": row.get("convergence"),
        "inputs_hash": _hash(row), "inputs_json": frozen,
    }


def log_observation(phrase, source="discovery", ticker=None, payload=None, run_date=None):
    """Record a discovery-mode proposal WITHOUT opening a position.

    Discovery multiplies whatever the signal already is. Until the signal is
    shown to be positive, multiplying it only multiplies noise -- but the
    proposals are still worth a timestamped record, so a discovery track
    record exists when it is time to judge it.
    """
    run_date = run_date or _today()
    obs = {"phrase": phrase, "ticker": ticker, "payload": payload or {}}
    with _db() as c:
        c.execute(
            "INSERT OR IGNORE INTO paper_observations"
            "(obs_id,run_date,source,phrase,ticker,payload,logged_at) VALUES (?,?,?,?,?,?,?)",
            (f"ob_{run_date}_{_hash(obs)}", run_date, source, phrase, ticker,
             json.dumps(obs, default=str), _now()),
        )
    return obs


# ---------------------------------------------------------------------------
# MARK — fill entries and write matured horizons, once, forever
# ---------------------------------------------------------------------------

def _series(ticker, range_="2y"):
    df = prices.history(ticker, range_=range_)
    return None if df is None or df.empty else df["close"]


def mark(today=None, verbose=True):
    today = pd.Timestamp(today or _today())
    bench = {b: _series(b) for b in BENCHMARKS}
    bench = {k: v for k, v in bench.items() if v is not None}

    filled, marked, skipped = 0, 0, 0

    # READ the positions, then CLOSE the connection before fetching prices.
    #
    # This used to be one long `with _db()` block with `_series()` called
    # inside the loop. That self-deadlocked: the outer connection holds a
    # write transaction while `_series` -> prices.history -> cache_put opens a
    # SECOND connection to the same file and tries to write, so SQLite raised
    # "database is locked" on the first ticker. Every mark run died there —
    # which is why the ledger had 4 positions and 0 marks.
    #
    # Price fetching is also the slow part (network). Holding a write lock
    # across it would block any concurrent reader for the whole run even if
    # the deadlock were solved another way.
    with _db() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM paper_positions").fetchall()]
        existing = {
            (r["position_id"], r["horizon"])
            for r in c.execute("SELECT position_id, horizon FROM paper_marks").fetchall()
        }

    # Fetch every series with NO database connection open.
    px_cache = {}
    for p in rows:
        if p["ticker"] not in px_cache:
            px_cache[p["ticker"]] = _series(p["ticker"])

    with _db() as c:
        for p in rows:
            close = px_cache[p["ticker"]]
            if close is None:
                skipped += 1
                continue

            entry_date, entry_px = p["entry_date"], p["entry_px"]

            # Fill the entry from the first session STRICTLY AFTER the scan.
            if entry_date is None:
                i = close.index.searchsorted(pd.Timestamp(p["run_date"]) + pd.Timedelta(days=1))
                if i >= len(close):
                    continue                      # market hasn't opened yet
                entry_date = close.index[i].strftime("%Y-%m-%d")
                entry_px = float(close.iloc[i])
                c.execute(
                    "UPDATE paper_positions SET entry_date=?, entry_px=? "
                    "WHERE position_id=? AND entry_date IS NULL",
                    (entry_date, entry_px, p["position_id"]),
                )
                filled += 1

            ei = close.index.searchsorted(pd.Timestamp(entry_date))
            for horizon, n in HORIZONS.items():
                if (p["position_id"], horizon) in existing:
                    continue                      # append-only: never remark
                mi = ei + n
                if mi >= len(close):
                    continue                      # horizon has not matured
                mark_date = close.index[mi]
                if mark_date > today:
                    continue

                px = float(close.iloc[mi])
                ret = (px / entry_px - 1) * 100
                bj = {}
                for name, bs in bench.items():
                    bi = bs.index.searchsorted(pd.Timestamp(entry_date))
                    if bi + n >= len(bs):
                        continue
                    b_ret = (float(bs.iloc[bi + n]) / float(bs.iloc[bi]) - 1) * 100
                    bj[name] = {"ret_pct": round(b_ret, 4),
                                "excess_pp": round(ret - b_ret, 4)}

                c.execute(
                    "INSERT OR IGNORE INTO paper_marks"
                    "(position_id,horizon,mark_date,marked_at,px,ret_pct,bench_json)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (p["position_id"], horizon, mark_date.strftime("%Y-%m-%d"),
                     _now(), px, ret, json.dumps(bj)),
                )
                marked += 1

    if verbose:
        print(f"entries filled {filled} · marks written {marked} · no price data {skipped}")
    return {"filled": filled, "marked": marked, "skipped": skipped}


# ---------------------------------------------------------------------------
# REPORT — signal vs control, with honest error bars
# ---------------------------------------------------------------------------

def _clustered_stats(df, value_col, cluster_col="ticker"):
    """Mean with a ticker-clustered standard error.

    Positions in the same name share a return path, so the naive SE
    understates uncertainty -- the exact error that made the backtest's
    t=1.68 look meaningful when the honest figure was ~0.4.
    """
    n = len(df)
    if n == 0:
        return {"n": 0, "mean": None, "se": None, "t": None, "n_eff": 0, "clusters": 0}
    mean = float(df[value_col].mean())
    groups = df.groupby(cluster_col)[value_col]
    g = groups.count().shape[0]
    if g < 2:
        return {"n": n, "mean": round(mean, 3), "se": None, "t": None,
                "n_eff": g, "clusters": g}
    # Variance of the mean under within-cluster correlation.
    resid = df[value_col] - mean
    cluster_sums = resid.groupby(df[cluster_col]).sum()
    var = float((cluster_sums ** 2).sum()) / (n ** 2) * (g / max(g - 1, 1))
    se = math.sqrt(var) if var > 0 else None
    naive_se = float(df[value_col].std()) / math.sqrt(n) if n > 1 else None
    n_eff = round(n * (naive_se / se) ** 2) if se and naive_se else n
    return {
        "n": n, "mean": round(mean, 3),
        "median": round(float(df[value_col].median()), 3),
        "se": round(se, 3) if se else None,
        "t": round(mean / se, 2) if se else None,
        "win_pct": round(float((df[value_col] > 0).mean() * 100), 1),
        "clusters": g, "n_eff": min(n_eff, n),
    }


def frame():
    """Flatten positions x marks into one tidy DataFrame."""
    with _db() as c:
        pos = pd.read_sql_query("SELECT * FROM paper_positions", c)
        mk = pd.read_sql_query("SELECT * FROM paper_marks", c)
    if pos.empty or mk.empty:
        return pd.DataFrame()
    df = mk.merge(pos, on="position_id", how="inner")
    bench = df["bench_json"].apply(json.loads)
    for b in BENCHMARKS:
        df[f"excess_{b}"] = bench.apply(lambda d, b=b: d.get(b, {}).get("excess_pp"))
    return df


def report(horizon=None, verbose=True):
    df = frame()
    out = {"generated_at": _now(), "horizons": {}}
    if df.empty:
        out["note"] = ("No matured marks yet. This is the expected state until the "
                       "first horizon (1w = 5 sessions) passes.")
        if verbose:
            print(out["note"])
            _print_pending()
        return out

    horizons = [horizon] if horizon else [h for h in HORIZONS if h in set(df["horizon"])]
    for h in horizons:
        sub = df[df["horizon"] == h]
        block = {}
        for b in BENCHMARKS:
            col = f"excess_{b}"
            if col not in sub or sub[col].isna().all():
                continue
            s = sub[(sub.cohort == "signal") & sub[col].notna()]
            k = sub[(sub.cohort == "control") & sub[col].notna()]
            sig = _clustered_stats(s, col)
            ctl = _clustered_stats(k, col)
            diff = (
                round(sig["mean"] - ctl["mean"], 3)
                if sig["mean"] is not None and ctl["mean"] is not None else None
            )
            block[b] = {"signal": sig, "control": ctl, "signal_minus_control_pp": diff}
        out["horizons"][h] = block

    (OUT_DIR / "paper_report.json").write_text(json.dumps(out, indent=2))
    if verbose:
        _print_report(out)
    return out


def _print_report(out):
    print("\nPAPER TRACK — signal vs random control, excess vs benchmark\n")
    for h, block in out["horizons"].items():
        for b, r in block.items():
            s, c = r["signal"], r["control"]
            print(f"  [{h} vs {b}]")
            for name, x in (("signal ", s), ("control", c)):
                if x["n"] == 0:
                    print(f"    {name}  n=0")
                    continue
                print(f"    {name}  n={x['n']:3} ({x['clusters']} names, N_eff {x['n_eff']:3})  "
                      f"mean {x['mean']:+.2f}pp  median {x.get('median', 0):+.2f}  "
                      f"win {x.get('win_pct', 0):.0f}%  t {x['t'] if x['t'] is not None else '—'}")
            print(f"    signal − control: "
                  f"{r['signal_minus_control_pp']:+.2f}pp" if r["signal_minus_control_pp"] is not None
                  else "    signal − control: —")
            print()
    print("  A positive `signal − control` with a clustered t > 2 is the bar.")
    print("  Anything less means the scanner is not beating a coin flip in the same names.\n")


def _print_pending():
    with _db() as c:
        rows = c.execute(
            "SELECT cohort, COUNT(*) n, MIN(run_date) first_run, MAX(run_date) last_run "
            "FROM paper_positions GROUP BY cohort"
        ).fetchall()
    if not rows:
        print("No positions yet — run `python -m tradeiq.paper open`.")
        return
    print("\nOpen positions awaiting maturity:")
    for r in rows:
        print(f"  {r['cohort']:8} {r['n']:4}   runs {r['first_run']} → {r['last_run']}")


def status():
    with _db() as c:
        runs = c.execute("SELECT COUNT(*) n, MIN(run_date) a, MAX(run_date) b FROM paper_runs").fetchone()
        pos = c.execute("SELECT cohort, COUNT(*) n, SUM(entry_date IS NOT NULL) filled "
                        "FROM paper_positions GROUP BY cohort").fetchall()
        marks = c.execute("SELECT horizon, COUNT(*) n FROM paper_marks GROUP BY horizon").fetchall()
        obs = c.execute("SELECT COUNT(*) n FROM paper_observations").fetchone()
    print(f"runs        {runs['n']}   {runs['a'] or '—'} → {runs['b'] or '—'}")
    for p in pos:
        print(f"{p['cohort']:12}{p['n']:4} positions ({p['filled']} entered)")
    if marks:
        print("marks       " + "  ".join(f"{m['horizon']}={m['n']}" for m in marks))
    else:
        print("marks       none matured yet")
    print(f"observations {obs['n']}")
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(prog="tradeiq.paper", description=__doc__.split("\n")[0])
    ap.add_argument("command", choices=["open", "mark", "report", "status"])
    ap.add_argument("--equity", type=float, default=25000)
    ap.add_argument("--horizon", choices=list(HORIZONS))
    ap.add_argument("--from-signals", metavar="PATH",
                    help="open the run from an existing signals.json instead of rescanning")
    ap.add_argument("--force", action="store_true",
                    help="record the run even if data coverage is degraded")
    args = ap.parse_args(argv)

    if args.command == "open":
        payload = json.loads(open(args.from_signals).read()) if args.from_signals else None
        try:
            res = open_run(equity=args.equity, payload=payload, force=args.force)
        except DegradedScan as e:
            print(f"SKIPPED: {e}")
            return 2
        print(f"{res['run_id']}: scanned {res['scanned']}, "
              f"{res['signals']} signal ({', '.join(res['signal_tickers']) or 'none'}), "
              f"{res['controls']} control")
    elif args.command == "mark":
        mark()
    elif args.command == "report":
        report(horizon=args.horizon)
    else:
        status()
    return 0


if __name__ == "__main__":
    sys.exit(main())
