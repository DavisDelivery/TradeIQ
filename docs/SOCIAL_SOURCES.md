# Wiring the rest of the socials

Status of every consumer/social source, what it costs, and the exact shape a
new one has to fit. Written 2026-08-03, Quiver section answered 2026-08-04.

## Where things stand

| Source | State | Notes |
|---|---|---|
| Wikipedia pageviews | **LIVE** | `shared/trend-exposure.ts`. Free, keyless, ABSOLUTE counts — the only attention series here comparable between two names. |
| Google Trends | **LIVE, UNWEIGHTED** | `shared/google-trends.ts`. Needs `SERPAPI_KEY` ($75/mo). Display only — see below. |
| Quiver off-exchange volume | **LIVE, UNWEIGHTED** | `shared/quiver-offexchange.ts`. On the $30/mo plan. Retail-crowding proxy. |
| **WSB mentions (ApeWisdom)** | **LIVE, UNWEIGHTED** | `shared/social-mentions.ts`. Free, keyless. Replaces the gated Quiver dataset — see "what to do when the vendor won't sell it". |
| **App ratings (Apple)** | **LIVE, UNWEIGHTED** | `shared/app-ratings.ts`. Free, keyless, official Apple. Replaces Quiver's $75/mo tier. |
| **Review velocity (Apple)** | **LIVE, UNWEIGHTED** | `shared/app-reviews.ts`. Free. The only consumer-demand FLOW here, available on the first call — see below. |
| Quiver WallStreetBets | **GATED (403)** | Not on any published tier. Routed around, not bought. |
| Quiver Twitter followers | **GATED (403)** | Same. No free substitute — X is the one genuinely paywalled leg. |
| Quiver app ratings | **GATED (403)** | On the Trader tier, $75/mo. Not worth buying — Apple serves it free. |
| Reddit (direct, official API) | **built, DORMANT** | `shared/reddit-client.ts` + `shared/reddit-mentions.ts`. Set `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` to activate. Needs Reddit approval — see below. |
| Google Play ratings | not wired | No official API. Android-side ratings need a scraper; Apple alone is a US-skewed sample. |
| StockTwits | absent | Public API deprecated; partner access only. |
| TikTok | absent | Research API is contractually academic/non-profit only. Licensed scraper (Apify) is the only compliant path. |
| X / Twitter | absent | Paid tiers only, ~$200/mo for meaningful volume. The one leg with no free route. |

## What to do when the vendor won't sell it

Quiver gates WallStreetBets, Twitter and app ratings. Two of those three turned
out to be **freely available at the source**, which is the general lesson:
a data vendor's product is usually aggregation and convenience, not exclusive
access. Before paying for a tier upgrade, check whether the underlying
publisher serves it directly.

| Gated at Quiver | Free route found | Verified |
|---|---|---|
| WallStreetBets mentions | ApeWisdom API, keyless — 757 tickers, mentions + 24h-ago | 2026-08-04 |
| App-store ratings | Apple iTunes Search API, keyless and official | 2026-08-04 |
| Twitter followers | none — X charges for this and there is no way around it | — |

### Review velocity — a demand FLOW, available on the first call

The claim that app ratings need months of accumulation was **too pessimistic**,
and `shared/app-reviews.ts` is the correction.

Apple's customer-reviews RSS feed returns **individual reviews, each with a
timestamp, a star rating and the app version**. Counting them by date gives
reviews-per-day directly. No waiting. This is the only genuine consumer-demand
flow in the whole evidence pack — everything else is a level.

Live, 2026-08-04:

| Company | recent | prior | change | stars now/prior | versions |
|---|---|---|---|---|---|
| Texas Roadhouse | 1.93/d | 1.18/d | **+64%** | 4.67 / 4.30 | 1 |
| Chewy | 1.00/d | 0.64/d | +56% | 3.96 / 2.83 | 5 ⚠ |
| Wingstop | 1.29/d | 1.00/d | +29% | 1.72 / 1.96 | 2 |
| CAVA | 1.86/d | 2.07/d | −10% | 3.63 / 3.59 | 3 |
| Crocs | 0.36/d | 0.68/d | −47% | 1.00 / 2.05 | 1 |
| Dutch Bros | 5.50/d | — | **not reported** | 4.69 / 4.61 | 2 |

Texas Roadhouse is the cleanest read on that table: a large acceleration on a
single app version, so a release did not manufacture it. Chewy's +56% across
**five** versions probably did.

**Three traps, each handled in code rather than left to the reader:**

1. **The feed is a fixed COUNT, not a window.** It returns the most recent ~50
   reviews per page. The time span they cover is an output, not an input. A
   hot app burns through them fast — Dutch Bros used 200 reviews in 34 days, so
   the prior 28-day window was never observed. Naively differencing would have
   invented a demand collapse out of pure truncation. `truncated` is reported
   and the comparison is **null rather than wrong**.
2. **These stars are NOT the app's rating.** Wingstop shows 4.91★ lifetime but
   1.72★ across recent reviews; Crocs 4.73★ versus 1.00★. Neither product
   collapsed — the lifetime figure is dominated by silent one-tap ratings from
   Apple's prompt, while people who bother to *write* skew heavily negative.
   Recent-vs-prior is fair; recent-vs-lifetime is not, and the evidence block
   says so in as many words.
3. **A release prompts reviews on its own.** `versionsInWindow` travels with
   the number so a release-driven spike is not read as demand.

Also: **US store only.** This is a US-iOS sample, not global demand.

### The limitation the other two free sources share

**Neither has history.** ApeWisdom serves a live snapshot with no per-ticker
time series. Apple's `userRatingCount` is lifetime cumulative, so its level
tells you the app is big — which market cap already told you.

For both, **the signal is the daily change, and that series exists nowhere to
be bought.** It only exists if something writes it down every day. That is
what `netlify/functions/snapshot-social.ts` does (cron `10 21 * * *`), writing
to Firestore `socialMentionSnapshots/{date}_{filter}` and
`appRatingSnapshots/{date}`.

The rating-count series is still worth accumulating even now that review
velocity exists, because they measure different populations: reviews are the
subset who wrote something, while the rating count includes every silent
one-tap rating. The latter is the larger and less self-selected sample, and
its daily delta is the better demand proxy of the two.

The app poll covers the **40 largest consumer names** in the Russell 2000,
paced at 1.2s apart to stay inside Apple's throttle, and only
**HIGH-confidence matches** are stored — a series built on the wrong company's
app is worse than no series. A stable list matters more than a broad one: a
watchlist that churns yields a panel where every ticker has two observations
and none has a series.

It runs **every day including weekends**, unlike every other cron here, because
r/wallstreetbets peaks on Sunday nights and a market-closed guard would put a
systematic hole in the most informative observations.

Nothing reads that history yet. In ninety days it is the only reason there will
be anything to measure.

### Absence is not zero

A ticker missing from ApeWisdom's list has mentions **below the tracking
floor**, not zero mentions. `social-mentions.ts` models three distinct states —
`TRACKED`, `BELOW_FLOOR`, `UNAVAILABLE` — and `mentions` is `null` for the
latter two, never `0`. Collapsing them would repeat the `None`→`0.0` coercion
that manufactured this project's fake +16.2% backtest result.

`BELOW_FLOOR` is a real finding and renders as a value, not as greyed-out
missing data. For an undiscovered-consumer setup, quiet is the expected state:
**consistent with the thesis, never evidence for it.**

### Reddit direct — the licensed route, built but dormant

`reddit-client.ts` and `reddit-mentions.ts` count the same mentions from the
source under Reddit's own terms. **Dormant until `REDDIT_CLIENT_ID` and
`REDDIT_CLIENT_SECRET` are set**, so it ships safely before approval lands and
nothing degrades while it is off.

Getting credentials (verified 2026-08-04):

1. **`https://old.reddit.com/prefs/apps`** — the Reddit redesign and the mobile
   app do not render this page. `old.reddit.com` does.
2. "create an app" → type **script** → redirect uri `http://localhost:8080`.
3. Client id is the short string under the app name; secret is beside it.
4. **Then follow the "register to use the API" link on that same form.** Since
   the late-2025 Responsible Builder Policy, creating the app does NOT by
   itself grant a working token — approval is a separate step. Reddit's own
   create-app page says so: *"You must also register to use the API."*

Because the credentials are issued at creation but the TOKEN is gated, a
missing approval surfaces one step later than people expect — as a bare 401
from `/api/v1/access_token`. `reddit-client.ts` catches that specific case and
says so in the error rather than leaving you to guess.

**Licence boundary:** the free tier is 100 QPM and is **non-commercial**.
Reddit treats any revenue-generating project as commercial. Swapping ApeWisdom
for Reddit removes the no-terms risk; it does not remove the obligation.

**Counting tickers in free text is the hard part, not the HTTP.** The matcher
requires a cashtag (`$GME`) or a bare all-caps standalone token, and refuses an
ambiguity list — `IT`, `ON`, `DD`, `CEO`, `ATH`, `YOLO` and friends are real
symbols or jargon that would otherwise turn the board into a word-frequency
table. A cashtag overrides the ambiguity list, since `$IT` is unmistakable.

This **deliberately undercounts**: "bought some crocs today" is not counted for
CROX. That is the safe direction for a saturation gauge — undercounting makes a
name look quieter, and quiet is the state that argues *for* a setup, so the
error works against the thesis rather than flattering it.

One mention is counted **per post**, not per occurrence, so a single ranting
post repeating a ticker nine times cannot dominate the board.

### Source risk on ApeWisdom, stated plainly

ApeWisdom publishes **no terms of service, no rate limits and no commercial-use
statement** (checked 2026-08-04). That is fine for personal research and not
fine as the backbone of something you charge for. Two consequences:

1. Every call is best-effort; nothing hard-depends on it.
2. If TradeIQ goes commercial, swap to the official Reddit API (OAuth, free
   tier, 100 QPM, non-commercial) or get written permission. The adapter
   boundary is one file wide precisely so that swap is cheap.

### Apple's matcher is the risky part, not the fetch

Matching a company to its app by name is where a silent wrong attribution
creeps in. Three rules were added only after live testing broke the naive
version:

- Searching the **legal name demotes the real app** — "Dutch Bros Inc" returned
  "Dutch Bros U" (67 ratings) while the genuine app (862,554) fell out of the
  top five. `searchTerm()` strips the corporate suffix before querying.
- A trailing descriptor only counts as a match **behind a delimiter** or from a
  generic allowlist. The first draft scored "Crocs Wallpapers HD" as a HIGH
  match for CROX.
- **A zero-rating app is refused even on an exact name match.** "Celsius
  Holdings" resolves to an app literally called "Celsius" with 0 ratings — a
  common-word collision with an unrelated product.

Live results across 12 names: 6 HIGH, 2 LOW (flagged, shown with a warning),
4 refused. A high refusal rate is correct — most listed companies have no
consumer app, and saying so beats attributing a stranger's.

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

| Source | Path | Rough cost | Verdict |
|---|---|---|---|
| WSB mentions | ApeWisdom | **free** | wired |
| App ratings | Apple Search API | **free** | wired |
| Off-exchange volume | Quiver Hobbyist | already paying $30/mo | wired |
| Reddit | official OAuth app | free, non-commercial | the licensed upgrade from ApeWisdom |
| Google Play ratings | Apify / scraper | ~$30-50/mo | only if the US-iOS skew starts to matter |
| TikTok / Instagram | Apify licensed actors | ~$50-150/mo | the real gap — where consumer trends now start |
| X | pay-per-use post reads | ~$200/mo for useful volume | skip; worst value here |
| Google Trends | SerpApi Developer | $75/mo | already wired, measured NO_EDGE |
| Quiver Trader tier | upgrade from Hobbyist | +$45/mo | **do not buy** — Apple serves the ratings free |

**Nothing on this list is worth buying next.** The two gated datasets that
mattered turned out to be free at the source, and the paid options that remain
are either poor value (X) or duplicate something already wired (Quiver Trader).

The highest-value next move costs nothing: **let `snapshot-social.ts` run.**
Every source above is a level, and levels are nearly uninformative — a big app
has many ratings, a meme stock has many mentions, and market cap told you both.
The differences are where any signal lives, and no vendor sells those
differences for these sources at any price. Ninety days of a free daily cron
buys something $500/mo of subscriptions cannot.

If a budget does get spent later, spend it on **TikTok/Instagram via a licensed
scraper**, not on another finance-data vendor. Consumer trends now start there
and every source wired here is downstream of that.
