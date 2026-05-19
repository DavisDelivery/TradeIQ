# Phase 4q — clickable analyst contribution detail

Makes each analyst CONTRIBUTIONS row in the target-board detail panel
expandable to show WHY it scored what it did — surfacing the
`rationale` + `signals` payload the engine already produces but the
thin `AnalystContribution[]` discards.

See `briefs/phase-4q-brief.md` for the full design and
`kickoffs/phase-4q-executor.md` for the executor brief.

## Summary

- **W1 — Live per-ticker rationale endpoint.**
  New `GET /api/target-rationale?ticker=NVDA` (live-recomputes the
  ten-analyst score for one ticker via `runAnalystsForTicker` and
  returns, per analyst, the full `score / direction / weight /
  confidence / rationale / signals` payload — including the
  `_noData` / `_reason` markers on no-data analysts). New
  `netlify/functions/target-rationale.ts`, matching `[[redirects]]`
  block in `netlify.toml`. Surface-only: re-uses the existing
  `composeTarget` scoring path and stops dropping the per-analyst
  detail. No analyst, composite, or weight changes. **MODEL_VERSION
  unchanged.**

- **W2 — Session-memoized hook + inline accordion UI.**
  New `useTargetRationale(ticker)` (React-Query, `staleTime: Infinity`
  + `gcTime: Infinity` = session-memoized per ticker, no localStorage).
  `AnalystContributions.jsx` extended: each contribution row is now a
  `<button>` with `aria-expanded` that toggles an inline body
  rendering the analyst's rationale and a humanized key/value table of
  its signals. Single fetch per ticker hydrates all ten rows.

- **Honest no-data state.**
  When `signals._noData === true` (or the row's target-level NO DATA
  badge fires before detail resolves), the expanded body renders an
  italic, opacity-60 "No actionable data — `<reason>`" line and skips
  the key/value table — never presenting the fallback 50 as a real
  assessment. This is the MU/Earnings case that motivated the phase.

- **REMOVED rows stay non-expandable** — macro-regime and patent-
  analyst were pulled from the weight table; there is no rationale +
  signals payload behind them.

- **Layout-agnostic.**
  The hook is called from the panel parent (not the individual row)
  so a single fetch hydrates all ten rows for that ticker. Works
  identically inside the mobile detail modal and the Phase 4k desktop
  docked panel (no layout changes — the accordion lives inside the
  existing CONTRIBUTIONS block).

## Architectural notes

- **On-demand path — snapshots stay lean.** The endpoint is the
  preferred path. A ~500-char `rationale` string × structured `signals`
  object × ten analysts × ~50 picks per universe (or ~2k for
  russell2k) is exactly the kind of unbounded inline growth Phase 4u
  fixed inside the Firestore doc-size cap. We do not enrich board
  snapshots with this detail.
- **The redirect block matters.** Without the `[[redirects]]` entry
  in `netlify.toml`, `/api/target-rationale` would 404 in production
  (no `/api/*` wildcard in the SPA's redirects). Added.
- **APP_VERSION:** `0.19.6-alpha` → `0.19.7-alpha`. Surface change;
  MODEL_VERSION unchanged.

## Test plan

- [x] `tsc --noEmit` clean
- [x] `npm test` — **1046 passing (was 1023, +23)**
  - W1: 7 new endpoint contract tests in
    `netlify/functions/__tests__/target-rationale.test.ts`
    (400 / 404 / 500 paths + per-analyst payload + `_noData`
    preservation + cache header).
  - W2 hook: 7 new tests in `src/hooks/__tests__/useTargetRationale.test.jsx`
    (enabled gate, ticker normalization, session memoization, error
    paths).
  - W2 UI: 9 new tests in `src/__tests__/AnalystContributions.test.jsx`
    (mount fires the rationale fetch; LIVE row expands rationale +
    signals key/value table; NO DATA row expands an italic
    "No actionable data — `<reason>`" line; the `no_actionable_data`
    variant of `_reason`; REMOVED rows are non-expandable; signals
    key filtering + humanization + value formatting unit tests).
- [x] `npm run build` clean (+3 kB JS, +0.4 kB CSS).
- [ ] **Post-merge live verification (deferred to orchestrator):**
  open a stock on `https://tradeiq-alpha.netlify.app` — confirm
  contribution rows expand on tap; confirm a stock with a NO DATA
  earnings or news analyst shows the explicit "No actionable data"
  line, not a misleading 50; confirm the accordion works on the
  desktop docked panel (≥1280px) and the mobile detail modal.
