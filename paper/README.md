# Trade IQ

A working social-arbitrage scanner built around the strategy Chris Camillo describes:
find consumer behaviour changing *before* the market notices, link it to a listed
company, and take the position while the information gap is still open.

The app measures three things and refuses to conflate them:

| Measure | Question it answers |
|---|---|
| **Consumer velocity** | Is real-world attention accelerating? (z of last 4 weeks vs its own 26-week baseline) |
| **Convergence** | Do independent sources agree, or is one feed spiking alone? |
| **Investor saturation** | Has the market already responded — searches for the ticker, retail chatter, volume, price? |

`SAS = 100 · sigmoid(0.95·consumer_z + 0.45·(convergence−1) − 0.65·investor_total − 0.40·price_z)`

High consumer velocity + low saturation is the trade. High saturation means the gap
has closed and you are the exit liquidity.

---

## Quick start

```bash
pip install -r requirements.txt
python3 -m tradeiq.pipeline 25000     # scan, equity $25k
python3 -m tradeiq.backtest           # 5-year event study (slow, rate-limited)
python3 build_dashboard.py            # -> out/dashboard.html
python3 app.py                        # -> http://localhost:8000
```

## Forward paper-tracking — start this today

Everything measured retrospectively in this repo was contaminated (see
"What the backtest actually found" below). Forward tracking is the only
evidence source that isn't, because the signal is written down before the
outcome exists. Every day it isn't running is evidence permanently lost.

```bash
python3 -m tradeiq.paper open      # scan, snapshot, open signal + control
python3 -m tradeiq.paper mark      # fill entries, mark matured horizons
python3 -m tradeiq.paper report    # signal vs control, clustered t-stats
python3 -m tradeiq.paper status
```

Four properties do the work, and each has a test that fails loudly if it
breaks:

- **Append-only.** Marks are written once, when the horizon matures, and
  never recomputed. Changing the scoring code tomorrow cannot rewrite
  yesterday's record.
- **Frozen inputs.** Each position stores the full scored row plus a hash,
  so you can prove what the system saw at entry.
- **Random control cohort.** Every signal draws 3 controls from the names
  scanned the same day that didn't pass the gates, via a seeded RNG.
  Without this the experiment measures "did consumer discretionary go up".
- **No look-ahead.** Entry is the close of the first session *strictly
  after* the scan. Entry price stays NULL until that bar exists.

A fifth guard is about data, not statistics: `open` **refuses** to record a
run when fewer than 60% of themes came back with consumer data. Google
Trends throttles hard, and a throttled day looks exactly like a genuinely
quiet market after the fact. It exits 2, the CI job treats that as a skip,
and the forward record stays clean.

**It has to run somewhere persistent.** A cloud dev container is reclaimed
between sessions. Either `.github/workflows/paper-track.yml` (commits the
ledger back to the repo), or cron on an always-on box:

```cron
30 17 * * 1-5  cd /path/to/tradeiq && python3 -m tradeiq.paper open
35 17 * * *    cd /path/to/tradeiq && python3 -m tradeiq.paper mark
```

Both commands are idempotent — positions are keyed on
`(run_id, cohort, ticker)` and marks on `(position_id, horizon)`, so a
double run inserts nothing.

### The bar

`report` prints `signal − control` per horizon with a **ticker-clustered**
standard error and an effective N. The bar for taking any of this seriously
is a positive difference with clustered **t > 2**. The naive t is not
reported on purpose: it was 1.68 in the backtest and ~0.4 once clustering
and overlap were handled, and that gap is exactly how the original result
fooled me.

## Layout

```
tradeiq/
  config.py       parameters + API keys (all optional)
  universe.py     the trend -> ticker map. THIS is the real IP.
  scoring.py      velocity, convergence, saturation, event-risk guard, sizing
  pipeline.py     fetch -> score -> rank -> persist
  backtest.py     out-of-sample event study
  broker.py       order tickets + exit checks (never places an order itself)
  store.py        SQLite cache so re-runs are cheap
  sources/
    trends.py     Google Trends       (free, backbone)
    wiki.py       Wikipedia pageviews (free)
    appstore.py   iOS top-chart ranks (free, snapshot only)
    prices.py     Yahoo + stooq       (free)
    social.py     Reddit consumer + r/wallstreetbets investor chatter (needs OAuth app)
    paid.py       SimilarWeb / Sensor Tower / Keepa / Apify-TikTok (needs keys)
app.py            Flask server + JSON API
build_dashboard.py  renders the single-file dashboard
```

## What the backtest actually found — RETRACTED

**The original result in this section was wrong. It is kept here, corrected,
because a retraction is more useful than a deletion.**

What was reported: 225 events, +1.70% mean 4w excess vs SPY, +3.36% at 12w,
with a "low investor saturation" cohort at +3.99% (t = 1.68) against
−0.56% for high saturation — described as the strategy's core claim
surviving contact with the data.

It did not survive. Five defects, in descending order of damage:

**1. It fails a placebo test.** Random entry into the same 22 names over the
same window matches or beats the signal. Independent null models put the
incremental contribution anywhere from −2.0pp to +2.1pp — a quantity whose
placebo estimate swings 4pp depending on how the random dates are drawn is
not a quantity to size positions against.

**2. The saturation split was a coercion bug.** Consumer and investor
keywords went out in one Google Trends request. Trends normalises every
series in a batch to the highest-volume term, so `"CELH stock"` quantised to
near-constant, its z returned `None`, and `None` was coerced to `0.0`. The
cohort test `0.0 < z * 0.6` is then **true by construction** for every event.

| Sub-cohort | n | 12w excess |
|---|---|---|
| "Low saturation" with a broken investor series | 58 | **+16.2%** |
| Low saturation with a real investor z | 136 | **−1.2%** |
| High saturation | 31 | −0.6% |

Strip the 58 broken events and the split disappears entirely.

**3. Entry landed inside the signal week.** pytrends labels weekly rows by
week *start*. Correcting entry flips the 1-week result from +0.49% to
**−0.87%** — the whole 1w number was look-ahead.

**4. Beta was assumed to be 1.0** on a universe averaging **1.59**.
Beta-adjusting cuts the 12w figure from +3.36% to **+1.73%**.

**5. The t-stats were inflated ~60%.** 225 events from 22 tickers with
overlapping 12-week windows give **N_eff ≈ 66**. Corrected, **t ≈ 0.4**.
Proof the naive t is meaningless: `cooldown_weeks` is a free parameter, and
setting it to 1 instead of 4 pushes n to 932 and naive t to **5.4** without
adding one new piece of information.

Also: HIMS (+1.88pp) and TDUP (+1.81pp) alone exceed the +3.36pp total, and
**12 of 22 tickers are net negative**. Dropping the 5 best of 225 events
turns the 4w result negative.

**Where the literature puts this.** Da/Engelberg/Gao (2011) measure the
attention effect at ~34bp over two weeks, *reversing* over weeks 5–52 — the
exact window where this claimed its largest gain. The durable finding is a
distinction this scanner blurs: signals from what consumers **do** (sales
rank, review velocity, downloads, stockouts) are information and don't
reverse; signals from what people **look at** (Trends, Wikipedia, ticker
chatter) are attention and do.

**What this means for the code.** The backtest in `backtest.py` still has
defects 3–5 in it. Fix them before quoting any number from it. In the
meantime the honest state of the evidence is: *no measured edge*, and
`tradeiq/paper.py` is the only thing running that could change that.

## Cost of closing the data gap

Free sources get you a real system; they do not get you TickerTrends. At your
$500/mo budget, in the order I would spend it:

| Feed | Rough cost | What it adds |
|---|---|---|
| **Keepa** | ~$20/mo | Amazon sales-rank history. Highest signal per dollar for physical products. |
| **Reddit OAuth app** | free | Consumer subs + r/wallstreetbets. The investor-saturation side is thin without it. |
| **Apify TikTok/Instagram** | ~$50–150/mo | Hashtag view counts. The one source that is genuinely early. |
| **SimilarWeb** | ~$200–400/mo | Web traffic per domain. Best for DTC and marketplace names. |
| **Sensor Tower / Appfigures** | ~$100+/mo | App download + revenue estimates. Essential for app-first companies. |

Every adapter already exists in `sources/paid.py` and returns `{}` until you set the
key, so nothing else changes when you subscribe. Set them in the environment:

```bash
export KEEPA_API_KEY=... SIMILARWEB_API_KEY=... SENSORTOWER_API_KEY=... APIFY_TOKEN=...
export REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=...
```

## Execution

`broker.py` produces reviewed tickets in `out/tickets.json`; it never sends an order.
Each ticket carries a limit price, a risk-sized quantity (≤1% of equity at risk,
hard 10% notional cap per name), a stop, a target, and a written invalidation
condition. Placing the order is a separate, human-confirmed step through your broker
connection.

That boundary is deliberate. Given a backtest with t ≈ 1.6 and a fat right tail,
automating entry would be automating a coin flip with good odds and no supervision.
Earn the automation with more evidence.

## Known gaps

- **Theme discovery is manual.** `universe.py` is a seed list. `trends.rising_queries()`
  can propose new terms but nothing yet links a novel breakout term to a ticker
  automatically — `universe.resolve_ticker()` is a fuzzy SEC name match, not a
  supply-chain graph.
- **Google Trends is relative, not absolute**, and rescales to the requested window.
  Two runs over different windows are not directly comparable.
- **No options.** Camillo's returns come substantially from options on the thesis.
  Sizing here is equity-only.
- **No live portfolio state.** `broker.exit_checks()` accepts holdings you pass in;
  it does not sync from a broker yet.

## Disclaimer

Not investment advice. This measures attention, not value. Every signal is a research
prompt: you still have to work out *why* the trend is happening and whether the listed
company actually monetises it.
