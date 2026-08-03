#!/usr/bin/env python3
"""Trade IQ web server.

    python3 app.py            -> http://localhost:8000

Serves the dashboard and exposes a small JSON API so the scan can be
triggered without touching the shell.
"""
import json
import threading

from flask import Flask, jsonify, request, send_from_directory

from tradeiq import broker, universe
from tradeiq.config import OUT_DIR
from tradeiq.pipeline import scan

app = Flask(__name__, static_folder=None)
_lock = threading.Lock()


def _read(name):
    p = OUT_DIR / name
    return json.loads(p.read_text()) if p.exists() else None


@app.get("/")
def index():
    if not (OUT_DIR / "dashboard.html").exists():
        return "Run `python3 -m tradeiq.pipeline && python3 build_dashboard.py` first.", 404
    return send_from_directory(OUT_DIR, "dashboard.html")


@app.get("/api/signals")
def api_signals():
    return jsonify(_read("signals.json") or {})


@app.get("/api/backtest")
def api_backtest():
    return jsonify(_read("backtest.json") or {})


@app.get("/api/tickets")
def api_tickets():
    return jsonify(_read("tickets.json") or {})


@app.get("/api/universe")
def api_universe():
    return jsonify(universe.load())


@app.post("/api/universe")
def api_add_theme():
    universe.add_theme(**request.get_json(force=True))
    return jsonify({"ok": True, "count": len(universe.load())})


@app.post("/api/scan")
def api_scan():
    if not _lock.acquire(blocking=False):
        return jsonify({"error": "scan already running"}), 409
    try:
        equity = float(request.args.get("equity", 25000))
        sig = scan(equity=equity, verbose=False)
        tk = broker.build_tickets(sig["rows"], equity)
        import build_dashboard
        build_dashboard.main()
        return jsonify({"ok": True, "themes": len(sig["rows"]),
                        "tickets": len(tk["tickets"])})
    finally:
        _lock.release()


@app.post("/api/exits")
def api_exits():
    """POST [{"ticker":"BROS","qty":21,"cost":66.16}] -> hold/exit verdicts."""
    sig = _read("signals.json") or {"rows": []}
    return jsonify(broker.exit_checks(request.get_json(force=True), sig["rows"]))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=False)
