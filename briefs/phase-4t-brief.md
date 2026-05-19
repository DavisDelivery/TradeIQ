# Phase 4t — Multi-factor composite edge validation

**Author:** orchestrator (CTO + CFO combined voice — house style)
**Target version:** patch bumps as code lands; MODEL_VERSION unchanged
— 4t **measures** the composite, it does not change it.
**Priority:** HIGH — this answers whether TradeIQ's core output is
trustworthy enough to allocate real money behind.
**Dependencies:** Phase 4s (composite fix — merged; the composite must
be correct before it is measured). Phase 4r W2/W3 (point-in-time
scoring for Williams/Lynch — the engineering pattern 4t extends to the
full composite). 4t sequences **after** 4r W2/W3 lands.
**Estimated effort:** a substantial multi-session phase — ~5–8 hours.
W1 (the point-in-time path for ten analysts) is the heavy lift.

---

## Executive summary — the decision and the ask

Chad has decided what he wants TradeIQ's strategy to be: not a
QQQ-chasing portfolio, but **a multi-factor model with an edge he can
trust** — one that fuses technical, fundamental, news, insider, and
other signals to flag stocks with a high probability of going up *or*
down, across the S&P 500 and the Russell 2000.

That model already exists in TradeIQ — it is the **target board's
ten-analyst composite**. What does *not* exist is any evidence that it
works. The composite was miscomputed until Phase 4s merged (hours ago),
and it has never been backtested. The thing that *was* backtested —
the Prophet portfolio — runs on a separate scorer; its verdict says
nothing about the target board.

So the honest status of TradeIQ's core output is: **unknown.** Phase 4t
resolves that. It extends the backtest engine to score the full
ten-analyst composite point-in-time, backtests the target board
out-of-sample on the S&P 500 and the Russell 2000 separately, and
decomposes which factors actually carry the edge.

**4t measures — it does not tune.** It will not be optimized against
its own backtest; that is how backtests start lying. It produces an
honest verdict, and that verdict may be "no edge," "edge on large caps
only," or "the edge is in three factors, not ten." Every one of those
is a valuable answer for someone about to allocate real money.
Approve — this is the foundation under every "should I trust this"
question that follows.

---

# PART I — THE QUESTION

From the 4e-1 discussion (2026-05-18): Chad wants a strategy he would
allocate real capital to — "an edge I can trust" — built from many
factors (technical, fundamental, news, contracts/IP, insider activity),
flagging high-probability winners *and* losers, covering the S&P 500
and the Russell 2000.

That description is the **target board** — the ten-analyst composite
(Technical, Sector, Fundamental, Flow, News, Earnings, Macro, Insider,
Patents, Political), which already runs on `sp500` and `russell2k` and,
since Phase 4s, scores directionally (bullish high, bearish low).

The problem is not the factors. The problem is that **the edge has
never been measured.** Specifically:

- The composite was **miscomputed** until Phase 4s merged — the
  `Math.abs()` bug meant every historical read on it is contaminated.
- The composite has **never been backtested.** The backtest engine has
  a point-in-time path for Prophet and (via Phase 4r W2) for
  Williams/Lynch — but not for the ten-analyst composite.
- The Prophet portfolio backtest (the "SHIP WITH CAVEATS / lost to QQQ"
  verdict) used a **separate** scorer (`composeProphet`). It tells Chad
  nothing about whether the target board has an edge.

So: *does TradeIQ's multi-factor board actually pick winners and
losers?* Right now that is an open question. 4t answers it.

---

# PART II — CURRENT-STATE ASSESSMENT (CTO)

- `netlify/functions/shared/analyst-runner.ts` — the ten-analyst
  composite (corrected by Phase 4s: directional `signed = score-50`,
  conflict-aware tier/dampening).
- `netlify/functions/analysts/*.ts` — the ten analyst implementations.
  Each computes a 0–100 bullishness score from its own data sources
  (price bars, fundamentals, news, filings, macro series, etc.).
- The backtest engine (`shared/backtest/*`, `score-at-date.ts`) — has
  point-in-time scoring for **Prophet** and, after Phase 4r W2, for
  **Williams and Lynch styles**. It does **not** yet have a PIT path
  for the ten-analyst composite.
- The checkpoint-resume backtest infrastructure (4e-1-infra) and its
  reinvoke (now reliable per 4r-W1b) — handle long runs.
- `reports/phase-4n/pit-integrity-attestation.md` — the precedent for
  honestly classifying point-in-time data integrity per factor.
- TradeIQ has **two** multi-factor scorers — the ten-analyst composite
  and Prophet's layers. They are distinct code paths. 4t validates the
  **ten-analyst composite** (the target board — what Chad described);
  it does not touch Prophet. Whether the two should later be unified is
  a separate decision, out of scope here.

---

# PART III — FINANCIAL ANALYSIS (CFO)

- **No LLM/token cost.** The analysts and the backtest are data +
  math.
- **Run cost is bounded API calls**, cached via the point-in-time
  cache. The composite backtest is heavier than the Williams/Lynch runs
  — ten analysts, and the Russell 2000 is ~2,000 tickers — but the
  checkpoint-resume infra and the 4r-W1b reinvoke fix handle it.
- **Build cost:** the largest item — a substantial multi-session phase.
  W1 (a point-in-time path honest for all ten analysts) is real
  engineering.
- **Value:** this is the highest-leverage measurement in the project.
  Chad has said he would allocate real money to a trusted edge. 4t is
  what tells him — honestly — whether that edge exists, on which
  universe, and in which factors. A true "the edge is weak" finding is
  worth as much as a positive one: it stops real capital going behind a
  model that does not work.

Approve.

---

# PART IV — PROPOSED SOLUTION (CTO)

Order **W1 → (ship + verify) → W2 → W3**. W1 ships as its own PR and is
verified before W2/W3, because the analysis is only as honest as the
scoring path under it.

### W1 — Point-in-time scoring path for the ten-analyst composite

Extend the backtest engine so it can compute the full ten-analyst
composite **as of a historical date** — the equivalent of the
Prophet/Williams/Lynch PIT paths, for the target board.

- **No look-ahead — and this must be established per analyst.** Each
  analyst draws on different data, and the point-in-time integrity
  differs by factor: price bars (Technical, Flow) are PIT-clean;
  fundamentals (Fundamental, Earnings) carry restatement risk (the
  Lynch caveat); news (News) requires news *timestamped on or before*
  the as-of date, not later coverage; insider data (Insider) is keyed
  to filing dates; Macro/Sector/Political/Patents each have their own
  as-of-date question.
- W1's first task is an **honest per-factor PIT audit** — for each of
  the ten analysts, can it be scored point-in-time without look-ahead,
  and from what data? Record it in `reports/phase-4t/pit-audit.md`,
  classifying each factor: PIT-clean / PIT-with-caveat / not
  PIT-able.
- A factor that **cannot** be scored honestly point-in-time must be
  **flagged and excluded or caveated** — never faked. A composite
  backtest over the PIT-honest subset, with the excluded factors named,
  is a valid and valuable deliverable. A backtest that silently uses
  look-ahead data for the hard factors is a negative deliverable.

### W2 — Backtest the composite, out-of-sample, both universes

- Run the ten-analyst composite through the backtest engine on
  **`sp500` and `russell2k` separately** — Chad specifically wants to
  know about small caps, and an edge real on large caps but imaginary
  on small caps is an important finding.
- Test **both tails**: do high-composite stocks out-perform *and* do
  low-composite stocks under-perform? The composite's value as a
  winner/loser flag depends on both.
- **Measurement, not optimization.** 4t backtests the composite *as it
  is* — it does not tune parameters to improve the numbers. Where a
  backtest parameter must be chosen (e.g. holding horizon), report
  results at a small set of **standard, fixed** horizons rather than
  searching for the flattering one.
- Report the honest metrics — forward return by composite decile/tier,
  hit rate, Sharpe, max drawdown, and **rolling-window consistency**
  (the 4e-1 rolling test showed how a flattering full-window number can
  hide period-to-period inconsistency) — each vs the right benchmark
  (SPY for sp500, IWM / the Russell 2000 index for russell2k).

### W3 — Factor attribution + honest verdict

- **Decompose the edge.** Which of the ten analysts actually drive the
  result? Use leave-one-out / ablation runs or a per-factor information
  measure to rank each analyst's contribution. The output: which
  factors carry the edge, which are noise, which may even hurt.
- **The verdict report** (`reports/phase-4t/verdict.md`) — does the
  composite have an edge Chad can trust? Stated plainly, with: the
  large-cap vs small-cap split, the per-factor attribution, the
  rolling-window consistency, and every PIT-integrity caveat from W1.
- **The verdict may be negative or partial.** "No reliable edge," "edge
  on sp500 only," "the edge is three factors, the other seven are
  noise" — any of these is the honest deliverable if it is what the
  data shows. Do not dress up a weak result.

---

# PART V — ARCHITECTURE & INTEGRITY DETAIL (CTO)

### 4t measures; it does not tune

This is the spine of the phase. Chad's stated goal is *an edge he can
trust* — and a strategy tuned against its own backtest cannot be
trusted, because the backtest stops being evidence. 4t therefore
measures the composite **as Phase 4s left it**. If the measurement
shows the composite needs improvement, *that* is a separate, later
phase — and that phase would carry strict walk-forward discipline for
any tuning. Keeping 4t pure measurement is what makes its verdict
honest.

### Do not add factors

Chad raised adding factors (e.g. government contracts). Out of scope
for 4t. The point of W3's attribution is to learn what the *existing*
ten factors deliver first. Adding factors to an unvalidated model adds
overfitting surface, not edge. New factors are earned by the
attribution data, in a later phase.

### W1 ships first, on its own PR

The PIT scoring path is the foundation; the W2/W3 analysis is only as
honest as that path. W1 ships, merges, and is verified (the per-factor
PIT audit reviewed, the path spot-checked against a known date) before
W2/W3 run.

### Out of scope

- Prophet and its portfolio — a separate scorer; 4t does not touch it.
- Changing the composite or the analysts — 4t measures; 4s already
  fixed the composite.
- Building a portfolio/allocation product on top — that depends on 4t's
  verdict and is downstream.

---

# PART VI — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Look-ahead bias in a hard factor (fundamentals, news) inflates the edge | **High if unguarded** | A backtest that lies — and real money behind it | W1's per-factor PIT audit; exclude/caveat factors that can't be scored honestly; never fake PIT. |
| R2 | The composite gets tuned against the backtest | Medium | The verdict stops being evidence | 4t is measurement-only (PART V); any future tuning is a separate walk-forward phase. |
| R3 | A flattering full-window number hides period inconsistency | Medium | False confidence | W2 reports rolling-window consistency, not just full-window. |
| R4 | sp500 and russell2k blended → small-cap reality hidden | Medium | Wrong conclusion for r2k | W2 validates the two universes separately. |
| R5 | A weak/negative result gets dressed up | Medium | Chad allocates behind a non-edge | W3 mandates a plain, honest verdict — negative or partial outcomes reported as-is. |
| R6 | News/Patents/Macro have no historical as-of-date data at all | Medium | Composite can't be fully PIT-backtested | W1 audit surfaces it; backtest the PIT-honest subset, name the exclusions. |

---

# PART VII — ACCEPTANCE CRITERIA

**W1:**
1. A per-factor point-in-time audit (`reports/phase-4t/pit-audit.md`)
   classifies all ten analysts: PIT-clean / PIT-with-caveat / not
   PIT-able.
2. The backtest engine can score the ten-analyst composite at a
   historical date, with no look-ahead in any factor classified
   PIT-clean, and excluded/caveated handling for the rest.
3. `tsc --noEmit` clean, suite green, build clean, tests covering the
   PIT composite path.

**W2:**
4. The composite is backtested on `sp500` and `russell2k`
   **separately**, both tails (high and low composite), reported at
   standard fixed horizons with rolling-window consistency and the
   right benchmark per universe.

**W3:**
5. A factor-attribution result ranks each of the ten analysts'
   contribution to the edge.
6. `reports/phase-4t/verdict.md` states plainly whether the composite
   has a trustworthy edge, where (large vs small cap), in which
   factors — with all PIT caveats. A negative or partial verdict is
   reported honestly.

---

# PART VIII — ROLLOUT PLAN

1. **W1 as its own PR** (ready-for-review, not draft) — the PIT
   composite path + the per-factor audit. Orchestrator reviews — the
   review focus is the PIT audit's honesty and that no hard factor is
   faked — merges, verifies.
2. **Then W2 + W3** — the backtests + attribution + verdict. May be a
   second PR (report-heavy) or orchestrator-driven runs; honest
   verdict either way.
3. Orchestrator reviews the verdict with Chad — it directly informs
   whether, and how, TradeIQ's board becomes a strategy he allocates
   to.
4. ORCHESTRATOR.md updated.

---

# PART IX — OPEN DECISIONS FOR CHAD

The method is settled (measurement-only, out-of-sample, per-factor PIT
honesty). One light decision:

1. **Backtest window.** What historical span — match the existing
   backtest infrastructure's window (the same span Prophet and the
   Williams/Lynch runs use), or a different one? *Recommendation: match
   the existing window — it makes the composite's result directly
   comparable to the Prophet and Williams/Lynch verdicts, and the
   infra/cache already cover it.*

(Benchmarks are not a decision — SPY for sp500, the Russell 2000 index
/ IWM for russell2k. Holding horizon is not a decision — a small fixed
set of standard horizons, not a tuned one.)

---

*End of brief. Phase 4t answers the question under everything Chad
asked for: does TradeIQ's multi-factor board actually have an edge he
can trust — on large caps, on small caps, and in which factors. It
measures honestly and out-of-sample; it does not tune; and it is
prepared to return "no." That honesty is exactly what makes the answer
worth allocating real money behind — or not. Recommendation: approve.*
