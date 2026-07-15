# VECTOR — design + pre-committed validation rule

**Author: Claude (claude-fable-5).** Follow-on to FABLE
(reports/fable/design.md, verdict NO_EDGE, 2026-07-14). Chad's
directives: event-driven, Russell-2000-inclusive, fundamentals and
entry timing surfaced as a two-axis verdict on any ticker. Written
**before** any backfill or backtest number exists. The validation
rule at the bottom is binding (FIX-1/FIX-2/FABLE precedent).

## Thesis — what FABLE's failure taught

FABLE measured that continuous cross-sectional momentum ranking
carries no edge net of costs (IC -0.017, -73pp vs SPY). What it could
not test: discrete information events and the speed of their
diffusion. VECTOR trades diffusion lag. An identified actor — the
company reporting, an officer buying with his own money, an activist
crossing 5% — injects new information at a federally timestamped
moment. The documented anomalies (PEAD: Bernard-Thomas; insider
clusters: Cohen-Malloy-Pomorski, Lakonishok-Lee; 13D drift:
Brav-Jiang-Partnoy-Thomas) are the market's slow absorption of that
information, strongest where coverage and institutional capacity are
thinnest (Hong-Lim-Stein; Mendenhall; Chordia et al.) — small caps.
VECTOR does not rank the universe. It sits flat until an event fires,
matches the event to its historical cohort, and reports the empirical
forward distribution. The library is the product.

## Universe (PIT, survivorship-proof)

No index membership anywhere. At each event date t: all US common
stocks in Polygon's full universe **including delisted tickers**, with
close >= $5, >= 287 daily bars, and 63d median dollar volume >= $2M,
all measured at t. Size buckets at t: LARGE >= $50M median $vol,
MID $10-50M, SMALL $2-10M ("Russell 2000" is the SMALL+MID band,
reconstructed by rule, dead companies included). Delisting handling:
positions close at the last available print — bankruptcy at that
price, buyout at that price — never dropped from the sample.

## Events

Every qualifying event is stored in vector_events with all state
features computed strictly from data filed or printed on or before
the event date. Live cards and backtests read the same rows.

**E1 — Earnings surprise.** Every report with >= 12 quarters of
split-adjusted reported EPS. SUE = (EPS_q - EPS_{q-4}) / sigma of the
last 8 seasonal differences. Event day d = the trading day the report
is public (AMC on calendar day c => d = next trading day; BMO => d =
c). Reaction = market-adjusted return close(d-1) -> close(d) vs SPY.
VolumeShock = vol(d) / median63 vol. All earnings events stored;
cohorts are query-time. Live display trigger ("agreement"):
SUE >= +1.5 AND reaction >= +2% AND VolumeShock >= 2.
Honest flag: Martineau (2021) — large-cap prices now absorb earnings
nearly fully at announcement; E1 may measure dead in LARGE. Either
result is a finding.

**E2 — Insider cluster in drawdown.** Form 4 open-market purchases
(code P), officer/director, >= $25k, filingDate - transactionDate
<= 30d. Routine screen per Cohen-Malloy-Pomorski: exclude insiders
whose purchases fall in the same calendar month in >= 3 consecutive
prior years (Form 4 backfill from 2013-01-01 serves the lookback; if
rate limits force it, reduced screen = same-insider-same-month in
prior 2 years, flagged routineScreen:'reduced'). Cluster event fires
on the filing date the 2nd distinct qualifying buyer appears within
trailing 90d, gated to close <= 0.80 x max(high, 252d) at that date —
insiders buy dips; FABLE proved the two regimes never overlap. Sell
context stored: >= 2 distinct sellers >= $1M aggregate 90d =>
sellCluster.

**E3 — Activist stake initiation.** Initial SC 13D filings from EDGAR
daily indexes, subject-company CIK mapped to ticker. Event date =
filing date. Structural break: the filing deadline moved 10 -> 5
business days (compliance Feb 2024); pre/post reported descriptively.

**Phase 2 (shadow-logged live only, never backtested from vendor
news):** buyback 8-Ks, earnings-call tone.

## State features (conditioners, at event date t)

trendState (close vs SMA200; SMA50 vs SMA200 — the golden-cross
question rides free here), extension (close/SMA50 - 1), contraction
(ATR14/ATR63), dist52w (close / max(high,252d)), drawdown
(1 - dist52w), IVOL (sigma of daily residuals vs SPY, 63d), amihud
(mean |ret|/$vol, 63d), volumeShock, sizeBucket, sector, fscore
(Piotroski 9-point from Massive PIT statements filed <= t; unresolved
=> null + _noData, never silently), insiderNet90d, instDelta (change
in distinct 13F holders between the two most recent quarters FILED
<= t — filing dates, never period dates), shortInterest/daysToCover
(FINRA biweekly where servable <= t, else null), coverageCount
(exploratory, flagged). Cohort matcher: max 2 active dimensions,
coarse buckets — beyond that, cells empty and the library becomes an
overfitting machine with extra steps.

## Two-axis verdict (the evaluator)

The owner's requirement, formalized so it can be measured. Constants
frozen at the introducing commit.

**F axis — is it fundamentally a good buy.** Points: fscore >= 7
-> +2, 4-6 -> +1, <= 3 -> 0, null -> axis computed from the rest,
_noData shown. Latest SUE >= +1 -> +1. >= 2 consecutive positive SUE
-> +1. insiderNet90d >= +$100k -> +1; sellCluster -> -1. instDelta
>= +2 institutions -> +1. Verdict: >= 4 STRONG, 2-3 NEUTRAL,
<= 1 WEAK (max 6).

**T axis — is now a good entry.** Points: close > SMA200 AND
SMA50 > SMA200 -> +2 (close > SMA200 only -> +1). extension <= 15%
-> +1; > 35% forces POOR (never buy the parabola). contraction
<= 0.85 -> +1. regime offense -> +1; panic forces POOR. Verdict:
>= 4 GOOD, 2-3 NEUTRAL, <= 1 POOR.
**Drawdown variant** (drawdown >= 20%, the E2 context): GOOD instead
requires close > EMA20 AND a higher 5-day low ("stabilized");
extension rule waived. Buying a falling knife is POOR timing by
definition until the knife has stopped.

**Quadrants:** PRIME (F STRONG + T GOOD) · WAIT (F STRONG, T not
GOOD — right company, wrong moment) · RENT (F not STRONG, T GOOD —
trade it, don't own it) · PASS (rest). Every badge displays the
library's measured forward CAR distribution for that quadrant next
to it. The label is a claim; the distribution is the evidence; H4
decides whether PRIME means anything. Naked labels never ship.

## Presentation

VECTOR tab: live event feed, newest first. Card: ticker, event type,
quadrant badge, cohort line ("n=214 like this: median +4.1% excess
60td, 61% positive, worst decile -9.2%"), F/T pillar bars, entry and
stop, regime banner. MasterDetail -> StockDetailPanel board="vector".
Ticker evaluator: any hygiene-passing symbol -> live F/T verdict,
sub-scores, active and recent events, matched cohort stats, plain-
language legend. Display floors: n >= 30 with wide-CI warning below
100; below 30 => "insufficient history", no stats shown.

## Playbook (fixed)

Entry: next regular-session open after the event is public (uniform
t+1 open — conservative; timestamp ambiguity biases against us, which
is the direction a bias is allowed to point). Exits: E1 min(60
trading days, next earnings - 2d); E2 90td; E3 120td. Disaster stop
15% close-to-close — small caps gap through intraday stops and
pretending otherwise flatters the sim. Max 15 concurrent, equal
weight, sector cap 30%, one position per ticker. Round-trip costs by
sizeBucket at event: LARGE 20bps, MID 40bps, SMALL 80bps.

## PRE-COMMITTED VALIDATION RULE (binding; written 2026-07-14,
before any backfill completes)

Window: events 2016-01-31 -> 2024-12-31 (12q EPS history precedes;
Form 4 from 2013). CARs market-adjusted — SPY for LARGE, IWM for
MID/SMALL — net of tiered costs, delistings included as described.

Primary hypotheses — named now, capped at five. Exploratory results
are reported but can never flip a verdict.

1. **H1 (E1):** agreement cohort, MID+SMALL pooled: mean 60td net
   CAR > 0, t >= 3.
2. **H2 (E2):** cluster-in-drawdown, all buckets: mean 90td net
   CAR > 0, t >= 3.
3. **H3 (E3):** 13D initiations: mean 120td net CAR > 0, t >= 3.
4. **H4 (quadrants):** within E1, PRIME minus PASS 60td CAR
   difference > 0, t >= 2.
5. **H5 (conditioning):** E1 CAR monotone across amihud terciles
   with smallest-vs-largest spread t >= 2, AND E2 fscore>=7 minus
   fscore<=3 difference t >= 2.

Verdicts. Each event type passing its hypothesis => chip
**TRADE THE TRIGGER** with the measured distribution; failing =>
**NO_EDGE**, and that trigger ships as a labelled event monitor.
Book verdict: portfolio sim over validated triggers only; net active
return vs IWM with t >= 2 => **TRADE THE BOOK**; otherwise the book
chip stays NO_EDGE even if individual triggers pass — deployment
drag is a finding, not a footnote. Time-in-market reported with the
sim. H4/H5 failures do not kill validated triggers; they kill the
labels' claims — quadrants would remain descriptive taxonomy and the
chip would say so. There is no third outcome and no post-hoc
re-tuning: the constants in shared/vector-constants.ts at the commit
introducing this file are the constants under test. t >= 3 on the
big three because three triggers x cohorts is multiple testing, and
the bar rises with the number of ways to fool ourselves.

Expected honest outcome, in writing, before any number exists: E1
dead in LARGE (Martineau), weak-positive in MID/SMALL if anywhere;
E2 modest positive, strongest at fscore >= 7; E3 positive and the
largest per-event effect but n in the low thousands at best; PRIME a
modest, not monstrous, improvement over PASS. Small-cap results will
look better partly for honest reasons and partly because costs and
fills are hardest to model there — the spread between size buckets
is itself a credibility check. **If any cohort shows a monster edge,
suspect survivorship or a PIT leak before believing it.** In this
universe the pipeline lies more easily than the market gives money
away. Measurement outranks narrative — including mine.

## VALIDATION RUN LOG (append-only; no edits above the rule after
launch)

(empty — first entry will be the universe snapshot + backfill counts)
