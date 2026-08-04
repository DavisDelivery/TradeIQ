# Wiring the rest of the socials

Status of every consumer/social source, what it costs, and the exact shape a
new one has to fit. Written 2026-08-03, Quiver section answered 2026-08-04.

## Where things stand

| Source | State | Notes |
|---|---|---|
| Wikipedia pageviews | **LIVE** | `shared/trend-exposure.ts`. Free, keyless, ABSOLUTE counts — the only attention series here that is comparable between two names. |
| Google Trends | **LIVE, UNWEIGHTED** | `shared/google-trends.ts`. Needs `SERPAPI_KEY`. Display only — see below. |
| Quiver off-exchange volume | **LIVE, UNWEIGHTED** | `shared/quiver-offexchange.ts`. On the current plan. Retail-crowding proxy — the nearest thing to an investor-saturation leg we can actually buy. |
| Quiver WallStreetBets | **GATED (403)** | Dataset exists; this plan does not include it, and it is not listed on any published tier. See below. |
| Quiver Twitter followers | **GATED (403)** | Same. |
| Quiver app ratings | **GATED (403)** | On the Trader tier, $75/mo. |
| Reddit (direct) | absent | Official API. Free tier is non-commercial, 100 QPM per client id. |
| StockTwits | absent | Public API deprecated; partner access only. |
| TikTok | absent | The Research API is contractually academic/non-profit only. A retail trading signal fails eligibility. Licensed scraper (Apify) is the only compliant path. |
| X / Twitter | absent | Paid tiers only; no free tier for new apps. |

## Why Google Trends carries no weight

It is in the app because it was asked for, and it is unweighted because both
of these are true:

1. **It has no measured edge here.** The consumer-velocity leg of the
   social-arb study was built on it and failed a placebo test — random entry
   into the same names matched it (`reports/trend/social-arb-study.md`,
   `verdicts.ts` → `trend` = NO_EDGE).
2. **The index is not comparable between calls.** Trends scales 0-100 to the
   maximum of the window you asked for. The same keyword over two windows
   gives two different series. Wikipedia is absolute, which is why it holds
   the attention display and Trends is the second opinion.

Transport is a compliance decision, not a preference. `SERPAPI_KEY` is the
sanctioned path — a licensed intermediary with its own ToS position. The
direct `trends.google.com/trends/api/*` endpoint is **deliberately not
implemented**: `robots.txt` disallows `/trends/explore` (verified 2026-08-03)
and Google's ToS prohibit automated access that violates it. Setting
`GOOGLE_TRENDS_ALLOW_DIRECT=1` returns an explanation, not data — so nobody
enables a compliance risk by flipping an env var they did not read.

## The Quiver question, answered 2026-08-04

Probed with the live key against `api.quiverquant.com/beta`. **Controls
behaved** — `lobbying` returned 200 with 13 rows, `/live/insiders` returned
403 — so the verdicts below are about the plan, not about a broken key.

| Dataset | Result |
|---|---|
| congresstrading, senatetrading, housetrading | **on plan** |
| govcontracts, govcontractsall, lobbying | **on plan** |
| **offexchange** | **on plan** — 1,209 daily rows for CROX back to 2021-01-11 |
| wallstreetbets, twitter, appratings | gated (403) |
| insiders, allpatents, sec13f, flights, politicalbeta, etfholdings | gated (403) |
| wikipedia, spendingdata, institutions, pelositracker | no such path |

That set of seven is exactly Quiver's **Hobbyist tier, $30/mo**. Upgrading to
**Trader, $75/mo** buys insider trading, hedge-fund activity, ETF holdings,
top shareholders, patents, exec comp and **app ratings**.

**It does not buy WallStreetBets or Twitter.** Neither appears on any tier
Quiver currently publishes, and both 403 here — so they are Commercial-only
(custom pricing) or withdrawn from the API product. Do not budget for a
Quiver upgrade expecting to get WSB mentions; ask them directly first.

Reproduce either way:

```
QUIVER_API_KEY=... npx tsx scripts/quiver-social-probe.ts CROX   # the four social families + controls
QUIVER_API_KEY=... npx tsx scripts/quiver-inventory.ts CROX      # every dataset, on-plan / gated / absent
GET /api/diag-quiver-social?ticker=GME                            # same probe, from a deploy
```

Verdicts: `AVAILABLE` (already paid for, wire it) · `AVAILABLE_BUT_EMPTY`
(covered, no rows for that ticker) · `SUBSCRIPTION_GATE` (exists, plan lacks
it) · `NOT_FOUND` (path guess wrong — add candidates and re-probe).

## What off-exchange volume replaces, and what it does not

`offexchange` gives `OTC_Short`, `OTC_Total` and `DPI` daily. Retail
marketable flow is overwhelmingly internalised by wholesalers, so **a surge in
off-exchange volume for a name is a reasonable proxy for a surge in retail
participation** — which is the investor-saturation leg WSB would have filled.
In one respect it is better: it measures what retail money did, not what
retail accounts said.

Two confounds measured on a 14-name sample, 2026-08-04:

1. **DPI level is not comparable across names.** Mega-caps sat at 0.29-0.52,
   small/mid consumer names at 0.58-0.71. That spread is capitalisation and
   liquidity, not accumulation. Only a name's move against its own baseline
   means anything, so `dpiRecent` and `dpiBase` are always shown together and
   never ranked cross-sectionally.
2. **The move is not a market-wide drift.** 8 of 14 names sat above their own
   baseline, mean delta +0.010 — so there is genuine name-specific variation.
   Variation is not edge; it stays unweighted until the paper tracker says
   otherwise.

The folk reading that high DPI is bullish (a wholesaler filling a retail buy
books its own side short) is **unverified here** and contaminated by real
short selling and hedging. `quiver-offexchange.ts` reports DPI as a number and
never as a direction.

Note the sign convention in the Camillo frame: a **positive** volume z is a
**discovery warning**. The crowd is already in the name. It argues against the
setup, not for it.

## Adding a source: the shape it must fit

Every adapter here obeys the same four rules, learned from bugs that cost
real time:

1. **Never cache a failure as a value.** A transient 500 stored as `{}`
   freezes a source into "silently absent" for the whole TTL. Store an
   error marker with a short TTL instead.
2. **A missing field is `null`, never `0`.** The social-arb study's headline
   finding was a `None` coerced to `0.0`, which made a cohort test true by
   construction and manufactured a fake +16.2% result.
3. **Resolve by header/field NAME, not position.** Vendors reorder columns.
   Report anything unresolved in a `missingFields`-style list so "this feed
   has no float" stays distinguishable from "this company has no float".
4. **Throttling is a typed failure with a cooldown.** Finviz answers a
   throttle with HTTP 200 and a plain-text body, so status codes alone miss
   it. Retrying into a throttle amplifies it — `finviz.ts` arms a circuit
   breaker; copy that.

Then decide weighting honestly. **Default to unweighted.** A new source
earns weight only by clearing the pre-committed gate in
`reports/trend/social-arb-study.md`: forward paper signals against a random
control cohort, ticker-clustered t > 2. Until then it is context, it renders
with a caveat that travels in the API payload, and it stays out of every
score and screen predicate.

## Cost, if you want the missing three

| Source | Path | Rough cost |
|---|---|---|
| Reddit | official OAuth app | free, non-commercial |
| TikTok / Instagram | Apify licensed actors | ~$50-150/mo |
| X | pay-per-use post reads | ~$25/mo for 5k reads |
| Google Trends | SerpApi Developer | $75/mo, 5k searches |
| Quiver Trader tier | upgrade from Hobbyist | +$45/mo — buys app ratings, **not** WSB |

**Reddit direct is still the highest value per dollar**, and now for a sharper
reason than before: Quiver will not sell WSB mentions on any published tier, so
counting r/wallstreetbets yourself is the only route to that series short of a
Commercial contract. It is free, and it is the one source that reads *investor*
saturation rather than another consumer-attention series.

Off-exchange volume now covers that leg approximately, so this is an
improvement rather than a hole — but it is a flow proxy, not a mention count,
and the two would fail differently. Having both is worth more than either.
