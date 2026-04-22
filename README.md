# TradeIQ Alpha v2

Private multi-factor equity analytics platform with Claude-driven portfolio management, analyst arbitration, earnings interpretation, and regime narrative.

## Status

- **Current live (v1):** https://tradeiq-alpha.netlify.app — compiled build only, v0.1.0-alpha
- **This repo (v2):** source-first rebuild, 0.2.0-alpha
- **Netlify site ID:** `8e90d525-78f3-4288-9c15-8b1968e994c1`

## Why v2 exists

v1 was built inside a Claude sandbox that was wiped before source was committed. The live site runs from a compiled build we can't edit. v2 is a full source-first rebuild committed to this repo from commit #1 so it survives sandbox wipes, can be iterated, and can be meaningfully improved.

v2 also addresses the known weaknesses of v1:
- **Alpha was only +1.4% vs SPY** (A-tier longs were +3.2%, shorts dragged at -3%)
- **AI involvement was light** — just news-sentiment analyst and a research brief endpoint
- **Backtest was not robust** — no position sizing, no transaction costs, no walk-forward discipline, no regime gating

## What's new in v2

### 1. Deeper AI

Four new Claude-driven synthesis modules sit ON TOP of the existing analyst layer:

| Module | Model | What it does |
|---|---|---|
| **Claude-as-PM** (`/api/claude-pm`) | Opus 4.7 | Reads the full target board + regime, picks 3-7 final trades with sizing, thesis, risks, invalidation. This is the single biggest AI differentiator. |
| **Arbitrator** (`/api/arbitrator`) | Sonnet 4.6 | Resolves conflicts when analysts disagree. Weighted judgment instead of averaging. |
| **Earnings Interpreter** (`/api/earnings-interpreter`) | Sonnet 4.6 | Reads full earnings call transcripts. Extracts tone, specificity, analyst pushback, unsaid things. |
| **Regime Narrative** (`/api/regime-narrative`) | Sonnet 4.6 | Daily macro narrative. Can override mechanical regime rule in borderline cases. |

### 2. Alpha lift

- **Shorts off by default** — v1 shorts were -3% alpha; toggled off until the short logic is fixed
- **Position sizing** — equal-weight, vol-target, and fractional-Kelly options
- **Regime-gated exposure** — gross exposure scales with regime (risk_on 100%, neutral 70%, risk_off 40%)
- **Tier discipline** — default to A-only; A+B and all-tiers are selectable
- **Transaction costs & slippage** — modeled explicitly (default 5bps + 2bps)
- **Conflict filtering** — severe-conflict candidates auto-skipped

### 3. Robustness

- **Backtest engine with pluggable data hooks** — swap in real historical price/board data via `getPriceSeries` / `getBoardSnapshot` functions
- **Summary stats** — total alpha, Sharpe, max drawdown, win rate, alpha-by-tier, alpha-by-side, alpha-by-score-bucket
- **Walk-forward structure** — train window, test window, roll (skeleton in place, ready to extend)
- **Schema typed end-to-end** — `types.ts` defines every wire contract

## Repo layout

```
tradeiq-alpha/
├── package.json                 # workspace root, deploy script
├── netlify.toml                 # relative-path config (no sandbox absolutes)
├── .gitignore
├── README.md
├── SPEC.md                      # detailed architecture per track
└── app/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx              # bottom-nav shell
        └── views/
            ├── BoardView.jsx
            ├── PMDecisionView.jsx   # Claude-as-PM UI
            ├── BacktestView.jsx     # 4 charts + config panel + trades table
            └── RegimeView.jsx       # Claude regime narrative
    └── netlify/
        └── functions/
            ├── health.ts
            ├── target-board.ts
            ├── research.ts
            ├── shared/
            │   ├── types.ts     # all wire contracts
            │   ├── claude.ts    # Anthropic SDK wrapper w/ retry + JSON parsing
            │   └── blobs.ts     # Netlify Blobs wrapper
            ├── synthesis/
            │   ├── claude-pm.ts         # FLAGSHIP AI: Claude as PM
            │   ├── arbitrator.ts        # AI: analyst conflict resolution
            │   └── regime-narrative.ts  # AI: daily macro narrative
            ├── analysts/
            │   └── earnings-interpreter.ts  # AI: transcript reader
            ├── backtest/
            │   └── engine.ts    # v2 engine w/ sizing, costs, regime gating
            └── ingest/          # (reserved for data ingestion functions)
```

## Deploy

### Environment variables (set in Netlify dashboard)

Required:
- `ANTHROPIC_API_KEY` — for all AI modules

Optional (for future data ingestion):
- `POLYGON_API_KEY`
- `FINNHUB_API_KEY`

### First deploy

```bash
cd app
npm ci
npm run build
# From repo root, Netlify linked:
netlify deploy --prod --dir=app/dist --site=8e90d525-78f3-4288-9c15-8b1968e994c1
```

Or let Netlify auto-deploy once you connect this GitHub repo to the site.

## Roadmap — remaining work by session

### Session 1 (done — this session)
- ✅ Repo scaffold
- ✅ Shared types + Claude/Blobs wrappers
- ✅ Claude-as-PM module (full prompt engineering)
- ✅ Arbitrator module
- ✅ Earnings interpreter module
- ✅ Regime narrative module
- ✅ Backtest engine v2 (control flow + sizing + costs)
- ✅ Frontend shell + all 4 views
- ✅ Research endpoint

### Session 2 (next — data wiring)
- Wire historical market data (Polygon or similar) for backtest
- Wire the 6 mechanical analysts (technical, sector-rotation, fundamental, flow, news, earnings)
- Wire target-board generation pipeline with real tickers
- Run backtest with actual data and measure real v2 alpha

### Session 3 (validation)
- Walk-forward backtest discipline (train 2023, test 2024, train 2023+2024, test 2025, etc.)
- Monte Carlo on trade sequences
- Real paper-trading mode with live data (no capital)

### Session 4 (polish)
- Cost dashboards (Claude API spend per day)
- Alerting for regime changes, PM selection shifts
- PDF daily report export

## Known v2 gaps (deliberate)

- Frontend is minimal by design — function over form this pass. v1's polish can be ported after data is wired.
- `target-board.ts` returns a placeholder payload. Real pipeline wires in Session 2.
- Backtest data hooks (`getPriceSeries`, `getBoardSnapshot`) are stubs. Session 2.
- No authentication yet — the site is otherwise only discoverable by URL.

## Contributing / continuing

Future Claude sessions:
1. `git clone` this repo into `/home/claude/tradeiq`
2. Read this README + SPEC.md
3. Branch, commit incrementally, push before session ends — do NOT repeat the v1 sandbox-wipe loss
4. If deploying, use the site ID above via Netlify MCP, not direct tokens

## License

Private. All rights reserved.
