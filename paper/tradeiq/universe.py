"""Theme universe: the trend -> ticker map.

This is the part TickerTrends charges for and the part that is genuinely hard.
A theme bundles the *consumer-side* evidence (what normal people search, watch
and buy) with the *investor-side* evidence (what the market already knows) and
the ticker that would monetise the trend.

Add themes freely -- the pipeline is generic. `discover.py` proposes new ones
from Google Trends breakout queries.
"""
import json
from pathlib import Path

from .config import DATA_DIR

UNIVERSE_PATH = DATA_DIR / "universe.json"

SEED = [
    # ticker, company, theme, consumer keywords, wiki article, extras
    ("CELH", "Celsius Holdings", "Energy drink share shift",
     ["celsius energy drink", "celsius drink"], "Celsius Holdings", {"domain": "celsius.com"}),
    ("ELF", "e.l.f. Beauty", "Mass-market beauty dupes",
     ["elf cosmetics", "elf makeup"], "E.l.f. Beauty", {"domain": "elfcosmetics.com"}),
    ("DUOL", "Duolingo", "Gamified language learning",
     ["duolingo", "duolingo app"], "Duolingo", {"app": "Duolingo", "domain": "duolingo.com"}),
    ("CROX", "Crocs", "Crocs / HeyDude footwear cycle",
     ["crocs", "hey dude shoes"], "Crocs", {"domain": "crocs.com"}),
    ("ONON", "On Holding", "Premium running shoes",
     ["on cloud shoes", "on running"], "On (company)", {"domain": "on-running.com"}),
    ("DECK", "Deckers Brands", "Hoka + UGG demand",
     ["hoka", "ugg boots"], "Deckers Brands", {"domain": "hoka.com"}),
    ("CAVA", "CAVA Group", "Mediterranean fast casual",
     ["cava restaurant", "cava menu"], "Cava (restaurant)", {"domain": "cava.com"}),
    ("SG", "Sweetgreen", "Healthy fast casual",
     ["sweetgreen", "sweetgreen menu"], "Sweetgreen", {"domain": "sweetgreen.com"}),
    ("WING", "Wingstop", "Wingstop unit growth",
     ["wingstop", "wingstop menu"], "Wingstop", {"domain": "wingstop.com"}),
    ("BROS", "Dutch Bros", "Drive-thru coffee expansion",
     ["dutch bros", "dutch bros menu"], "Dutch Bros", {"domain": "dutchbros.com"}),
    ("HIMS", "Hims & Hers", "Telehealth GLP-1 / hair",
     ["hims", "hers weight loss"], "Hims & Hers Health", {"domain": "forhims.com"}),
    ("RBLX", "Roblox", "Youth gaming engagement",
     ["roblox", "roblox codes"], "Roblox", {"app": "Roblox", "domain": "roblox.com"}),
    ("APP", "AppLovin", "Ad-tech / e-commerce ads",
     ["applovin"], "AppLovin", {"domain": "applovin.com"}),
    ("RDDT", "Reddit Inc", "Reddit as a search engine",
     ["reddit"], "Reddit", {"app": "Reddit", "domain": "reddit.com"}),
    ("CHWY", "Chewy", "Online pet spend",
     ["chewy", "chewy pet food"], "Chewy (company)", {"domain": "chewy.com"}),
    ("DKNG", "DraftKings", "Sports betting handle",
     ["draftkings", "sportsbook"], "DraftKings", {"app": "DraftKings", "domain": "draftkings.com"}),
    ("PLNT", "Planet Fitness", "Budget gym membership",
     ["planet fitness"], "Planet Fitness", {"domain": "planetfitness.com"}),
    ("YETI", "YETI Holdings", "Premium drinkware cycle",
     ["yeti cooler", "yeti tumbler"], "Yeti (company)", {"domain": "yeti.com"}),
    ("FIGS", "FIGS Inc", "Premium scrubs",
     ["figs scrubs"], "Figs, Inc.", {"domain": "wearfigs.com"}),
    ("OLPX", "Olaplex", "Hair repair category",
     ["olaplex"], "Olaplex", {"domain": "olaplex.com"}),
    ("TDUP", "ThredUp", "Online resale",
     ["thredup"], "ThredUp", {"domain": "thredup.com"}),
    ("LULU", "Lululemon", "Athleisure demand",
     ["lululemon", "lululemon leggings"], "Lululemon Athletica", {"domain": "lululemon.com"}),
    ("PTON", "Peloton", "Connected fitness",
     ["peloton", "peloton bike"], "Peloton (company)", {"domain": "onepeloton.com"}),
    ("SKX", "Skechers", "Comfort footwear",
     ["skechers"], "Skechers", {"domain": "skechers.com"}),
]


def default_universe():
    themes = []
    for tkr, name, theme, kws, wiki, extra in SEED:
        themes.append({
            "ticker": tkr,
            "company": name,
            "theme": theme,
            "consumer_keywords": kws,
            "wiki_product": wiki,
            "wiki_company": wiki,
            "investor_keywords": [f"{tkr} stock"],
            **extra,
        })
    return themes


def load():
    if UNIVERSE_PATH.exists():
        return json.loads(UNIVERSE_PATH.read_text())
    u = default_universe()
    save(u)
    return u


def save(themes):
    UNIVERSE_PATH.write_text(json.dumps(themes, indent=2))


def add_theme(**kw):
    u = load()
    u.append(kw)
    save(u)
    return u


# ---- SEC ticker resolution for ad-hoc trend -> company linking ----
_sec_cache = None


def resolve_ticker(name):
    """Fuzzy-match a company name to a US ticker using the SEC master list."""
    global _sec_cache
    import difflib

    import requests

    from .config import USER_AGENT
    if _sec_cache is None:
        r = requests.get("https://www.sec.gov/files/company_tickers.json",
                         headers={"User-Agent": USER_AGENT}, timeout=30)
        _sec_cache = {v["title"].lower(): v["ticker"] for v in r.json().values()}
    names = list(_sec_cache)
    m = difflib.get_close_matches(name.lower(), names, n=1, cutoff=0.72)
    return _sec_cache[m[0]] if m else None
