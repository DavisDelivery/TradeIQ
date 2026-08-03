"""Event-study backtest: does a consumer-attention spike actually pay?

Method
------
For each theme we pull 5 years of Google Trends (weekly granularity at that
horizon) plus daily prices. At every historical week we recompute the SAME
velocity z-score the live scanner uses, strictly out-of-sample (only data up to
that week), and record forward excess returns vs SPY at 1w / 4w / 12w.

Deliberate conservatism:
  * only data available at signal time is used (no look-ahead)
  * entry at the NEXT week's open-equivalent close, not the signal close
  * returns are measured against SPY over the identical window
  * a 1-week cooldown prevents one long ramp counting as 12 signals

Caveats you should hold onto: Google Trends rescales to the max of the
requested window, the theme universe is chosen with hindsight (survivorship),
and n is small. Treat the output as a sanity check, not a proof.
"""
import datetime as dt
import json

import numpy as np
import pandas as pd

from . import universe
from .config import OUT_DIR
from .scoring import velocity_z
from .sources import prices
from .sources import trends as gt

HORIZONS = {"1w": 5, "4w": 20, "12w": 60}


def _weekly_z(series: pd.Series, i, vel_w=4, base_w=26):
    """z of the last `vel_w` weeks vs the prior `base_w`, using data <= i only."""
    if i < vel_w + base_w:
        return None
    recent = series.iloc[i - vel_w + 1 : i + 1]
    base = series.iloc[i - vel_w - base_w + 1 : i - vel_w + 1]
    sd = float(base.std())
    if sd == 0 or np.isnan(sd):
        return None
    return float((recent.mean() - base.mean()) / sd)


def run(themes=None, z_threshold=1.5, timeframe="today 5-y", cooldown_weeks=4):
    themes = themes or universe.load()
    spy = prices.history("SPY", range_="5y")
    if spy.empty:
        raise RuntimeError("no benchmark data")
    spy_close = spy["close"]

    events, skipped = [], []
    for t in themes:
        kws = t["consumer_keywords"][:2]
        inv_kw = t.get("investor_keywords", [])[:1]
        series_map = gt.interest(kws + inv_kw, timeframe=timeframe)
        cons = [series_map[k] for k in kws if series_map.get(k)]
        if not cons:
            skipped.append(t["ticker"])
            continue
        cons_df = pd.DataFrame({
            k: pd.Series({pd.Timestamp(d): v for d, v in series_map[k].items()})
            for k in kws if series_map.get(k)
        }).sort_index()
        consumer = cons_df.mean(axis=1)
        investor = None
        if inv_kw and series_map.get(inv_kw[0]):
            investor = pd.Series({pd.Timestamp(d): v
                                  for d, v in series_map[inv_kw[0]].items()}).sort_index()

        px = prices.history(t["ticker"], range_="5y")
        if px.empty or len(px) < 300:
            skipped.append(t["ticker"])
            continue
        close = px["close"]

        last_fire = -99
        for i in range(len(consumer)):
            z = _weekly_z(consumer, i)
            if z is None or z < z_threshold:
                continue
            if i - last_fire < cooldown_weeks:
                continue
            iz = _weekly_z(investor, i) if investor is not None else 0.0
            iz = 0.0 if iz is None else iz
            sig_date = consumer.index[i]

            # entry on the first trading day strictly after the signal week
            entry_idx = close.index.searchsorted(sig_date + pd.Timedelta(days=1))
            if entry_idx >= len(close) - max(HORIZONS.values()):
                continue
            last_fire = i
            entry_px = float(close.iloc[entry_idx])
            entry_date = close.index[entry_idx]
            spy_i = spy_close.index.searchsorted(entry_date)
            if spy_i >= len(spy_close) - max(HORIZONS.values()):
                continue
            spy_entry = float(spy_close.iloc[spy_i])

            ev = {"ticker": t["ticker"], "theme": t["theme"],
                  "date": str(entry_date.date()), "z": round(z, 2),
                  "investor_z": round(iz, 2),
                  "low_saturation": bool(iz < z * 0.6)}
            for label, n in HORIZONS.items():
                r = float(close.iloc[entry_idx + n]) / entry_px - 1
                b = float(spy_close.iloc[spy_i + n]) / spy_entry - 1
                ev[f"ret_{label}"] = round(r * 100, 2)
                ev[f"exc_{label}"] = round((r - b) * 100, 2)
            events.append(ev)

    if not events:
        raise RuntimeError("no events generated")
    df = pd.DataFrame(events)

    def stats(sub, label):
        out = {"cohort": label, "n": int(len(sub))}
        for h in HORIZONS:
            e = sub[f"exc_{h}"]
            out[f"mean_exc_{h}"] = round(float(e.mean()), 2)
            out[f"median_exc_{h}"] = round(float(e.median()), 2)
            out[f"winrate_{h}"] = round(float((e > 0).mean() * 100), 1)
            se = float(e.std()) / max(np.sqrt(len(e)), 1)
            out[f"t_{h}"] = round(float(e.mean()) / se, 2) if se else None
        return out

    summary = [
        stats(df, "all signals"),
        stats(df[df.low_saturation], "low investor saturation"),
        stats(df[~df.low_saturation], "high investor saturation"),
        stats(df[df.z >= 2.5], "very strong spike (z>=2.5)"),
    ]
    result = {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "z_threshold": z_threshold, "timeframe": timeframe,
        "themes_tested": len(themes), "themes_skipped": skipped,
        "summary": summary,
        "events": events,
    }
    (OUT_DIR / "backtest.json").write_text(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    r = run()
    print(f"\nEvents: {len(r['events'])}   (skipped: {r['themes_skipped']})\n")
    cols = ["cohort", "n", "mean_exc_4w", "median_exc_4w", "winrate_4w", "t_4w",
            "mean_exc_12w", "winrate_12w", "t_12w"]
    print(pd.DataFrame(r["summary"])[cols].to_string(index=False))
