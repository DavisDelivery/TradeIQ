# Social-arbitrage study — why the Trend tab has no score

**Run id:** `social-arb-study-2026-08-03`
**Verdict:** `NO_EDGE` (see `netlify/functions/shared/verdicts.ts` → `trend`)
**Decision:** ship the attribution layer, do not ship the signal.

## What was measured

A consumer-attention ("social arbitrage") signal in the style Chris Camillo
describes: consumer interest accelerating while investor interest has not yet
responded. Implemented as three measures over 22 hand-picked US consumer
tickers, 2021-08 → 2026-07:

- **consumer velocity** — z of the trailing 4 weeks vs its own 26-week
  baseline, from Google Trends + Wikipedia pageviews
- **convergence** — count of independent consumer sources confirming
- **investor saturation** — ticker-search interest, retail chatter, volume,
  price momentum

Event study: fire on weekly `z >= 1.5`, 4-week cooldown, enter the next
trading day, measure 1w / 4w / 12w excess return vs SPY. 225 events.

## Headline (raw)

| Cohort | n | 4w excess | 12w excess | naive t (12w) |
|---|---|---|---|---|
| All signals | 225 | +1.70% | +3.36% | 1.53 |
| Low investor saturation | 194 | +1.94% | +3.99% | 1.68 |
| High investor saturation | 31 | +0.22% | −0.56% | −0.10 |

## Why none of that survived

**1. It fails a placebo test.** Random entry into the same 22 names over the
same window matches or beats the signal. Two independent null models
disagreed on magnitude (−2.02pp to +2.14pp incremental) — a quantity whose
placebo estimate swings 4pp depending on how dates are drawn is not a
quantity to size positions against.

**2. The saturation split was a coercion bug, not a finding.** Consumer and
investor keywords were sent in one Google Trends batch. Trends normalises
every series in a batch to the highest-volume term, so the investor series
quantised to near-constant, its z returned `None`, and `None` was coerced to
`0.0`. The cohort test `0.0 < z * 0.6` is then **true by construction** for
every event. 58 of 194 "low saturation" events had `investor_z == 0.0` and
average **+16.2%**; the 136 with a real investor z average **−1.2%**, against
−0.56% for high saturation. The split disappears.

**3. Three further inflations.**
- *Look-ahead:* pytrends labels weekly rows by week **start**, so entry landed
  inside the signal week. Correcting it flips the 1w result from +0.49% to
  **−0.87%**.
- *Beta:* "excess vs SPY" assumed beta 1.0 on a universe averaging **1.59**.
  Beta-adjusting cuts 12w from +3.36% to **+1.73%**.
- *Overlap:* 225 events from 22 tickers with overlapping 12-week windows give
  **N_eff ≈ 66**. Corrected **t ≈ 0.4**.

**4. Concentration.** HIMS (+1.88pp) and TDUP (+1.81pp) alone exceed the
+3.36pp total. **12 of 22 tickers are net negative.** Dropping the 5 best of
225 events turns the 4w result negative.

**5. Wrong side of the literature.** Da/Engelberg/Gao (2011) measure the
attention effect at ~34bp over two weeks, **reversing** over weeks 5–52 — the
exact window where this claimed its largest gain. Signals from what consumers
*do* (sales rank, review velocity, downloads) do not reverse; signals from
what people *look at* do.

## What shipped instead

The entity-resolution half, which answers a **factual** question rather than a
predictive one: *which public filers write this phrase into their filings?*
SEC EDGAR full-text search exposes an `entity_filter` aggregation whose
buckets carry ticker and CIK. Guarded by a **specificity ratio**
(top bucket ÷ total hits, reject below 0.25) so homonyms — bare "Celsius"
scores 0.054 — are labelled ambiguous rather than presented as attribution.

Wikipedia pageviews ride along as descriptive context only: absolute counts,
no score, no ranking, and an explicit note that attention measured this way
reverses.

## Pre-committed gate for ever adding a score

Do not add a ranked or scored version of this board without, in order:

1. **6–12 months of timestamped forward paper signals with a random control
   cohort** drawn from the same universe, showing the signal beats the control.
2. A **point-in-time universe** (delisting-inclusive, rule-selected) on which
   the placebo-adjusted 12w excess is positive with a ticker-clustered
   **t > 2**.
3. If the payoff turns out to concentrate around earnings, build the
   earnings-timing product instead — that effect is published and larger
   (Froot et al.: 3.40% five-day announcement spread, t = 3.43).

## Integration defects found at review (2026-08-03, before merge)

The feature above was authored in a separate session and reviewed here before
landing. Three problems were found that measurement — not reading — caught:

1. **No `netlify.toml` redirect.** This repo has no `/api/*` wildcard; all 60
   endpoints are routed explicitly, and the SPA catch-all answers anything
   unrouted with `/index.html` at **status 200**. `fetchWithRetry` only
   retries 502/503/504, so a 200 passes through and `r.json()` throws
   `Unexpected token '<'`. The tab would have been dead on arrival with an
   error pointing nowhere near the cause. Added.
2. **No function timeout.** The handler makes up to three sequential upstream
   calls (EDGAR FTS → Wikipedia resolve → pageviews) against Netlify's 10s
   default. A timeout surfaces as 502, which *is* in the retry list — turning
   one slow SEC response into three more requests against the shared budget,
   the exact amplification the throttle-to-429 mapping exists to prevent.
   Added `timeout = 26`, matching the other multi-call endpoints.
3. **The "no buy/sell language" test was hollow.** It banned the substring
   `expected return`, but its fixture's disclaimer was truncated while the
   real API disclaimer ends *"…not demand, materiality, or expected return."*
   The test passed only because the fixture diverged from the contract it was
   testing; syncing them would have failed it. The fixture now carries the
   real disclaimer and the ban-list is scoped to the results region, so the
   guarantee is enforced where promotional language would actually appear.

Two smaller corrections: `EFTS_EPOCH` was exported but unused while the "Max"
window allowed 9,000 days (reaching before 2001, which EDGAR's full-text index
does not cover) — the start date is now clamped to the epoch. And the ticker
regex accepted any all-caps parenthetical, so a name like `SANOFI (US)` would
be misread as ticker `US`; it now requires the double-space field separator
EDGAR uses, which distinguishes a field from part of the company's own name.
