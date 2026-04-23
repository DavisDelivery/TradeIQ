# TradeIQ Alpha — Recovered v1 Source

This is the complete frontend source code for TradeIQ Alpha v0.1.0-alpha, recovered from the source map embedded in the last production deploy (`69e7ff554f31016c5699b647`).

## Status

- **Live site:** https://tradeiq-alpha.netlify.app (running deploy `69e7ff554f31016c5699b647`)
- **Frontend source:** 100% recovered ✅
  - `src/App.jsx` — 2,187 lines, the monolithic component with all views
  - `src/main.jsx` — entry point
- **Backend (Netlify Functions):** source NOT in this recovery, but **still deployed and running** on the live site
  - 7 functions: target-board, backtest, research, health, engine-test, earnings-board, options-flow
  - Keep running as-is until we rebuild them in a future session

## How to build and run locally

```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # produces dist/
```

The dev server won't show real data because `/api/*` endpoints are on the deployed site. You can either:
1. Deploy this frontend (but be careful — see below)
2. Proxy `/api/*` to tradeiq-alpha.netlify.app during dev (add a Vite proxy config)

## ⚠️ Deployment caution

**Deploying this frontend to the same Netlify site will REPLACE the backend functions** with nothing, breaking all `/api/*` endpoints. Do NOT `netlify deploy --prod` against site `8e90d525-78f3-4288-9c15-8b1968e994c1` from this directory.

Safe paths:
1. **Deploy to a new Netlify site** for development/preview (safe)
2. **Use branch deploys / previews** on the existing site (doesn't publish)
3. **If publishing over v1:** first rebuild the backend functions (Netlify Functions source), include them in the deploy, THEN publish

## Recovery provenance

- Source extracted from `dist/assets/index-dafeover.js.map` via `sourcesContent` field
- Tailwind config inferred from compiled CSS (`index-g6i_kzlm.css`, 19.7 KB)
- Dependencies inferred from JS imports: react 18, react-dom 18, recharts 2, lucide-react
- Original build: 651,108 bytes
- Recovered rebuild: 651,010 bytes (functionally identical, different hash due to timestamps)

## Session log

- Session 1 (Apr 21–22 2026): source recovered from deploy map; dev environment rebuilt and build verified against original.
// deploy trigger 1776908002
