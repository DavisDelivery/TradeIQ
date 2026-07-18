# TRIDENT — near-term picker: fundamentals × technicals × institutional flow, regime-aware

**Mandate (Chad, 2026-07-18):** stocks with really strong fundamentals,
growth prospects, and technical setups likely to go up in the NEAR TERM;
track whether institutions/hedge funds are buying each name; universes
S&P 500 + Russell 2000; factor in whether NQ and SPX are overbought/
oversold or near support/resistance.

**Horizon locked: 21–63 trading days (1–3 months).** Rationale: our own
FABLE-2 measurements found rank-IC positive at 63d and NEGATIVE at 21d
for momentum-flavored signals; 13F cadence is quarterly; the strongest
fundamental signals below peak at 1–3 months. "Near term" shorter than
this fights our own evidence.

**Sequencing locked: ship as labelled screener fast, pre-committed
backtest stamps the verdict behind it** (the FABLE pattern). Robinhood
execution is now live in the app — pick quality is actionable, so the
NO-EDGE-until-proven labeling discipline matters more, not less.

Name: three prongs — **F**undamental thrust, **T**echnical setup,
**I**nstitutional accumulation — on one regime-aware shaft.

---

## 1. Research base (2026-07-18 fan-out, four agents; citations in §8)

The design uses ONLY signals that survived a skeptical, post-publication-
decay-aware review, measured at OUR horizon, ex-microcap. One-line
verdicts:

**Fundamental (21–63d):**
- Earnings ACCELERATION (ΔQoQ of YoY EPS growth): the best-documented
  1–3mo fundamental signal — ~1.5%/mo value-weighted in-sample, survives
  ex-microcap (He–Narayanamoorthy 2020). Haircut for post-publication.
- Estimate-revision momentum (breadth of up vs down revisions): 0.3–0.5%/mo
  gross ex-micro, front-loaded months 1–3, stronger in small caps
  (Chan–Jegadeesh–Lakonishok 1996; HXZ replication survivor).
- Monthly-refresh quarterly ROE + gross profitability: slow quality tilt,
  works via sticky analyst expectations (Bouchaud et al. 2019).
- PEAD/SUE drift in large caps: DEAD since ~2006 (Martineau 2021 — and
  our own FIX-2 study measured the broad S&P earnings-event population
  at t = −6.5 net of costs). Announcements are info events here, not
  drift trades.
- Revenue-surprise drift in large caps: never existed (Jegadeesh–Livnat).
  F-score as a monthly timing signal: fails value-weighted (HXZ).
  Quality-screening the SMALL-CAP sleeve: justified (Asness et al. 2018).

**Technical (2–13 weeks):**
- 52-week-high proximity: the strongest-evidenced setup (George–Hwang
  2004; no long-horizon reversal). Already implemented for FABLE.
- MA-distance (short MA vs 200d) predicts cross-sectionally beyond
  momentum (Avramov et al.). Uptrend condition is the payoff-relevant
  state (Cooper–Gutierrez–Hameed 2004).
- Volume shocks carry a 1–20 day premium (Gervais–Kaniel–Mingelgrin
  2001); volume as CONDITIONING is real, IBD-style ratio thresholds are
  folklore.
- Breakout systems earn their alpha from <7% of trades (extreme right
  skew, Zarattini et al. 2025); breakout failure rates roughly DOUBLE in
  choppy tape (Bulkowski). Pullback-in-uptrend entries: higher hit rate,
  smaller tails. → entry-type MIX should depend on chop state.
- RSI(2) washouts: a days-horizon ENTRY-TIMING tactic within uptrends,
  never a 1–3mo selection factor.

**Institutional (the "smart money" axis):**
- LIVE 13D activist filings: the best per-stock institutional signal at
  our horizon — event-dated (5 business days), ~+1–2% one-month
  post-filing drift with no long-run reversal (Brav et al.). Weight it
  highest.
- Curated 13F conviction: consensus×conviction positions (≥5–7.5% of
  book) of CONCENTRATED fundamental-equity funds beat SPX ~+3.8%/yr and
  survive the 45-day lag (Angelini–Iqbal–Jivraj 2019; Antón–Cohen–Polk
  2021). Unfiltered hedge-fund universe: alpha ≈ 0. Fund curation is the
  signal.
- Multi-fund same-quarter initiations: additive, BUT carries crowding
  left-tail (2021 degrossing) → penalize high HF-ownership × high short
  interest.
- Ownership-breadth declines: a negative flag (Chen–Hong–Stein), not a
  primary signal.
- Timestamps by EDGAR ACCEPTANCE datetime, never period-end. Naive
  AUM-weighted cloning: dead (Lewellen 2011).

**Index regime (NQ + SPX — Chad's explicit ask):**
- Trend filter (price vs 200dma) conditioning entries: strong evidence
  (Faber drawdown-halving; CGH04 momentum-only-in-up-states).
- Continuous vol scaling beats binary gates (Barroso–Santa-Clara,
  Moreira–Muir).
- Momentum crashes concentrate in high-vol REBOUNDS after bear markets
  (Daniel–Moskowitz) → dedicated crash-regime detector.
- RSI(14) "overbought" does NOT predict negative 1–4wk returns —
  overbought = trend strength. It must not gate entries; it is context.
  Deep oversold WITHIN an uptrend = better entry timing.
- Breadth washouts (<~20% above 200dma) precede strong returns
  (asymmetric); McClellan Oscillator: noise (CXO), skip.
- S/R from daily bars: prior 52w/N-day extremes and round numbers are
  real but small effects (Osler; Huddart et al.); Donchian channels are
  a validated rule class; "bounces off the 50dma" are folklore.

## 2. Board spec

**Universes:** `sp500` and `russell2k` (separate boards, same engine).
**Gate (eligibility, all must pass):**
- price > $3; 20d median dollar volume > $2M (r2k) / $10M (sp500);
- UPTREND: close > 200dma AND 200dma slope over 21d ≥ 0 (CGH04/Faber);
- small-cap sleeve only: quality floor — trailing-4q gross profit > 0
  AND positive trailing-4q operating cash flow (junk screen, Asness).

**Three pillars, each 0–100 (percentile within universe):**

**F — Fundamental Thrust (weight 40):**
- f1 EarningsAcceleration (35% of F): ΔQoQ of YoY quarterly EPS growth,
  last 8 quarters (data: Finnhub /stock/earnings, already live-cached).
- f2 SurpriseQuality (20%): latest SUE vs consensus + CAR3 sign
  agreement (announcement as info event, not drift chase).
- f3 RevisionMomentum (25%): breadth of analyst revisions/actions over
  60d — from recommendation-trend deltas + upgrade/downgrade events at
  our Finnhub tier; upgraded to true estimate-revision deltas as our
  daily estimate snapshots accrue (§4).
- f4 QualityTrend (20%): quarterly ROE level + 4q trend, gross margin
  trend (data: Massive statements, already integrated).

**T — Technical Setup (weight 35):**
- t1 HighGround (30% of T): proximity to 52w high (reuse FABLE).
- t2 TrendQuality (25%): MAD (21d MA vs 200d MA distance), RS slope vs
  benchmark (SPY/IWM).
- t3 Coil (25%): consolidation tightness + volume dry-up (reuse FABLE
  coiledSpring); classifies the entry as BREAKOUT (pivot above tight
  range) or PULLBACK (retrace toward rising 21/50d in uptrend) and
  emits pivot + stop levels.
- t4 VolumeEvidence (20%): recent volume-shock days in the direction of
  trend (Gervais), up/down-volume balance 21d (conditioning, no magic
  thresholds).

**I — Institutional Accumulation (weight 25):**
- i1 ActivistLive (40% of I): open 13D (whitelisted activist CIKs) on
  the name, scored by recency (full weight <30d from acceptance,
  linear decay to 0 at 180d; amendments refresh; exit filings kill).
- i2 ConvictionAdds (30%): curated-fund 13F new/increased positions at
  ≥5% of filer book, decayed linearly from acceptance date to 0 at
  135d. Curation rule (frozen): fundamental-equity filers, 8–60
  positions, top-10 ≥40% of book, 13F AUM $500M–$20B, turnover
  bottom-half.
- i3 ClusterBonus (15%): ≥2 curated funds initiating same name same
  quarter.
- i4 CrowdingPenalty (−15% cap): high short interest (Massive
  short-interest endpoint) × high institutional share of float →
  subtracts; breadth-decline flag suppresses the "accumulating" label.
- i5 InsiderCorroboration (15%): open-market insider buys 90d (existing
  free Finnhub path, live-cached).
- Until the EDGAR pipes are populated (§4 phases), I renders with an
  explicit "warming up — activist/13F feeds backfilling" state and the
  composite reweights to F 53 / T 47 pro-rata. No fake zeros.

**Composite:** weighted percentile blend, displayed with per-pillar bars
and the full FABLE-style dossier (chart with pivot/stop lines, legend,
plain-language explainers). Verdict chip: SCREENER until the §5 bar is
met — never VALIDATED by default.

## 3. Regime module (the NQ/SPX panel — server-computed nightly)

Per index (QQQ→NQ proxy, SPY→SPX proxy, IWM for r2k context), from
Polygon daily bars:
- TREND: above/below 200dma + 21d slope sign → UP / DOWN / FLAT.
- STRETCH: RSI(14) and RSI(2); %distance from 20d high/low (Donchian
  20 and 55); realized 21d vol percentile vs 2y.
- SUPPORT/RESISTANCE levels (displayed with distances): prior swing
  high/low (10d pivot definition), Donchian 20/55 bounds, 50/200dma
  values, nearest round-number century level. Labeled honestly as
  reference levels, not predictions.
- BREADTH: % of universe constituents above 200dma (computed from our
  own bars; accrual starts at first deploy).
- CRASH-REGIME flag (Daniel–Moskowitz): index >15% below 252d high
  within past 63d AND vol percentile >80 → "rebound risk" state.

**Pre-committed modulation (what regime DOES to picks):**
1. HARD GATE: index trend DOWN (below 200dma) for a stock's benchmark →
   no NEW entries in the tracked book for that universe (display-only
   picks still shown, flagged).
2. SIZE SCALAR: position size × min(1, 12% ÷ annualized realized vol of
   the index) (Moreira–Muir style, capped at 1).
3. ENTRY MIX: chop state (FLAT trend + vol percentile >60) → breakout
   setups demoted 15 composite points, pullback setups favored;
   crash-regime flag → breakout entries suppressed entirely for the
   flag's duration (Daniel–Moskowitz).
4. RSI(14) overbought/oversold and S/R distances: DISPLAY ONLY. Deep
   oversold (RSI(2)<10) while trend UP renders "pullback window" as
   context on pullback-classified setups. Overbought NEVER gates.

## 4. Data plumbing (phased; reuses existing infra)

- **P1 (regime + F/T board):** Polygon bars + Massive statements +
  Finnhub earnings/insider — ALL EXISTING, all behind provider-live-cache.
  New: regime computer, trident scorer, scan workers (background,
  sieve-style for r2k), snapshot-store board 'trident'.
- **P2 (institutional):** reuse vector's `edgarFetch` (patient backoff,
  proper UA) + 13F parsing. New: (a) 13D watcher cron — EDGAR daily
  form index + intraday Atom (SC 13D/13D-A), whitelist match, acceptance
  timestamps → Firestore `tridentActivist`; (b) quarterly 13F ingest —
  bulk Form 13F Data Sets TSV for backfill, per-filing XML for the
  current quarter; curated-fund list per frozen rule; CUSIP→ticker map
  via OpenFIGI/Polygon reference; (c) short-interest fetcher (Massive,
  all-plans endpoint, bi-weekly).
- **P3 (revisions upgrade):** nightly estimates snapshotter (whatever
  tier allows) accrues our own revision history; f3 upgrades from
  recommendation-deltas to true estimate deltas when ≥60d accrued.
- EDGAR from Netlify shared egress rate-blocks (vector lesson): ≤5 r/s,
  declared UA, bulk files preferred, cursor-resume background jobs.

## 5. Pre-committed validation rule (BINDING — written before any result)

Backtest via the policy-mode engine (banding entry ≥90th pctile / exit
<60th, maxHoldDays 63, stop 10%, slippage 10bps/leg, monthly
checkpoints, regime modulation §3 active, F+T axes only until
institutional backfill is complete — the I axis joins as a variant, not
a re-tune):
- TRAIN 2018-01-01→2023-12-31, ≤15 logged runs, hard endDate clamp.
- HOLDOUT 2024-01-01→2026-06-30, SINGLE-SHOT, fired once on the frozen
  config.
- PROMOTION BAR (all three): holdout net > SPY total return; holdout
  rank-IC63 > 0; combined-window monthly-active t ≥ 2.0.
- Meets all three → VALIDATED chip. Fails any → ships/stays as labelled
  SCREENER with the measured numbers printed on the board, and a
  6-month live forward test (fable2-live-track pattern) becomes the
  only path to promotion. No third outcome; no post-hoc re-tuning.
- Institutional variant: when 13D/13F backfill lands, ONE additional
  holdout run of F+T+I (same window, same bar) — if it beats F+T on
  holdout net AND clears the bar, it becomes the tracked config;
  otherwise F+T remains. Logged here either way.

## 6. What TRIDENT deliberately does NOT do

No PEAD drift chasing in large caps (our own study + Martineau). No
F-score timing. No McClellan. No overbought gating. No naive 13F
cloning of mega-funds. No revenue-surprise drift in large caps. No
untested VCP mysticism beyond the measurable tightness/volume-dry-up
FABLE already computes. No VALIDATED language before §5 is met.

## 7. Delivery phases

- W1: this doc committed → regime module + scorer (pure, tested) →
  scan workers + board endpoints → TridentView tab (replaces Vector
  slot) with regime panel + dossier integration. Ships as SCREENER.
- W2: 13D watcher + short interest + curated-fund frame; "Smart Money"
  per-stock panel goes live with real activist/13F rows as they ingest.
- W3: 13F backfill (2013→present bulk TSVs) + estimates snapshotter.
- W4: train runs → freeze → single-shot holdout → verdict on the board.

## 8. Source register (abbreviated)

George–Hwang JF 2004 · He–Narayanamoorthy JAE 2020 (SSRN 3057632) ·
Chan–Jegadeesh–Lakonishok JF 1996 · Hou–Xue–Zhang RFS 2020 ·
McLean–Pontiff JF 2016 · Green–Hand–Zhang RFS 2017 · Martineau CFR 2021
· Novy-Marx 2015 (FMFM) · Bouchaud–Krüger–Landier–Thesmar JF 2019 ·
Asness et al. JFE 2018 · Antón–Cohen–Polk JF 2021 · Angelini–Iqbal–
Jivraj 2019 (SSRN 3459526) · Brav–Jiang–Partnoy–Thomas JF 2008 (+2019
update) · Chen–Hong–Stein JFE 2002 · Yan–Zhang RFS 2009 · Lewellen JFE
2011 · Griffin–Xu RFS 2009 · Cooper–Gutierrez–Hameed JF 2004 ·
Daniel–Moskowitz JFE 2016 · Barroso–Santa-Clara JFE 2015 · Moreira–Muir
JF 2017 · Faber 2007/2013 · Gervais–Kaniel–Mingelgrin JF 2001 ·
Lee–Swaminathan JF 2000 · Avramov et al. (MAD) · Zarattini–Pagani–
Wilcox 2025 (SSRN 5084316) · Osler FRBNY 2000 / JF 2003 ·
Huddart–Lang–Yetman 2009 · Sullivan–Timmermann–White JF 1999 · SEC
33-11253 (2023 13D/G acceleration) · full URLs in the research-agent
transcripts (session 2026-07-18).

## VALIDATION RUN LOG (append-only below this rule after launch)

(empty — first entry will be the first train run)
