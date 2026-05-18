# Phase 4m + 4n — Williams & Lynch: discrete signals + backtest validation

**Author:** orchestrator (CTO + CFO combined voice — house style)
**Target version:** `~0.19.x-alpha` (agent bumps from `main` at branch
time; if it ships as two PRs, 4m then 4n, bump each).
**MODEL_VERSION:** the Williams/Lynch signal change is a scoring-surface
change — **bump MODEL_VERSION** when the discrete-signal layer lands
(it changes what those boards emit).
**Dependencies:** none blocking. The backtest engine (Phases 4a / 4e-1)
provides the point-in-time backtest harness 4n extends.
**Parallel-with:** designed to run **alongside Phase 4k**. File
ownership is split — see PART VI.
**Estimated effort:** this is a **large phase** — combined 4m + 4n. Plan
~5–7 hours, or two sittings. The brief is explicit (PART IX) about
shipping 4m first if 4n's point-in-time work proves deep.

---

## Executive summary — the decision and the ask

TradeIQ has a Williams board and a Lynch board. Chad asked whether they
"truly function like a stock professional would want." Investigation
(2026-05-17) gave a clear answer: **the analysts are legitimate** —
they genuinely implement Larry Williams' and Peter Lynch's methods, not
generic scorers wearing famous names. That is the good news.

The real gaps are two, and Chad named both:

1. **They emit a score, not a signal.** Each board produces a
   continuous number (−100…+100) and a `side`. There is no discrete
   **BUY / SELL / HOLD** verdict, no entry, no stop, no target. A score
   is something to look at; a signal is something to act on.
2. **Neither has ever been backtested.** Nobody has confirmed that a
   Williams %R reversal or a Lynch GARP basket actually produces
   returns. They are untested ideas.

Phase 4m converts the scores into clear, discrete, actionable signals.
Phase 4n adds the backtest path to *prove whether those signals work*.
They are one initiative — you define a signal, then you validate it —
and Chad asked for them combined.

One honest CTO warning carried up front: backtesting Lynch correctly
requires **point-in-time fundamentals** (the numbers as they were known
on the historical date, not as later restated). A backtest with
look-ahead bias is worse than no backtest — it lies. PART V and the
risk register treat this seriously; 4n must report the integrity of
its data, not just a return number.

This phase has modest cost and is the most substantive feature work
left on the board. Approve.

---

# PART I — THE PROBLEM

From Chad's 2026-05-17 request: make the Williams and Lynch tabs
"working better… clear buy and sell signals… and back tests to see if
those signals work or not."

### What the investigation found

Reading `netlify/functions/styles/williams.ts` and `styles/lynch.ts`:

- **Williams is real.** It genuinely uses Larry Williams' own tools:
  Williams %R (14-period), the classic volatility-breakout system
  (`prevClose + k × prevRange`), the trading-day-of-month / seasonality
  tilt, and a 20/50-EMA trend gate. The interpretation matches how
  Williams actually traded.
- **Lynch is real.** It genuinely uses the GARP framework: the PEG
  ratio with Lynch's own thresholds (<1 reasonable, >2 priced for
  perfection), earnings-consistency checks, the 15–50% revenue "sweet
  spot" with hypergrowth penalized, and debt-to-equity.

These are knowledgeable implementations. The problem is not that they
are fake.

### The two real gaps

1. **Score, not signal.** Both emit a continuous `score` and a `side`.
   There is no discrete verdict and no levels. "Williams scores TICKER
   72" is not "BUY TICKER, entry 41.20, stop 38.40, target 47.00."
2. **No validation.** Neither signal has been run through a backtest.
   The backtest engine today only has a point-in-time scoring path for
   the **Prophet** board. Whether Williams or Lynch signals make money
   is, at present, unknown.

---

# PART II — CURRENT-STATE ASSESSMENT (CTO)

- `netlify/functions/styles/williams.ts` — Williams %R, volatility
  breakout, seasonality, EMA trend gate → a continuous score + side.
- `netlify/functions/styles/lynch.ts` — PEG, earnings consistency,
  revenue sweet spot, debt-to-equity → a continuous score + side.
- `shared/scan-williams.ts` / `shared/scan-lynch.ts`, the
  `williams-board.ts` / `lynch-board.ts` endpoints, `WilliamsView.jsx`
  / `LynchView.jsx` — the boards that surface the scores.
- The backtest engine (Phases 4a, 4e-1 — `engine.ts`,
  `engine-batched.ts`, `prophet-portfolio/*`) — has a point-in-time
  scoring path for **the Prophet board only**: `scoreTickerAtDate(…,
  'prophet', …)`. There is no PIT path for Williams or Lynch.
- The backtest engine already has a PIT *price-bar* data layer (it
  backtests Prophet). Whether it has a PIT *fundamentals* layer
  suitable for Lynch is the open question 4n must resolve (PART V).

---

# PART III — FINANCIAL ANALYSIS (CFO)

- **The analysts themselves cost nothing per run** — Williams and Lynch
  scoring is price-bar and fundamentals math, no LLM inference. The
  discrete-signal layer (4m) adds arithmetic, not API calls. No new
  recurring cost.
- **The backtests (4n) are compute, not tokens.** Running historical
  Williams/Lynch signals through the engine uses the same checkpoint-
  resumable backtest infrastructure as the Prophet backtests — bounded,
  one-off per run, no LLM cost. Whatever Polygon/fundamentals API calls
  the PIT path needs are cached the same way the existing backtests
  cache bars.
- **Build cost:** the large item. Combined 4m + 4n is ~5–7 hours.
  4m (the signal layer) is well-scoped. 4n (the PIT path + the runs) is
  the deeper, riskier half — see PART IX.
- **Value:** this turns two "interesting score" boards into either
  *validated, actionable signals* — or an honest verdict that a signal
  does not work, which is itself valuable (it stops Chad acting on
  noise). Both outcomes are worth the build.

Approve. The cost is build-time; the run cost is negligible.

---

# PART IV — PROPOSED SOLUTION (CTO)

Five workstreams. **4m = W1–W3, 4n = W4–W5.** Order W1 → W2 → W3 →
W4 → W5. Ship 4m first if 4n proves deep (PART IX).

### W1 — Williams discrete signal (4m)

Williams is a **short-term technical trader**. His discrete signal is a
**trade signal**:

- Map the existing Williams logic to a discrete verdict — **BUY /
  SELL / HOLD** — fired on the *confluence* of his indicators (a %R
  reversal from oversold/overbought, volatility-breakout confirmation,
  the EMA trend gate), not merely a score crossing a threshold. The
  score stays as the underlying strength measure; the signal is the
  discrete call derived from it.
- Attach **entry, stop, and target** levels. Authentic to Williams,
  these are **volatility-based**: entry at the breakout/trigger level,
  stop at the volatility-derived invalidation (e.g. an ATR-based or
  prior-range-based level), target as a risk multiple or volatility
  projection. (Stop/target method is an open decision — PART X.)

### W2 — Lynch discrete signal (4m)

Lynch is a **long-term GARP investor** — he did *not* trade with tight
price stops; he sold when the story changed or the valuation got rich.
Forcing a day-trader's stop onto a Lynch signal would misrepresent the
strategy. So Lynch's discrete signal is an **investment signal**:

- A discrete verdict — **BUY / HOLD / AVOID** (AVOID doubles as the
  exit/sell call) — derived from the PEG + earnings-consistency +
  revenue-sweet-spot + debt logic.
- A **fair-value range** instead of a price target — e.g. the price
  implied by PEG ≈ 1–1.5 on the company's growth, expressed as a band.
- A **fundamental invalidation condition** instead of a price stop —
  the conditions under which the thesis breaks (PEG expands past a
  threshold, earnings consistency breaks, debt deteriorates).

Both boards end with a clear discrete verdict — which is what Chad
asked for — but each is shaped honestly to its strategy: Williams a
trade, Lynch an investment.

### W3 — Surface the signals in the board views (4m)

- `WilliamsView.jsx` and `LynchView.jsx` display the discrete verdict
  prominently (BUY/SELL/HOLD, BUY/HOLD/AVOID) with its levels — entry/
  stop/target for Williams, fair-value band + invalidation for Lynch.
- Keep every table column sortable (`useSortable`/`SortableTh`),
  including a sortable verdict column.
- Match the existing visual system. Build the views **responsive**
  (mobile + desktop) on their own — Phase 4k is not touching these
  views in parallel, and a later small pass aligns them to 4k's
  desktop primitives once both land (PART VI).

### W4 — Point-in-time scoring path for Williams & Lynch (4n)

- Extend the backtest engine so it can score the **Williams** and
  **Lynch** boards at a historical date — the equivalent of today's
  Prophet-only `scoreTickerAtDate(…, 'prophet', …)`, for these two
  styles.
- **No look-ahead.** Williams' inputs are price bars — PIT-clean (use
  bars up to date D only). Lynch's inputs are fundamentals — this is
  the hard part: the score must use fundamentals **as known on date
  D**, not later-restated figures. See PART V.

### W5 — Run the backtests and report (4n)

- Run the discrete Williams and Lynch signals through the engine over a
  historical window. For each signal, measure forward outcome —
  win rate, average return, for Williams whether target-hit-before-stop,
  drawdown, and a benchmark comparison (vs SPY, as the Prophet verdicts
  do).
- Produce a verdict report per signal in `reports/phase-4n/`. The
  report must state the **data-integrity caveats honestly** —
  especially the Lynch fundamentals point-in-time situation (PART V).
  An index-beating number printed next to a look-ahead-bias warning is
  not a passing result.

---

# PART V — ARCHITECTURE DETAIL (CTO)

### Williams = trade signal, Lynch = investment signal

This distinction is the spine of 4m. Williams trades short-term moves —
his signal needs entry/stop/target. Lynch buys companies — his signal
needs a verdict, a fair-value band, and a thesis-invalidation
condition, not a price stop. Implementing them as the *same* shape
would make one of them a lie. They share a discrete-verdict envelope;
their levels differ by design.

### The look-ahead-bias hazard in the Lynch backtest

This is the single most important integrity point in 4n.

- Williams backtests on price bars. Bars are point-in-time by nature —
  the bar for date D is fixed. A Williams PIT score for date D is
  honest as long as it uses only bars ≤ D.
- Lynch backtests on **fundamentals** — P/E, EPS growth, earnings
  history, debt. Fundamentals get **restated**. If the backtest scores
  a 2021 date using fundamentals as they read *today*, it is using
  information that did not exist in 2021 — look-ahead bias — and the
  backtest will look better than reality.
- 4n must establish what point-in-time fundamentals the data layer can
  actually provide. If genuine PIT fundamentals are available, the
  Lynch backtest is sound. **If they are not, the agent must say so**
  and either (a) constrain the Lynch backtest to what can be done
  honestly, or (b) report the Lynch backtest as *indicative only, with
  a look-ahead-bias caveat*. The agent must **not** present a
  bias-contaminated Lynch return as a clean result.

A backtest's job is to tell the truth about whether a signal works. A
flattering lie is a negative deliverable.

### Reuse the existing backtest infrastructure

4n extends the existing engine — the same checkpoint-resumable harness,
the same PIT bar layer, the same benchmark machinery the Prophet
verdicts use. W4 adds Williams/Lynch as scoreable styles within it; it
does not build a new backtest engine.

### Out of scope

- Re-architecting the Williams or Lynch *scoring logic* — it is sound;
  4m adds a discrete-signal layer on top, it does not rewrite the
  analysts.
- The Prophet board, the target/insider boards, desktop layout (4k).

---

# PART VI — COORDINATION WITH PHASE 4k (parallel execution)

4m+4n and 4k run at the same time. Ownership split:

| Owned by **4m+4n** | Owned by **4k** |
|---|---|
| `src/WilliamsView.jsx`, `src/LynchView.jsx` | `src/App.jsx`, `TargetBoardView.jsx`, `InsiderBoardView.jsx` |
| `netlify/functions/styles/*`, `analysts/*`, the backtest engine | the desktop layout primitives |

- 4m+4n builds the Williams/Lynch views **responsive on their own**;
  4k is not touching them.
- 4m+4n does **not** touch the shell or the target/insider views.
- Shared files (e.g. `shared/types.ts`) — keep changes minimal and
  additive on both sides.
- After both merge, a small follow-up adopts 4k's desktop layout
  primitives in the Williams/Lynch views.

---

# PART VII — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Lynch backtest contaminated by look-ahead bias (restated fundamentals) | **High if unguarded** | A backtest that lies | W4/W5 establish PIT-fundamentals availability first; W5 reports integrity caveats honestly; never present a biased number as clean. |
| R2 | Williams/Lynch forced into one signal shape | Medium | One strategy misrepresented | Williams = trade signal, Lynch = investment signal — designed distinct (PART V). |
| R3 | Combined 4m+4n too large for one session | Medium | Rushed delivery | PART IX: ship 4m first if 4n proves deep; 4n can be its own PR. |
| R4 | Discrete thresholds are arbitrary | Medium | Signals that don't reflect the method | Derive verdicts from indicator confluence, not a bare score cut; W5's backtest is the reality check on the thresholds. |
| R5 | Merge conflict with 4k | Low | Rework | Ownership split (PART VI), additive shared-file changes. |
| R6 | MODEL_VERSION not bumped | Low | Stale-cache confusion | The discrete-signal layer changes board output — bump MODEL_VERSION. |

---

# PART VIII — ACCEPTANCE CRITERIA

**4m (W1–W3):**

1. The Williams board emits a discrete **BUY / SELL / HOLD** verdict
   per ticker with entry, stop, and target levels.
2. The Lynch board emits a discrete **BUY / HOLD / AVOID** verdict per
   ticker with a fair-value range and a fundamental-invalidation
   condition.
3. `WilliamsView.jsx` / `LynchView.jsx` show the verdict + levels
   prominently; all columns sortable; views render on mobile and
   desktop.
4. MODEL_VERSION bumped.

**4n (W4–W5):**

5. The backtest engine can score the Williams and Lynch boards at a
   historical date with **no look-ahead** (Williams verified PIT-clean
   on bars; Lynch's fundamentals-PIT situation explicitly established).
6. A verdict report per signal in `reports/phase-4n/` — win rate,
   average return, drawdown, benchmark comparison — **with honest
   data-integrity caveats**, especially for Lynch.

**Both:** `tsc --noEmit` clean, full test suite green, `npm run build`
clean; tests cover the discrete-signal derivation and the PIT scoring
path.

---

# PART IX — ROLLOUT PLAN

1. The agent builds 4m (W1–W3) first — discrete signals are independent
   value and land cleanly.
2. Then 4n (W4–W5). **If the point-in-time work proves deep** — likely
   on the Lynch fundamentals side — the agent ships **4m as its own
   PR** and carries 4n in a follow-up PR rather than blocking the
   signals behind the backtest. One PR is fine if both fit; two is
   fine if they don't. The agent says which in the hand-off.
3. Orchestrator reviews — for 4n, the **look-ahead-bias handling** is
   the specific review focus.
4. Merge (confirm `merged: True` before branch delete). Update
   `ORCHESTRATOR.md` — 4m and 4n rows.

---

# PART X — OPEN DECISIONS FOR CHAD

Each has a recommended default. Answer (or say "defaults").

1. **Williams stop/target method.** Volatility/ATR-based levels, or
   fixed risk-multiple (e.g. 1R stop, 2R target)? *Recommendation:
   volatility/ATR-based — it is authentic to how Williams actually
   sized trades; fixed-R can be offered as a secondary display.*

2. **Lynch signal shape.** Confirm Lynch gets an **investment** signal
   (BUY/HOLD/AVOID + fair-value band + fundamental invalidation) rather
   than a forced price stop. *Recommendation: yes — anything else
   misrepresents a buy-and-hold GARP strategy. You still get a clear
   discrete verdict.*

3. **Backtest window & universe.** What span and universe for the 4n
   backtests? *Recommendation: match the Prophet verdict backtests
   (same multi-year window) for comparability, on the S&P 500 universe
   first — fundamentals point-in-time data is most reliable for large
   caps, which keeps the Lynch backtest honest. Widen later.*

---

*End of brief. Phases 4m + 4n turn two legitimate-but-passive analyst
boards into validated, actionable signals — or into an honest verdict
that a signal does not work. Either outcome is worth having. Runs in
parallel with 4k. Recommendation: approve the three defaults and
proceed.*
