"""Paid alt-data adapters.

Each returns {iso_date: value} and degrades to {} when the key is missing, so
the pipeline runs unchanged before and after you subscribe. This is the layer
that actually closes the gap with TickerTrends -- consumer web traffic, app
download estimates, and Amazon sales-rank history are the three feeds that do
most of the work.

Wire-up cost (approximate, check current pricing):
  SimilarWeb  ~ web traffic + engagement per domain
  Sensor Tower / Appfigures ~ app downloads + revenue estimates
  Keepa       ~ Amazon sales-rank & price history  (cheap, high value)
  Apify       ~ TikTok / Instagram hashtag + view counts (pay per run)
"""
import datetime as dt

import requests

from ..config import APIFY_TOKEN, KEEPA_KEY, SENSORTOWER_KEY, SIMILARWEB_KEY, USER_AGENT
from ..store import cache_get, cache_put, save_series

H = {"User-Agent": USER_AGENT}


def _cached(key, fn, ttl=24):
    hit = cache_get(key, ttl_hours=ttl)
    if hit is not None:
        return hit
    try:
        val = fn() or {}
    except Exception as e:  # noqa: BLE001
        print(f"  [paid] {key}: {e}")
        val = {}
    cache_put(key, val)
    return val


def web_traffic(domain, months=12):
    """SimilarWeb monthly visits for a domain."""
    if not SIMILARWEB_KEY:
        return {}
    def go():
        end = dt.date.today().replace(day=1) - dt.timedelta(days=1)
        start = (end.replace(day=1) - dt.timedelta(days=30 * months)).replace(day=1)
        r = requests.get(
            f"https://api.similarweb.com/v1/website/{domain}/total-traffic-and-engagement/visits",
            params={"api_key": SIMILARWEB_KEY, "start_date": start.strftime("%Y-%m"),
                    "end_date": end.strftime("%Y-%m"), "granularity": "monthly",
                    "main_domain_only": "false"},
            headers=H, timeout=30,
        )
        pts = {v["date"]: float(v["visits"]) for v in r.json()["visits"]}
        save_series("similarweb", domain, pts)
        return pts
    return _cached(f"sw::{domain}::{months}", go)


def app_downloads(app_id, os_="ios", days=180):
    """Sensor Tower daily unified download estimates."""
    if not SENSORTOWER_KEY:
        return {}
    def go():
        end = dt.date.today()
        start = end - dt.timedelta(days=days)
        r = requests.get(
            f"https://api.sensortower.com/v1/{os_}/sales_report_estimates",
            params={"auth_token": SENSORTOWER_KEY, "app_ids": app_id,
                    "countries": "US", "date_granularity": "daily",
                    "start_date": start.isoformat(), "end_date": end.isoformat()},
            headers=H, timeout=30,
        )
        pts = {row["d"][:10]: float(row.get("iu", 0)) for row in r.json()}
        save_series("sensortower", app_id, pts)
        return pts
    return _cached(f"st::{app_id}::{os_}::{days}", go)


def amazon_sales_rank(asin, domain=1):
    """Keepa sales-rank history (lower rank = selling more; inverted here)."""
    if not KEEPA_KEY:
        return {}
    def go():
        r = requests.get("https://api.keepa.com/product",
                         params={"key": KEEPA_KEY, "domain": domain, "asin": asin,
                                 "stats": 180, "history": 1},
                         headers=H, timeout=40)
        prod = r.json()["products"][0]
        csv = prod.get("salesRanks") or {}
        series = next(iter(csv.values()), [])
        pts = {}
        for i in range(0, len(series) - 1, 2):
            minutes, rank = series[i], series[i + 1]
            if rank is None or rank < 0:
                continue
            d = (dt.datetime(2011, 1, 1) + dt.timedelta(minutes=minutes)).date().isoformat()
            pts[d] = -float(rank)  # invert so "up" always means "more demand"
        save_series("keepa", asin, pts)
        return pts
    return _cached(f"keepa::{asin}", go)


def tiktok_hashtag(tag):
    """Apify TikTok hashtag scraper -> daily view/post counts."""
    if not APIFY_TOKEN:
        return {}
    def go():
        r = requests.post(
            "https://api.apify.com/v2/acts/clockworks~tiktok-hashtag-scraper/run-sync-get-dataset-items",
            params={"token": APIFY_TOKEN},
            json={"hashtags": [tag], "resultsPerPage": 200},
            timeout=180,
        )
        from collections import Counter
        c = Counter()
        for item in r.json():
            ts = item.get("createTimeISO")
            if ts:
                c[ts[:10]] += int(item.get("playCount") or 1)
        pts = dict(c)
        save_series("tiktok", tag, pts)
        return pts
    return _cached(f"tt::{tag}", go, ttl=24)


def available():
    return {
        "similarweb": bool(SIMILARWEB_KEY),
        "sensortower": bool(SENSORTOWER_KEY),
        "keepa": bool(KEEPA_KEY),
        "apify_tiktok": bool(APIFY_TOKEN),
    }
