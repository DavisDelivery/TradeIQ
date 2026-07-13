# FIX-2 — PEAD / earnings-reaction event study

**Purpose.** Measure whether the earnings playType taxonomy
(`pead_long / pead_short / reversal / long_volatility / short_volatility /
directional_long / directional_short`) has a realized, out-of-sample edge —
BEFORE re-deriving any scoring from it. The taxonomy's current composite is
hand-typed constants (70/75/65/35 in `shared/earnings-scoring.ts`); it has
never been validated. This study is the honest base-rate engine every later
FIX-2 step cites.

Evidence source: `GET /api/earnings-edge-study` (W2), background/cached to
Firestore. Pure price + PIT surprise data — **no transcripts / LLM** (that
is FIX-2B). Survivorship is handled via the backtest engine's
universe-as-of membership (delisted/acquired members included); the study
output states its survivorship handling explicitly.

---

## PRE-COMMITTED DECISION RULE (written 2026-07-11, BEFORE any study numbers exist; binding)

This section is committed before the study runs. Same anti-p-hack
discipline as FIX-1 W3 (`reports/fix-1/composite-verdict.md`): the
thresholds below are fixed now and may not change after the first study
result lands. No tuning during measurement.

**A playType's scoring SURVIVES (stays scored as edge) only if its
bucket — measured over 2018-01-31 → 2024-12-31, both universes — shows
ALL THREE of:**

1. **Statistical reliability:** forward-return t-stat **≥ 2.0** on the
   primary horizon (fwdRet from +2 → +20 trading days), AND
2. **Ranking information:** **positive IC** of the driving signal
   (surprise for PEAD; RV-rank for vol; drift for directional) vs fwdRet
   within the bucket, AND
3. **Economic size:** mean fwdRet edge **greater than the round-trip cost
   model** for that universe (earnings turnover is not cheap: sp500
   ≈ 10 bps/leg = 20 bps round-trip; russell2k ≈ 40 bps/leg = 80 bps
   round-trip — matches the FIX-1 cost model). A statistically-significant
   1-bp edge that costs 20 bps to harvest does NOT survive.

**Consequences (pre-committed):**

- **Surviving playTypes** → `scoreEarningsComposite` is REPLACED (W3) with
  a score **monotonic in the realized bucket edge** — the composite ranks
  by measured effect size, not by the typed constants. `MODEL_VERSION`
  bumps (this is a real scoring change, unlike FIX-1 / DESK-1).
- **Non-surviving playTypes** (e.g. if `reversal` shows no continuation,
  or `directional_*` drift is arbitraged away) → demoted to
  **score ≤ 40** and labelled **"unvalidated"**. They are NOT deleted (the
  taxonomy stays legible) but never rank as edge.
- **If NOTHING survives** → the earnings composite becomes a **screener**
  exactly like Target/Williams/Lynch, its verdict is **NO VALIDATED
  EDGE** in `shared/verdicts.ts`, and the edge search moves to **FIX-2B
  (transcripts)**, which plugs into the harness built here. **We
  pre-commit to accepting this outcome if the numbers say so.**

There is no fourth outcome. "Significant but below costs" → demote.
"Works only in one regime" → the surviving score is gated to that regime,
or demoted if the regime sample is too thin (n < 30 per the em-dash gate).

---

## Method (W2)

For every historical earnings event in the universe over the window:

| Field | Definition (PIT) |
|---|---|
| `surprisePct` | Finnhub actual vs estimate, announcement-dated ≤ event |
| `reaction0_1` | signed % move announce-day close → +1 trading-bar close (the initial gap) |
| `fwdRet[N]` | forward return from +2 bar → +N bar, N ∈ {5, 20, 60}, PIT bars |
| `regime` | risk_on / neutral / risk_off tag at the event date (server-side `regime.ts`) |

Aggregation (the point):

- Bucket by **surprise quintile × reaction sign**. Per bucket: `n`,
  mean `fwdRet` (5/20/60d), hit rate, **t-stat**, and **IC** of
  surprise-vs-fwdRet within the bucket.
- Same cut **per regime** (does PEAD only pay in neutral / risk-off?).
- **Reversal hypothesis, tested not assumed:** isolate
  gap-AGAINST-surprise events (gap up on a miss / gap down on a beat) —
  do they mean-revert or continue? Report both directions.
- Buckets with **n < 30** are reported but flagged low-confidence
  (the em-dash gate that also governs the Desk dossier surface, W4).

---

## ⛔ MEASUREMENT NOT FEASIBLE ON THIS FINNHUB PLAN — data-depth limit (2026-07-12/13)

The W2 study **engine, endpoint, and harness are complete and unit-tested**
(see `shared/earnings-study.ts` + 23 green tests), but the historical
2018-2024 measurement **cannot be built from the configured Finnhub
account.** Every run finalizes with **0 events** — and the definitive
reason (isolated with `GET /api/earnings-edge-study?debug=<TICKER>`, which
probes Finnhub directly with the deployed env's real key) is TWO hard
provider limits, not a code defect:

1. **Rate-limited earnings endpoints.** `/stock/earnings` and
   `/calendar/earnings` flap between HTTP 200 and **429
   "Too many requests"** even on isolated calls, while `/quote` and Polygon
   bars are always 200. (Mitigated in code by routing `getEarningsHistory`
   through the Finnhub token bucket + 429 retry — but see #2, which pacing
   cannot fix.)
2. **Only ~4 recent quarters of earnings history returned.** When the call
   *does* succeed, `/stock/earnings?limit=44` returns just the **4 most
   recent quarters** (e.g. MSFT → 2026-Q1, 2025-Q4, 2025-Q3, 2025-Q2). All
   fall **after** the pre-committed study window (2018-01-31 → 2024-12-31),
   so every event is windowed out → 0 events, deterministically. The
   `/calendar/earnings` announcement-date join also returns mostly empty on
   this plan. Deep multi-year earnings-surprise history is a **premium
   Finnhub tier**; the basic tier caps at the last 4 quarters.

`/quote` = 200, Polygon bars = 1,829 for AAPL — everything EXCEPT deep
earnings history works. No amount of pacing, retrying, or batching produces
2018-2024 events because that data is simply not served on this plan.

**⚠️ Implication for the rest of the app (flagged to owner):** the same
`getEarningsHistory` / `getUpcomingEarnings` calls power the live earnings
scan, `earnings-radar`, the DESK-1 earnings surfaces, AND the W1 earnings
backtest board. A point-in-time historical earnings backtest needs deep
history it can't get here, so those earnings features are likely
data-starved in production too. Worth verifying directly.

**To actually run the PEAD validation, one of:**
- **(a)** Upgrade Finnhub to a tier with deep earnings-surprise history +
  a workable rate limit, then: `?universe=sp500&years=7&limit=250` →
  russell2k → apply the pre-committed rule below. `debug=AAPL` confirms
  depth in one call (look for pre-2024 periods in the sample).
- **(b)** Re-point the study's gather at a deeper earnings source the repo
  already integrates (e.g. the Polygon financials / quarterly-fundamentals
  path) — a `shared/earnings-study-gather.ts` swap, engine unchanged.
- **(c)** Accept a recent-window study (last ~4 quarters, all universes)
  instead of the 2018-2024 backtest window — abandons the pre-committed
  window and has forward-return truncation on the newest quarter, so it
  would NOT satisfy the FIX-2 rule as written.

**Code hardening shipped while diagnosing (all real defects, merged in #105):**
reinvoke resume, poison-ticker skip (`SGAFT`), non-destructive allocation,
single-flight lease, mid-batch checkpointing, EPS/announce-date fallbacks,
single-batch `?limit=` path, `?debug=` probe, and Finnhub-bucket pacing of
`getEarningsHistory`.

---

## Bucket table — sp500, 2018-2024

_Pending a study run (blocked on Finnhub earnings-endpoint access — see above)._

| Surprise quintile | Reaction sign | n | mean fwdRet 5d | 20d | 60d | hit% | t-stat (20d) | IC | Survives rule? |
|---|---|---|---|---|---|---|---|---|---|
| _pending_ | | | | | | | | | |

## Bucket table — russell2k, 2018-2024

_Pending W2 study run._

| Surprise quintile | Reaction sign | n | mean fwdRet 5d | 20d | 60d | hit% | t-stat (20d) | IC | Survives rule? |
|---|---|---|---|---|---|---|---|---|---|
| _pending_ | | | | | | | | | |

## Per-regime cut

_Pending._

## Reversal hypothesis (gap-against-surprise)

_Pending — reports continuation vs mean-reversion for the `reversal` class._

## Survivorship handling

_Pending — states the universe-as-of membership used and the count of
delisted/acquired members included._
