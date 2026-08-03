# Wiring the rest of the socials

Status of every consumer/social source, what it costs, and the exact shape a
new one has to fit. Written 2026-08-03.

## Where things stand

| Source | State | Notes |
|---|---|---|
| Wikipedia pageviews | **LIVE** | `shared/trend-exposure.ts`. Free, keyless, ABSOLUTE counts — the only attention series here that is comparable between two names. |
| Google Trends | **LIVE, UNWEIGHTED** | `shared/google-trends.ts`. Needs `SERPAPI_KEY`. Display only — see below. |
| Quiver: WSB / twitter / app ratings | **UNKNOWN** | Quiver sells them; this plan may not include them. `GET /api/diag-quiver-social` answers it. |
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

## Answer the Quiver question first

```
GET https://tradeiq-alpha.netlify.app/api/diag-quiver-social?ticker=GME
```

Probes `wallstreetbets`, `twitter`, `appratings`, `spendingdata`, plus two
controls: `lobbying` (known-good, already wired) and `/live/insiders` (known
403 on this plan per `data-provider.ts:1288`).

Read the controls first. If lobbying is not `AVAILABLE`, the key or base URL
is broken and every other verdict is noise — the response says so in
`summary.trustworthy`. Per-family verdicts:

- `AVAILABLE` — wire it, it is already paid for
- `AVAILABLE_BUT_EMPTY` — covered, but no rows for that ticker
- `SUBSCRIPTION_GATE` — the dataset exists, this plan lacks it
- `NOT_FOUND` — the path guess was wrong; add candidates and re-probe

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

Reddit is the highest value per dollar: it is the only one that gives an
*investor*-saturation read (r/wallstreetbets) rather than another consumer
attention series, and that is the leg with no source at all today.
