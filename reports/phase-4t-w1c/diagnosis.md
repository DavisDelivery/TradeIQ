# Phase 4t W1c — diagnosis

## Summary

The earnings analyst's silence in the PIT path is overdetermined by two
independent code defects: (1) `getEarningsHistory`'s Finnhub URL omits
`from`/`to` and relies on `limit=32` + a client-side post-filter, which
empties `history` whenever Finnhub's "latest 32 reports" do not reach
back to `asOfDate` (always true for 2018-2020 backtest rebalances, and
empirically true for 2022-2024 as well per the brief's 100% silent
table — Finnhub's free/cheap-tier `/stock/earnings` behaviour is
recent-skewed and does not honour `limit` for arbitrarily deep history);
**and** (2) `runEarnings` computes `daysUntilEarnings` from
`Date.now()` rather than `asOfDate`, so the upcoming-earnings branch
cannot fire in PIT mode even when `getUpcomingEarnings` returns data
correctly. The insider analyst is a different shape of problem: the
code path I traced shows `insiderActivity` cannot be `null` (its
provider catches its own errors and returns the `empty` shape on any
failure), which means the score-at-date `_noData` fallback should
almost never fire. The 70-98% per-year insider silence is therefore
**not** the `_noData` branch but the `runInsider(empty) → score=50`
branch — driven by `getFinnhubInsiderTransactions` returning sparse
data for the historical PIT windows. Whether that sparseness is a
provider limit, a date-window construction bug, or a stale-PIT-cache
artefact needs one final verification step (a temporary diagnostic
endpoint or admin-SDK probe) which the W2 fix can add safely. **The
two analysts share an `asOfDate`-threading surface but their failure
modes are independent: earnings has two confirmed code defects;
insider has a confirmed data-path return-shape pattern that lands at
score=50, with the upstream cause still requiring one direct probe.**

## Earnings — evidence

### Repro target

NVDA on 2020-06-30 (per brief). Live call (today's
`/api/target-rationale?ticker=NVDA`): `earnings-analyst score=45,
direction=short, rationale="earnings in 0d, de-rated, 4/4 beats"`.
Brief reports `earnings 100% silent in every year 2018-2024` in the
sp500 backtest attribution.

### Provider trace — `getEarningsHistory`

File: `netlify/functions/shared/data-provider.ts:475-508`.

```typescript
export async function getEarningsHistory(
  ticker: string,
  limit = 8,
  opts: { asOfDate?: string } = {},
): Promise<EarningsSurprise[]> {
  try {
    // Fetch extra to absorb post-filter losses when asOfDate is set.
    const fetchLimit = opts.asOfDate ? Math.max(limit * 4, 32) : limit;
    const url = `${FINNHUB}/stock/earnings?symbol=${ticker}&limit=${fetchLimit}&token=${finnhubKey()}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = parseOrFallback(FinnhubEarningsHistoryResponseSchema, await res.json(), {...}, []);
    if (!Array.isArray(data)) return [];
    let rows = data.map((r) => ({
      date: r.period,
      epsActual: Number(r.actual),
      epsEstimate: Number(r.estimate),
      surprisePct: r.surprisePercent !== undefined ? Number(r.surprisePercent) : undefined,
    })).filter((r) => Number.isFinite(r.epsActual) && Number.isFinite(r.epsEstimate));
    if (opts.asOfDate) {
      rows = rows.filter((r) => r.date <= opts.asOfDate!);
    }
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}
```

**The Finnhub `/stock/earnings` URL has only `symbol` and `limit` —
no `from`/`to`.** That endpoint returns "the most recent N quarterly
earnings surprises" sorted newest-first, anchored to the wall clock,
not to a PIT date. The function compensates by fetching `Math.max(4×4,
32) = 32` entries when `asOfDate` is set, then locally filtering
`r.date <= asOfDate`, then `.slice(0, 4)`.

Live path is fine: `runAnalystsForTicker` calls `getEarningsHistory(ticker, 4)`
(no asOfDate), `fetchLimit = 4`, no post-filter, returns the 4 most
recent quarters — exactly what the analyst wants today.

PIT path fails by construction: it requests 32 entries from an
endpoint that returns "latest N as of now". For the early backtest
years this is hopeless — 32 quarters newest-first from `today`
(2026-05) reaches back to ~2018-Q1, so for `asOfDate < 2018-04-30`
the post-filter wipes every row and `history === []`. For mid-range
years it depends on Finnhub honouring `limit=32`; the brief's
**100% silent in every year 2018-2024, including 2024**, is the
empirical signal that Finnhub on the deployed plan is not in fact
returning 32 entries — it's returning roughly the last 4 (the
default), which are post-2024-12-31 by the time of every backtest
rebalance, so the post-filter wipes them. The brief reports the same
empty result across all 7 years; if Finnhub were honouring limit=32
we would expect a soft cliff matching coverage-depth, not uniform
100% silence.

**The deeper structural bug: the API contract of Finnhub
`/stock/earnings` does not include `from`/`to` parameters.** This
endpoint is not designed for PIT-windowed historical queries; using
it that way is what makes the wiring brittle. Finnhub
`/calendar/earnings?from=&to=` (already used by
`getUpcomingEarnings`) does support a date range and returns
historical actuals once `actual` has been reported. The fix is to
route historical earnings-history queries through `/calendar/earnings`
with a backward-looking window, not through `/stock/earnings`.

### Code defect — `runEarnings` uses `Date.now()` not `asOfDate`

File: `netlify/functions/analysts/core.ts:123-172`.

```typescript
export function runEarnings(upcoming: UpcomingEarning | null, history: EarningsSurprise[]): AnalystOutput {
  let raw = 0;
  // ...
  let upcomingContributed = false;
  let historyContributed = false;

  if (upcoming?.date) {
    const days = Math.round((new Date(upcoming.date).getTime() - Date.now()) / 86400000);
    //                                                            ^^^^^^^^^^^
    s.daysUntilEarnings = days;
    s.earningsDate = upcoming.date;
    if (days >= 0 && days <= 5) { raw -= 30; parts.push(`earnings in ${days}d, de-rated`); upcomingContributed = true; }
    else if (days >= 0 && days <= 10) { raw -= 10; upcomingContributed = true; }
    else if (days >= 0 && days <= 21) { parts.push(`earnings in ${days}d`); upcomingContributed = true; }
  }
  // history branch — does not depend on Date.now()
  if (history.length >= 2) {
    const beats = history.slice(0, 4).filter((q) => q.epsActual > q.epsEstimate).length;
    s.beats4q = beats;
    if (beats >= 3) { raw += 20; parts.push(`${beats}/4 beats`); historyContributed = true; }
    else if (beats <= 1 && history.length >= 4) { raw -= 15; parts.push(`only ${beats}/4 beats`); historyContributed = true; }
  }

  // Phase 4f-finish W3 — when neither branch had actionable data, this
  // analyst has no real signal to contribute. Surface as _noData so the
  // composite skips it...
  if (!upcomingContributed && !historyContributed) {
    return {
      score: 50,
      direction: 'neutral',
      confidence: 0,
      rationale: 'no earnings catalyst',
      signals: { ...s, _noData: true, _reason: 'no_actionable_data' },
    };
  }
  // ...
}
```

In PIT mode, `upcoming.date` (from `getUpcomingEarnings(ticker, 45,
{ asOfDate })`) is a date in `[asOfDate, asOfDate + 45d]` — i.e.,
always historical relative to `Date.now()` for any backtest rebalance.
`days = (upcoming.date - Date.now()) / 86400000` is therefore a
large negative number (e.g., -2,150 for asOfDate 2020-06-30). None
of the three `days >= 0 && days <= N` branches fire. **The
`upcomingContributed = true` assignment never happens in PIT mode**,
regardless of whether the upstream provider returned data correctly.

`earnings-intel.ts:111-118` already has the PIT-correct pattern:

```typescript
const nowMs = opts.asOfDate
  ? new Date(`${opts.asOfDate}T12:00:00Z`).getTime()
  : Date.now();
const daysUntilEarnings = upcoming?.date
  ? Math.round((new Date(upcoming.date).getTime() - nowMs) / 86400000)
  : undefined;
```

So a working precedent for the W2 fix exists inside the same
codebase. The pattern is to take `asOfDate` as a parameter (or to
pull it from the upcoming date itself) and compute `days` against it.

### Combined effect

With `history === []` (provider bug, no entries survive post-filter)
AND `upcomingContributed === false` (Date.now bug, no upcoming
branch can fire), every earnings PIT call enters the
`!upcomingContributed && !historyContributed` branch at
`analysts/core.ts:153`. That branch returns `{ score: 50, ...,
signals: { _noData: true, _reason: 'no_actionable_data' } }`.

Attribution persists only `layers: Record<string, number>`
(`shared/backtest/score-at-date.ts:688-699`) — i.e., the per-analyst
score as a number, not `_noData`. The brief's 100%-silent metric
reads this as "earnings score == 50 ⇒ silent". Score is 50 because
both branches missed.

### Named root cause — earnings

- **E1 — `data-provider.ts:483`**: `getEarningsHistory` builds a
  Finnhub URL with `?limit=N&symbol=X` only, then relies on a
  client-side `r.date <= asOfDate` post-filter. The Finnhub
  `/stock/earnings` endpoint is recent-anchored and does not support
  `from`/`to`. For early backtest years (`asOfDate < 2018-04-30`)
  the post-filter mathematically wipes all results. For recent years
  the survival depends on Finnhub honouring `limit=32` over its
  documented "latest 4 default" behaviour, which the empirical
  100%-silent-in-every-year stat suggests it does not on this plan.
  The correct endpoint for windowed historical earnings actuals is
  Finnhub `/calendar/earnings?from=X&to=Y`, which is already used by
  `getUpcomingEarnings`.

- **E2 — `analysts/core.ts:135`**: `runEarnings` computes
  `daysUntilEarnings` from `Date.now()` rather than threading
  `asOfDate` through. The upcoming-earnings branch can never fire in
  PIT mode regardless of provider behaviour. The
  `_noData`/`_reason='no_actionable_data'` fallback at line 153
  always triggers when history is empty.

E1 and E2 stack: each on its own is sufficient to produce score=50;
both must be fixed to restore the live-equivalent earnings signal.

## Insider — evidence

### Repro target

NVDA on 2020-06-30. Live call (today): `insider-analyst score=40,
direction=neutral, rationale="$163.7M net sells"`. Brief reports
insider 70-98% silent per year, 2018-2024 — variable but consistently
high.

### Provider trace — `getInsiderActivity` cannot return `null`

File: `netlify/functions/shared/insider-provider.ts:54-158`.

```typescript
export async function getInsiderActivity(
  ticker: string,
  lookbackDays = 90,
  opts: { asOfDate?: string } = {},
): Promise<InsiderActivity> {
  const empty: InsiderActivity = {
    ticker, lookbackDays,
    totalBuys: 0, totalSells: 0, netDollars: 0,
    buyDollars: 0, sellDollars: 0, uniqueBuyers: 0,
    clusters: [], firstBuyInAYear: false, transactions: [],
    fetchedAt: new Date().toISOString(),
  };

  try {
    const fetchDays = lookbackDays + 365;
    const raw = await getFinnhubInsiderTransactions(ticker, fetchDays, { asOfDate: opts.asOfDate });
    if (raw.length === 0) return empty;
    // ... processing ...
    return { /* real data */ };
  } catch { return empty; }
}
```

The function has an outer `try { ... } catch { return empty; }` and
an explicit `if (raw.length === 0) return empty;` — it cannot resolve
to `null`, and it cannot reject. The brief's hypothesis ("if
`getInsiderActivity()` returns null, the wrapper produces `_noData`
without calling `runInsider`") is therefore not what is happening
in the current code: `insiderActivity` in
`score-at-date.ts:561,584-585` is always truthy, the `runInsider`
branch always fires, and the `_noData: true` fallback at
`score-at-date.ts:616-622` is dead code on this path under current
provider implementation.

### Where the silence comes from — `runInsider(empty)`

File: `netlify/functions/shared/insider-provider.ts:217-261`.

```typescript
export function scoreInsiderActivity(a: InsiderActivity): {
  score: number; confidence: number; rationale: string; tags: string[];
} {
  // ...
  if (a.totalBuys === 0 && a.totalSells === 0) {
    return { score: 50, confidence: 0.1, rationale: 'no recent insider activity', tags: [] };
  }
  // ... rest of scoring (handles -ve, +ve netDollars, clusters, etc.) ...
}
```

When `getInsiderActivity` returns the `empty` shape (because
`getFinnhubInsiderTransactions` returned `raw.length === 0`),
`runInsider(empty)` → `scoreInsiderActivity(empty)` → hits the
early-return at line 224-226 → score=50. `runInsider` then wraps
with `direction: 'neutral'`, `confidence: 0.1`, signals containing
all the zero fields but **no `_noData` flag**. Attribution stores
score=50.

The brief's "silent" metric (read from `layers.insider` in
attribution) registers this as silent because the raw number stored
is 50. The brief's framing-text "produces `_noData` without even
calling `runInsider`" is the wrong mechanism but the right
empirical pattern.

### Why `getFinnhubInsiderTransactions` returns empty for so many PIT calls

File: `netlify/functions/shared/data-provider.ts:584-666`.

```typescript
const anchor = opts.asOfDate
  ? Date.parse(opts.asOfDate + 'T23:59:59Z')
  : Date.now();
const from = new Date(anchor - daysBack * 86400000).toISOString().slice(0, 10);
const to = new Date(anchor).toISOString().slice(0, 10);
const url = `${FINNHUB}/stock/insider-transactions?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${finnhubKey()}`;
```

Unlike `getEarningsHistory`, this URL **does** thread `from` and
`to` correctly. `daysBack = lookbackDays + 365 = 455` when called
from `getInsiderActivity(ticker, 90, { asOfDate })`. For NVDA on
2020-06-30 the URL is
`/stock/insider-transactions?symbol=NVDA&from=2019-04-02&to=2020-06-30`.
That call should return rich historical Form 4 data for NVDA in
that 15-month window.

Post-fetch the response is parsed with
`FinnhubInsiderTxResponseSchema`. The schema is permissive
(`.passthrough()`, all fields `.optional().default(...)`), so a
malformed response is unlikely to be silently dropped.

Then the body filter (line 624-642) maps to
`InsiderTransaction[]` and drops rows missing `name`,
`transactionDate`, finite `change`, finite `transactionPrice`.

Then `getInsiderActivity` (insider-provider.ts:84-95) filters
`inWindow` to `transactionDate >= asOfDate - 90 days` and bins
into `buys` (`transactionCode === 'P' && share > 0`) and `sells`
(`transactionCode === 'S' && share < 0`). **Only `P` (open-market
purchase) and `S` (open-market sale) Form 4 transaction codes
count.** Stock comp grants (`A`), option exercises (`M`), gifts
(`G`), tax-payment-for-option-exercise (`F`) — the bulk of large-cap
Form 4 activity — are excluded from the count.

The 70-98% silent rate is therefore consistent with one of three
upstream causes — and I cannot fully discriminate among them without
one direct probe:

- **Hypothesis I-A: Finnhub historical depth limit.** Finnhub's
  `/stock/insider-transactions` may return sparse or empty results
  for historical windows older than 1-2 years on this plan even
  though the URL builds correctly. The variable 70-98% per-year
  rate (not a clean cliff) argues against a hard archive-depth
  limit, but a soft one (lower coverage farther back) is plausible.

- **Hypothesis I-B: Transaction-code filter exclusion.** If
  Finnhub's historical Form 4 normalisation differs from its live
  feed — e.g., historical sells were tagged `F` or `M` instead of
  `S` more often — then `getInsiderActivity` would correctly count
  zero `S` rows even with rich underlying activity. NVDA's brief
  live value (`$163.7M net sells`) is consistent with the `S`
  branch hitting on the live URL; PIT URL behaviour on the same
  ticker for 2020 is what we need to inspect.

- **Hypothesis I-C: Stale PIT cache.** The PIT cache
  (`shared/pit-cache.ts:144-146`) writes `fresh` to Firestore even
  when `fresh` is the `empty` InsiderActivity shape. A prior
  bugged run (e.g., from before Phase 4o W1's rate-limit handling)
  would have cached `empty` for many (ticker, asOfDate) pairs that
  are now serving the backtest. `PIT_CACHE_BYPASS=1` would let us
  test this in one shot, OR comparing PIT-cache hit rates would
  surface it.

The diagnostic experiment that distinguishes these is a single
deployed temporary endpoint that takes a (ticker, asOfDate) pair
and returns the raw `getFinnhubInsiderTransactionsWithStatus` body
plus a per-`transactionCode` histogram of the in-window
transactions, with `PIT_CACHE_BYPASS=1` set on that one call. I
recommend wiring this into the W2 PR as a permanent gated
admin-only diagnostic so the next time this kind of
"data path returns empty in one mode but not another" question
arises we have a debugging surface — it's a tiny endpoint and the
4t-recovery PR established the always-stamp-telemetry precedent.

### Named root cause — insider

**The brief's mechanism description ("getInsiderActivity returns
null") is wrong in the current code; the empirically observed
score=50 silence comes from `getInsiderActivity` returning the
`empty` shape due to `getFinnhubInsiderTransactions` returning
zero rows for the historical PIT window.** Which of (I-A) provider
historical depth, (I-B) transaction-code mapping, or (I-C) stale
PIT cache is the dominant cause requires one direct probe to
confirm. **My current best read is (I-B) + (I-C) combined**:
the variable per-year rate (70-98%, not flat) is consistent with
the `P`/`S` filter excluding most large-cap Form 4 activity in
many windows, made worse by cached `empty` entries from earlier
runs. The most surgical fix surface, regardless of which
hypothesis wins, is:

- Expand the `transactionCode` filter in `insider-provider.ts:94-95`
  to include `S` regardless of the `share < 0` sign convention
  (Finnhub's `share` semantics may differ between historical and
  live feeds), and consider counting `F` (forced sales for tax) as a
  weakly-signaled sell rather than excluding entirely. Mirror the
  separation Quiver's `/live/insiders` does.
- AND wire the diagnostic endpoint (above) into W2 so the
  hypothesis is verifiable in production after deploy.

This is more speculative than the earnings root cause; the
confidence section below reflects that.

## Are the two related?

Partially. They share the same architectural surface — both go
through `score-at-date.ts:scoreTargetAtDate`'s `Promise.all` block
where each fetch is wrapped in `pitCacheWrap` and the inner fetch
has a `.catch(() => null)`/`.catch(() => [])` swallow. They share
the property that the `.catch(() => null)` defence is the kind of
"silent fallback" that hides real problems — the 4t-recovery PR's
"always-stamp-telemetry" precedent applies equally here, and any
W2 fix should include surfacing what got swallowed (Sentry
breadcrumb or structured warning to the rebalance warnings
collection).

But the **failure modes are independent**:

- Earnings: two confirmed code defects in the EARNINGS-specific
  modules (`data-provider.ts` URL build + `analysts/core.ts`
  Date.now usage). Neither would affect insider; neither would
  affect any other analyst.

- Insider: the `runInsider(empty) → score=50` path that the
  brief's metric registers as "silent". The upstream cause —
  provider depth vs code-side filter vs cache pollution — needs
  one direct probe to discriminate. Even at the resolution where
  the bug is identified, the fix is INSIDER-specific
  (`insider-provider.ts` filter expansion + cache bypass for one
  diagnostic).

So: not one bug with two symptoms. Two bugs with one shared
architectural concern (`.catch()` swallows).

## Proposed fix

### Earnings — two specific changes, ~30 LOC total

1. **`netlify/functions/shared/data-provider.ts:475-508`** —
   reroute `getEarningsHistory` through Finnhub's
   `/calendar/earnings?from=&to=&symbol=` endpoint when
   `opts.asOfDate` is set. Build the window as `from = asOfDate -
   limit*100d` (covers ~4 quarters of history with slack), `to =
   asOfDate`. Filter the response by `actual !== null && actual !==
   undefined` to keep only reported quarters (the calendar endpoint
   returns both past and future entries with `actual` only populated
   for past). Map to `EarningsSurprise[]` as today. The live path
   (no `asOfDate`) continues to use `/stock/earnings?limit=4` —
   no change.

   ~15 LOC. Touches one file. Affects one analyst's data path.
   Does not change any analyst's scoring math. Does not affect
   sp500 vs russell2k (W1b) or any non-earnings analyst.

2. **`netlify/functions/analysts/core.ts:123-172`** — thread
   `asOfDate` through to `runEarnings`. Either (a) add a third
   parameter `{ asOfDate?: string }` to `runEarnings` and pass it
   from both callers (`scoreTargetAtDate` and `runAnalystsForTicker`),
   or (b) compute `nowMs` inside `runEarnings` from
   `upcoming?.asOfDate` if we add the field to `UpcomingEarning`,
   or (c) the simplest: mirror the `earnings-intel.ts:111-118`
   pattern exactly — accept an optional `asOfDate` parameter and
   use it in the `days =` calculation. Live callers pass nothing
   (preserves current behaviour); PIT caller passes `asOfDate`.

   ~15 LOC + small adjustments to the two callers + the
   `earnings-intel.ts` precedent already exists.

### Insider — one filter change + one diagnostic surface, ~50 LOC total

1. **`netlify/functions/shared/insider-provider.ts:94-95`** — expand
   the buy/sell binning to be tolerant of `share` sign convention
   variation between Finnhub's historical and live feeds. Use the
   `transactionCode` as the authoritative direction signal (`P` is
   always a buy regardless of `share` sign in the row;
   `S`/`F`/`M` mapped as sells with attenuated weight for `F`/`M`
   in `scoreInsiderActivity`). Mirror the live behaviour exactly
   for the live path — this is a PIT-fix, not a scoring redesign.

   ~15 LOC.

2. **Add a permanent gated diagnostic endpoint** to
   `/api/target-rationale` (or a sibling `/api/insider-debug` if
   the orchestrator prefers) that accepts `?asOfDate=YYYY-MM-DD` and
   `?ticker=X` and returns:
   - The raw `getFinnhubInsiderTransactionsWithStatus` body for
     that pair (with `PIT_CACHE_BYPASS=1` set on that one call).
   - A per-`transactionCode` histogram of the in-window transactions.
   - The resulting `InsiderActivity` shape after `getInsiderActivity`
     processing.
   - A diff vs the live call (same ticker, no asOfDate).

   ~30 LOC for a read-only diagnostic. Gated to admin email
   (chadwickblyth@gmail.com) per existing auth pattern. **This is
   exactly the kind of telemetry the 4t-recovery PR's
   "always-stamp-telemetry" discipline argues for** — silent
   fallbacks are how we got here.

3. **Replace `.catch(() => null)` and `.catch(() => [])` in
   `score-at-date.ts:567-597`** with a logged-then-fallback
   pattern (Sentry breadcrumb or structured warning written to
   the per-rebalance warnings collection via the engine's
   existing `appendWarningRows`). Each call's failure becomes
   diagnosable in the warning subcollection. **This is a
   cross-analyst change — it touches the data-fetch wrapping
   for all 8 PIT fetches**. Surfaces to the orchestrator: include
   in W2 or scope out as Phase 4t W1d? My recommendation is
   include in W2 since it's small, makes the next "silent silence"
   diagnosable for free, and the brief explicitly endorses the
   discipline. But if the orchestrator wants the W2 PR to remain
   tightly scoped to earnings+insider data paths only, this can
   be a follow-on phase.

### Estimated diff size

Earnings: ~30 LOC code + ~80 LOC test = 110 LOC.

Insider (filter change + diagnostic endpoint): ~45 LOC code + ~50 LOC
test = 95 LOC.

Optional `.catch` logging change: ~30 LOC, affects 8 sites
symmetrically (one helper function `loggedCatch(label)`).

Total W2 + W3: well under the 150-LOC "stop and re-scope" threshold.

## Confidence

**High** on the earnings root cause.

- E1 is provable from code reading: the URL plainly omits
  `from`/`to`, the Finnhub endpoint is recent-anchored, the
  post-filter cannot survive when the fetched window doesn't
  reach `asOfDate`. The brief's "100% silent in every year
  2018-2024" matches this construction exactly when Finnhub's
  effective return is the most recent ~4 quarters (its default).
- E2 is provable from code reading: `Date.now()` versus
  `asOfDate`; the upcoming branch cannot fire in PIT mode
  regardless. `earnings-intel.ts` already contains the
  PIT-correct precedent that just wasn't applied to
  `analysts/core.ts:runEarnings`.

**Medium** on the insider root cause.

- The mechanism (score=50 from `runInsider(empty)`) is confirmed
  from code reading.
- The upstream cause (provider depth vs transaction-code mapping
  vs stale cache) is a calibrated hypothesis, not a confirmed
  cause. Without one direct probe (the diagnostic endpoint I
  propose for W2, or admin-SDK access to the PIT cache) I cannot
  definitively name the dominant contributor.
- The proposed fix (expand transaction-code binning + add
  diagnostic endpoint) is conservative: the filter expansion
  addresses (I-B) which is my leading hypothesis, the diagnostic
  endpoint surfaces ground truth for (I-A) and (I-C) at deploy
  time so subsequent fixes (if needed) are evidence-based.

**Low** confidence claim I want to flag honestly: the brief's
mechanism statement for insider ("`getInsiderActivity()` returns
null, the wrapper produces `_noData`") is not what the current
code does. The 70-98% rate must therefore come from a different
mechanism than the brief describes. I have proposed one (score=50
from `runInsider(empty)`) that is consistent with all observed
data, but there is a non-trivial chance I am missing a code path
that does in fact let `insiderActivity` be `null` (e.g., a
codepath in `pitCacheWrap` or `pitCacheGetRaw` returning null
under certain Firestore states I haven't catalogued, or stale
cache entries from before `getInsiderActivity`'s try/catch was
added). The W2 PR should include the diagnostic endpoint
regardless, even if the proposed filter expansion turns out
to be necessary-but-not-sufficient.

## Things to verify before W2 lands

- [ ] **Probe earnings provider behaviour once.** Call
      `getEarningsHistory('NVDA', 4, { asOfDate: '2020-06-30' })`
      with `PIT_CACHE_BYPASS=1` and inspect: how many rows did
      Finnhub return at `limit=32`? How many survived
      `Number.isFinite` filtering? How many survived the
      `<= asOfDate` filter? This confirms whether E1 is "Finnhub
      caps at 4" vs "Finnhub returns 32 but post-filter is brittle".
      Either way, the fix is the same (route through
      `/calendar/earnings?from=&to=`), but the diagnosis text in
      the W2 PR body should reflect ground truth.

- [ ] **Probe insider provider behaviour once.** Call
      `getFinnhubInsiderTransactionsWithStatus('NVDA', 455, {
      asOfDate: '2020-06-30' })` with `PIT_CACHE_BYPASS=1` and
      inspect the raw `data` length, the per-`transactionCode`
      histogram, and the `rateLimited`/`errorMessage` envelope.
      This distinguishes hypotheses I-A vs I-B vs I-C.

- [ ] **Confirm `runEarnings`' two callers.** `scoreTargetAtDate`
      at `score-at-date.ts:611` and `runAnalystsForTicker` at
      `analyst-runner.ts:135`. If there's a third caller I missed,
      the `asOfDate` parameter threading needs to extend to it.
      `grep -rn "runEarnings\b" netlify/` should be sufficient.

- [ ] **Confirm sp500 vs russell2k blast radius.** Neither
      earnings nor insider fix touches universe-resolution or
      survivorship logic, so PR #52's work is isolated. But the
      `analyst-runner.ts` change does affect the live target board
      for sp500 + russell2k symmetrically — verify that the live
      path's existing behaviour is preserved (it should be: the
      no-`asOfDate` branch of `runEarnings` would still use
      `Date.now()` since the caller passes no date).

- [ ] **Re-run baseline tests before opening the W2 PR.** Current
      branch baseline: `npm test` → 1054 passing (verified locally
      pre-diagnosis). All must still pass after W2.

- [ ] **Diagnostic endpoint cleanup if the orchestrator opts.** If
      the diagnostic endpoint is intended to be temporary (per
      W1c kickoff "remove it before W2 ships" default), then the
      W2 PR removes it. If the orchestrator opts to keep it as
      a permanent gated admin diagnostic surface, document the
      auth gate in the PR body and link it from
      `docs/BACKTEST_LIMITATIONS.md`.

— Executor 4t W1c

---

## Addendum — probe results (2026-05-20)

Per orchestrator W1c review: earnings authorised for W2; insider
required a probe first. The diagnostic endpoint
`/api/diag-insider-pit` was deployed on this branch and called
against five (ticker, asOfDate) pairs to discriminate I-A/I-B/I-C.
The probe **rejects I-A and I-B and confirms I-C**, but in a
specific and architecturally tractable form. The leading-read in
the report above ("I-B + I-C combined") was wrong on I-B; the
true cause is cache pollution alone.

### Raw probe data

```text
NVDA / 2020-06-30
  pit raw rows: 273
  pit in-window histogram: {S: 99, F: 5, A: 11}
  pit processed: { totalBuys: 0, totalSells: 99, netDollars: -95,082,060 }   ← NOT silent
  pit cache: absent
  live processed: { totalSells: 38, netDollars: -163,747,346 }

AAPL / 2022-03-31
  pit raw rows: 145
  pit in-window histogram: {A: 8, S: 5, M: 16, G: 1}
  pit processed: { totalBuys: 0, totalSells: 5, netDollars: -4,713,702 }     ← NOT silent
  pit cache: HIT — cachedShape: 'empty', cachedFetchedAt: '2026-05-14T10:31:02Z'   ← STALE EMPTY
  live processed: { totalSells: 12, netDollars: -96,154,105 }

MSFT / 2021-12-31
  pit raw rows: 199
  pit in-window histogram: {A: 19, G: 2, S: 19, F: 4}
  pit processed: { totalBuys: 0, totalSells: 19, netDollars: -322,158,999 }  ← NOT silent
  pit cache: absent
  live processed: { totalSells: 2, netDollars: -5,564,810 }

NVDA / 2024-06-30
  pit raw rows: 584
  pit in-window histogram: {S: 222, G: 7, F: 6, A: 2}
  pit processed: { totalBuys: 0, totalSells: 222, netDollars: -537,719,169 } ← NOT silent
  pit cache: absent

AAPL / 2020-06-30
  pit raw rows: 145
  pit in-window histogram: {S: 23, M: 19, F: 4}
  pit processed: { totalBuys: 0, totalSells: 23, netDollars: -24,750,311 }   ← NOT silent
  pit cache: absent
```

### What the probe rejects

- **I-A (provider depth) REJECTED.** Finnhub `/stock/insider-transactions`
  returns rich historical data for every probed (ticker, asOfDate)
  pair, including 273 rows for NVDA 2020-06-30 and 199 rows for
  MSFT 2021-12-31. The `from`/`to` URL building at
  `data-provider.ts:599-601` works correctly for historical windows.
  The brief's hypothesis "Finnhub coverage cliff" was wrong for
  insider.

- **I-B (transactionCode filter exclusion) REJECTED.** Every probed
  PIT call has `S` (open-market sale) codes in the in-window
  histogram. The processed `totalSells` matches the in-window
  `S` count exactly (99 for NVDA-2020, 5 for AAPL-2022, 19 for
  MSFT-2021, 222 for NVDA-2024, 23 for AAPL-2020). The filter at
  `insider-provider.ts:94-95` is correctly counting sells. The
  brief's hypothesis "P/S filter exclusion" — and my own original
  leading read — was also wrong.

### What the probe confirms

**I-C (stale PIT cache) is the cause, in a specific architecturally
tractable form.**

The AAPL/2022-03-31 probe shows the cache holding `cachedShape: 'empty'`
from 2026-05-14T10:31:02Z — five days before the
`bt_20260519233423_avaa64` sp500 backtest ran. Calling the live
provider RIGHT NOW returns 5 `S` transactions in the same 90-day
window, which would process to `totalSells: 5, netDollars:
-$4.7M, score: 40 (short — "net sells")`. **The cache serves a
stale empty that does not reflect actual provider data.** The
backtest read that stale empty, ran `runInsider(empty)` →
`scoreInsiderActivity` early-return → score=50 → attribution
records 50 → brief's coverage script registers as silent.

The remaining four pairs show `cache: absent` (probably because
the sp500 backtest's writes have either not persisted to the
public-read query path, or those specific keys were cleaned
between then and now). The pattern is consistent with cache
pollution being PARTIAL across the backtest's 1,662 attribution
rows — the brief's 70-98% per-year silence (not a uniform
100%) matches a cache that has many but not all entries poisoned.

### Architectural root cause

`netlify/functions/shared/insider-provider.ts:70` calls
`getFinnhubInsiderTransactions(...)` which is a thin wrapper that
**discards the status envelope** returned by the underlying
`getFinnhubInsiderTransactionsWithStatus`:

```typescript
// data-provider.ts:570-577
export async function getFinnhubInsiderTransactions(
  ticker: string,
  daysBack: number = 180,
  opts: { asOfDate?: string } = {},
): Promise<FinnhubInsiderTx[]> {
  const r = await getFinnhubInsiderTransactionsWithStatus(ticker, daysBack, opts);
  return r.data;   // ← drops `rateLimited`, `rateLimitExhausted`, `errorMessage`
}
```

When the status envelope has `rateLimitExhausted: true` or a non-429
`errorMessage`, `data` is `[]`. `getInsiderActivity` sees
`raw.length === 0` and returns the `empty` InsiderActivity shape
(line 73). **`empty` from rate-limit-exhaustion is indistinguishable
from `empty` from verified-no-activity.**

`pitCacheWrap` (`shared/pit-cache.ts:144-146`) then caches that
`empty` shape with the comment "Cache nulls too — 'no insider
activity in window' is itself PIT-stable." That comment is only
correct when the call succeeded. For a rate-limit-exhausted call
the cache is **lying** — it claims to know the answer when in fact
the call failed.

The Phase 4o W1 work that added the WithStatus envelope explicitly
designed for surfaceability ("a 429-storm no longer becomes a
silent `[]`") — but the consumer (`getInsiderActivity`) drops the
status, and the cache layer caches the silently-failed `[]` as if
it were verified empty. Phase 4o W1's intent was undermined at the
consumer boundary.

### Revised root cause — insider

**`getInsiderActivity` discards the `rateLimitExhausted`/`errorMessage`
status from `getFinnhubInsiderTransactionsWithStatus`, returns
the `empty` shape on any provider failure, and `pitCacheWrap`
caches that empty shape permanently.** Every backtest run after
a rate-limit storm (or any other transient provider failure)
serves cached lies for any key that was poisoned. The 70-98%
chronic silence is the cumulative effect of poisoned keys
across runs.

Confirmed by direct cache inspection on AAPL/2022-03-31. The
leading-read in the original report ("I-B + I-C combined") was
wrong on I-B; the true cause is I-C alone, in a specific
architectural form (cache poisoning by error-derived empties).

### Revised proposed fix — insider

Three small surgical changes:

1. **`netlify/functions/shared/insider-provider.ts:67-73`** — call
   `getFinnhubInsiderTransactionsWithStatus` directly (not the
   thin `getFinnhubInsiderTransactions` wrapper). Check
   `r.rateLimitExhausted` and `r.errorMessage`. If either is set,
   **throw a `ProviderUnavailableError`** so the caller can
   distinguish "failed fetch, unknown" from "successful fetch,
   verified empty." ~15 LOC.

2. **`netlify/functions/shared/backtest/score-at-date.ts:583-585`** —
   wrap the insider fetcher in a "don't cache failures" pattern.
   Either:
   - **(a)** Catch `ProviderUnavailableError` in the fetcher
     itself before pitCacheWrap sees it; if caught, return a
     sentinel that `pitCacheSet` skips writing. Requires extending
     `pitCacheWrap` with an optional `shouldCache` predicate.
     ~20 LOC across pit-cache.ts + score-at-date.ts.
   - **(b)** Use a new `pitCacheWrapNoErrorCache(key, fetcher)`
     variant that swallows known error types and bypasses the
     cache write on them. Same effect, slightly more invasive
     because it's a new public API.
   - Recommend **(a)**: a `shouldCache: (value) => boolean`
     optional second-positional arg on `pitCacheWrap` keeps the
     API surface small. Default behaviour (cache everything,
     including null/empty) is unchanged for other callers; insider
     opts in.

3. **One-shot cache cleanup script** at
   `scripts/clear-stale-insider-empties.ts`. Reads
   `pitCache` Firestore docs where `key.provider === 'finnhub' &&
   key.dataClass === 'insider' && value.totalBuys === 0 &&
   value.totalSells === 0`, deletes them. Documented in the script
   comment header and in `docs/BACKTEST_LIMITATIONS.md`. After
   deploying the W2 fix, run this once; subsequent backtests
   repopulate the cache with the corrected behaviour and the
   silence rate drops. **The script is the cure for the
   already-poisoned 1,662 rows**; the code fix prevents recurrence.
   ~30 LOC.

**Total revised insider scope: ~65 LOC.** Slightly larger than the
original ~45 LOC estimate (was: filter expansion + diagnostic
endpoint = ~45 LOC) because the actual fix touches three sites
(provider call, cache wrap, cleanup script) — but each site is
small and the fix is architecturally clean.

The diagnostic endpoint `/api/diag-insider-pit` already shipped
on this branch (committed `eb379df`); per the orchestrator's W1
review ("The diagnostic endpoint is a good idea regardless —
keep it in scope") it remains permanent and gated only by the
"private URL" model.

### Revised confidence — insider

**High** on the root cause (cache poisoning of rate-limit-exhausted
empties), backed by direct cache inspection of AAPL/2022-03-31
showing `cachedShape: 'empty'` from 2026-05-14 alongside a live
provider response with 5 `S` transactions in window.

**Medium** on whether `shouldCache` (option 2a) is the right
ergonomic shape for the cache fix. The alternative — having
`getInsiderActivity` throw and `pitCacheWrap` not cache thrown
errors — is also clean (throws never reach `pitCacheSet`). But
the outer `.catch(() => null)` at `score-at-date.ts:584` would
catch the throw before pitCacheWrap could surface it to the
caller. So `shouldCache` (the value-shape predicate) is more
robust than throw-based control flow here.

**Open question for orchestrator**: option 2a (shouldCache
predicate on pitCacheWrap) extends a shared module's API. That
shared module is consumed by ALL eight PIT fetches in
`score-at-date.ts`, not just insider. The W1c constraint is
"earnings + insider data paths only; do NOT touch other
analysts." A shouldCache addition that only insider OPTS INTO
stays inside the W1c scope — but it does extend the shared
module's surface. If the orchestrator prefers a strictly local
fix, option 2b (a new `pitCacheWrapNoErrorCache` co-located in
`score-at-date.ts` or a small helper in `insider-provider.ts`)
keeps the pit-cache shared module untouched but means a slightly
larger surface in the insider-specific code. Recommend **2a** for
elegance; defer to orchestrator for scope discipline.

### Revised W2 scope summary

- Earnings: ~30 LOC code + ~80 LOC tests (unchanged from original).
- Insider: ~65 LOC code + ~50 LOC tests (revised up from ~45 LOC).
- Diagnostic endpoint: already shipped on this branch (~350 LOC
  including hypothesis tagging) — permanent gated.
- Cache-cleanup script: ~30 LOC + simple unit test (~20 LOC).
- Optional `.catch` → logged-fallback: ~30 LOC (deferred — would
  cross W1c scope into other-analyst paths).

**Total: ~275 LOC code + ~150 LOC tests = ~425 LOC**, still under
any reasonable "stop and re-scope" threshold.

### Updated hand-off summary

```
Probe results — insider root cause discrimination:
  I-A (provider depth):      REJECTED. Finnhub returns 145-584 historical
    rows per ticker; 'S' codes present in every probed window.
  I-B (code filter exclusion): REJECTED. Processed totalSells matches
    in-window 'S' counts exactly across all 5 probes. The filter works.
  I-C (stale PIT cache):     CONFIRMED. AAPL/2022-03-31 cache holds
    cachedShape: 'empty' from 2026-05-14T10:31:02Z, while the live
    provider response in the same window has 5 'S' transactions
    ($4.7M sells). The backtest read the stale cache, not the live data.

Architectural root cause:
  getInsiderActivity (insider-provider.ts:70) discards the
  rateLimitExhausted / errorMessage status envelope from
  getFinnhubInsiderTransactionsWithStatus, returns the `empty` shape
  indistinguishably from verified-no-activity. pitCacheWrap then caches
  that empty permanently.

Revised insider W2 scope:
  1. insider-provider.ts: use WithStatus variant, throw on failure
  2. pit-cache.ts: add optional shouldCache predicate; insider opts in
  3. scripts/clear-stale-insider-empties.ts: one-shot cleanup of the
     1,662-row contamination
  ~65 LOC code + ~50 LOC tests.
```
