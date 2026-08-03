"""Trade IQ configuration."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_DIR = ROOT / "out"
DB_PATH = DATA_DIR / "tradeiq.db"
DATA_DIR.mkdir(exist_ok=True)
OUT_DIR.mkdir(exist_ok=True)

USER_AGENT = os.environ.get(
    "TRADEIQ_UA", "tradeiq-research/1.0 (contact: chadwickblyth@gmail.com)"
)

# ---- Paid feed credentials (optional; adapters degrade gracefully) ----
SIMILARWEB_KEY = os.environ.get("SIMILARWEB_API_KEY")
SENSORTOWER_KEY = os.environ.get("SENSORTOWER_API_KEY")
KEEPA_KEY = os.environ.get("KEEPA_API_KEY")          # Amazon sales rank history
APIFY_TOKEN = os.environ.get("APIFY_TOKEN")           # TikTok / Instagram scrapers
REDDIT_CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")

# ---- Signal parameters ----
BASELINE_DAYS = 90      # lookback window for z-score baseline
VELOCITY_DAYS = 14      # recent window measured against baseline
MIN_CONVERGENCE = 2     # independent sources that must confirm
CACHE_TTL_HOURS = 12
