"""Wikipedia pageviews adapter (free).

Used two ways:
  - product/brand article views  -> consumer attention
  - company article views        -> investor/press attention
"""
import datetime as dt

import requests

from ..config import USER_AGENT
from ..store import cache_get, cache_put, save_series

BASE = ("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
        "en.wikipedia/all-access/all-agents/{article}/daily/{start}/{end}")


def pageviews(article, days=400):
    key = f"wiki::{article}::{days}"
    hit = cache_get(key)
    if hit is not None:
        return hit
    end = dt.date.today() - dt.timedelta(days=1)
    start = end - dt.timedelta(days=days)
    url = BASE.format(
        article=article.replace(" ", "_"),
        start=start.strftime("%Y%m%d"),
        end=end.strftime("%Y%m%d"),
    )
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
        if r.status_code != 200:
            cache_put(key, {})
            return {}
        items = r.json().get("items", [])
    except Exception as e:  # noqa: BLE001
        print(f"  [wiki] {article} failed: {e}")
        return {}
    pts = {i["timestamp"][:4] + "-" + i["timestamp"][4:6] + "-" + i["timestamp"][6:8]: float(i["views"])
           for i in items}
    cache_put(key, pts)
    save_series("wikipedia", article, pts)
    return pts


def search_article(term):
    """Resolve a free-text term to the best en.wikipedia article title."""
    key = f"wikisearch::{term}"
    hit = cache_get(key, ttl_hours=24 * 30)
    if hit is not None:
        return hit
    try:
        r = requests.get(
            "https://en.wikipedia.org/w/api.php",
            params={"action": "query", "list": "search", "srsearch": term,
                    "format": "json", "srlimit": 1},
            headers={"User-Agent": USER_AGENT}, timeout=20,
        )
        hits = r.json()["query"]["search"]
        title = hits[0]["title"] if hits else None
    except Exception:  # noqa: BLE001
        title = None
    cache_put(key, title)
    return title
