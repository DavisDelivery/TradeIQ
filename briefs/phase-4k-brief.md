# Phase 4k — Desktop layout / responsive redesign

**Author:** orchestrator (CTO + CFO combined voice — house style)
**Target version:** `~0.19.0-alpha` (a notable feature; agent bumps the
minor — confirm with the existing version on `main` at branch time)
**MODEL_VERSION:** unchanged.
**Dependencies:** none blocking. Phase 4j shipped `CompanyInfo` and
`PriceChart` already built responsive — they carry into the desktop
layout cleanly.
**Parallel-with:** designed to run **alongside Phase 4m+4n**. File
ownership is split so the two phases do not collide — see PART VI.
**Estimated effort:** one executor agent session, ~3–4 hours — a
substantial UI build.

---

## Executive summary — the decision and the ask

TradeIQ was built mobile-first, for Chad working from a phone and a
truck. That was the right call then. But Chad is now also using TradeIQ
on a desktop — and on a desktop the app is just the phone layout
stretched across a wide monitor: a single narrow column, oceans of dead
horizontal space, the stock detail still opening as a full-screen modal
that hides the board behind it.

A desktop is a different instrument. It can show a dense sortable table
and the detail of a selected row *at the same time*. It can keep
navigation permanently visible. It can size a chart for a monitor
instead of a 380px phone. Phase 4k builds that — a real desktop layout
that activates at desktop widths while leaving the mobile experience
exactly as it is today.

This is a frontend-only phase: no new run cost, no LLM tokens, no new
services. Its value is straightforward — TradeIQ becomes a tool Chad
can actually work in on the screen he is increasingly using. Approve.

---

# PART I — THE PROBLEM

Surfaced 2026-05-17 when Chad noted he is moving to desktop use and
asked for a dedicated desktop layout.

TradeIQ is a mobile-first React/Vite SPA. Every layout decision assumes
a narrow viewport:

- **Single-column everything.** Board views are a vertical list; on a
  1920px monitor that is one narrow column flanked by empty space.
- **The detail is a full-screen modal.** Tapping a pick on mobile opens
  the detail panel as an overlay that covers the whole screen — you
  lose sight of the board. On a desktop that is needless: there is room
  to show both.
- **Navigation is mobile-style** (a compact bar / menu) — fine on a
  phone, an underuse of space on a desktop where nav can simply always
  be visible.
- **Tables are phone-density** — few columns, large touch rows. A
  desktop can show more columns and more rows per screen.
- **Charts are phone-width-capped** — the radar, the price chart, the
  attribution chart are all sized for ~380px.

None of this is *broken* — it works. It just wastes the desktop.

---

# PART II — CURRENT-STATE ASSESSMENT (CTO)

- `src/App.jsx` — top-level shell + navigation between boards.
- Board views — `TargetBoardView.jsx`, `InsiderBoardView.jsx`,
  `WilliamsView.jsx`, `LynchView.jsx`, and others.
- The stock detail panel lives within `TargetBoardView.jsx` — radar,
  contributions, attribution, plus `CompanyInfo` and `PriceChart`
  (Phase 4j, already responsive).
- Shared UI: `SortableTh` + `useSortable` (the standard sortable-table
  pattern), `FreshnessPill`, `ResearchPanel`.
- Styling: a dark theme, emerald `#14e89a` accent, IBM Plex Mono.
  **The agent must read `/mnt/skills/public/frontend-design/SKILL.md`**
  and work within the established visual system — 4k changes *layout*,
  not the visual identity.

What is missing is any notion of viewport tier — there is no breakpoint
system, no desktop layout branch, no master-detail container.

---

# PART III — FINANCIAL ANALYSIS (CFO)

Brief, because it is genuinely cheap.

- **Run cost:** zero. 4k is frontend layout — no new API calls, no
  background functions, no Firestore, no LLM/token cost. The bundle
  grows modestly; immaterial.
- **Build cost:** one agent session, ~3–4 hours — a substantial UI
  build, larger than a typical fix but a single session.
- **Value:** TradeIQ becomes usable as a desktop research tool — dense
  tables and a docked detail panel are the difference between
  "evaluating a pick" and "scrolling a phone list on a big screen."
  Directly serves how Chad now works.

No recurring cost to model. Approve.

---

# PART IV — PROPOSED SOLUTION (CTO)

Three workstreams, one PR. Order **W1 → W2 → W3**.

### W1 — Responsive foundation + desktop shell

- A **viewport/breakpoint hook** (e.g. `useBreakpoint` / `useViewport`)
  — a single source of truth for "are we at desktop width." Board
  views and the shell branch on it.
- A **desktop app shell**: at desktop widths, navigation becomes
  **persistently visible** (a left sidebar — see PART X) instead of the
  mobile nav. Below the breakpoint, the existing mobile nav is
  unchanged.
- The breakpoint gate is the contract for the whole phase: **above it,
  the new desktop layout; below it, the mobile layout exactly as it is
  today.** No mobile regression (Risk R1).

### W2 — Master-detail: the detail as a docked side panel

- On desktop, selecting a board row no longer opens a full-screen
  modal. The detail renders in a **docked panel** beside the board —
  board list on the left, selected pick's detail on the right, both
  visible at once. Selecting another row swaps the panel content; the
  board never disappears.
- Build this as a reusable **master-detail container** so the target
  board (and later other boards) plug into it.
- The detail *content* is unchanged — same radar, contributions,
  attribution, `CompanyInfo`, `PriceChart` — only its *container*
  changes (docked panel vs full-screen modal). Charts size up to use
  the panel's width on desktop.
- On mobile, the detail stays a full-screen modal — unchanged.
- Apply the master-detail pattern to the **target board** in this
  phase; the insider board adopts it via W3's density work.

### W3 — Desktop-density board tables

- At desktop widths, the **target** and **insider** boards render as
  denser tables that use the horizontal space — more columns visible
  without horizontal scroll, tighter rows, more rows per screen.
- Continue to use the `SortableTh` + `useSortable` standard — every
  column stays sortable; desktop just shows more of them at once.
- Where a board genuinely benefits from more than one column of cards
  at intermediate widths, that is allowed — but the primary desktop
  form for these data boards is a dense table.
- Mobile board rendering is unchanged.

---

# PART V — ARCHITECTURE DETAIL (CTO)

### One codebase, breakpoint-driven — not a separate desktop app

4k is a **responsive** change. There is no second app, no separate
route tree. Each affected view renders a mobile layout or a desktop
layout based on the W1 breakpoint hook. The mobile code path is left
intact; the desktop path is new and gated.

### The master-detail container

The reusable container owns the desktop split (board pane + detail
pane) and the selection state. On desktop it renders both panes; on
mobile it falls back to "board list, tap opens modal detail." A board
view passes it the list and the detail renderer. This keeps the
desktop/mobile branching in one place rather than scattered through
every view.

### Mobile path is sacred

Chad still works from a phone. Every change is additive behind the
desktop breakpoint. The acceptance criteria explicitly require the
mobile layout to be unchanged (PART VIII).

### Out of scope

- The visual identity (colors, type, the theme) — unchanged; 4k is
  layout only.
- `WilliamsView.jsx` / `LynchView.jsx` — owned by Phase 4m+4n running
  in parallel (PART VI). 4k's layout primitives are reusable; a small
  later pass brings the Williams/Lynch views onto the desktop layout
  once both phases land.
- Any backend, scan, analyst, or backtest code.

---

# PART VI — COORDINATION WITH PHASE 4m+4n (parallel execution)

4k and 4m+4n are designed to run at the same time. File ownership is
split to keep them collision-free:

| Owned by **4k** | Owned by **4m+4n** |
|---|---|
| `src/App.jsx` (shell + nav) | `src/WilliamsView.jsx`, `src/LynchView.jsx` |
| `src/TargetBoardView.jsx`, `src/InsiderBoardView.jsx` | `netlify/functions/styles/*`, `analysts/*`, the backtest engine |
| new layout primitives (breakpoint hook, master-detail container, desktop table) | the Williams/Lynch signal + backtest code |

- 4k does **not** touch the Williams/Lynch views; 4m+4n does **not**
  touch the shell or the target/insider views.
- If both need `src/shared/types.ts` or similar, each keeps its change
  **minimal and additive**.
- 4k builds the desktop layout primitives as reusable pieces; after
  both phases merge, a small follow-up pass adopts them in the
  Williams/Lynch views. That follow-up is noted, not part of 4k.

---

# PART VII — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Desktop work regresses the mobile layout | Medium | Chad's primary device degrades | Every change gated behind the desktop breakpoint; mobile path untouched; acceptance requires verified-unchanged mobile (PART VIII). |
| R2 | Master-detail state (selection) tangles with existing modal state | Medium | Detail panel bugs | The master-detail container owns selection in one place; mobile keeps the existing modal flow. |
| R3 | Merge conflict with 4m+4n | Low | Rework | File ownership split (PART VI); additive-only shared-file changes. |
| R4 | "Desktop" vs "tablet/landscape phone" ambiguity at the breakpoint | Medium | Wrong layout on mid-size screens | A clear breakpoint decision (PART X); mid-size screens resolve to one tier deterministically. |
| R5 | Drift from the visual system | Low–Medium | Inconsistent UI | Read `frontend-design` SKILL.md; reuse existing tokens; 4k is layout, not restyle. |

No cost risk — frontend-only.

---

# PART VIII — ACCEPTANCE CRITERIA

A build passes when **all** hold:

1. At desktop widths, navigation is persistently visible and the board
   views use the full horizontal space (dense tables, no dead column
   of whitespace).
2. On desktop, selecting a target-board pick shows its detail in a
   **docked side panel** with the board still visible; selecting
   another row swaps the panel.
3. The target and insider boards render as desktop-density tables at
   desktop widths, every column still sortable via
   `useSortable`/`SortableTh`.
4. **The mobile layout is unchanged** — at phone widths the app looks
   and behaves exactly as it does today (full-screen modal detail,
   mobile nav, single column). Verified at a phone-width viewport.
5. The layout responds cleanly across the breakpoint — no broken
   intermediate states when resizing.
6. `tsc --noEmit` clean, full test suite green, `npm run build` clean.
7. Tests cover the breakpoint hook and the master-detail container's
   mobile/desktop branching.

---

# PART IX — ROLLOUT PLAN

1. Agent ships W1–W3 as one PR; CI green; orchestrator reviews the
   breakpoint gating and confirms the mobile path is untouched. **PR
   opened ready-for-review, not draft.**
2. Merge (confirm `merged: True` before any branch delete). Netlify
   deploys.
3. Orchestrator verifies the desktop layout (a real desktop-width
   check) and confirms the mobile layout is unchanged at phone width.
4. Update `ORCHESTRATOR.md` — 4k done.

Rollback is clean — 4k is additive behind a breakpoint. Reverting
restores the all-mobile layout.

---

# PART X — OPEN DECISIONS FOR CHAD

Each has a recommended default. Answer (or say "defaults") and the
executor kickoff goes out.

1. **Desktop breakpoint.** Where does the desktop layout activate —
   ~1024px, ~1280px, or ~1440px? *Recommendation: ~1280px — a genuine
   desktop/large-laptop threshold; tablets and landscape phones stay on
   the mobile layout, which is the safer default for them.*

2. **Desktop navigation.** A persistent **left sidebar** or a
   persistent **top bar**? *Recommendation: left sidebar — it scales as
   more boards are added and is the conventional shape for a
   multi-board data app.*

3. **Detail side panel behavior.** When the docked detail panel opens,
   does it **push/resize** the board (board stays fully usable,
   narrower) or **overlay** part of it? *Recommendation: push/resize —
   the whole point of master-detail is keeping the board usable
   alongside the detail.*

---

*End of brief. Phase 4k makes TradeIQ a real desktop tool without
touching the mobile experience Chad still relies on. It runs cleanly in
parallel with 4m+4n. Recommendation: approve the three defaults and
proceed.*
