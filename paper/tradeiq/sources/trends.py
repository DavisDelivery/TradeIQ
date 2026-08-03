"""Google Trends adapter (free, the backbone of the consumer-interest signal).

Returns daily-or-weekly interest series normalised 0-100 by Google.
Handles the 5-keyword-per-request cap and rate limiting.
"""
import time

import pandas as pd
from pytrends.request import TrendReq

from ..store import cache_get, cache_put, save_series

_SLEEP = 6.0


def _client():
    # NB: do not pass retries/backoff_factor -- pytrends 4.9 uses the urllib3 v1
    # `method_whitelist` kwarg which was removed in urllib3 v2.
    return TrendReq(hl="en-US", tz=0, timeout=(10, 30))


def interest(keywords, timeframe="today 12-m", geo="US"):
    """dict keyword -> {iso_date: value}. Batches of 5, cached."""
    out = {}
    todo = []
    for kw in keywords:
        key = f"gt::{geo}::{timeframe}::{kw}"
        hit = cache_get(key)
        if hit is not None:
            out[kw] = hit
        else:
            todo.append(kw)

    for i in range(0, len(todo), 5):
        batch = todo[i : i + 5]
        df = None
        for attempt in range(4):
            try:
                p = _client()
                p.build_payload(batch, timeframe=timeframe, geo=geo)
                df = p.interest_over_time()
                break
            except Exception as e:  # noqa: BLE001
                wait = _SLEEP * (3 ** attempt) + 5
                if "429" in str(e):
                    wait = 30 * (attempt + 1)
                print(f"  [trends] {batch} attempt {attempt+1} failed ({e}); sleeping {wait:.0f}s")
                time.sleep(wait)
        if df is None:
            continue
        if df is None or df.empty:
            continue
        if "isPartial" in df.columns:
            df = df[~df["isPartial"].astype(bool)] if df["isPartial"].any() else df.drop(columns=["isPartial"])
            df = df.drop(columns=["isPartial"], errors="ignore")
        for kw in batch:
            if kw not in df.columns:
                continue
            pts = {d.strftime("%Y-%m-%d"): float(v) for d, v in df[kw].items()}
            out[kw] = pts
            cache_put(f"gt::{geo}::{timeframe}::{kw}", pts)
            save_series("google_trends", kw, pts)
        time.sleep(_SLEEP)
    return out


def rising_queries(seed, timeframe="today 3-m", geo="US"):
    """Breakout / rising related queries for a seed term -- discovery feed."""
    key = f"gtrq::{geo}::{timeframe}::{seed}"
    hit = cache_get(key)
    if hit is not None:
        return hit
    try:
        p = _client()
        p.build_payload([seed], timeframe=timeframe, geo=geo)
        rel = p.related_queries().get(seed, {}) or {}
        rising = rel.get("rising")
        res = [] if rising is None else rising.to_dict("records")
    except Exception as e:  # noqa: BLE001
        print(f"  [trends] rising({seed}) failed: {e}")
        res = []
    cache_put(key, res)
    time.sleep(_SLEEP)
    return res


def to_frame(series_map):
    return pd.DataFrame(
        {k: pd.Series({pd.Timestamp(d): v for d, v in pts.items()}) for k, pts in series_map.items()}
    ).sort_index()
