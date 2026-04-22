# TradeIQ Alpha v2 — Detailed Spec

Supplement to README. Deep dives per track for the next 3-5 sessions of build-out.

---

## Track A — Alpha Lift

### A1. Short-side fix

v1 shorts were -3% alpha. Options:

1. **Keep disabled** (current default). A-only longs are +3.2% alpha, fine standalone strategy.
2. **Fix short logic** — short candidates in v1 likely used inverted long logic, which doesn't work. Short edge comes from very different signals: insider selling, debt covenant risk, channel checks on declining demand, options skew inversion. Dedicated short-side analyst required.
3. **Constrained shorts** — only short on borrow-cost-low, high-short-interest-momentum names as a hedge, not alpha source.

**Recommended:** (2) Build a dedicated short-side analyst in Session 3 that uses different signals than long-side. Keep shorts disabled until validated.

### A2. Position sizing

Three modes in `backtest/engine.ts`:

- **Equal-weight** — baseline. 1/N sizing.
- **Vol-target** — weight = (1/vol) / sum(1/vol). Higher-vol names get smaller allocation. Portfolio targets a specified annualized vol.
- **Fractional Kelly** — weight proportional to (edge / variance), fractionally scaled. Aggressive. Caps at 25% per position.

**Data requirement:** rolling 30-day realized vol per ticker. Session 2 should pull this from market data provider.

### A3. Regime gating

`exposureForRegime()` scales gross exposure:
- risk_on: 100%
- neutral: 70%
- risk_off: 40%

Further refinement in Session 3: use the Claude regime narrative's `confidence` field to interpolate between bands rather than step function.

### A4. Tier discipline

Default config is A-tier only. Expected impact: fewer trades, higher per-trade alpha, lower absolute return but higher Sharpe.

Session 2 validation: backtest all three configs (A-only, A+B, all-tiers) and show Sharpe comparison in the UI.

### A5. Conflict filtering

Candidates with `conflictLevel === 'severe'` are filtered out of backtest. Arbitrator module (Track B) can reclassify conflicts as resolvable before this filter runs.

---

## Track B — Deeper AI

### B1. Claude-as-PM (`claude-pm.ts`)

The flagship. Prompt is production-quality in this commit. Key design decisions:

- **Opus 4.7** — this call costs more but the decision it drives is the single highest-leverage output. Worth the tokens.
- **Temperature 0.2** — low variance in portfolio decisions; we want consistency, not creativity.
- **Structured output contract** (`PMDecision` type) — validated by `validateDecision()` before return.
- **Hard constraints in prompt** — sector concentration limits, position size caps by conviction, net exposure bands by regime, mandatory invalidation levels.
- **Cost control** — compact candidate payload (top 20 only, trimmed analyst fields).
- **Persistence** — every decision saved to blob store keyed by date for later review / backtest alignment.

**Future extensions:**
- Pass in correlation matrix to Claude so it can reason about true diversification
- Pass in current holdings so Claude understands position-add vs new-entry context
- Post-trade feedback loop: after N days, show Claude its prior decisions + outcomes for calibration

### B2. Arbitrator (`arbitrator.ts`)

Resolves analyst conflicts. Inputs: ticker + all analyst scores + context. Output: arbitrated score + dominant/discounted analysts + recommendation.

**Use pattern:** called per-ticker during board generation, replaces naive weighted-average composite score for high-conflict names.

**Cost control:** only invoke when `conflictLevel` is moderate or severe. Skip for 'none' or 'mild'.

### B3. Earnings Interpreter (`earnings-interpreter.ts`)

Reads full transcripts (up to 40k chars). Produces structured signals: overall sentiment, per-theme breakdown, analyst pushback assessment, red/green flags, actionable takeaway.

**Use pattern:** triggered by earnings ingest pipeline on report day. Output feeds into the `earnings` analyst score for next day's board.

**Future extensions:**
- Compare to prior quarter's interpretation (Claude sees the delta)
- Read the 10-Q/10-K alongside the call for cross-check

### B4. Regime Narrative (`regime-narrative.ts`)

Daily macro context + regime classification. Can override mechanical rule.

**Use pattern:** runs once per day (scheduled function, Session 3 wiring). Output is read by target-board generation and applied as global multiplier.

**Future extensions:**
- Weekly macro deep-dive using Opus
- Integration with news ingest for automatic headline collection

### B5. NEW — Post-trade AI review (Session 4)

Not yet built. Concept: after a trade closes, Claude reviews entry thesis vs actual outcome and classifies the outcome: thesis-confirmed, thesis-invalidated-but-profitable (lucky), thesis-failed, externally-driven. Over time this builds a calibration dataset showing which analyst signals consistently produce good theses vs which produce noise.

---

## Track C — Robustness

### C1. Backtest engine (`backtest/engine.ts`)

**Current:** control flow is complete. Data hooks are stubs. Summary stats are implemented.

**Session 2 data wiring:**
```ts
async function getPriceAt(ticker: string, date: string): Promise<number | null> {
  // Wire to Polygon aggregate bars or similar
}
async function getBoardSnapshot(date: string): Promise<TargetBoard | null> {
  // Historical board snapshots — requires backfilling analyst scores,
  // OR replaying the analyst pipeline on historical data
}
async function getSpyReturn(date: string, days: number): Promise<number> {
  // SPY price series
}
```

### C2. Walk-forward discipline (Session 3)

Current structure runs one backtest over one date range. Production discipline:

1. Split window into train/test pairs. Example for 2022-2025:
   - Train 2022 → Test Q1 2023
   - Train 2022+Q1 2023 → Test Q2 2023
   - etc.
2. Report OOS alpha, not IS alpha
3. Flag overfitting: if IS alpha >> OOS alpha, the parameter set is too fit to history

### C3. Monte Carlo (Session 3)

Resample trade sequence to estimate:
- 95% CI on realized alpha
- Probability of drawdown > X%
- Time-to-recovery distribution

### C4. Transaction cost modeling

Current: flat bps per round-trip + slippage. Session 3 refinement:
- ADV-relative impact cost (larger positions in thinner names cost more)
- Wider spreads during vol spikes
- Market-on-close vs intraday fill modeling

### C5. Paper trading mode (Session 4)

Run v2 live against real data, emit "trade logs" instead of executing. Compare paper results to backtest to catch implementation shortfall.

---

## Cost management

AI call costs per day, estimate:

| Call | Frequency | Model | Tokens | ~Cost/call |
|---|---|---|---|---|
| Regime narrative | 1x/day | Sonnet | ~3k | $0.01 |
| Claude-as-PM | 1x/day | Opus | ~5k | $0.15 |
| Arbitrator | 5-10x/day | Sonnet | ~2k | $0.01 |
| Earnings interpreter | Per report | Sonnet | ~30k | $0.10 |
| Research brief | On-demand | Sonnet | ~2k | $0.01 |

Daily floor: ~$0.25/day. Earnings season spikes up to $3-5/day.

Monthly: ~$10 normal, ~$50 during heavy earnings weeks.

Cheap relative to a single missed alpha point on any meaningful book size.

---

## Session checklist template

Every session starts with:
```bash
cd /home/claude
git clone https://github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git checkout -b session-N-<topic>
```

Every session ends with:
```bash
git add -A
git commit -m "session N: <what was done>"
git push origin session-N-<topic>
# Open PR or merge to main
```

No more sandbox-wipe losses.
