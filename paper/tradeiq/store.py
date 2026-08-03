"""SQLite cache + signal store."""
import json
import sqlite3
import time
from contextlib import contextmanager

from .config import CACHE_TTL_HOURS, DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    fetched_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS series (
    source TEXT, entity TEXT, date TEXT, value REAL,
    PRIMARY KEY (source, entity, date)
);
CREATE TABLE IF NOT EXISTS signals (
    run_date TEXT, ticker TEXT, theme TEXT, payload TEXT,
    PRIMARY KEY (run_date, ticker, theme)
);
"""


@contextmanager
def conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        c.executescript(SCHEMA)
        yield c
        c.commit()
    finally:
        c.close()


def cache_get(key, ttl_hours=CACHE_TTL_HOURS):
    with conn() as c:
        row = c.execute("SELECT payload, fetched_at FROM cache WHERE key=?", (key,)).fetchone()
    if not row:
        return None
    if time.time() - row["fetched_at"] > ttl_hours * 3600:
        return None
    return json.loads(row["payload"])


def cache_put(key, payload):
    with conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO cache(key,payload,fetched_at) VALUES (?,?,?)",
            (key, json.dumps(payload), time.time()),
        )


def save_series(source, entity, points):
    """points: dict of ISO-date -> value"""
    with conn() as c:
        c.executemany(
            "INSERT OR REPLACE INTO series(source,entity,date,value) VALUES (?,?,?,?)",
            [(source, entity, d, float(v)) for d, v in points.items()],
        )


def save_signals(run_date, rows):
    with conn() as c:
        c.executemany(
            "INSERT OR REPLACE INTO signals(run_date,ticker,theme,payload) VALUES (?,?,?,?)",
            [(run_date, r["ticker"], r["theme"], json.dumps(r)) for r in rows],
        )


def load_signals(run_date):
    with conn() as c:
        rows = c.execute("SELECT payload FROM signals WHERE run_date=?", (run_date,)).fetchall()
    return [json.loads(r["payload"]) for r in rows]
