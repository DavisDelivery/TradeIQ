# Phase 5a — `mlTraining` schema notes (W1)

> **Source of truth.** All Phase 5a downstream code (export, features, targets, models) references this document. Discrepancies between brief assumptions and engine reality are recorded below — adopt the engine's reality, not the brief.

## How rows are produced

`netlify/functions/shared/backtest/engine.ts` writes one `MLTrainingRow` per rebalance × ticker, but **only for tickers in the `target` portfolio** (the post-`buildPortfolio` top-N). See `engine.ts:489-535`. Tickers that were scored but did not make the cut produce **no row**.

Persistence: `persistMLTrainingRows()` in `persistence.ts:151-156` batched into `backtestRuns/{runId}/mlTraining/{idx}` subcollection, with `idx` zero-padded ordinal across the run.

## Canonical type

From `netlify/functions/shared/backtest/types.ts:118-135`:

```ts
export interface MLTrainingRow {
  runId: string;
  ticker: string;
  asOfDate: string;
  composite: number;
  layers: Record<string, number>;
  regime: string | null;
  sector: string | null;
  marketCapBucket: 'small' | 'mid' | 'large' | null;
  entryPrice: number | null;
  exitPrice: number | null;
  holdDays: number | null;
  forward5dReturn: number | null;
  forward20dReturn: number | null;
  forward60dReturn: number | null;
  forward252dReturn: number | null;
  realizedPnl: number | null;
}
```

## Per-field documentation

| Field | Type | Always present? | Units / encoding | PIT? | Notes |
|-------|------|:---:|---|:---:|---|
| `runId` | `string` | yes | parent run id, format `bt_YYYYMMDDHHMMSS_<6chars>` | n/a | Same value across every row in a run. |
| `ticker` | `string` | yes | uppercase symbol, e.g. `NVDA` | yes | |
| `asOfDate` | `string` | yes | ISO date `YYYY-MM-DD`, the rebalance / scoring date | yes | Aligned to engine's walk-forward rebalance grid. |
| `composite` | `number` | yes | analyst-composite score in 0–100 (post-weight, post-normalize) | yes | Brief calls this `compositeScore`; engine writes `composite`. **Use `composite`.** |
| `layers` | `Record<string, number>` | yes | per-analyst layer scores 0–100; keys are analyst names from `prophet-layers.ts` | yes | Brief calls this `layerScores`; engine writes `layers`. **Use `layers`.** Schema is open-ended; downstream code must enumerate keys at load time, not hard-code them. |
| `regime` | `string \| null` | nullable | engine-stamped market regime label (e.g. `bull_low_vol`); null when `ctx.regime` undefined | yes | One-hot encode for Feature set D; treat `null` as its own category, not impute. |
| `sector` | `string \| null` | nullable | GICS-style sector string from `ScoredCandidate.sector` | yes | Not used by the brief's feature sets; available for stratification. |
| `marketCapBucket` | `'small'\|'mid'\|'large'\|null` | **always null in current engine** | n/a | n/a | `engine.ts:526` hard-codes `marketCapBucket: null`. The `marketCapBucket()` helper at `engine.ts:259` is defined but never called. **Drop this column** at export. Flag for engine fix before Phase 6+. |
| `entryPrice` | `number \| null` | nullable | adjusted close on `asOfDate` (or last trading day at-or-before) | yes | Computed via `lastCloseAtOrBefore(longBars, asOfDate)`. Null when bars unavailable. |
| `exitPrice` | `number \| null` | **always null in current engine** | n/a | n/a | `engine.ts:528` hard-codes `null`. **Drop this column** at export. |
| `holdDays` | `number \| null` | **always null in current engine** | n/a | n/a | `engine.ts:529` hard-codes `null`. **Brief's CV purge expects a per-row hold window — derive it from the chosen forward-return horizon instead.** See "CV purge implications" below. |
| `forward5dReturn` | `number \| null` | nullable | decimal return from `asOfDate` close to close 5 trading days later, **pre-cost** | yes | Net of nothing; just raw close-to-close. Null when bars window doesn't cover entry+5d. |
| `forward20dReturn` | `number \| null` | nullable | decimal, 20 trading days, pre-cost | yes | Closest analog to monthly rebalance return. **Default ML target.** |
| `forward60dReturn` | `number \| null` | nullable | decimal, 60 trading days, pre-cost | yes | Sensitivity target. |
| `forward252dReturn` | `number \| null` | nullable | decimal, 252 trading days, pre-cost | yes | Annual horizon; rarely populated for recent rebalances. |
| `realizedPnl` | `number \| null` | **always null in current engine** | n/a | n/a | `engine.ts:534` hard-codes `null`. **Drop this column** at export. |

## Brief assumption vs engine reality — the diff

The Phase 5a brief's example schema (PART 3) said:

```ts
{ compositeScore, layerScores, forwardReturn, forwardReturnRaw,
  holdDays (always present), inPortfolio (always present) }
```

Engine reality:

| Brief field | Engine field | Action |
|-------------|--------------|--------|
| `compositeScore` | `composite` | Rename in features/models. |
| `layerScores` | `layers` | Rename. |
| `forwardReturn` (single, post-cost) | `forward{5,20,60,252}dReturn` (4 horizons, pre-cost) | Pick `forward20dReturn` as default; report `forward5dReturn`/`forward60dReturn` as sensitivity. **Note: returns are pre-cost.** Brief's "net of slippage" assumption is wrong; ML targets are gross. |
| `forwardReturnRaw` | — | Doesn't exist; all four forward returns are gross. |
| `holdDays` (always present) | `holdDays` (always null) | Use the forward-horizon (5/20/60/252) as the purge-window proxy in CV. |
| `inPortfolio` (always present) | not written | **Cannot be derived from `mlTraining` rows alone.** Every row IS an `inPortfolio == True` row — see "Critical limitation" below. |

## Critical limitation — universe filtering happens before ML sees the data

Because `mlTraining` rows are written only inside the `for (const p of target)` loop at `engine.ts:489`, **only top-N portfolio picks contribute rows**. The brief's framing assumes a per-asOfDate cross-section of the full universe; the engine writes a cross-section of `topN` tickers per asOfDate (typically 20 for the canonical `dow/monthly/top20` config).

Concrete consequences for downstream workstreams:

1. **Cross-sectional IC is over topN, not the universe.** For `dow/monthly/top20` with 5 CV folds over 2018–2024, each fold has roughly 12 asOfDates × 20 tickers = 240 test rows. Spearman over n=20 has high sampling noise; reported IC means will have wide CIs.
2. **Decile spread is degenerate.** Top decile and bottom decile of 20 tickers = 2 tickers each. Brief's decile-spread metric becomes a 2-vs-2 mean comparison. Either widen to quintiles when topN ≤ 30, or report the metric with an explicit caveat. We pick the latter — compute it as specified but footnote sample size.
3. **Brief's W6 sensitivity check `inPortfolio == True`-only is a no-op.** Every row is `inPortfolio == True` by construction; the comparison "portfolio IC vs universe IC" cannot be answered from this data.
4. **ML cannot distinguish picks from rejects.** The composite scorer's "decision" (which tickers to elevate to topN) is selection-filtered out of the training signal. Phase 5a can answer "given the composite chose these picks, can a model re-rank within them?" — not "should the composite have chosen different picks?".
5. **Phase 5b deployment implications.** A model trained on `mlTraining` rows would be a re-ranker over the composite's topN — not a replacement for the composite. If a model "beats baseline" in Phase 5a, deployment is a thin re-ranking layer atop the existing scorer, not a wholesale swap.

**Recommendation for Phase 6+ engine work (NOT in 5a scope):** add a second mlTraining path that writes a row for every `scored` candidate (not just `target`), gated by a flag. Without this, ML can never see the de-selected tickers and can never improve the selection step.

## Per-asOfDate row count expectation

For a single complete run with `portfolio.topN = N`, expected rows = `N × len(rebalanceDates)`.

- `dow/monthly/top20/2018-01-01→2024-12-31` ≈ 20 × 84 ≈ 1,680 rows.
- `sp500/monthly/top50/2018-01-01→2024-12-31` ≈ 50 × 84 ≈ 4,200 rows.

The Phase 5a 10k-row threshold therefore requires ~5–6 runs minimum.

## Config-hash inputs (for W2 deduplication)

The `_runConfigHash` (12 chars of SHA-256 over canonical-JSON-encoded config) should include fields that affect either layer scores OR forward returns OR portfolio selection:

- `universe`
- `startDate`, `endDate`
- `rebalanceFrequency` (brief calls this `frequency`; engine writes `rebalanceFrequency`)
- `board` (only `prophet` produces non-null rows in current engine)
- `portfolio.topN`, `portfolio.weighting`, `portfolio.minComposite`, `portfolio.maxPositionPct`, `portfolio.maxSectorPct`, `portfolio.cashSleeve`
- `costs.slippageBps` (only affects realizedPnl/exitPrice — currently null — so technically irrelevant; include for forward compatibility)
- `costs.commission`
- `initialCapital` (affects nothing in mlTraining; exclude to keep hash stable across capital-amount-only changes)

Fields **excluded** from hash: `scoringConcurrency` (perf only), `clockOverride` (test only), `initialCapital`.

Human-readable summary `_runConfigSummary`: `"{universe}/{rebalanceFrequency}/top{topN}/{startDate}→{endDate}"`.

## CV purge implications

The brief's purged walk-forward CV uses `asOfDate + holdDays` as the train-row forward-return-window end. With `holdDays` always null, substitute the forward-return horizon used as the ML target:

- Target = `forward20dReturn` → purge window = 20 trading days from `asOfDate`.
- Convert trading days to calendar days for the comparison using the conventional 1.4 ratio (5 trading days ≈ 7 calendar; 20 ≈ 28; 60 ≈ 84; 252 ≈ 365). The purge is conservative — small mismatches in the trading-to-calendar conversion shouldn't matter because the embargo (≥ 3 rebalances) already guarantees a large gap.

## Known scorer issues (carried from brief, verified for this work)

- **Composite cluster at 50.** Sigmoid normalization compresses scores toward 50 for tickers with mixed-signal layers. Real artifact; ML on raw `layers` may extract information the composite squashed.
- **Fundamental layer returns 0 for NKE, V, CVX (and possibly others).** Data-mapping bug upstream. Flag any ticker with `layers.fundamental === 0` across multiple asOfDates as suspect; exclude in W3 sensitivity check.
- **Insider/quiver layers may have nulls in 2018–2019.** Upstream data gaps. Flag any layer with > 30% null rate within a year as compromised.

## Open questions to resolve before/during W2 export

None blocking. Field renames and dropped columns are mechanical; the universe-filtering constraint is acknowledged here and surfaced in W9 limitations.
