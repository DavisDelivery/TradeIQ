"""Order-ticket generation and the execution boundary.

Deliberate design choice: this module NEVER places an order. It emits reviewed
tickets to out/tickets.json. Execution happens through your broker connection
(Robinhood MCP: review_equity_order -> place_equity_order) with a human
confirming each one. If you later want it fully automatic, the only change is
a runner that reads this file -- keep the review step until the backtest
earns your trust.
"""
import datetime as dt
import json

from .config import OUT_DIR
from .scoring import position_size


def build_tickets(signals, equity, max_positions=6, max_risk_pct=1.0,
                  stop_pct=18.0, target_pct=45.0, min_sas=70, max_saturation=45,
                  min_convergence=2, min_dollar_volume=3_000_000):
    """Turn ranked signals into concrete, risk-sized entry tickets."""
    tickets = []
    for r in signals:
        if len(tickets) >= max_positions:
            break
        if r["sas"] < min_sas or r["saturation"] > max_saturation:
            continue
        if r["convergence"] < min_convergence:
            continue
        if r.get("event_risk"):
            continue  # market already repriced on news -- wait for it to settle
        px, vol = r.get("price"), r.get("avg_vol") or 0
        if not px or px * vol < min_dollar_volume:
            continue
        size = position_size(r, equity, max_risk_pct, stop_pct)
        qty = int(size["notional"] // px)
        if qty < 1:
            continue
        tickets.append({
            "ticker": r["ticker"], "company": r["company"], "theme": r["theme"],
            "side": "buy", "type": "limit",
            "qty": qty,
            "limit_price": round(px * 1.005, 2),
            "notional": round(qty * px, 2),
            "stop_loss": round(px * (1 - stop_pct / 100), 2),
            "take_profit": round(px * (1 + target_pct / 100), 2),
            "time_in_force": "gfd",
            "rationale": (f"SAS {r['sas']} | saturation {r['saturation']} | "
                          f"{r['convergence']} sources converging | "
                          f"consumer z {r['consumer_z']} vs investor z {r['investor_z']}"),
            "invalidation": ("Exit if consumer velocity z drops below 0 for 2 consecutive "
                             "weeks, saturation exceeds 70, or stop is hit."),
        })
    payload = {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "equity": equity,
        "rules": {"max_positions": max_positions, "max_risk_pct": max_risk_pct,
                  "stop_pct": stop_pct, "target_pct": target_pct,
                  "min_sas": min_sas, "max_saturation": max_saturation},
        "tickets": tickets,
        "total_notional": round(sum(t["notional"] for t in tickets), 2),
    }
    (OUT_DIR / "tickets.json").write_text(json.dumps(payload, indent=2))
    return payload


def exit_checks(open_positions, signals):
    """Given current holdings, flag which theses have broken."""
    by_ticker = {r["ticker"]: r for r in signals}
    out = []
    for p in open_positions:
        r = by_ticker.get(p["ticker"])
        if not r:
            out.append({**p, "action": "REVIEW", "why": "theme no longer scanned"})
            continue
        why = []
        if r["saturation"] >= 70:
            why.append("saturation >= 70 (gap closed)")
        if r["consumer_z"] <= 0:
            why.append("consumer velocity rolled over")
        if r["sas"] < 45:
            why.append("SAS below 45")
        out.append({**p, "sas": r["sas"], "saturation": r["saturation"],
                    "action": "EXIT" if why else "HOLD",
                    "why": "; ".join(why) or "thesis intact"})
    return out
