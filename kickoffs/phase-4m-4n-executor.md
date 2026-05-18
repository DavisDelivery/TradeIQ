# Phase 4m+4n Executor Kickoff — Williams & Lynch: discrete signals + backtest validation

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a new Claude chat. The GitHub PAT is embedded
> inline; no follow-up needed.

---

You are an executor agent. Your assignment is the combined **Phase 4m +
4n** of the TradeIQ project. The conversation you are reading is your
boot prompt. Read it end-to-end, then read `briefs/phase-4m-4n-brief.md`
in the repo (full design + the critical look-ahead-bias section), then
start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app` — a React/Vite SPA backed by
TypeScript Netlify functions, Firestore, Polygon and Finnhub. Among its
boards are a **Williams** board and a **Lynch** board — analyst styles
modeled on Larry Williams (short-term technical trader) and Peter Lynch
(GARP investor). Owner: Chad Davis.

## The problem you're fixing (full detail in the brief)

The Williams and Lynch analysts are **legitimate** — Williams genuinely
uses Williams %R, volatility breakout, seasonality, an EMA trend gate;
Lynch genuinely uses PEG, earnings consistency, the revenue sweet spot,
debt-to-equity. Two real gaps:

1. **They emit a continuous `score` + `side`, not a discrete signal.**
   No BUY/SELL/HOLD verdict, no levels.
2. **Neither has ever been backtested.** The backtest engine has a
   point-in-time scoring path for the Prophet board only.

## Your assignment

- **4m (W1–W3):** convert the scores into discrete, actionable signals
  and surface them in the board views.
- **4n (W4–W5):** add a point-in-time scoring path for the Williams and
  Lynch boards to the backtest engine, run the signals, and produce
  honest verdict reports.

## Chad's settled decisions (FINAL — do not re-litigate)

- **Williams stop/target: volatility/ATR-based** (authentic to how
  Williams sized trades). A fixed risk-multiple may be shown as a
  secondary display.
- **Lynch signal shape: an investment signal** — BUY/HOLD/AVOID + a
  fair-value band + a fundamental-invalidation condition. **Not** a
  forced price stop; Lynch was a buy-and-hold GARP investor.
- **Backtest window/universe:** match the Prophet verdict backtests'
  window for comparability; S&P 500 universe first (cleanest
  point-in-time fundamentals — keeps the Lynch backtest honest).

## The one thing you must not get wrong

**The Lynch backtest must not have look-ahead bias.** Fundamentals get
restated; scoring a 2021 date with today's restated numbers is
cheating, and the backtest will lie. Establish what point-in-time
fundamentals the data layer can provide; if genuine PIT fundamentals
aren't available, constrain the Lynch backtest to what's honest and
report it with an explicit caveat. A flattering, bias-contaminated
return is a NEGATIVE deliverable. The brief's PART V covers this.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4mn@tradeiq.local"
git config user.name "Executor 4m4n"

npm ci    # if it fails on cross-platform optional deps, fall back to: npm install
npx tsc --noEmit
npm test
npm run build

git checkout -b phase-4m-4n-williams-lynch-signals
```

If baseline fails, STOP and report. Bump APP_VERSION from `main`, and
**bump MODEL_VERSION** when the discrete-signal layer lands (it changes
what those boards emit).

**Environment note:** if commits fail from `/home/claude/TradeIQ`, the
signing server may expect commits from `/home/user/TradeIQ` (or a
`/tmp` path) — relocate the repo and commit from there.

Read `briefs/phase-4m-4n-brief.md` before writing code.

**Secrets:** GitHub PAT (write-scoped) in the clone URL. The deploy has
Polygon + Finnhub + Firebase configured server-side.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key existing code

- `netlify/functions/styles/williams.ts` — Williams %R, volatility
  breakout, seasonality, EMA trend gate → continuous score + side.
- `netlify/functions/styles/lynch.ts` — PEG, earnings consistency,
  revenue sweet spot, debt-to-equity → continuous score + side.
- `netlify/functions/shared/scan-williams.ts`, `shared/scan-lynch.ts`,
  `williams-board.ts`, `lynch-board.ts` — the boards.
- `src/WilliamsView.jsx`, `src/LynchView.jsx` — the board views.
- The backtest engine — `engine.ts`, `engine-batched.ts`,
  `prophet-portfolio/*` — has a point-in-time scoring path for the
  **Prophet board only** (`scoreTickerAtDate(…, 'prophet', …)`). It
  already has a PIT price-bar data layer.
- `shared/data-provider.ts` — `getDailyBars`, fundamentals fetchers.

## 2.2 Files you ARE allowed to touch

- `netlify/functions/styles/williams.ts`, `styles/lynch.ts` — add the
  discrete-signal layer (do NOT rewrite the scoring logic — it's sound)
- `netlify/functions/shared/scan-williams.ts`, `shared/scan-lynch.ts`,
  `williams-board.ts`, `lynch-board.ts` — carry the new signal fields
- `src/WilliamsView.jsx`, `src/LynchView.jsx` — surface the signals
- the backtest engine — add Williams/Lynch as PIT-scoreable styles
- `shared/data-provider.ts` — only if the PIT fundamentals path needs it
- test files for all of the above
- `src/App.jsx` — APP_VERSION + MODEL_VERSION bumps
- `briefs/phase-4m-4n-pr-description.md` + `reports/phase-4n/*`
- `ORCHESTRATOR.md` — mark 4m and 4n done at the end

## 2.3 Files you may NOT touch

- `src/App.jsx` shell/nav, `src/TargetBoardView.jsx`,
  `src/InsiderBoardView.jsx`, the desktop layout primitives — **owned
  by Phase 4k running in parallel** (only touch `src/App.jsx` for the
  version bumps, nothing else)
- The Prophet board scoring, the scan workers, `snapshot-store.ts`
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`

---

# PART 3 — THE WORK (order W1 → W2 → W3 → W4 → W5)

## W1 — Williams discrete signal (4m)

- Derive a discrete **BUY / SELL / HOLD** verdict from the *confluence*
  of Williams' indicators (a %R reversal from oversold/overbought,
  volatility-breakout confirmation, the EMA trend gate) — not a bare
  score threshold. Keep the continuous score as the strength measure.
- Attach **entry, stop, target** — **volatility/ATR-based** (entry at
  the breakout/trigger level, stop at the volatility-derived
  invalidation, target as a risk multiple or volatility projection).

## W2 — Lynch discrete signal (4m)

- Derive a discrete **BUY / HOLD / AVOID** verdict from the PEG +
  earnings-consistency + revenue-sweet-spot + debt logic.
- Attach a **fair-value range** (the price band implied by PEG ≈
  1–1.5 on the company's growth) and a **fundamental-invalidation
  condition** (what breaks the thesis). **No price stop.**

## W3 — Surface the signals (4m)

- `WilliamsView.jsx` / `LynchView.jsx` show the discrete verdict
  prominently with its levels. Every column sortable
  (`useSortable`/`SortableTh`), including a sortable verdict column.
- Build the views **responsive** (mobile + desktop) on their own —
  Phase 4k is not touching them.

## W4 — Point-in-time scoring path for Williams & Lynch (4n)

- Extend the backtest engine so it can score the Williams and Lynch
  boards at a historical date — the equivalent of the Prophet-only
  `scoreTickerAtDate`.
- **No look-ahead.** Williams = price bars, PIT-clean (bars ≤ D only).
  Lynch = fundamentals — establish what point-in-time fundamentals are
  available; see the brief's PART V and the warning above.

## W5 — Run the backtests + report (4n)

- Run the discrete Williams and Lynch signals through the engine over
  the Prophet-verdict window, S&P 500 universe. Measure win rate,
  average return, drawdown, benchmark (vs SPY); for Williams, target-
  hit-before-stop.
- Verdict report per signal in `reports/phase-4n/` — **with honest
  data-integrity caveats**, especially the Lynch fundamentals
  point-in-time situation.

---

# PART 4 — TESTS

- W1/W2: the discrete-verdict derivation (confluence → BUY/SELL/HOLD;
  PEG logic → BUY/HOLD/AVOID); level computation.
- W4: the PIT scoring path scores Williams/Lynch at a past date with no
  look-ahead (Williams uses only bars ≤ D).
- Don't network in unit tests — mock Polygon/Finnhub/Firestore.
- Report the real test delta; don't pad.

---

# PART 5 — CONVENTIONS

- One commit per workstream + tests + reports.
- APP_VERSION bumped; **MODEL_VERSION bumped** when the discrete-signal
  layer lands.
- `strict: true` TypeScript; no `any` without an inline reason.
- Do NOT rewrite the Williams/Lynch scoring logic — it's sound; you add
  a discrete-signal layer on top.

---

# PART 6 — PR + ACCEPTANCE

If 4m and 4n both fit cleanly, one PR. **If 4n's point-in-time work
proves deep (likely on the Lynch fundamentals side), ship 4m as its own
PR and carry 4n in a follow-up PR** — don't block the signals behind
the backtest. State which you did in the hand-off.

```bash
git push -u origin phase-4m-4n-williams-lynch-signals
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4m+4n - Williams & Lynch discrete signals + backtest",
    "head": "phase-4m-4n-williams-lynch-signals",
    "base": "main",
    "body": "See briefs/phase-4m-4n-brief.md. 4m: discrete BUY/SELL/HOLD signals for Williams (trade signal w/ entry/stop/target) and BUY/HOLD/AVOID for Lynch (investment signal w/ fair-value + fundamental invalidation). 4n: point-in-time scoring path for the Williams/Lynch boards + backtest verdict reports. Lynch backtest integrity (look-ahead bias) reported honestly."
  }'
```

**Open the PR(s) as ready-for-review, NOT a draft.**

---

# PART 7 — HAND-OFF FORMAT

When mergeable, post one message:

```
PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Change summary:
- W1: Williams discrete BUY/SELL/HOLD + ATR-based entry/stop/target
- W2: Lynch discrete BUY/HOLD/AVOID + fair-value band + invalidation
- W3: signals surfaced in WilliamsView/LynchView (sortable, responsive)
- W4: PIT scoring path for Williams + Lynch in the backtest engine
- W5: backtest verdicts — <Williams result>, <Lynch result>

Lynch backtest integrity: <PIT fundamentals available? / caveat>

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was <baseline>)
- npm run build: clean
- MODEL_VERSION bumped: <old> -> <new>

PR shape: <one PR | 4m shipped, 4n follow-up>

Acceptance: DEFERRED to post-merge
```

---

# PART 8 — FAILURE MODES TO AVOID

- **A look-ahead-biased Lynch backtest presented as clean.** The single
  worst outcome — establish PIT-fundamentals integrity and report it
  honestly.
- **Forcing Lynch into a trade signal** with a price stop — it's an
  investment signal (BUY/HOLD/AVOID + fair-value + invalidation).
- **Rewriting the Williams/Lynch scoring logic** — it's sound; add a
  layer, don't replace.
- **Bare score-threshold verdicts** — derive from indicator confluence.
- **Touching the 4k-owned files** (App shell, target/insider views).
- **Forgetting the MODEL_VERSION bump.**
- **Networking in unit tests.** **Opening the PR as a draft.**

---

# PART 9 — PARALLEL CONTEXT

Phase 4k is running in parallel — it owns `src/App.jsx` (shell/nav),
`TargetBoardView.jsx`, `InsiderBoardView.jsx`, and the desktop layout
primitives. You own the Williams/Lynch views and the analyst/backtest
backend. Only shared file is possibly `src/shared/types.ts` — keep any
change there minimal and additive. If you hit an unexpected conflict on
`main`, stop and report.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for the combined Phase 4m+4n of the TradeIQ
project at DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4m-4n-executor.md — that's your full assignment
   — then read briefs/phase-4m-4n-brief.md (especially PART V on
   look-ahead bias).

Everything you need is in those two files: 4m converts the Williams +
Lynch continuous scores into discrete signals (Williams a trade signal
with ATR-based entry/stop/target; Lynch an investment signal with
BUY/HOLD/AVOID + fair-value band + fundamental invalidation — NOT a
price stop), surfaced in the board views; 4n adds a point-in-time
scoring path to the backtest engine and validates the signals. The
Lynch backtest must not have look-ahead bias — establish PIT
fundamentals integrity and report honestly; a flattering biased number
is a negative deliverable. Chad's decisions are settled — don't
re-litigate. Bump MODEL_VERSION. Do NOT touch the 4k-owned files (App
shell, target/insider views). If commits fail from /home/claude/TradeIQ,
relocate to /home/user/TradeIQ. Open the PR ready-for-review, not a
draft; ship 4m as its own PR if 4n proves deep. Start with PART 1 once
you've read both. ~5-7 hour session.
