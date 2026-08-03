"""Signal maths.

The thesis being operationalised: an edge exists when *consumer* attention is
accelerating, several independent consumer sources agree, and *investor*
attention plus price have not yet responded. Those three ideas become:

    velocity     - z-score of the recent window vs its own trailing baseline
    convergence  - how many independent consumer sources confirm
    saturation   - investor attention / price response, relative to consumer

Composite:  SAS = 100 * sigmoid(w1*consumer_z + w2*(conv-1) - w3*investor_total - w4*price_z)

Low saturation + high consumer velocity = the trade Camillo describes.
High saturation = the trend is already common knowledge; the gap has closed.
"""
import math

import numpy as np
import pandas as pd

W_CONSUMER, W_CONVERGE, W_INVESTOR, W_PRICE = 0.95, 0.45, 0.65, 0.40


Z_CLIP = 2.5          # z-scores beyond this are artefacts, not information
VEL_WEEKS = 4
BASE_WEEKS = 26
MIN_WEEKS = 20
MIN_NONZERO = 0.40    # sparse series (e.g. a thin "XYZ stock" query) are unusable


def _to_series(points):
    """Normalise any source to a weekly mean series.

    Weekly is the common denominator: Google Trends returns weekly at the
    12-month horizon, Wikipedia and Keepa are daily, SimilarWeb is monthly.
    Resampling (rather than interpolating up to daily) avoids the variance
    deflation that would otherwise inflate every z-score.
    """
    if not points:
        return pd.Series(dtype=float)
    s = pd.Series({pd.Timestamp(d): float(v) for d, v in points.items()}).sort_index()
    if len(s) < 4:
        return s
    return s.resample("W").mean().dropna()


def _usable(s):
    if len(s) < MIN_WEEKS:
        return False
    if float((s > 0).mean()) < MIN_NONZERO:
        return False
    return float(s.std()) > 0


def velocity_z(points, vel_weeks=VEL_WEEKS, base_weeks=BASE_WEEKS):
    """How many baseline std-devs above its own baseline the recent window sits.

    Returns None when the series is too short or too sparse to trust -- the
    caller then drops that source rather than scoring noise.
    """
    s = _to_series(points)
    if not _usable(s):
        return None
    recent = s.iloc[-vel_weeks:]
    baseline = s.iloc[-(vel_weeks + base_weeks):-vel_weeks]
    if len(baseline) < 12:
        baseline = s.iloc[:-vel_weeks]
    if len(baseline) < 8:
        return None
    sd = float(baseline.std())
    if sd == 0 or math.isnan(sd):
        return None
    z = float((recent.mean() - baseline.mean()) / sd)
    return max(-Z_CLIP, min(Z_CLIP, z))


def yoy_change(points):
    s = _to_series(points)          # weekly
    if len(s) < 56:
        return None
    now = s.iloc[-4:].mean()
    then = s.iloc[-56:-52].mean()
    if then == 0:
        return None
    return float((now / then - 1) * 100)


def price_signals(px: pd.DataFrame):
    """Price momentum z and volume z -- the 'already priced in' check."""
    if px is None or px.empty or len(px) < 80:
        return {"price_z": 0.0, "vol_z": 0.0, "ret_1m": None, "ret_3m": None,
                "recent_gap_pct": 0.0, "gap_days_ago": None, "event_risk": False}
    ret = px["close"].pct_change()
    r20 = float(px["close"].iloc[-1] / px["close"].iloc[-21] - 1)
    base = ret.rolling(20).sum().iloc[-260:]
    sd = float(base.std()) or 1e-9
    vol = px["volume"]
    vz = float((vol.iloc[-10:].mean() - vol.iloc[-120:].mean()) / (vol.iloc[-120:].std() or 1e-9))
    # Event-risk guard: a large recent single-day gap means the market has
    # already repriced on hard news (usually earnings). Falling price then
    # signals a broken thesis, not an undiscovered one -- the model must not
    # read it as "cheap and unnoticed".
    last10 = ret.iloc[-10:]
    gap = float(last10.abs().max()) if len(last10) else 0.0
    gap_day = int(last10.abs().argmax()) - len(last10) if len(last10) else 0
    gap_dir = float(last10.iloc[int(last10.abs().argmax())]) if len(last10) else 0.0

    return {
        "price_z": float((r20 - float(base.mean())) / sd),
        "vol_z": vz,
        "recent_gap_pct": round(gap_dir * 100, 2),
        "gap_days_ago": abs(gap_day),
        "event_risk": bool(gap >= 0.12),
        "ret_1m": round(r20 * 100, 2),
        "ret_3m": round(float(px["close"].iloc[-1] / px["close"].iloc[-64] - 1) * 100, 2)
        if len(px) > 64 else None,
    }


def sigmoid(x):
    return 1 / (1 + math.exp(-x))


def score_theme(consumer_series: dict, investor_series: dict, px: pd.DataFrame):
    """consumer_series / investor_series: {source_label: {date: value}}"""
    c_z = {k: velocity_z(v) for k, v in consumer_series.items()}
    c_z = {k: v for k, v in c_z.items() if v is not None}
    i_z = {k: velocity_z(v) for k, v in investor_series.items()}
    i_z = {k: v for k, v in i_z.items() if v is not None}

    consumer_z = float(np.mean(list(c_z.values()))) if c_z else 0.0
    investor_z = float(np.mean(list(i_z.values()))) if i_z else 0.0
    convergence = sum(1 for v in c_z.values() if v >= 1.0)

    ps = price_signals(px)
    # A *quiet* investor series is weak evidence -- absence of chatter is the
    # normal state. Only give limited credit downward, full credit upward.
    investor_total = max(-1.0, investor_z) + 0.5 * max(-1.5, ps["vol_z"])

    raw = (W_CONSUMER * consumer_z + W_CONVERGE * (convergence - 1)
           - W_INVESTOR * investor_total - W_PRICE * ps["price_z"])
    sas = 100 * sigmoid(raw)
    # Hard gate: without accelerating consumer attention there is no thesis,
    # however quiet the market is.
    if consumer_z < 0.5 or convergence == 0:
        sas = min(sas, 55.0)
    if not c_z:
        sas = min(sas, 40.0)
    if ps["event_risk"]:
        # the market has just repriced on news; stand down until it settles
        sas = min(sas, 50.0)
    sas = round(sas, 1)

    # saturation: 0 = nobody in the market has noticed, 100 = fully discovered
    sat = round(100 * sigmoid(0.9 * investor_total + 0.7 * ps["price_z"]
                              - 0.3 * consumer_z), 1)

    yoy = {k: yoy_change(v) for k, v in consumer_series.items()}
    yoy = {k: round(v, 1) for k, v in yoy.items() if v is not None}

    return {
        "sas": sas,
        "saturation": sat,
        "consumer_z": round(consumer_z, 2),
        "investor_z": round(investor_z, 2),
        "convergence": convergence,
        "sources_used": len(c_z),
        "source_z": {k: round(v, 2) for k, v in c_z.items()},
        "investor_source_z": {k: round(v, 2) for k, v in i_z.items()},
        "yoy_pct": yoy,
        **ps,
        "price_z": round(ps["price_z"], 2),
        "vol_z": round(ps["vol_z"], 2),
    }


def classify(row):
    """Turn scores into the action language of the strategy."""
    if row.get("event_risk"):
        return f"EVENT RISK — {row.get('recent_gap_pct')}% gap {row.get('gap_days_ago')}d ago"
    if row["sas"] >= 70 and row["convergence"] >= 2 and row["saturation"] <= 45:
        return "EARLY — candidate entry"
    if row["sas"] >= 60 and row["saturation"] <= 60:
        return "BUILDING — watch for confirmation"
    if row["saturation"] >= 70:
        return "CROWDED — gap likely closed"
    if row["consumer_z"] <= -0.75:
        return "DECAYING — exit / avoid"
    return "NEUTRAL"


def position_size(row, equity, max_risk_pct=1.0, stop_pct=18.0):
    """Risk-first sizing: never risk more than max_risk_pct of equity per idea,
    scaled by conviction (SAS). Camillo concentrates; this keeps it survivable."""
    conviction = max(0.0, min(1.0, (row["sas"] - 55) / 35))
    risk_dollars = equity * (max_risk_pct / 100) * conviction
    notional = risk_dollars / (stop_pct / 100) if stop_pct else 0
    return {
        "conviction": round(conviction, 2),
        "risk_dollars": round(risk_dollars, 2),
        "notional": round(min(notional, equity * 0.10), 2),  # hard 10% cap per name
        "stop_pct": stop_pct,
    }
