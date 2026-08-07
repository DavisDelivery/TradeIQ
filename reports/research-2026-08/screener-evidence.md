# Screener evidence: what replicates, what decayed, what was never real

Research pass, 2026-08-07. Commissioned after all seven ranking boards were
measured and none beat buy-and-hold. Question: which screening approaches
have real out-of-sample evidence, and which failed after publication.

## The number that should govern product decisions

Seven boards failing is the **expected** outcome, not an anomaly.

| Source | Scope | Finding |
|---|---|---|
| Hou, Xue & Zhang (2020, RFS) | 447 anomalies, NYSE breakpoints, value-weighted | **64% insignificant** at t<1.96; **85%** at t<3. Survivors' magnitudes "often much lower than originally reported." |
| McLean & Pontiff (2016, JF) | 97 predictors | **26% lower** out-of-sample, **58% lower** post-publication |
| Harvey, Liu & Zhu (2016, RFS) | 316 factors | Need **t > 3**, not 2. 27–53% of published anomalies are false discoveries. |
| Research Affiliates | live smart-beta | **+2.77%/yr before launch, −0.44%/yr after.** Median **73% Sharpe deterioration** backtest → live. |
| Chen, Lopez-Lira & Zimmermann | peer-reviewed vs 29,000 mined ratios | Peer review confers **essentially no post-sample advantage** over brute-force mining at t>2. |

HXZ's decisive lever is microcaps: 3% of market cap, 60% of the stock count.
Equal-weighting overweights them massively. **We cannot trade microcaps, so
HXZ's universe is our universe and 64–85% is the failure rate to design
against.**

## Survives

1. **Momentum, 12-1 with a one-month skip** — best-replicated anomaly.
   212 years of US data, 40 countries (Asness et al. 2014). Best HXZ
   survivor. Cost: real, recurring crashes (Daniel & Moskowitz).
2. **Cash-based operating profitability** — survives HXZ *and* the q-factor
   model. QMJ positive in 23 of 24 countries. Low turnover, large capacity.
   **Definition is load-bearing:** Fama-French (2015) operating
   profits-to-*book-equity* FAILS replication. Use cash-based.
3. **Composite value** (EV/EBIT, FCF yield, sales-to-price) — premium likely
   intact; the *book-to-market operationalisation* is what broke (13.3-year,
   55% drawdown; Arnott et al. 2021 attribute it to spread-widening plus
   intangibles, not structural decay).

## Combinations beat single factors — the most robust product finding

- Value and momentum are **negatively correlated (−0.5 to −0.6)**; a 50/50
  blend reaches **Sharpe 0.80**, roughly double value alone (Asness,
  Moskowitz & Pedersen 2013).
- **Integrated** scoring beats two independent sleeves (Fisher, Shah &
  Titman 2016) — lower turnover, avoids buying names good on one signal and
  terrible on the other.
- **Order is asymmetric:** splitting a value portfolio by momentum adds
  value; splitting a momentum portfolio by value does not.

## Dead — do not ship

Altman Z-score / Ohlson O-score (HXZ: distress predictability "virtually
nonexistent") · idiosyncratic, total and systematic volatility (all fail) ·
Amihud illiquidity and the trading-friction family (**95 of 102 fail**) ·
broad accruals (Green, Hand & Soliman) · short-term reversal (Jegadeesh
1990) · size as a standalone · PEAD in large caps (zero by ~2006;
Martineau 2022) · Gompers-Ishii-Metrick governance · any signal whose edge
lives in the bottom 3% of market cap.

**Checked against this repo:** none of the seven retired boards used these.
The failure was not signal selection.

## The practitioner gap — paper vs real money

**CAN SLIM.** AAII's paper screen: **+24%/yr**. FFTY, the real-money
IBD-methodology ETF: **5.2%/yr since inception, −7.14% annualised alpha**,
Sharpe 0.37 vs SPY 0.74, downside capture 138% against upside 104%. The
entire gap is costs, slippage, capacity and the difference between a
monthly-rebalanced spreadsheet and a portfolio. **Never publish an
AAII-style number for a strategy whose live analogue looks like this.**

Also measured: AAII's own base rate is **17 of 55 screens beating the S&P
over 5 years** (~29%). Magic Formula's famous 30.8%/yr does not replicate —
independent tests find ~+3%/yr alpha. Minervini's contest wins are audited;
the "220%/yr" figure is self-reported to an author. Qullamaggie has **no
audited record found** — treat as marketing. Dreman's fund beat its peer
group for a decade, then returned 2%/yr and lost 46% in 2008 holding Fannie,
Freddie, Wachovia and WaMu — the value-trap failure mode. **Never ship a
cheapness-only screen.**

## Recommended build

1. Integrated quality-value (cash-based operating profitability × composite
   cheapness)
2. Momentum 12-1 **with the skip**, liquid universe, 30–50 names
3. Value-then-momentum, sequenced in that order, integrated scoring
4. Sector-ETF momentum on intermediate windows (see `sector-evidence.md`)
5. *Stretch:* text-similarity peer momentum — the only version of industry
   momentum surviving Grundy & Martin

## Product guardrails

- **Haircut every backtest ~50%** before display (Chen/Lopez-Lira/Zimmermann)
- **Never display a gross-of-cost number** — the FFTY gap is what that does
- **t > 3 for anything discovered internally**, not t > 2
- **Set IC expectations honestly:** documented factors sit at **0.02–0.05**.
  Above 0.10 on a large universe usually means look-ahead bias or
  overfitting. The negative ICs we measured were *correct measurements*; the
  error was expecting a large positive one.
- **The measurement harness is the asset.** Publish live screen performance
  from day one, not backtests.

## Unresolved conflicts, flagged rather than papered over

- **Piotroski F-Score:** international peer-reviewed evidence shows ~10%/yr
  spreads through 2018; a specific US measurement finds the spread **negative
  9.5%/yr over 10 years**. Do not ship as a headline US screen without
  re-measuring.
- **Investment / CMA:** HXZ replication favourable; CFA Institute's
  five-factor review says it dissipated after 2004.
- HXZ per-category replication rates circulating in secondary sources
  (87.7% momentum etc.) could not be confirmed from the primary text and do
  not reconcile with its 64% headline. Only the ordering is used here.
