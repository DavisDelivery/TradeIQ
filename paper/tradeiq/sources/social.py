"""Social chatter adapters.

Reddit's anonymous JSON endpoints are blocked from most cloud IPs, so this
module uses OAuth when REDDIT_CLIENT_ID/SECRET are set and returns empty
otherwise (the pipeline just drops that source from the convergence count).

Reddit matters twice over in a Camillo-style system:
  - r/<consumer subs>   -> consumer attention
  - r/wallstreetbets, r/stocks, r/investing -> INVESTOR saturation
"""
import datetime as dt
from collections import Counter

import requests

from ..config import REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, USER_AGENT
from ..store import cache_get, cache_put, save_series

INVESTOR_SUBS = ["wallstreetbets", "stocks", "investing", "StockMarket", "options"]
_token = {"v": None, "exp": 0}


def _auth():
    import time
    if not (REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET):
        return None
    if _token["v"] and time.time() < _token["exp"]:
        return _token["v"]
    r = requests.post(
        "https://www.reddit.com/api/v1/access_token",
        auth=(REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET),
        data={"grant_type": "client_credentials"},
        headers={"User-Agent": USER_AGENT}, timeout=20,
    )
    r.raise_for_status()
    j = r.json()
    _token["v"] = j["access_token"]
    _token["exp"] = time.time() + j.get("expires_in", 3600) - 60
    return _token["v"]


def mentions(query, subs=None, days=30):
    """Daily mention counts. Empty dict when Reddit creds are absent."""
    key = f"rdt::{query}::{','.join(subs or [])}::{days}::{dt.date.today()}"
    hit = cache_get(key)
    if hit is not None:
        return hit
    tok = _auth()
    if not tok:
        return {}
    counts = Counter()
    targets = subs or ["all"]
    for sub in targets:
        try:
            r = requests.get(
                f"https://oauth.reddit.com/r/{sub}/search",
                params={"q": query, "restrict_sr": sub != "all", "sort": "new",
                        "limit": 100, "t": "month"},
                headers={"Authorization": f"bearer {tok}", "User-Agent": USER_AGENT},
                timeout=25,
            )
            for c in r.json()["data"]["children"]:
                d = dt.datetime.utcfromtimestamp(c["data"]["created_utc"]).date().isoformat()
                counts[d] += 1
        except Exception as e:  # noqa: BLE001
            print(f"  [reddit] r/{sub} {query}: {e}")
    pts = dict(counts)
    if pts:
        save_series("reddit", f"{query}|{','.join(targets)}", pts)
    cache_put(key, pts)
    return pts


def investor_chatter(ticker, days=30):
    """Proxy for how *discovered* a name already is among retail investors."""
    return mentions(ticker, subs=INVESTOR_SUBS, days=days)
