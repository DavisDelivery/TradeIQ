# Phase 4j — Detail panel enrichment (company info + price chart)

Closes the two gaps Chad surfaced from the FLEX detail-panel screenshot:
no company description, no price chart. The panel now reads as "what is
this company → what has the stock done → what's the thesis → what do
the analysts think" instead of jumping straight into analyst output.

See **`briefs/phase-4j-brief.md`** for full rationale + architecture and
**`reports/phase-4j/verification.md`** for the build verification.

## Summary

- **W1** — extend Phase 4h's `shared/ticker-reference.ts` to extract the
  full company info (description, homepage, logo, employees, market cap,
  list date, industry) from the Polygon call it was already making. New
  `getTickerInfo()`; `getTickerName()` keeps its 4h contract. Bumps
  `schemaV` to 3 with a **lazy cache-migration guard** so 4h's
  `{name,fetchedAt}`-only docs are treated as a miss by `getTickerInfo`
  and refetched on first detail-panel open — not all at once during a
  scan. Cached branding URLs are stored raw (no `apiKey=`) — the proxy
  appends the key server-side.

- **W2** — `GET /api/ticker-info?ticker=X` on-demand endpoint serving
  the full company info. **Architectural guardrail (the rule that
  matters):** the description is fetched on-demand, **never** enriched
  onto snapshot picks — a ~500-char description × ~2,000 russell2k
  picks would silently push the snapshot past Firestore's 1 MiB ceiling
  (the same trap 4e-1-infra and 4h had to engineer around). A new
  structural test (`snapshot-pick-no-description.test.ts`) reads the
  `Target` interface and the scan/analyst code and fails if any future
  change re-introduces the field on the pick.

- **W3** — `GET /api/price-history?ticker=X&range=1M|6M|1Y|All` wrapping
  `getDailyBars`. Per-ticker-per-range Firestore cache (`merge:true`)
  refreshed daily — repeat opens of the same panel cost zero Polygon
  calls.

- **W4** — `CompanyInfo` + `PriceChart` components wired into
  `TargetBoardView.jsx` above the existing Thesis block. CompanyInfo
  renders logo (with ticker-monogram fallback) + name + industry +
  description + key facts; PriceChart defaults to a 6M area chart with
  a 1M/6M/1Y/All range toggle and a chart-type button to flip to
  **candlestick** — implemented via a recharts custom shape on a
  `ComposedChart` (wick + body) so **no new runtime dependency** is
  added. Both components stack on phone, expand on `sm:` / `md:` so the
  detail panel uses the wider desktop viewport per Chad's direction.

- **Hotfix (review pass)** — new `netlify/functions/logo.ts` proxies
  Polygon branding images so the API key never reaches the browser.
  `/api/ticker-info` now returns `/api/logo?ticker=X` URLs instead of
  raw Polygon URLs; the proxy appends the key server-side and streams
  the image bytes back. `schemaV` bumped 2 → 3 so any v2 docs with
  key-bearing URLs are invalidated. See the hotfix section in
  `reports/phase-4j/verification.md` for the full rationale.

APP_VERSION 0.18.5-alpha → 0.18.6-alpha. MODEL_VERSION unchanged.

## Verification

```
npx tsc --noEmit       # clean
npm test               # 811 passing (was 746, +65)
npm run build          # clean (one chunk-size advisory, pre-existing)
```

Test delta breakdown:

| Workstream | + tests | File |
|---|---|---|
| W1 | +9 | `netlify/functions/shared/__tests__/ticker-reference.test.ts` |
| W2 endpoint | +9 | `netlify/functions/__tests__/ticker-info.test.ts` |
| W2 guardrail | +3 | `netlify/functions/__tests__/snapshot-pick-no-description.test.ts` |
| W3 endpoint | +16 | `netlify/functions/__tests__/price-history.test.ts` |
| W4 CompanyInfo | +9 | `src/__tests__/CompanyInfo.test.jsx` |
| W4 PriceChart | +8 | `src/__tests__/PriceChart.test.jsx` |
| Hotfix logo proxy | +11 | `netlify/functions/__tests__/logo.test.ts` |

## Live acceptance (post-merge, by the orchestrator)

Per the brief — the sandbox has no outbound network to the deploy.
Open the detail panel for a large-cap (FLEX / AAPL) and a thin
small-cap (any russell2k name without a fresh 4h cache entry) and
confirm:

- Description + key facts + logo render, or graceful "unavailable" /
  monogram fallback for tickers Polygon doesn't cover.
- Price chart renders at 6M; range and chart-type toggles both work.
- Layout reads cleanly at phone width AND on desktop — the chart uses
  the wider viewport, not capped at phone width.
- Endpoints respond under 2s, cache-served on a repeat call.

## Known limitations

- "All" range respects Polygon plan history limits (~2003 cutoff on the
  current plan). Documented in the verification report.
- No volume strip below the price chart — flagged as optional in the
  brief; skipped to keep the candlestick implementation tight. Easy
  follow-up if Chad wants it.
- ~~Polygon logo URLs carry the API key in the URL~~ — **resolved in
  the review hotfix.** The key is now appended only on the server-side
  fetch inside `/api/logo`; cache stores raw URLs; client receives
  proxy URLs.
