# TradeIQ Alpha

A personal trading research stack: regime-aware screening across multiple
analyst styles, an AI-narrated PROPHET ensemble, an earnings-setup board,
chart analysis, a journal, and a backtest harness — all in a single React
SPA on top of TypeScript Netlify Functions.

**Live:** https://tradeiq-alpha.netlify.app
**Owner:** Chad Davis · single-user app
**Roadmap:** see [`ORCHESTRATOR.md`](./ORCHESTRATOR.md) — the source of truth
for what's built, what's next, and where each phase landed. Phase 1
(universe coverage + scheduled snapshots) is live as of v0.9.1-alpha;
Phase 0 (engineering foundation) is reconciled on top in this branch.

## Architecture (one paragraph)

The frontend is a React 18 SPA built with Vite, served from Netlify CDN.
A trade journal syncs through Firebase Firestore (`tradeLog` collection).
Every `/api/*` endpoint is a TypeScript Netlify Function in
`netlify/functions/*.ts`; they pull market data from Polygon (bars),
Finnhub (insider, earnings calendar), FRED (macro), and Quiver (political,
patents, gov contracts), then call Anthropic (Claude Opus 4.7) for the
AI-narrated views (research briefs, PROPHET narratives, chart reads) via
`netlify/functions/shared/anthropic-client.ts`. All Anthropic calls go
through a daily spend cap + circuit breaker backed by Netlify Blobs.

## Local development

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # produces dist/
```

Required env vars (Netlify dashboard already has these in production):

```
ANTHROPIC_API_KEY            # Opus 4.7 access
POLYGON_API_KEY              # bars, news
FINNHUB_API_KEY              # insider, earnings
FRED_API_KEY                 # macro
QUIVER_API_KEY               # political, patents, gov contracts
ANTHROPIC_DAILY_BUDGET_USD   # default 25
SENTRY_DSN                   # optional, errors no-op without it
VITE_SENTRY_DSN              # frontend equivalent
VITE_FIREBASE_API_KEY        # frontend journal sync
VITE_FIREBASE_APP_ID         # frontend journal sync
```

The dev server doesn't run the Netlify functions locally — point `/api/*`
at the deployed site or use `netlify dev` if you have the CLI installed.

## Tests + CI

```bash
npm test              # vitest run (runs both projects)
npm run test:watch    # interactive
npm run coverage      # full coverage report → coverage/
npm run typecheck     # tsc --noEmit
```

Two Vitest projects:

- **functions** (node env): tests under `netlify/functions/**/__tests__/`
- **frontend** (jsdom env): tests under `src/**/*.test.{js,jsx,ts,tsx}`

CI is `.github/workflows/ci.yml`: typecheck + tests + build on every PR
and every push to main. Coverage report uploads as a non-blocking artifact.
A failing test or type error blocks merge once branch protection is enabled.

## Deploy story

Push to `main` → Netlify auto-builds and deploys. After CI green, verify
the live bundle includes the expected `APP_VERSION`:

```bash
curl -sS https://tradeiq-alpha.netlify.app/ \
  | grep -oE 'assets/[^"]*\.js' | head -1 \
  | xargs -I{} curl -sS https://tradeiq-alpha.netlify.app/{} \
  | grep -oE '0\.[0-9]+\.[0-9]+-alpha' | head -1
```

## Conventions

- **APP_VERSION** is bumped in `src/App.jsx` on every user-visible change.
- **Tables** sort via `useSortable` + `SortableTh` (no exceptions).
- **Cache-poisoning rule**: function-level `resultCache` writes are gated
  on `length > 0`. Regression test:
  `netlify/functions/__tests__/cache-poisoning.test.ts`.
- **Brand colour** for Davis Delivery family is `#1e5b92`. TradeIQ stays
  on a neutral dark palette.

## Where things live

```
src/
  App.jsx                  # 2.9k-line monolith with all views (Phase 1 splits this)
  CatalystView.jsx         # other view modules
  ChartView.jsx
  InsiderBoardView.jsx
  JournalView.jsx
  LynchView.jsx
  ProphetView.jsx
  WilliamsView.jsx
  components/              # reusable UI atoms
  lib/                     # validateResponse, useSortable, sentry init
  firebase.js              # CDN-loaded Firebase singleton
  tradeLog.js              # journal sync logic
  test/setup.ts            # jsdom test env setup

netlify/functions/
  *.ts                     # one file = one /api/* endpoint
  __tests__/               # cache-poisoning regression suite + harness
  shared/                  # data providers, regime, prophet layers,
                           # anthropic-budget + anthropic-client,
                           # logger, sentry helpers
  shared/__tests__/        # unit tests for the shared layer

scripts/
  export-firestore.ts      # weekly backup (run by GH Action)
  restore-firestore.ts     # restore drill

docs/
  CI_WORKFLOW.md.template.yml      # CI yaml (PAT scope blocked direct push)
  BACKUP_WORKFLOW.md.template.yml  # weekly backup workflow yaml
```
