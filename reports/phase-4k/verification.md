# Phase 4k — verification report

**Branch:** `phase-4k-desktop-layout`
**APP_VERSION:** `0.19.0-alpha` (bumped from `0.18.9-alpha` on `main`)
**MODEL_VERSION:** unchanged
**New runtime dependency:** none — frontend-only, layout-only.
**Live acceptance:** deferred to orchestrator post-merge. The executor
sandbox can build and unit-test, but cannot verify the docked detail
panel and the dense tables in a real browser at both phone and desktop
widths. The orchestrator hits the deploy at ~1280px+ and at a phone
width to confirm the breakpoint gate.

---

## Static verification (executor-local)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | clean (vite 5.4.21, ~2.3s; CSS 30.89 → 31.76 kB, JS 968.84 → 978.77 kB) |
| `npm test` baseline (`main`) | 910 passing across 96 files |
| `npm test` after 4k | **923 passing across 98 files (+13 tests, +2 files)** |

### New test files

| File | Tests | Covers |
|---|---|---|
| `src/hooks/__tests__/useBreakpoint.test.jsx` | 6 | Mobile/desktop resolution from a mocked `matchMedia`; the matchMedia query targets `(min-width: 1280px)`; subscribers re-resolve on transitions in both directions; missing-matchMedia fallback returns mobile; explicit symmetry between `isDesktop` and `isMobile`. |
| `src/layout/__tests__/MasterDetail.test.jsx` | 7 | Mobile path renders the list alone (no chrome) when nothing is selected, mounts a full-screen modal when selected; modal backdrop and explicit close button both fire `onClose`. Desktop path renders the split layout (board pane always mounted) and only adds the docked side panel when selected; the desktop close button fires `onClose`. Critically: the desktop path NEVER mounts the modal chrome, and the mobile path NEVER mounts the panel — the breakpoint gate is total. |

### Modified test files

None. The existing 910 tests continue to pass — including
`src/__tests__/InsiderBoardView.test.jsx`, which exercises the table
that 4k W3 tightened the density on. Density is a class-name change,
not a structural one, so the existing selectors (`tbody td.font-serif`,
column header buttons by name) keep finding the same elements.

---

## Workstream summary

### W1 — Responsive foundation + persistent desktop sidebar

`src/hooks/useBreakpoint.js` is the single source of truth for "are we
at desktop width?" `DESKTOP_BREAKPOINT_PX = 1280`, the value Chad
locked in PART X of the brief. Implementation is a `matchMedia`
subscription with three properties that matter for the rest of 4k:

1. **Server / pre-mount default is mobile** — so a first paint that
   beats the layout effect never mis-claims desktop and over-paints a
   sidebar that's about to vanish.
2. **The subscription uses `addEventListener('change', ...)` with a
   Safari `addListener` fallback** — the layout flips live when the
   user resizes across the threshold.
3. **Missing matchMedia returns mobile** — JSDOM (used by the test
   suite) ships without `matchMedia`, so the hook degrades to "mobile
   layout" rather than throwing. That's the safer default for any
   non-browser caller.

The desktop shell is composed of three small layout primitives:

- `src/layout/Sidebar.jsx` — vertical nav list with the logo at the
  top, the same `VIEWS` array the mobile TopBar reads (hoisted out of
  TopBar into App.jsx). Active item gets an emerald left bar +
  emerald-tinted background — consistent with the existing visual
  system.
- `src/layout/DesktopShell.jsx` — flex shell: `<sidebar /> | <top
  strip + main content>`. The top strip slot is sticky so the regime
  ticker stays in view as the board scrolls.
- `src/layout/RegimeStrip.jsx` — the same regime / VIX / 10Y / 2Y10Y /
  universe / clock row that lives inside the mobile TopBar, extracted
  so the desktop top strip can render it without duplicating JSX. The
  mobile TopBar's inline regime row is unchanged (zero mobile DOM
  delta).

App.jsx now forks at the breakpoint:

- At `≥1280px`: `<DesktopShell sidebar={<Sidebar />} topStrip={<RegimeStrip />}>` wraps the
  universe selector + view router + footer.
- At `<1280px`: the pre-4k path — `<TopBar />`, the universe bar, the
  view router, the footer — renders verbatim.

The `UniverseSelector` consumer also branches: at desktop it loses the
`max-w-[1400px]` cap and sits flush against the content padding.

### W2 — Master-detail: detail as a docked side panel (target board)

`src/layout/MasterDetail.jsx` owns the container chrome so consumers
never reinvent it. It takes a `list`, an optional `detailHeader`, a
`detail` body, plus `selected` + `onClose` + `closeLabel`. It renders:

- **Mobile (`!isDesktop`):** the list, and if `selected` is truthy, a
  full-screen modal overlay with a sticky chrome bar (detailHeader +
  X) and the detail body scrolling inside. Identical user model to
  pre-4k.
- **Desktop:** a side-by-side flex layout — board pane + a docked
  `<aside>` that's sticky, max-height-fits-viewport, and scrolls its
  own content. The board pane shrinks (`flex-1`) when the panel
  mounts; it never disappears.

`TargetBoardView.jsx` refactor:

- The old `TargetDetail` modal split into `TargetDetailHeader` (title
  row, badges, price summary, LogButton) and `TargetDetailBody`
  (CompanyInfo, PriceChart, thesis, ResearchPanel, radar +
  contributions, signals, CTAs). Both are container-agnostic —
  identical JSX whether they land inside the modal or inside the
  docked panel. `CompanyInfo` and `PriceChart` were already Phase 4j-
  responsive, so they size up to whichever pane they render in.
- `LiveTargetBoard` now owns the row selection (`useState`) that used
  to live at App.jsx root. It composes `MasterDetail` with the board
  list and the detail slots.
- `App.jsx` drops the root-mounted `<TargetDetail />` and the
  `selectedTarget` state. The dead `TargetDetail` import is removed.

The chrome (backdrop, sticky header, X button) is provided exactly
once, by `MasterDetail`. The Phase 4j header LogButton survives — it
just moves inside the new `TargetDetailHeader` slot.

### W3 — Desktop-density sortable tables

The target board branches in `TargetBoardView.jsx`:

- Mobile: the 1-/2-/3-column card grid — exactly as pre-4k.
- Desktop: a new `TargetTable` component using
  `useSortable`/`SortableTh` for every column: Ticker / Company /
  Sector / Tier / Side / Composite / Price / Chg % / Conflict.
  Default sort is `composite desc` (matches the card-grid sort). The
  selected row gets the same emerald left bar + tinted background
  treatment the docked panel uses for its title chrome — so a glance
  at the table immediately answers "which row populated the panel."

The insider board (`InsiderBoardView.jsx`) is already a table; W3
tightens density at desktop widths:

- Wrapper drops `max-w-[1400px] mx-auto` in favor of flush-left
  `px-6 py-5` so the table breathes into the full content pane.
- Cell vertical padding tightens (`py-2.5` → `py-1.5`) so meaningfully
  more rows fit per screen.
- The top-buyer column gets more truncation budget (`max-w-[180px]` →
  `max-w-[260px]`) to take advantage of the extra horizontal room.
- `overflow-x-auto` drops on desktop — the layout is wide enough that
  the table no longer needs to scroll horizontally.
- Below the breakpoint everything is byte-identical to pre-4k.

The expand-row-to-show-filings behavior is unchanged in both tiers —
no master-detail on the insider board this phase (per the brief, the
master-detail pattern lands on the target board now; the insider
board's row-expand pattern is acceptable for both tiers).

---

## Acceptance check (against brief PART VIII)

| # | Criterion | Status |
|---|-----------|--------|
| 1 | At desktop widths, nav is persistently visible and the board uses the full horizontal space | ✅ in code (Sidebar always mounted ≥1280px; TargetTable/InsiderTable lose narrow caps); live verification deferred |
| 2 | On desktop, selecting a target shows its detail in a docked side panel with the board still visible; selecting another row swaps the panel | ✅ in code (MasterDetail desktop branch; both panes always mount; selection state in LiveTargetBoard); covered by MasterDetail tests |
| 3 | Target and insider boards render as desktop-density tables, every column sortable via `useSortable`/`SortableTh` | ✅ in code (TargetTable uses SortableTh on every column; insider table was already SortableTh and stayed that way) |
| 4 | Mobile layout is unchanged | ✅ at the code level — the desktop branch is gated behind `isDesktop`; the mobile JSX path is verbatim pre-4k except for the small APP_VERSION footer string. The mobile TopBar, the mobile card grid, the mobile-density insider rows, the full-screen modal detail — all unchanged. Live confirmation deferred. |
| 5 | Layout responds cleanly across the breakpoint — no broken intermediate states when resizing | ✅ in code — `useBreakpoint` re-resolves on `matchMedia` change and React swaps the entire shell. Live resize-drag confirmation deferred. |
| 6 | `tsc --noEmit` clean, full test suite green, `npm run build` clean | ✅ |
| 7 | Tests cover the breakpoint hook and the master-detail container's mobile/desktop branching | ✅ — 6 tests for `useBreakpoint`, 7 tests for `MasterDetail` (4 mobile + 3 desktop) |

---

## Files touched

### New (7)
- `src/hooks/useBreakpoint.js` — W1
- `src/hooks/__tests__/useBreakpoint.test.jsx` — W1
- `src/layout/Sidebar.jsx` — W1
- `src/layout/DesktopShell.jsx` — W1
- `src/layout/RegimeStrip.jsx` — W1
- `src/layout/MasterDetail.jsx` — W2
- `src/layout/__tests__/MasterDetail.test.jsx` — W2

### Modified (3)
- `src/App.jsx` — W1 (hoist VIEWS, branch shell on isDesktop, APP_VERSION 0.18.9 → 0.19.0) + W2 (drop root-mounted TargetDetail + selectedTarget state)
- `src/TargetBoardView.jsx` — W2 (LiveTargetBoard owns selection + adopts MasterDetail; TargetDetail split into header/body) + W3 (TargetTable component + isDesktop branching)
- `src/InsiderBoardView.jsx` — W3 (desktop-density padding/width)

### Untouched (per brief PART V "Out of scope" + PART VI ownership split)
- `src/WilliamsView.jsx`, `src/LynchView.jsx` — owned by Phase 4m+4n
- Any `netlify/functions/*` — frontend-only phase
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`
- Visual identity: dark theme, emerald `#14e89a`, IBM Plex Mono — used as-is, not restyled

---

## Known limitations / follow-ups

- **Williams / Lynch / Catalyst / Prophet / Earnings / Options / Engine
  / Backtest / Chart / Regime / Analysts / Alerts / Journal / Settings
  views.** The desktop shell wraps them (sidebar + regime strip), but
  their inner layouts still render at mobile density. Adopting the
  desktop primitives (master-detail where applicable, density tables
  where the data fits) is the natural Phase 4q+ follow-up. The brief
  flagged this explicitly: "4k's layout primitives are reusable; a
  small later pass brings the Williams/Lynch views onto the desktop
  layout once both phases land."
- **Bundle.** The build emits one ~979 kB JS chunk (vs ~969 kB on
  main). The +10 kB is the new layout primitives + TargetTable. The
  pre-existing "chunks larger than 500 kB" warning is unchanged in
  character — no code-splitting work was in scope for 4k.
- **The footer at the bottom of the desktop main pane** is the same
  string as the mobile footer. On a very tall desktop monitor it sits
  far below the fold of the active view; that's intentional (it's a
  footer, not a status bar) but worth flagging in case Chad prefers it
  pinned.
