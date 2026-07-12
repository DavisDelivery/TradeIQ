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

## ⛔ MEASUREMENT BLOCKED — Finnhub earnings endpoints return HTTP 429 (2026-07-12)

The W2 study **engine, endpoint, and harness are complete and unit-tested**
(see `shared/earnings-study.ts` + 23 green tests), but the live measurement
run **cannot produce data in the current environment** and every attempt
finalized with **0 events**.

Root cause was isolated with a synchronous single-ticker probe
(`GET /api/earnings-edge-study?debug=AAPL`) hitting Finnhub directly with
the deployed env's real key:

| Finnhub endpoint | HTTP | note |
|---|---|---|
| `/quote` | **200** | basic data works; the key is valid (len 40) |
| `/stock/earnings` (EPS surprise history) | **429** | `{"error":"Too many requests…"}` — persists on a single isolated call after 10h idle |
| `/calendar/earnings` (announcement dates) | **429** | same |

Polygon bars resolve fine (1,829 bars for AAPL). Only the **earnings**
endpoints 429. A single isolated call fails, so this is **not** a burst
from the study's own volume — the earnings data endpoints are
plan-gated / hard-rate-limited on this Finnhub account.

**Implication (flagged to owner):** the same `getEarningsHistory` /
`getUpcomingEarnings` calls power the live earnings scan, `earnings-radar`,
and the DESK-1 earnings surfaces — those may be silently degrading to empty
in production too if prod shares this key/plan. Worth verifying separately.

**Code hardening shipped while diagnosing (all real defects):** reinvoke
resume, poison-ticker skip (`SGAFT`), non-destructive allocation,
single-flight lease, EPS/announce-date fallbacks, single-batch `limit=`
path, and — the actual fix once data flows — pacing `getEarningsHistory`
through the Finnhub token bucket + 429 retry.

**To complete the measurement (once earnings access is restored):**
`GET /api/earnings-edge-study?universe=sp500&years=7&limit=250` (single
clean batch), then russell2k, then apply the pre-committed rule below to
the buckets. `debug=AAPL` re-confirms data flow in one call.

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
