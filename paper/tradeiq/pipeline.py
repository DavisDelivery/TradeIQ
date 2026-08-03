"""Run the full scan: fetch -> score -> rank -> persist."""
import datetime as dt
import json

from . import universe
from .config import OUT_DIR
from .scoring import classify, position_size, score_theme
from .sources import appstore, paid, prices, social
from .sources import trends as gt
from .sources import wiki
from .store import save_signals


def collect_theme(t, timeframe="today 12-m"):
    """Gather every available consumer + investor series for one theme."""
    consumer, investor = {}, {}

    kw_series = gt.interest(t["consumer_keywords"], timeframe=timeframe)
    for kw, pts in kw_series.items():
        if pts:
            consumer[f"gtrends:{kw}"] = pts

    if t.get("wiki_product"):
        pts = wiki.pageviews(t["wiki_product"])
        if pts:
            consumer[f"wiki:{t['wiki_product']}"] = pts

    if t.get("domain"):
        pts = paid.web_traffic(t["domain"])
        if pts:
            consumer[f"similarweb:{t['domain']}"] = pts
    if t.get("app_id"):
        pts = paid.app_downloads(t["app_id"])
        if pts:
            consumer[f"sensortower:{t['app_id']}"] = pts
    for asin in t.get("asins", []):
        pts = paid.amazon_sales_rank(asin)
        if pts:
            consumer[f"amazon:{asin}"] = pts
    for tag in t.get("tiktok_tags", []):
        pts = paid.tiktok_hashtag(tag)
        if pts:
            consumer[f"tiktok:#{tag}"] = pts

    inv_kw = gt.interest(t.get("investor_keywords", []), timeframe=timeframe)
    for kw, pts in inv_kw.items():
        if pts:
            investor[f"gtrends:{kw}"] = pts
    rdt = social.investor_chatter(t["ticker"])
    if rdt:
        investor[f"reddit_investor:{t['ticker']}"] = rdt

    px = prices.history(t["ticker"], range_="2y")
    return consumer, investor, px


def scan(themes=None, equity=25000, timeframe="today 12-m", verbose=True):
    themes = themes or universe.load()
    rows = []
    ios_rank_snapshot = appstore.top_charts()
    for i, t in enumerate(themes, 1):
        if verbose:
            print(f"[{i}/{len(themes)}] {t['ticker']} — {t['theme']}")
        try:
            consumer, investor, px = collect_theme(t, timeframe)
        except Exception as e:  # noqa: BLE001
            print(f"   !! {t['ticker']} collect failed: {e}")
            continue
        if not consumer:
            print(f"   .. {t['ticker']} no consumer data, skipped")
            continue
        sc = score_theme(consumer, investor, px)
        q = prices.quote(t["ticker"]) or {}
        row = {
            "ticker": t["ticker"], "company": t["company"], "theme": t["theme"],
            "keywords": t["consumer_keywords"],
            **sc,
            "price": q.get("price"), "chg_pct": q.get("chg_pct"),
            "avg_vol": q.get("avg_vol"),
            "ios_rank": next((r for n, r in ios_rank_snapshot.items()
                              if t.get("app", "\0").lower() in n.lower()), None),
        }
        row["action"] = classify(row)
        row["sizing"] = position_size(row, equity)
        rows.append(row)

    rows.sort(key=lambda r: -r["sas"])
    run_date = dt.date.today().isoformat()
    save_signals(run_date, rows)
    payload = {
        "run_date": run_date,
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "equity": equity,
        "paid_feeds": paid.available(),
        "rows": rows,
    }
    (OUT_DIR / "signals.json").write_text(json.dumps(payload, indent=2))
    return payload


if __name__ == "__main__":
    import sys
    eq = float(sys.argv[1]) if len(sys.argv) > 1 else 25000
    out = scan(equity=eq)
    print(f"\nScored {len(out['rows'])} themes -> out/signals.json")
    for r in out["rows"][:10]:
        print(f"  {r['ticker']:6} SAS {r['sas']:5}  sat {r['saturation']:5}  "
              f"conv {r['convergence']}  {r['action']}")
