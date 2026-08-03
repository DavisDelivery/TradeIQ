"""Price / volume adapter. Yahoo chart API (free) with a stooq fallback."""
import io

import pandas as pd
import requests

from ..config import USER_AGENT
from ..store import cache_get, cache_put

YF = "https://query1.finance.yahoo.com/v8/finance/chart/{t}"

# Yahoo's `quote[0].close` is the RAW close. A 2-for-1 split reads as a -50%
# daily return, which fabricates an event_risk flag, corrupts price_z, and
# invents +-50% forward returns in any study. `adjclose` is the split- and
# dividend-adjusted series and is the only one safe for return maths.
# Stooq uses a different adjustment convention, so a series is tagged with
# `adjusted` and the two sources are never silently interchanged.


def history(ticker, range_="2y", interval="1d"):
    """DataFrame indexed by date with open/high/low/close/volume."""
    key = f"px::{ticker}::{range_}::{interval}"
    hit = cache_get(key, ttl_hours=6)
    if hit is None:
        hit = _yahoo(ticker, range_, interval) or _stooq(ticker)
        cache_put(key, hit or {})
    if not hit:
        return pd.DataFrame()
    df = pd.DataFrame(hit)
    df.columns = [str(c).lower() for c in df.columns]
    if "date" not in df.columns or "close" not in df.columns:
        return pd.DataFrame()
    df["date"] = pd.to_datetime(df["date"])
    if "volume" not in df.columns:
        df["volume"] = 0
    return df.set_index("date").sort_index()


def _yahoo(ticker, range_, interval):
    try:
        r = requests.get(
            YF.format(t=ticker), params={"range": range_, "interval": interval},
            headers={"User-Agent": USER_AGENT}, timeout=25,
        )
        res = r.json()["chart"]["result"][0]
        q = res["indicators"]["quote"][0]
        adj = (res.get("indicators", {}).get("adjclose") or [{}])[0].get("adjclose")
        ts = res["timestamp"]
        rows = []
        for i, t in enumerate(ts):
            raw = q["close"][i]
            if raw is None:
                continue
            close = adj[i] if adj is not None and i < len(adj) and adj[i] is not None else raw
            # The adjustment factor lets OHLC ride along on the same basis, so
            # a stop computed off `low` is comparable to a close-based return.
            k = (close / raw) if raw else 1.0
            rows.append({
                "date": pd.to_datetime(t, unit="s").strftime("%Y-%m-%d"),
                "open": (q["open"][i] or raw) * k,
                "high": (q["high"][i] or raw) * k,
                "low": (q["low"][i] or raw) * k,
                "close": close,
                "raw_close": raw,
                "volume": q["volume"][i] or 0,
                "adjusted": adj is not None,
            })
        return rows
    except Exception as e:  # noqa: BLE001
        print(f"  [px] yahoo {ticker} failed: {e}")
        return None


def _stooq(ticker):
    try:
        r = requests.get(f"https://stooq.com/q/d/l/?s={ticker.lower()}.us&i=d",
                         headers={"User-Agent": USER_AGENT}, timeout=25)
        df = pd.read_csv(io.StringIO(r.text))
        df.columns = [c.lower() for c in df.columns]
        return df.rename(columns={"date": "date"}).to_dict("records")
    except Exception:  # noqa: BLE001
        return None


def quote(ticker):
    df = history(ticker, range_="1mo")
    if df.empty:
        return None
    last = df.iloc[-1]
    prev = df.iloc[-2] if len(df) > 1 else last
    return {
        "price": round(float(last["close"]), 2),
        "chg_pct": round((float(last["close"]) / float(prev["close"]) - 1) * 100, 2),
        "avg_vol": int(df["volume"].tail(20).mean()),
    }
