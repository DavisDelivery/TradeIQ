# Phase 4k Executor Kickoff — Desktop layout / responsive redesign

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a new Claude chat. The GitHub PAT is embedded
> inline; no follow-up needed.

---

You are an executor agent. Your single assignment is **Phase 4k** of
the TradeIQ project. The conversation you are reading is your boot
prompt. Read it end-to-end, then read `briefs/phase-4k-brief.md` in the
repo, then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app` — a React 18 / Vite SPA backed by
TypeScript Netlify functions and Firestore. It was built mobile-first
for the owner, Chad Davis, who worked from a phone. He now also uses it
on a desktop, where the app is just the phone layout stretched across a
wide monitor.

## Your assignment in one sentence

Build a real desktop layout — persistent navigation, a docked
master-detail panel, desktop-density sortable tables — that activates
above a desktop breakpoint while leaving the mobile experience exactly
as it is today, shipped as one PR with tests.

## Chad's settled decisions (FINAL — do not re-litigate)

- **Desktop breakpoint: ~1280px.** Desktop layout activates at and
  above ~1280px; below it, the mobile layout is unchanged.
- **Desktop navigation: persistent left sidebar.**
- **Detail side panel: push/resize the board** (the board stays fully
  usable, narrower) — not an overlay.

## Read the design skill first

Before writing any UI, read `/mnt/skills/public/frontend-design/SKILL.md`.
4k changes *layout*, not the visual identity — work within the existing
dark theme, emerald `#14e89a` accent, IBM Plex Mono.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4k@tradeiq.local"
git config user.name "Executor 4k"

npm ci    # if it fails on cross-platform optional deps, fall back to: npm install
npx tsc --noEmit
npm test
npm run build

git checkout -b phase-4k-desktop-layout
```

If baseline fails, STOP and report. Bump APP_VERSION's minor on
`src/App.jsx` (target ~`0.19.0-alpha`).

**Environment note:** if commits fail from `/home/claude/TradeIQ`, the
signing server may expect commits from `/home/user/TradeIQ` (or a
`/tmp` path) — relocate the repo and commit from there.

Read `briefs/phase-4k-brief.md` before writing code.

**Secrets:** GitHub PAT (write-scoped) in the clone URL — for `git
push` + `POST /pulls`.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key existing code

- `src/App.jsx` — top-level shell + board navigation.
- `src/TargetBoardView.jsx` — the target board; the stock detail panel
  lives inside it (radar, contributions, attribution, `CompanyInfo`,
  `PriceChart`).
- `src/InsiderBoardView.jsx` — the insider board.
- `src/components/{CompanyInfo,PriceChart,FreshnessPill}.jsx` — Phase
  4j components, already responsive.
- `useSortable` hook + `SortableTh` component — the standard
  sortable-table pattern; every table uses it.
- The dark theme + emerald `#14e89a` + IBM Plex Mono visual system.

## 2.2 Files you ARE allowed to touch

- `src/App.jsx` — the desktop shell + persistent sidebar nav
- `src/TargetBoardView.jsx`, `src/InsiderBoardView.jsx` — desktop
  layout + density
- new layout primitives — a breakpoint/viewport hook, a master-detail
  container component, a desktop-density table component (place under
  `src/components/` or `src/layout/`)
- shared styles / tokens, ONLY additively
- test files for the above
- `src/App.jsx` — APP_VERSION bump
- `briefs/phase-4k-pr-description.md` + `reports/phase-4k/verification.md`
- `ORCHESTRATOR.md` — mark 4k done at the end

## 2.3 Files you may NOT touch

- `src/WilliamsView.jsx`, `src/LynchView.jsx` — **owned by Phase 4m+4n
  running in parallel.** Do not touch them. 4k's layout primitives are
  reusable; a later pass adopts them in those views.
- Any `netlify/functions/*` — no backend, scan, analyst, or backtest
  code
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`

---

# PART 3 — THE WORK (order W1 → W2 → W3)

## W1 — Responsive foundation + desktop shell

- Build a **viewport/breakpoint hook** (`useBreakpoint` /
  `useViewport`) — the single source of truth for "are we at desktop
  width (≥ ~1280px)."
- At desktop widths, navigation becomes a **persistent left sidebar**.
  Below the breakpoint, the existing mobile nav is unchanged.
- The breakpoint gate is the contract for the whole phase: above it,
  the new desktop layout; below it, the mobile layout exactly as today.

## W2 — Master-detail: detail as a docked side panel

- Build a reusable **master-detail container**. On desktop it renders
  the board pane + a docked detail pane side by side; selecting a row
  populates the detail pane and **pushes/resizes** the board (board
  stays usable, narrower) — the board never disappears. Selecting
  another row swaps the panel.
- On mobile, the container falls back to the existing behavior — board
  list, tap opens the full-screen modal detail. Unchanged.
- Apply it to the **target board**. The detail *content* is unchanged
  (same radar/contributions/attribution/`CompanyInfo`/`PriceChart`) —
  only its container changes; charts size up to the panel width on
  desktop.

## W3 — Desktop-density board tables

- At desktop widths, the **target** and **insider** boards render as
  denser tables that use the horizontal space — more columns visible
  without horizontal scroll, tighter rows, more rows per screen.
- Keep `useSortable`/`SortableTh` — every column stays sortable.
- Mobile board rendering is unchanged.

---

# PART 4 — TESTS

- The breakpoint hook resolves mobile vs desktop correctly around
  ~1280px.
- The master-detail container branches correctly: desktop → split
  panes; mobile → list + modal.
- Don't rely on a real browser — use the existing component-test setup.
- Report the real test delta; don't pad.

---

# PART 5 — CONVENTIONS

- One commit per workstream + tests + verification report.
- APP_VERSION minor bumped in `src/App.jsx`.
- `strict: true` TypeScript; no `any` without an inline reason.
- Work within the `frontend-design` skill's tokens and the existing
  visual system — 4k is layout, not a restyle.

---

# PART 6 — PR + ACCEPTANCE

```bash
git push -u origin phase-4k-desktop-layout
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4k - desktop layout / responsive redesign",
    "head": "phase-4k-desktop-layout",
    "base": "main",
    "body": "See briefs/phase-4k-brief.md and reports/phase-4k/verification.md. W1 responsive foundation + persistent desktop sidebar nav; W2 master-detail docked detail panel for the target board; W3 desktop-density sortable tables. Breakpoint ~1280px; mobile layout unchanged below it."
  }'
```

**Open the PR as ready-for-review, NOT a draft.** If your tooling
defaults to draft, immediately mark it ready.

Acceptance is verified post-merge by the orchestrator at both desktop
and phone widths.

---

# PART 7 — HAND-OFF FORMAT

When the PR is mergeable, post one message:

```
PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Change summary:
- W1: useBreakpoint hook + persistent desktop sidebar (≥1280px)
- W2: master-detail container; target-board detail docked side panel
- W3: desktop-density tables for target + insider boards

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was <baseline>)
- npm run build: clean
- Mobile layout: confirmed unchanged at phone width

Acceptance: DEFERRED to post-merge (orchestrator checks both widths)

Known limitations:
- <anything worth flagging>
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Regressing the mobile layout.** Everything desktop is gated behind
  the ~1280px breakpoint; the mobile path stays exactly as today.
- **Touching `WilliamsView.jsx` / `LynchView.jsx`** — Phase 4m+4n owns
  them in parallel.
- **Restyling.** 4k is layout. Keep the visual identity.
- **A non-standard table** — use `useSortable`/`SortableTh`.
- **Opening the PR as a draft.**

---

# PART 9 — PARALLEL CONTEXT

Phase 4m+4n is running in parallel — it owns `WilliamsView.jsx`,
`LynchView.jsx`, and the analyst/backtest backend. You own the shell
and the target/insider views. The only possible shared file is
`src/shared/types.ts` or similar — keep any change there minimal and
additive. If you hit an unexpected conflict on `main`, stop and report.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4k of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4k-executor.md — that's your full assignment —
   then read briefs/phase-4k-brief.md, then /mnt/skills/public/frontend-design/SKILL.md.

Everything you need is in those files: a breakpoint-gated desktop
layout (persistent left sidebar nav, master-detail docked detail panel,
desktop-density sortable tables) that activates at ~1280px while
leaving the mobile layout completely unchanged. Chad's decisions are
settled (breakpoint ~1280px, left sidebar, push/resize detail panel) —
don't re-litigate. Do NOT touch WilliamsView.jsx / LynchView.jsx (Phase
4m+4n owns them in parallel). If commits fail from /home/claude/TradeIQ,
relocate to /home/user/TradeIQ. Open the PR ready-for-review, not a
draft. Start with PART 1 once you've read everything. ~3-4 hour session.
