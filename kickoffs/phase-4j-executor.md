# Phase 4j Executor Kickoff — Detail panel enrichment (company description + price chart)

> **For Chad:** paste the bootstrap block at the very end of this file
> as the opening message of a new Claude chat. The GitHub PAT is
> embedded inline; no follow-up message needed.

---

You are an executor agent. Your single assignment is **Phase 4j** of
the TradeIQ project. The conversation you are reading is your boot
prompt. Read it end-to-end, then read `briefs/phase-4j-brief.md` in the
repo (full rationale + architecture), then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. It scans universes of tickers,
scores each through an analyst pipeline, and presents ranked picks. The
stock detail panel currently shows an analyst-agreement radar, a
contributions list, and an attribution chart. Owner: Chad Davis. Stack:
TypeScript Netlify functions + React 18 / Vite SPA + Firestore +
Polygon.

## The problem you're fixing (summary — full detail in the brief)

The detail panel shows *what the analysts think* but nothing about
*what the company is* or *what the stock has done*. Two gaps:
1. **No company description** — no passive "what does this company do."
2. **No price chart** — current price is shown, but not the trend.

## Your assignment in two sentences

Add a company-description + key-facts block (extending Phase 4h's
`ticker-reference.ts` — the Polygon call it already makes returns the
extra fields) and a price chart (wrapping the existing `getDailyBars`),
both surfaced in the detail panel via two new on-demand read endpoints.
Ship as one PR with full tests.

## Chad's settled decisions (FINAL — do not re-litigate)

- **Chart ranges:** default **6M**; toggle **1M / 6M / 1Y / All**.
  "All" = max available daily history.
- **Chart type:** area/line chart default, **plus a toggle button to
  switch to candlestick**. Area chart is the baseline must-have;
  candlestick is a real deliverable (recharts custom shape or
  `lightweight-charts` — your call). If candlestick is a large lift,
  ship the area chart solid and flag candlestick in the hand-off — but
  the intent is both.
- **Company logos:** include them (Polygon `branding.logo_url`, API key
  appended; ticker-monogram fallback when absent).
- **Key facts:** show all — description, industry, employees, market
  cap, IPO/list date, homepage link.
- **Responsive:** the new components must render well on **both phone
  and desktop** — not mobile-locked. (A full desktop layout is a later
  phase; 4j just ensures these components aren't capped at phone width.)

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4j@tradeiq.local"
git config user.name "Executor 4j"

npm ci
npx tsc --noEmit             # must be clean
npm test                     # baseline 746 passing
npm run build                # must complete cleanly

git checkout -b phase-4j-detail-panel-enrichment
```

If baseline fails, STOP and report with exact output.

Read `briefs/phase-4j-brief.md` before writing code — it has the
forensic detail, the architecture guardrail, and the risk register.

**Secrets:** GitHub PAT (write-scoped) in the clone URL — for `git
push` + `POST /pulls`. Live verification is post-merge; the deploy has
Polygon + Firebase configured server-side.

---

# PART 2 — REPO ORIENTATION

## 2.1 What already exists (do NOT rebuild)

- `netlify/functions/shared/ticker-reference.ts` (Phase 4h) — calls
  Polygon `/v3/reference/tickers/{ticker}`, extracts only `name`,
  caches `{name, fetchedAt}` at `tickerReference/{ticker}`. **You
  extend this.**
- `netlify/functions/shared/data-provider.ts` — `getDailyBars(ticker,
  from, to)` hits Polygon `/v2/aggs/.../range/1/day/...`, returns
  `Bar[]`. **You wrap this** for the price-history endpoint.
- `recharts` — already a dependency (radar + attribution charts).
- The detail panel lives in `src/TargetBoardView.jsx`.

## 2.2 Files you ARE allowed to touch

- `netlify/functions/shared/ticker-reference.ts` — extend to full
  company info
- `netlify/functions/ticker-info.ts` — NEW endpoint
- `netlify/functions/price-history.ts` — NEW endpoint
- `src/components/PriceChart.jsx` — NEW
- `src/components/CompanyInfo.jsx` — NEW (or co-locate, your call)
- `src/TargetBoardView.jsx` — wire the two new blocks into the panel
- test files for all of the above
- `package.json` — ONLY if you add `lightweight-charts` for candlestick
- `briefs/phase-4j-pr-description.md` + `reports/phase-4j/verification.md`
  — you create
- `src/App.jsx` — APP_VERSION bump
- `ORCHESTRATOR.md` — mark 4j done at the end

## 2.3 Files you may NOT touch

- `netlify/functions/shared/snapshot-store.ts` and any scan function —
  **the description must NOT be enriched onto snapshot picks** (see the
  guardrail below). Snapshots are out of scope entirely.
- Any analyst / scoring code, `data-provider.ts`'s existing functions
  (you call `getDailyBars`, you don't modify it), backtest code,
  `target-board.ts`
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`

---

# PART 3 — THE WORK (four workstreams, order W1 → W2 → W3 → W4)

## W1 — Extend `ticker-reference.ts`

- Extend `fetchFromPolygon` to extract, in addition to `name`:
  `description`, `homepage_url`, `total_employees`, `market_cap`,
  `list_date`, `sic_description` (→ `industry`), and
  `branding.logo_url` / `branding.icon_url`.
- Extend the `TickerReferenceDoc` schema + the cached document.
- **Cache-migration guard:** Phase 4h docs hold only `{name,
  fetchedAt}`. Add a `schemaV` field; treat a doc with an old/absent
  `schemaV` (or missing `description`) as a cache MISS → refetch.
  Otherwise old entries never gain the new fields.
- Keep `getTickerName` working unchanged (other callers depend on it).
  Add `getTickerInfo(ticker)` returning the full object.

## W2 — `/api/ticker-info` endpoint

- `GET /api/ticker-info?ticker=X` → `{ticker, name, description,
  homepageUrl, logoUrl, employees, marketCap, listDate, industry}`.
- Reads the `tickerReference/{ticker}` cache; fetch + cache on miss.
- **CRITICAL GUARDRAIL:** the description is fetched ON-DEMAND by the
  detail panel via this endpoint. It is **NOT** enriched onto snapshot
  picks — a description paragraph × ~2,000 russell2k picks would push
  the snapshot document past Firestore's 1 MiB ceiling. Do not modify
  the snapshot writer. `name`/`sector` stay on the pick (short);
  `description` is on-demand only.
- The logo URL needs the Polygon API key appended — return a usable
  URL (or proxy it) so the browser can load it without exposing the
  key in client code where avoidable; if the key must be in the URL,
  that matches the existing Polygon-image pattern — acceptable.

## W3 — `/api/price-history` endpoint

- `GET /api/price-history?ticker=X&range=1M|6M|1Y|All` → daily bars
  `[{date, close, open, high, low, volume}]` for the range.
- Wraps `getDailyBars(ticker, from, to)`. Compute `from` from `range`
  (`All` → a far-back date, e.g. 2000-01-01; Polygon returns whatever
  exists, which for a recent IPO is since-listing).
- Cache per ticker per range per day: `priceHistory/{ticker}` keyed by
  range with a date stamp; serve cached if the stamp is today, else
  refetch. Daily bars change once a day.
- Handle empty/sparse results gracefully (delisted/illiquid names).

## W4 — Detail panel UI

- **`CompanyInfo`** — company logo (with ticker-monogram fallback),
  name, industry, description paragraph, key facts (employees, market
  cap, IPO/list date), homepage link. Near the top of the panel.
  Graceful "unavailable" states.
- **`PriceChart`** — default area/line chart of closing price; range
  toggle **1M / 6M / 1Y / All** (default 6M); a **chart-type toggle
  button** to switch to **candlestick** (recharts custom shape or
  `lightweight-charts`). Loading + empty states.
- Wire both into `src/TargetBoardView.jsx`. Match the existing visual
  system (dark theme, emerald `#14e89a`, IBM Plex Mono). **Responsive
  — render well on both phone and desktop**; the chart should use the
  wider viewport on desktop, not be capped at phone width.

---

# PART 4 — TESTS

- `ticker-reference`: cache hit, cache miss → fetch, and the 4h-doc
  migration (old `{name}`-only doc → treated as miss → refetched).
- `/api/ticker-info`: returns full object; cache-served on repeat;
  graceful response for an unknown ticker.
- `/api/price-history`: range→date math for 1M/6M/1Y/All; cache hit
  same-day; empty-result handling.
- Snapshot pick schema UNCHANGED — add a test/assertion that the
  snapshot writer was not modified to carry `description`.
- Component tests for PriceChart (range toggle, type toggle) and
  CompanyInfo (fallback states) as the existing test setup allows.
- Baseline 746; report the real delta, don't pad.

---

# PART 5 — CONVENTIONS

- One commit per workstream + tests + verification report.
- APP_VERSION: `0.18.5-alpha` → `0.18.6-alpha` in `src/App.jsx`.
- MODEL_VERSION unchanged.
- `strict: true` TypeScript; no `any` without an inline reason.
- Don't network in unit tests — mock Polygon + Firestore.
- If you add `lightweight-charts`, pin the version and note it in the
  hand-off.

---

# PART 6 — PR + ACCEPTANCE

```bash
git push -u origin phase-4j-detail-panel-enrichment
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4j - detail panel enrichment (company info + price chart)",
    "head": "phase-4j-detail-panel-enrichment",
    "base": "main",
    "body": "See briefs/phase-4j-brief.md and reports/phase-4j/verification.md. Company description + key facts + logo via extended ticker-reference; price chart (area + candlestick toggle, 1M/6M/1Y/All) via new price-history endpoint. Description served on-demand, never on snapshot picks."
  }'
```

**Open the PR as ready-for-review, NOT a draft.** (A prior phase was
opened as a draft and the merge silently failed on it.) If your tooling
defaults to draft, immediately mark it ready.

Acceptance is verified post-merge by the orchestrator (the sandbox has
no outbound network to the deploy): open the detail panel for a
large-cap and a thin small-cap, confirm description + facts + logo +
price chart render with working toggles and graceful empty states, on
both phone and desktop widths.

---

# PART 7 — HAND-OFF FORMAT

When the PR is mergeable, post one message:

```
PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Change summary:
- W1: ticker-reference.ts extended to full company info + cache-migration guard
- W2: /api/ticker-info endpoint (on-demand; description NOT on picks)
- W3: /api/price-history endpoint (1M/6M/1Y/All, cached per-day)
- W4: CompanyInfo + PriceChart (area + candlestick toggle), responsive,
      wired into the detail panel

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was 746)
- npm run build: clean
- New dependency: <lightweight-charts@x.y.z if added, else "none">

Acceptance: DEFERRED to post-merge (orchestrator opens the panel)

Known limitations:
- <anything worth flagging — e.g. candlestick scope, sparse-history names>
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Enriching the description onto snapshot picks.** This is THE
  guardrail. Description is on-demand via `/api/ticker-info`. Do not
  touch the snapshot writer.
- **Forgetting the 4h cache-migration guard.** Old `{name}`-only docs
  must refetch, or descriptions stay blank forever for cached tickers.
- **Mobile-locking the chart.** It must work on desktop too — Chad is
  moving to desktop use.
- **Letting candlestick balloon the phase.** Area chart is the
  baseline; if candlestick via a custom shape gets deep, consider
  `lightweight-charts`, and if still large, ship area + flag it.
- **Networking in unit tests.** Mock Polygon + Firestore.
- **Opening the PR as a draft.** Ready-for-review.

---

# PART 9 — PARALLEL CONTEXT

4h merged (`c3f822b`); 5a-prep merged (`0b99745`); 4i, 4e-1-infra
merged. The 4h russell2k scan may be running server-side — unrelated to
your work, don't poll it. The 5a discovery agent may be active in
another conversation (Python pipeline files) — disjoint from your
TypeScript/React work. No conflicts expected.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4j of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4j-executor.md — that's your full assignment —
   then read briefs/phase-4j-brief.md for the rationale and architecture.

Everything you need is in those two files: the two gaps, the four
workstreams, Chad's settled decisions (6M default chart with
1M/6M/1Y/All toggle, area chart + candlestick toggle button, company
logos, all key facts, responsive for phone AND desktop), the on-demand
guardrail, the test plan, and the failure modes. Open the PR
ready-for-review, not as a draft. Start with PART 1 once you've read
both end-to-end. ~2-3 hour session.
