// Phase 6 W1 — per-component score decomposition for the Williams + Lynch
// rationale endpoints.
//
// **Surface-only, NOT a scoring change.** The authoritative style score is
// still `runWilliams()` / `runLynch()`. These builders re-read the `signals`
// dict those functions already emit and decompose the single accumulated
// score into the named sub-components the detail-panel ScoreBreakdown (Phase
// 6 W5) renders — each with its point contribution, a nominal importance
// weight, a direction, a human rationale, and the numeric signals behind it.
//
// The decomposition mirrors the arithmetic inside the style modules. Because
// the style modules round some signals before storing them (vbStrength to 2dp,
// closeStrength10d to 1dp) the component contributions are an *approximate*
// reconstruction — we always report the analyst's own `score` as the
// authoritative total and never claim the components sum to it exactly. If the
// style scoring math ever changes, update the constants here in lock-step;
// this module is intentionally coupled to it as a presentation layer.

export type ComponentDirection = 'long' | 'short' | 'neutral';

export interface ScoreComponent {
  name: string;
  /** Point contribution to the −100..+100 style score. */
  score: number;
  /** Nominal importance share (0..1) — the component's max magnitude as a
   *  fraction of the strategy's total. Presentation only. */
  weight: number;
  direction: ComponentDirection;
  rationale: string;
  signals: Record<string, number | string | boolean>;
  noData?: boolean;
  noDataReason?: string;
}

function dirOf(score: number): ComponentDirection {
  if (score > 0.5) return 'long';
  if (score < -0.5) return 'short';
  return 'neutral';
}

function weightsFrom(nominal: Record<string, number>): Record<string, number> {
  const total = Object.values(nominal).reduce((a, b) => a + b, 0) || 1;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(nominal)) out[k] = +(v / total).toFixed(3);
  return out;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function boolOf(v: unknown): boolean {
  return v === true;
}

// ---------------------------------------------------------------------------
// Williams — short-term technical / momentum
// ---------------------------------------------------------------------------

const WILLIAMS_NOMINAL = {
  momentum: 25,
  breakout: 25,
  strength: 15,
  seasonality: 13,
  trend: 22,
};

export function buildWilliamsComponents(
  signals: Record<string, unknown>,
): ScoreComponent[] {
  const w = weightsFrom(WILLIAMS_NOMINAL);

  // If there were too few bars to score, runWilliams returns an empty signals
  // dict. Surface that as a uniform no-data breakdown.
  const wr = numOrUndef(signals.williamsR);
  if (wr === undefined) {
    return (Object.keys(WILLIAMS_NOMINAL) as (keyof typeof WILLIAMS_NOMINAL)[]).map(
      (k) => ({
        name: williamsName(k),
        score: 0,
        weight: w[k],
        direction: 'neutral' as const,
        rationale: 'insufficient price history',
        signals: {},
        noData: true,
        noDataReason: 'insufficient_bars',
      }),
    );
  }

  const wrTurning = boolOf(signals.wrTurning);
  const wrTopping = boolOf(signals.wrTopping);
  const volLong = boolOf(signals.volBreakoutLong);
  const volShort = boolOf(signals.volBreakoutShort);
  const vbStrength = numOrUndef(signals.vbStrength) ?? 0;
  const closeStrength10d = numOrUndef(signals.closeStrength10d) ?? 50;
  const seasonalTilt = numOrUndef(signals.seasonalTilt) ?? 0;
  const uptrend = boolOf(signals.uptrend);
  const downtrend = boolOf(signals.downtrend);

  // 1 — Williams %R momentum
  let momentum = 0;
  let momentumRationale = `%R neutral at ${wr.toFixed(0)}`;
  if (wrTurning) {
    momentum = 25;
    momentumRationale = `%R turning up from oversold (${wr.toFixed(0)})`;
  } else if (wr < -80) {
    momentum = 15;
    momentumRationale = `%R deep oversold (${wr.toFixed(0)})`;
  } else if (wrTopping) {
    momentum = -25;
    momentumRationale = `%R rolling over from overbought (${wr.toFixed(0)})`;
  } else if (wr > -20) {
    momentum = -10;
    momentumRationale = `%R extended at ${wr.toFixed(0)}`;
  }

  // 2 — Volatility breakout
  let breakout = 0;
  let breakoutRationale = 'no volatility breakout';
  if (volLong) {
    breakout = 25 * vbStrength;
    breakoutRationale = `volatility breakout long (strength ${vbStrength.toFixed(2)})`;
  } else if (volShort) {
    breakout = -25 * vbStrength;
    breakoutRationale = `volatility breakout short (strength ${vbStrength.toFixed(2)})`;
  }

  // 3 — Intraday closing strength
  const cs = closeStrength10d / 100;
  const strength = (cs - 0.5) * 30;
  const strengthRationale =
    closeStrength10d >= 70
      ? `closing near highs (${closeStrength10d.toFixed(0)}%)`
      : closeStrength10d <= 30
        ? `closing near lows (${closeStrength10d.toFixed(0)}%)`
        : `mid-range closes (${closeStrength10d.toFixed(0)}%)`;

  // 4 — Seasonality tilt
  const seasonality = seasonalTilt;
  const seasonalityRationale =
    seasonalTilt > 0
      ? `seasonal tailwind (+${seasonalTilt})`
      : seasonalTilt < 0
        ? `seasonal headwind (${seasonalTilt})`
        : 'no seasonal tilt';

  // 5 — Trend confirmation gate (Williams' discipline: disagreeing with the
  // larger trend halves the setup, agreeing adds a bonus). The component's
  // contribution is the net effect of the gate + alignment bonus on the
  // pre-gate sum.
  const pre = momentum + breakout + strength + seasonality;
  let gated = pre;
  if (gated > 0 && downtrend) gated *= 0.4;
  if (gated < 0 && uptrend) gated *= 0.4;
  if (uptrend && gated > 0) gated += 10;
  if (downtrend && gated < 0) gated -= 10;
  const trend = gated - pre;
  const trendRationale = uptrend
    ? 'trend up (20>50 EMA)'
    : downtrend
      ? 'trend down (20<50 EMA)'
      : 'trend mixed';
  const trendDir: ComponentDirection = uptrend ? 'long' : downtrend ? 'short' : 'neutral';

  return [
    {
      name: 'Momentum (%R)',
      score: round(momentum),
      weight: w.momentum,
      direction: dirOf(momentum),
      rationale: momentumRationale,
      signals: { williamsR: wr, wrTurning, wrTopping },
    },
    {
      name: 'Volatility Breakout',
      score: round(breakout),
      weight: w.breakout,
      direction: dirOf(breakout),
      rationale: breakoutRationale,
      signals: { volBreakoutLong: volLong, volBreakoutShort: volShort, vbStrength },
    },
    {
      name: 'Closing Strength',
      score: round(strength),
      weight: w.strength,
      direction: dirOf(strength),
      rationale: strengthRationale,
      signals: { closeStrength10dPct: closeStrength10d },
    },
    {
      name: 'Seasonality',
      score: round(seasonality),
      weight: w.seasonality,
      direction: dirOf(seasonality),
      rationale: seasonalityRationale,
      signals: { seasonalTilt },
    },
    {
      name: 'Trend Confirmation',
      score: round(trend),
      weight: w.trend,
      direction: trendDir,
      rationale: trendRationale,
      signals: { uptrend, downtrend },
    },
  ];
}

function williamsName(k: keyof typeof WILLIAMS_NOMINAL): string {
  return {
    momentum: 'Momentum (%R)',
    breakout: 'Volatility Breakout',
    strength: 'Closing Strength',
    seasonality: 'Seasonality',
    trend: 'Trend Confirmation',
  }[k];
}

// ---------------------------------------------------------------------------
// Lynch — growth at a reasonable price (additive, no gate)
// ---------------------------------------------------------------------------

const LYNCH_NOMINAL = {
  peg: 40,
  growth: 15,
  earnings: 20,
  debt: 20,
  margin: 10,
};

export function buildLynchComponents(
  signals: Record<string, unknown>,
): ScoreComponent[] {
  const w = weightsFrom(LYNCH_NOMINAL);

  const peg = numOrUndef(signals.peg);
  const peRatio = numOrUndef(signals.peRatio);
  const epsGrowthYoYPct = numOrUndef(signals.epsGrowthYoYPct);
  const revGrowthYoYPct = numOrUndef(signals.revGrowthYoYPct);
  const debtToEquity = numOrUndef(signals.debtToEquity);
  const operatingMarginPct = numOrUndef(signals.operatingMarginPct);
  const positiveQtrs = numOrUndef(signals.positiveQtrs);
  const beats4q = numOrUndef(signals.beats4q);

  // 1 — PEG
  let pegComp: ScoreComponent;
  if (peg !== undefined) {
    let s = 0;
    let r = '';
    if (peg < 0.7) { s = 40; r = `PEG ${peg.toFixed(2)} — cheap for growth`; }
    else if (peg < 1.0) { s = 25; r = `PEG ${peg.toFixed(2)} — reasonable`; }
    else if (peg < 1.5) { s = 5; r = `PEG ${peg.toFixed(2)} — fair`; }
    else if (peg < 2.0) { s = -10; r = `PEG ${peg.toFixed(2)} — expensive`; }
    else { s = -25; r = `PEG ${peg.toFixed(2)} — priced for perfection`; }
    pegComp = {
      name: 'PEG (valuation)',
      score: s,
      weight: w.peg,
      direction: dirOf(s),
      rationale: r,
      signals: { peg, peRatio: peRatio ?? 'n/a', epsGrowthYoYPct: epsGrowthYoYPct ?? 'n/a' },
    };
  } else if (peRatio !== undefined && peRatio < 0) {
    pegComp = {
      name: 'PEG (valuation)',
      score: -15,
      weight: w.peg,
      direction: 'short',
      rationale: 'unprofitable — Lynch avoids loss-makers',
      signals: { peRatio },
    };
  } else {
    pegComp = noDataComponent('PEG (valuation)', w.peg, 'no positive P/E and growth to compute PEG', 'peg_uncomputable');
  }

  // 2 — Revenue growth
  let growthComp: ScoreComponent;
  if (revGrowthYoYPct !== undefined) {
    const rev = revGrowthYoYPct / 100;
    let s = 0;
    let r = `revenue ${revGrowthYoYPct.toFixed(0)}% YoY`;
    if (rev > 0.15 && rev < 0.5) { s = 15; r = `revenue +${revGrowthYoYPct.toFixed(0)}% (Lynch sweet spot)`; }
    else if (rev > 0.5) { s = -5; r = `revenue +${revGrowthYoYPct.toFixed(0)}% (hypergrowth, risky)`; }
    else if (rev < 0) { s = -15; r = `revenue ${revGrowthYoYPct.toFixed(0)}% (declining)`; }
    growthComp = {
      name: 'Revenue Growth',
      score: s,
      weight: w.growth,
      direction: dirOf(s),
      rationale: r,
      signals: { revGrowthYoYPct },
    };
  } else {
    growthComp = noDataComponent('Revenue Growth', w.growth, 'revenue growth unavailable', 'no_revenue_growth');
  }

  // 3 — Earnings quality
  let earningsComp: ScoreComponent;
  if (positiveQtrs !== undefined) {
    const beats = beats4q ?? 0;
    let s = 0;
    let r = `${positiveQtrs}/4 profitable quarters`;
    if (positiveQtrs === 4 && beats >= 3) { s = 20; r = `4/4 profitable quarters, ${beats}/4 beats`; }
    else if (positiveQtrs === 4) { s = 10; r = '4/4 profitable quarters'; }
    else if (positiveQtrs <= 2) { s = -15; r = `only ${positiveQtrs}/4 profitable quarters`; }
    earningsComp = {
      name: 'Earnings Quality',
      score: s,
      weight: w.earnings,
      direction: dirOf(s),
      rationale: r,
      signals: { positiveQtrs, beats4q: beats },
    };
  } else {
    earningsComp = noDataComponent('Earnings Quality', w.earnings, 'earnings history unavailable', 'no_earnings_history');
  }

  // 4 — Debt
  let debtComp: ScoreComponent;
  if (debtToEquity !== undefined) {
    let s = 0;
    let r = `D/E ${debtToEquity.toFixed(2)}`;
    if (debtToEquity < 0.3) { s = 15; r = `low debt (D/E ${debtToEquity.toFixed(2)})`; }
    else if (debtToEquity < 1.0) { s = 5; r = `manageable debt (D/E ${debtToEquity.toFixed(2)})`; }
    else if (debtToEquity > 2.0) { s = -20; r = `high debt (D/E ${debtToEquity.toFixed(2)})`; }
    else if (debtToEquity > 1.0) { s = -8; r = `elevated debt (D/E ${debtToEquity.toFixed(2)})`; }
    debtComp = {
      name: 'Debt / Equity',
      score: s,
      weight: w.debt,
      direction: dirOf(s),
      rationale: r,
      signals: { debtToEquity },
    };
  } else {
    debtComp = noDataComponent('Debt / Equity', w.debt, 'debt-to-equity unavailable', 'no_debt_data');
  }

  // 5 — Operating margin
  let marginComp: ScoreComponent;
  if (operatingMarginPct !== undefined) {
    const m = operatingMarginPct / 100;
    let s = 0;
    let r = `op margin ${operatingMarginPct.toFixed(0)}%`;
    if (m > 0.2) { s = 10; r = `strong op margin ${operatingMarginPct.toFixed(0)}%`; }
    else if (m < 0.05) { s = -8; r = `thin op margin ${operatingMarginPct.toFixed(0)}%`; }
    marginComp = {
      name: 'Operating Margin',
      score: s,
      weight: w.margin,
      direction: dirOf(s),
      rationale: r,
      signals: { operatingMarginPct },
    };
  } else {
    marginComp = noDataComponent('Operating Margin', w.margin, 'operating margin unavailable', 'no_margin_data');
  }

  return [pegComp, growthComp, earningsComp, debtComp, marginComp];
}

function noDataComponent(
  name: string,
  weight: number,
  rationale: string,
  reason: string,
): ScoreComponent {
  return {
    name,
    score: 0,
    weight,
    direction: 'neutral',
    rationale,
    signals: {},
    noData: true,
    noDataReason: reason,
  };
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}
