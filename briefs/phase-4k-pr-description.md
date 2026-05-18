# Phase 4k — Desktop layout / responsive redesign

**Branch:** `phase-4k-desktop-layout`
**APP_VERSION:** `0.18.9-alpha` → `0.19.0-alpha`
**MODEL_VERSION:** unchanged
**Run cost:** zero (frontend-only).

See `briefs/phase-4k-brief.md` and `reports/phase-4k/verification.md`.

---

## What this PR does

TradeIQ was a mobile-first SPA stretched across a desktop monitor: one
narrow column, a full-screen modal for every selected pick, a phone-
density table for the insider board. This PR builds a real desktop
layout that activates at and above 1280px and leaves the mobile
experience exactly as it is today.

Three workstreams, three commits:

### W1 — Responsive foundation + persistent desktop sidebar (`749c18d`)
- `useBreakpoint` hook — single source of truth for "desktop width?",
  matchMedia-backed, defaults to mobile when matchMedia is unavailable
  (so SSR / JSDOM never mis-claim desktop).
- `Sidebar` (persistent vertical nav) + `DesktopShell` (sidebar + top
  strip + main pane) + `RegimeStrip` (regime ticker extracted so the
  desktop top strip and the mobile TopBar can render the same ticker).
- App.jsx forks the shell on the breakpoint. The mobile path — TopBar,
  card grid, full-screen modal — is byte-identical to pre-4k.
- VIEWS hoisted out of TopBar so the mobile horizontal scroller and
  the desktop vertical sidebar share one nav source.
- APP_VERSION bumped to 0.19.0-alpha.

### W2 — Master-detail: detail as a docked side panel (`ee3832b`)
- `MasterDetail` container — branches on the breakpoint: full-screen
  modal on mobile (unchanged), docked side panel on desktop with the
  board still visible beside it (push/resize, not overlay).
- `TargetDetail` split into a container-agnostic header + body. The
  chrome (backdrop, sticky bar, close button) is owned by
  `MasterDetail`.
- `LiveTargetBoard` now owns the row selection (was at App.jsx root)
  and composes `MasterDetail`.

### W3 — Desktop-density sortable tables (`0ddfac5`)
- Target board branches at desktop: a new `TargetTable` (sortable on
  every column: Ticker / Company / Sector / Tier / Side / Composite /
  Price / Chg % / Conflict) replaces the card grid. Selected-row
  highlight matches the docked panel chrome so the user always knows
  which row populated the panel.
- Insider board drops its phone-friendly max-width on desktop and
  tightens row padding so meaningfully more filings fit per screen.
  Below 1280px both boards render exactly as pre-4k.

---

## Chad's settled decisions (PART X)

All three defaults adopted as-is, per the kickoff:

- **Breakpoint:** ~1280px.
- **Desktop nav:** persistent left sidebar.
- **Detail panel:** push/resize (board stays usable beside it).

---

## Verification

- `npx tsc --noEmit` clean
- `npm test` — 923 passing across 98 files (was 910 / 96; +13 / +2
  files — `useBreakpoint.test.jsx` and `MasterDetail.test.jsx`)
- `npm run build` clean (vite 5.4.21, ~2.3s)
- Mobile path inspected end-to-end at the code level — the
  `if (isDesktop)` branch is gated total; the `else` path is the
  pre-4k tree intact (TopBar, card grid, full-screen `TargetDetail`
  modal). Live phone-width confirmation deferred to orchestrator.

Acceptance is deferred to post-merge per PART VII of the brief — the
orchestrator checks both a desktop-width viewport and a phone-width
viewport on the deployed site.

---

## Files

### New (7)
- `src/hooks/useBreakpoint.js`
- `src/hooks/__tests__/useBreakpoint.test.jsx`
- `src/layout/Sidebar.jsx`
- `src/layout/DesktopShell.jsx`
- `src/layout/RegimeStrip.jsx`
- `src/layout/MasterDetail.jsx`
- `src/layout/__tests__/MasterDetail.test.jsx`

### Modified (3)
- `src/App.jsx`
- `src/TargetBoardView.jsx`
- `src/InsiderBoardView.jsx`

### Not touched (per brief PART VI ownership split + PART V scope)
- `src/WilliamsView.jsx`, `src/LynchView.jsx` — Phase 4m+4n is running
  in parallel and owns those views.
- `netlify/functions/*` — frontend-only phase.
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`,
  `netlify.toml`.

---

## Known limitations

- The desktop shell wraps every view, but only the target and insider
  boards (the in-scope ones) got dense-table treatment. Williams /
  Lynch / Prophet / Catalyst / etc. still render at mobile density
  inside the desktop main pane. The brief flagged this as the natural
  follow-up once 4m+4n lands.
- Bundle grows ~10 kB JS / ~1 kB CSS for the new primitives. The pre-
  existing "chunks > 500 kB" warning is unchanged in character.
