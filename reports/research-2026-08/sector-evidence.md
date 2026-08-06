# Sector context on a stock profile: what the evidence supports

Research pass, 2026-08-07. Commissioned to test the thesis: *"if the sector
is doing well, and the stock has good fundamentals and technicals, the stock
is likely to do well."*

## Verdict: right direction, wrong metric

| Claim | Verdict |
|---|---|
| Sector strength predicts *sector* returns (6–12m) | True 1963–1995; **not measurable 2001–2018** |
| A stock's strength **relative to its own sector** predicts its returns | **Strong** — replicated, out-of-sample, global, ~2× Sharpe |
| Sector strength and stock quality **interact** | **Unsupported.** No measured interaction anywhere. |

**The value is not in showing how the sector is doing. It is in showing how
the stock is doing relative to its sector.**

## Sector momentum: decayed

Moskowitz & Grinblatt (1999) found IM(6,6) = +0.43%/month and IM(12,1) =
+0.66%/mo (t=3.11). But in their own Table III, **IM(6,1) is +0.08%/mo
(t=0.41)** — and IM(6,1) is closest to how anyone would actually use it.

Grundy & Martin (2001): with a standard one-month gap between formation and
holding, **industry strategies produce no momentum profits.**

Grobys & Kolari (2019), 48 FF industries, **May 2001 – Feb 2018** — the
genuinely out-of-sample window:

| Strategy | Return/mo | t |
|---|---|---|
| 1–0–1 | 19 bp | 0.64 |
| 6–1–1 | 9 bp | 0.37 |
| 12–1–1 | 34 bp | 0.84 |

None significant. Live sector-rotation ETFs (XLSR, SECT) meet or trail SPY.

**Where it survives:** Hoberg & Phillips (2018, JFQA) using text-based
industry classification from 10-K product descriptions — TNIC momentum is
robust to 12 months and *stronger* than own-firm momentum, while SIC/FF-48
"generally loses significance." Mechanism is **inattention to less-visible
peers.** Implication: the surviving alpha lives in the peer set investors
cannot see. **A GICS sector badge is the most visible peer grouping in
existence — definitionally the half that no longer pays.**

## Stock-vs-own-sector: the strong finding

- Blitz, Huij & Martens (2011): residual momentum earns **~2× the
  risk-adjusted profit** of conventional momentum — comparable raw returns at
  roughly half the volatility, markedly reduced crash risk.
- Huij & Lansdorp (2017): holds **2009–2015**, post-publication, globally.
- Blitz, Hanauer & Vidojevic (2020): global across developed *and* emerging
  markets; near-doubling of Sharpe; priced after controlling for known
  factors.
- Blitz et al. (FAJ 2023): a reversal factor's alpha goes from **37bp
  (t=3.02) to 74bp (t=9.24)** purely by measuring the stock against its
  industry instead of the market.
- Ehsani, Harvey & Li (2023, FAJ): average long–short factor Sharpe
  **within-sector 0.53 vs across-sector 0.10**.

Cheap defensible approximation: **stock 12–1m return minus sector ETF 12–1m
return** (the Asness-Porter-Stevens "within-industry" construction).

## One genuine argument for showing sector context

Ehsani, Harvey & Li (2023) find that for **long-only** investors — which is
this app's user — the sector component's Sharpe ratio is **0.93× the
firm-specific component's**, and "the as-is factor always earns a higher
t-value than its sector-neutral version." Sector context is informative for
long-only. Caveat: the two components are **0.75 correlated** — substantially
redundant, not additive.

## Skip

- **Sector rotation clock / business-cycle map — folklore.** Molchanov &
  Stangl: give the investor **perfect foresight of NBER turning points and
  zero costs** and conventional rotation earns +0.11%/mo with *worse* Sharpe
  than buy-and-hold. Under FF3/Carhart-4, **zero of 48 industries** show
  significant outperformance in their predicted stage. Of all **1,022**
  possible rotation variants, only 3.4% beat naive market timing. 2,160
  cross-sector lead-lag regressions: 6% positive / 5% negative — noise.
- **"#1 sector" badges.** Rank among 11 series with 0.40–0.92 pairwise
  correlation is mostly noise, and it converts a noisy continuous quantity
  into something that looks more certain than it is. Adds no information over
  the underlying relative return.
- **Sector 1-day/1-week/1-month move as evidence.** MG's IM(1,1) is the
  strongest in-sample industry effect ever measured *and* untradeable — dies
  on a skip month, 19bp/t=0.64 post-2001, turnover-prohibitive by MG's own
  admission. Show as news.
- **Any sector multiplier on a stock score.** Components test as
  independent/additive. **There is no measured interaction term to
  implement.**
- **RRG / four-quadrant widgets** on a single-stock page — the vendor
  (StockCharts) explicitly documents that RRGs "are not a trading system."

## Horizon warning

Industry effects **continue at 1–12 months and reverse at 2–5 years**
(Moskowitz & Grinblatt's own IM(24,36) is negative; *Journal of Banking &
Finance* 2016 finds losing industries beat winning industries over the
following five years). A "hot sector" badge is a buy signal on a 6–12 month
horizon and a sell signal on a 3–5 year horizon. Most retail users hold for
years.

## What shipped (SECTOR-1, revised)

- **Stock vs its own sector, at the top of the panel** — the Tier-1 item
- Sector return and vs-SPY at 6M/12M as evidenced context; 1M/3M visually
  demoted to "context"
- Above/below 200d as trend-quality, not a score
- **Removed after this research:** the sector rank row ("#2 of 11") with its
  top-third/bottom-third colour coding — a Tier-3 item that presented noise
  as certainty
- No multiplier, no composite, no rotation clock

## Before any of this becomes a signal

1. Backtest **stock-minus-sector 12–1m with a one-month skip** and real
   costs. Only Tier-1 item likely to survive.
2. Backtest sector 6m/12m vs SPY on **2001-onward only**. Expect failure.
3. Test the interaction explicitly with a 2×2 double sort. Prior: no
   interaction. If confirmed, never ship a multiplier.
4. **Do not test the rotation clock.** It has been tested to exhaustion.
