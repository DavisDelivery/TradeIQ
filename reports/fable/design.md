# FABLE — my board. Design + pre-committed validation rule.

**Author: Claude (claude-fable-5).** Chad asked me to design my own
stock-selection tab from a blank slate — not an adaptation of his designs —
targeting names likely to rise over **30–170 trading days**, built from
internet-wide research into what measurably works. This document is that
design, written **before** any backtest number exists. The validation rule
at the bottom is binding, per this repo's anti-p-hack discipline
(FIX-1/FIX-2 precedent).

## Where FABLE comes from (research synthesis)

Four parallel research sweeps (academic factor literature, practitioner
track records, insider/alt-data evidence, institutional quant practice —
full citations in the session record) converged on one intersection:

- **Academic:** skip-month momentum (Jegadeesh-Titman), *smooth-path*
  momentum ("frog in the pan", Da-Gurun-Warachka: +8.0%/6mo continuous-vs-
  discrete spread, drift persists ~8 months, no reversal), 52-week-high
  proximity (George-Hwang: dominates plain momentum, no long-run reversal),
  idiosyncratic momentum (Blitz et al.: ~2× Sharpe of raw momentum,
  crash-resistant), opportunistic insider cluster buying (Cohen-Malloy-
  Pomorski: 82bp/mo VW), quality as a *veto* not a ranker (Novy-Marx GP/A).
  Post-publication haircut ~50% (McLean-Pontiff) assumed throughout.
- **Practitioners with verifiable records** (AAII 27-year frozen-rule
  tracking, USIC audited winners, AQR/Alpha-Architect methodologies)
  independently converge on: buy strength **near 52-week highs**, demand
  top-quartile **relative strength** with the recent quarter overweighted,
  require a **stacked rising moving-average trend template**
  (50>150>200, 200d rising), enter on **volatility contraction with volume
  dry-up**, and gate everything on **market regime**.
- **Quant practice:** equal-weight percentile ranks of 3-5 low-correlation
  signals beat optimized weights out-of-sample (DeMiguel 1/N); at most ONE
  hard gate; banding (enter top decile, exit below ~top 30%) is the only
  cost-mitigation that reliably pays (Novy-Marx-Velikov); 15-25 names,
  sector caps; exits by rank decay + max-hold, not tight stops; report
  percentile + realized spreads, never a naked score.

FABLE is that intersection, constrained to data this stack can actually
serve **and validate**: deep Polygon daily bars + Finnhub Form-4 insider
filings (both PIT-reconstructable). Fundamentals participate only as a
live veto (never load-bearing, never in the survival test).

## The algorithm

Universe: sp500 (russell2k later). Hygiene: price ≥ $5, ≥ 287 daily bars
(auto-excludes recent IPOs), 63d median dollar volume ≥ $10M.

### Gate — FOUNDATION (the one hard gate; fail ⇒ no setup, null score)

All must hold at scan date t (Minervini trend-template mechanized):

1. close > SMA50 > SMA150 > SMA200
2. SMA200(t) > SMA200(t−21)  (200-day line rising ≥ 1 month)
3. close ≥ 1.30 × min(low, 252d)  (≥30% off the 52-week low)
4. close ≥ 0.75 × max(high, 252d)  (within 25% of the 52-week high)
5. 12-1 momentum > 0  (r(t−252→t−21) positive)

Most of the universe fails the gate most of the time; in bear tapes the
board may be near-empty. That is by design (the "screen goes to cash"
property that made frozen CANSLIM tracking survivable).

### Five pillars (composite = 20% each)

Pillars 1-4 are cross-sectional **percentile ranks (0-100) among
gate-passers**; pillar 5 is a calibrated 0-100 event score used raw
(ranking a sparse signal is degenerate).

1. **ASCENT — weighted relative strength.**
   `RS_raw = 0.4·r63 + 0.2·r126 + 0.2·r189 + 0.2·r252` (IBD-replication
   weighting; recent quarter double-weighted). Rank.
2. **SMOOTH PATH — path quality.** Mean of two ranks over t−252→t−21:
   (a) rank(−FIP), FIP = sign(r12-1) × (%negative days − %positive days),
   non-zero-return days only; (b) rank(iMOM IR) = Σ(daily residual vs SPY)
   / (σ_residual·√N), residual = stock return − β·SPY return, β from the
   same window. Smooth, self-propelled climbs score high; jumpy,
   beta-driven moves score low.
3. **HIGH GROUND — 52-week-high proximity.** `close / max(high, 252d)`,
   ranked.
4. **COILED SPRING — contraction/entry readiness.** Mean of three ranks:
   ATR14/ATR63 (lower better), 10d high-low range as % of close (lower
   better), vol10/vol63 volume dry-up (lower better) — then multiplied by
   an extension damper: 1.0 if close ≤ 15% above SMA50, linearly → 0 at
   35% above (never buy the parabola).
5. **INSIDER EDGE — opportunistic conviction (0-100, raw).** From Form-4
   open-market purchases (code P, officer/director roles, ≥ $25k,
   filingDate−transactionDate ≤ 30d), decay weight w = max(0, 1−age/180d)
   from filingDate: +40·w latest qualifying buy; +25·w if ≥2 distinct
   buyers in 90d; +15·w if ≥3; +10·w if CFO/CEO/Chair among them; +10·w if
   net 90d buys ≥ $250k; −25 if ≥2 distinct sellers ≥ $1M aggregate in
   90d. Clipped 0-100.

`FABLE = 0.2·(P1 + P2 + P3 + P4) + 0.2·P5`, reported with its
**percentile among gate-passers** — the percentile is the tradable
number; the raw composite is internal.

### Quality veto (live tilt only — never in the survival test)

From fundamentals when available: GP/A = (revenue−COGS)/assets and ROA.
Both in the universe's bottom quintile, or ROA<0 with top-quintile
leverage ⇒ composite × 0.8, flag `junkVeto`. Missing fundamentals ⇒ no
adjustment, flag `_noData`. In PIT mode the veto only applies when Massive
PIT statements resolve; otherwise skipped.

### Regime overlay (surfaced, not score-mangling)

`regime: 'offense' | 'defense' | 'panic'` on every snapshot:
defense = SPY < SMA200(SPY); panic = trailing 24-mo SPY return < 0 AND
21d SPY realized vol in top decile of trailing 5y (Daniel-Moskowitz
momentum-hostile state). UI shows the flag and the standing rule: no new
entries in defense; in panic, momentum is historically broken — sit out.

### Position discipline (displayed with every pick)

Entry: pivot break (10d high) or pullback-to-20d-EMA in trend. Initial
stop: max(8% below entry, below 10d low). Banding: a name enters the book
at percentile ≥ 90 and exits below 60 (hysteresis — the only cost control
that reliably pays). Max hold 126 trading days without re-qualifying.
15-25 names, equal weight, sector cap 30%. Disaster stop 15-20%.

### Honest presentation

Every pick shows: percentile, pillar breakdown, entry/stop, and a verdict
chip. Until the backtest completes the chip is **PENDING — unvalidated**.
After it completes the chip shows the measured spread (either way). No
naked "87/100" implying precision the IC cannot support.

---

## PRE-COMMITTED VALIDATION RULE (binding; written 2026-07-13, before any run)

Backtest: `board=fable`, sp500, 2018-01-31 → 2024-12-31, monthly
rebalance, discreteSignalOnly=true (gate-fail null = valid no-trade),
benchmark SPY, round-trip cost 20bps (FIX-1 sp500 cost model). PIT inputs:
bars + insider filings only (quality veto inactive unless Massive PIT
resolves; never required).

**FABLE is VALIDATED iff ALL THREE hold:**
1. Net total return (after costs) > SPY total return over the window;
2. IC of composite vs forward 1-month returns > 0;
3. t-stat of mean monthly active return ≥ 2.0.

Consequences: pass ⇒ verdict VALIDATED with the measured edge on the chip.
Fail any ⇒ verdict **NO_EDGE**, FABLE ships as a labelled screener exactly
like Target — still useful, never claiming validated alpha. There is no
third outcome and no post-hoc re-tuning: the constants in
`shared/fable-scoring.ts` at the commit introducing this file are the
constants under test. Russell2k, when run later, is reported alongside but
sp500 is decisive (matches FIX-1 precedent).

Expected honest outcome per the research (post-publication haircuts, VW
large-cap universe, net of costs): low-single-digit annual active return
with materially lower drawdown via the gate — if the backtest shows a
monster edge, suspect the test before believing the number.

---

## VALIDATION RUN LOG (append-only; no edits above the rule after launch)

**Live scan (first real picks):** 2026-07-13T20:18Z, deploy-preview-109.
498 sp500 names checked, **100 passed the FOUNDATION gate**, regime
OFFENSE. Top of board: CNC 56.7, CVS 53.3, VLO 51.1, MNST 50.3,
TRGP 49.8. Insider Edge ≈ 0 across most of the board — expected:
opportunistic insiders buy dips, not names within 25% of 52w highs
(design.md § Insider Edge; sparse-but-high-signal by construction).

**Backtest attempts (spec identical each time — infra changed, never
the algorithm):**

| # | runId | outcome | finding |
|---|---|---|---|
| 1 | `bt_20260713202030_y7l6m8` | dead at 15-min cap before first checkpoint | fable per-rebalance cost is Finnhub-bound (insider per gate-passer @55rpm); default batch 8 cannot fit the window. Also: null-cursor zombies were unrecoverable AND invisible to the sweep. Netlify queue-RETRIED the dead invocation ~30 min later. |
| 2 | `bt_20260713205837_oyb66q` | killed (contaminated) | ran fine on batchSize=2, but attempt 1's queue retry contended for the shared 55rpm bucket → 98 insider TickerFailures on rebalance #1 (visible ONLY because the M8 throw discipline replaced `.catch(()=>[])`). |
| 3 | `bt_20260713212426_hs37nm` | killed (contaminated) | 47 failures on rebalance #1 SOLO — root cause the token bucket's full-bucket cold start: ~55 instant tokens ⇒ one-second burst ⇒ Finnhub short-window 429 storm ⇒ 3.5s default retry envelope exhausts. Every invocation restarts the bucket ⇒ every batch boundary bursts. |
| 4 | `bt_20260713215334_w80rb8` | **RUNNING — the validation run** | fixes live: batchSize=2 (per-run config), initialTokens=8 (burst cap), ~50s patient insider retry, terminal-status guard (kill switch + retry immunity), zombie fail-out in the sweep. First batch: 6/1018 failures (0.6%, prod-cron overlap minute) — misses bias the measurement AGAINST fable, i.e., conservative. |

Infra shipped because of this validation (all on `fable/board`):
`batchSize` in BacktestConfig; terminal-status guard in the runner;
null-cursor zombie fail-out in `recoverStuckBacktestRuns`;
`initialTokens` on the token bucket (Finnhub starts at 8); patient
retry envelope on the insider PIT fetch. Every failure mode above was
*visible* because failures throw instead of caching empties — the
4t-W1c lesson, honored.
