# TradeIQ v0.2.0-alpha — Merged Deploy Guide

## What's in this build

### Backend functions (9 total — v1 recovered + v2 new)
- `/api/target-board` — 7-analyst composite ranking across core watchlist
- `/api/engine-test?ticker=X` — single-ticker deep dive with per-analyst breakdown
- `/api/earnings-board` — upcoming 14-day earnings with IVR proxy + expected move
- `/api/options-flow` — volume/vol-regime unusual activity scanner (proxy until TradeStation)
- `/api/backtest` — historical forward-return signal validation
- `/api/research?ticker=X` — Claude Sonnet research brief with 30-min cache
- `/api/health` — env var / service status
- `/api/williams-board?index=sp500&side=both` — Larry Williams setups (NEW)
- `/api/lynch-board?index=sp500` — Peter Lynch GARP picks (NEW)

### Frontend
- All v1 views preserved: Target Board, Earnings, Options Flow, Engine Test, Backtest, Regime, Analysts, Alerts, Settings
- Two new tabs: **Williams** and **Lynch** — in both desktop top bar and mobile bottom nav
- App version 0.2.0-alpha

### Universe
- 380+ tickers deduped across S&P 500, Nasdaq 100, DJIA, top 250 Russell 2000
- Each tagged with index membership for filtering

## Required env vars (already set on tradeiq-alpha.netlify.app)
- `POLYGON_API_KEY` ✓
- `FINNHUB_API_KEY` ✓
- `FRED_API_KEY` ✓
- `ANTHROPIC_API_KEY` ✓

## Deploy to main tradeiq-alpha site (replaces v1 completely)

On Mac in Cowork:

```bash
cd ~/Desktop
rm -rf tradeiq-merged
unzip ~/Downloads/tradeiq-v0.2.0-merged.zip -d tradeiq-merged
cd tradeiq-merged
npm install
npm run build
netlify deploy --prod --dir=dist --site=8e90d525-78f3-4288-9c15-8b1968e994c1 --functions=netlify/functions
```

## Rollback (if something breaks)
From Netlify dashboard → Deploys → find `69e7ff554f31016c5699b647` → Publish deploy.

## Build verified
- `npm run build` → 660 KB bundle (clean)
- `npx tsc --noEmit` → zero errors across all 20 backend TypeScript files
