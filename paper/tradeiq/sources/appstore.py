"""Apple App Store free signals: top-chart rank + review velocity.

Free tier gives a daily snapshot only, so ranks accumulate into a history in
the local store. For real rank *history* wire SENSORTOWER_API_KEY (see paid.py).
"""
import datetime as dt

import requests

from ..config import USER_AGENT
from ..store import cache_get, cache_put, save_series

RSS = "https://itunes.apple.com/us/rss/{feed}/limit=200/json"


def top_charts(feed="topfreeapplications"):
    key = f"ios::{feed}::{dt.date.today()}"
    hit = cache_get(key, ttl_hours=6)
    if hit is not None:
        return hit
    try:
        r = requests.get(RSS.format(feed=feed), headers={"User-Agent": USER_AGENT}, timeout=25)
        entries = r.json()["feed"]["entry"]
    except Exception as e:  # noqa: BLE001
        print(f"  [ios] {feed} failed: {e}")
        return {}
    ranks = {}
    today = dt.date.today().isoformat()
    for i, e in enumerate(entries, 1):
        name = e["im:name"]["label"]
        ranks[name] = i
        save_series(f"ios_rank::{feed}", name, {today: float(i)})
    cache_put(key, ranks)
    return ranks


def rank_of(app_name, feed="topfreeapplications"):
    charts = top_charts(feed)
    target = app_name.lower()
    for name, rank in charts.items():
        if target in name.lower():
            return rank
    return None
