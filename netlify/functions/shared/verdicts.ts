// FIX-1 W4 — the verdict registry: measured edge per board, in one place.
//
// Narrative confidence ≠ measured edge. Every board header and every
// AI-generated thesis/research-brief render shows the chip derived from
// this registry, so a fluent Claude paragraph can never outrank the
// backtest that measured the board losing to SPY.
//
// PURE DATA MODULE — no imports, no side effects — so both runtimes can
// consume it:
//   - Functions (esbuild):  import { BOARD_VERDICTS } from './shared/verdicts'
//   - Frontend (Vite):      import { BOARD_VERDICTS } from '../netlify/functions/shared/verdicts'
//
// Update discipline: a verdict row changes ONLY when a valid
// (status:'complete', guard-passing) backtest run lands, and the commit
// that changes it links the runId. The `target` row is PENDING until the
// two FIX-1 W3 runs complete (see reports/fix-1/composite-verdict.md for
// the pre-committed decision rule that will set it).

/**
 * UNMEASURED is not a softer NO_EDGE — it is the absence of a measurement.
 *
 * BROKER-1 W1. Registering it matters because the registry and the navigation
 * had drifted completely apart: every board a user can actually open
 * (catalyst, trident, screens, insiders, earnings, crosses, quiet-strength)
 * was ABSENT from BOARD_VERDICTS, while every board present in it had been
 * retired. The intersection was empty, so VerdictChip — whose whole job is to
 * stop a fluent thesis outranking a backtest — returned null on every reachable
 * board and rendered nowhere at all.
 *
 * That is the state in which a NO_EDGE board sits one tap from a real-money
 * Buy button with no edge statement anywhere on the screen.
 */
export type VerdictStatus = 'NO_EDGE' | 'MIXED' | 'PENDING' | 'VALIDATED' | 'UNMEASURED';

export type VerdictBoard =
  // Retired boards. Kept because the measurement is the record — a board that
  // lost to SPY should not be able to return without its verdict returning too.
  | 'williams'
  | 'lynch'
  | 'prophet'
  | 'target'
  | 'fable'
  | 'vector'
  | 'trend'
  // Boards reachable in the app today. These IDs must match VIEWS ids in
  // src/App.jsx exactly — the chip looks up by nav id, so 'insiders' not
  // 'insider'. verdict-coverage.test.ts pins that correspondence.
  | 'catalyst'
  | 'trident'
  | 'screens'
  | 'insiders'
  | 'earnings'
  | 'crosses'
  | 'quiet-strength';

export interface BoardVerdict {
  board: VerdictBoard;
  status: VerdictStatus;
  /** Measurement window / config the verdict is based on. */
  window: string;
  /** Excess total return vs SPY, percentage points. null = not measured. */
  excessVsSPYPp: number | null;
  /** Excess total return vs QQQ, percentage points. null = not measured. */
  excessVsQQQPp: number | null;
  /** Information coefficient. null = not measured. */
  ic: number | null;
  /** Rolling-window consistency, e.g. '4/8'. null = not measured. */
  rollingWindowsWon: string | null;
  /** The backtest run(s) the verdict rests on. */
  runId: string | null;
  /** Date the verdict was established (YYYY-MM-DD). */
  date: string | null;
  /** One-line honest qualifier surfaced in tooltips/details. */
  note: string;
}

export const BOARD_VERDICTS: Record<VerdictBoard, BoardVerdict> = {
  // TREND-1 — the consumer-attention ("social arbitrage") signal was
  // measured and FAILED ITS PLACEBO TEST. Recorded here so the Trend
  // Exposure tab can never be mistaken for a predictive board.
  //
  // The tab that ships is ATTRIBUTION ONLY (which filers mention a
  // phrase) plus descriptive pageview context. It deliberately exposes
  // no score and no ranking by expected return. This row exists so that
  // if anyone — including a future me — tries to add one, the chip in
  // the header already says what the measurement found.
  trend: {
    board: 'trend',
    status: 'NO_EDGE',
    window: '2021-08 -> 2026-07, 22 hand-picked consumer tickers, 225 events, weekly z >= 1.5',
    // NULL on purpose. The raw figure is +3.36 pp, but rendering it in the
    // chip would print "NO VALIDATED EDGE (+3.36pp vs SPY)" — which reads as
    // a win. Placebo-adjusted it is ~0, so the honest chip carries no number
    // and the full decomposition lives in `note` (the tooltip).
    excessVsSPYPp: null,
    excessVsQQQPp: null,
    ic: null,
    rollingWindowsWon: null,
    runId: 'social-arb-study-2026-08-03',
    date: '2026-08-03',
    note:
      'Raw +3.36 pp 12w excess vs SPY does NOT survive controls. Placebo (random entry, ' +
      'same 22 names) matches or beats it. Entry landed inside the signal week (look-ahead); ' +
      'beta assumed 1.0 on a universe averaging 1.59; overlapping windows put N_eff at ~66, ' +
      'not 225 — corrected t ~= 0.4. The headline "low-saturation" split was an artifact: 58 ' +
      'of 194 events had a quantised investor series whose z was coerced from null to 0.0 and ' +
      'auto-classified into the winning cohort (those 58 average +16.2%; the 136 with a real ' +
      'investor z average -1.2%, vs -0.56% for high saturation — no split). Two tickers supply ' +
      'more than 100% of the total; 12 of 22 are net negative. Attribution shipped; scoring did not.',
  },
  williams: {
    board: 'williams',
    status: 'NO_EDGE',
    window: '2018-01-31 → 2024-12-31, sp500, weekly top20, BUY-only',
    excessVsSPYPp: -73.4,
    excessVsQQQPp: null,
    ic: null,
    rollingWindowsWon: null,
    runId: 'bt_20260519014409_zsxtsq',
    date: '2026-05-19',
    note:
      'Phase 4r W2: total return 34.5% vs SPY 107.9% (−73.4 pp); Sharpe ≈ SPY buy-and-hold. ' +
      '1,785 trades could not beat holding the index.',
  },
  lynch: {
    board: 'lynch',
    status: 'NO_EDGE',
    // AUDIT-1 (2026-08-06): this row previously cited runId 'bt_20260608015737'
    // — a TRUNCATED id that resolves to "run not found" — and claimed the
    // 2018→2024 window while the underlying run (…_t8uk0v) actually covered
    // 2018-02→2021-12 quarterly, the friendliest of three available
    // measurements. The two runs that DO cover the full window are
    // bt_20260519014419_litbxp (−100.98pp) and bt_20260519014435_71ak9q
    // (−87.56pp). The row now cites the discrete-signal full-window run.
    // Caveat inherited from that era's engine: it predates the
    // delisting-realization fix (b93eb3e), so the loss is if anything
    // understated.
    window: '2018-01-31 → 2024-12-31, sp500, quarterly, discrete BUY signal',
    excessVsSPYPp: -101.0,
    excessVsQQQPp: null,
    ic: -0.0612,
    rollingWindowsWon: null,
    runId: 'bt_20260519014419_litbxp',
    date: '2026-08-06',
    note:
      'Full-window discrete run: +6.9% vs SPY +107.9% (−101.0 pp), IC −0.0612. The BUY ' +
      'signal fired in only a handful of quarterly rebalances across 7 years; when it fired ' +
      'there is no evidence it beat the index. A shorter 2018–2021 run (…_t8uk0v) showed ' +
      '−1.3 pp / IC 0.0011 and was previously (mis)quoted here as the full window.',
  },
  prophet: {
    board: 'prophet',
    // AUDIT-1 (2026-08-06): demoted MIXED → PENDING. The +80.9pp figure was
    // never attributable (runId was null) and does not measure the board's
    // ranking process: the underlying full-window portfolio run bought one
    // 14-name basket at the window start and never traded again, because a
    // single stored snapshot resolved for every rebalance date. Verified
    // live the same day: 20 consecutive nightly rolling-2018 runs return
    // portfolio 0.000% (100% cash, snapshot predates window) while SPY fell
    // 7.01% — and each counts as a rolling "win" under excess>0. A number
    // produced that way is concentration luck plus a scoring artifact, not
    // a measurement. PENDING until a ranked-engine run with real per-date
    // snapshots exists (AUDIT-1 top-N campaign, in flight).
    status: 'PENDING',
    window: 'no valid measurement — prior run traded once in 8 years',
    excessVsSPYPp: null,
    excessVsQQQPp: null,
    ic: null,
    rollingWindowsWon: null,
    runId: null,
    date: '2026-08-06',
    note:
      'RETIRED 2026-08-07 — still unmeasured. The previously shown +80.9 pp vs SPY came from ' +
      'a run that bought 14 names on day one and never rebalanced (one stale snapshot served ' +
      'all 418 dates), with 6/20 slots in cash; its "4/8 rolling windows" included an ' +
      'all-cash year credited as a win because SPY fell. Three attempts at a valid ' +
      'ranked-engine measurement all died in the reinvoke chain — the engine dispatches the ' +
      'next invocation, Netlify returns 202, and the invocation never lands (reinvokeAttempts ' +
      '=== invocationCount === 3, lastReinvokeStatus 202, no error). Reproducible at ' +
      'batchSize 8 and 2 alike, so it is a platform-level chain failure, not tuning. Prophet ' +
      'retires UNMEASURED rather than disproved: its live forward-test alpha is −2.87pp at ' +
      '26% alpha win rate, and no board in the app retains a validated edge.',
  },
  target: {
    board: 'target',
    status: 'NO_EDGE',
    window: '2018-01-31 → 2024-12-31, sp500, monthly top20 equal-weight, net of costs',
    excessVsSPYPp: -74.2,
    excessVsQQQPp: -168.1,
    ic: -0.0105,
    rollingWindowsWon: null,
    runId: 'bt_20260711013530_q5qdh7',
    date: '2026-07-11',
    note:
      'FIX-1 W3: the ten-analyst composite returned +33.68% vs SPY +107.90% (−74.2 pp) ' +
      'over 2018-2024 net of costs, with a NEGATIVE information coefficient (IC −0.0105) — ' +
      'the scores rank stocks worse than random. Loses in risk-on regimes; Sharpe 0.31, ' +
      'IR −0.62. Same result class as Williams (−73.4 pp). Demoted to a screener; the ' +
      'target board is no longer presented as edge. russell2k confirmation run did not ' +
      'complete (reinvoke-chain infra); sp500 alone is decisive per the pre-committed ' +
      'binding rule (reports/fix-1/composite-verdict.md). The prior avaa64 run was INVALID ' +
      '(all-null candidates); this q5qdh7 run is the first valid composite backtest.',
  },
  vector: {
    board: 'vector',
    status: 'MIXED',
    window: 'events 2016-01-31 → 2024-12-31, full-hygiene universe incl. delisted, tiered costs',
    excessVsSPYPp: null,
    excessVsQQQPp: null,
    ic: null,
    rollingWindowsWon: null,
    runId: 'vrun_v1_initial',
    date: '2026-07-15',
    note:
      'VECTOR run vrun_v1_initial (51,680 CAR rows): E1 trigger NO_EDGE — agreement cohort ' +
      'mean +1.17% 60td net CAR, t 1.30 vs the binding t≥3 (MID+SMALL pooled weaker still); ' +
      'E1 ships as a labelled event monitor. H4 not measurable (PRIME unreachable until ' +
      'fscore/insider/13F features populate — quadrants are descriptive taxonomy for now). ' +
      'E2/E3 triggers PENDING (backfills incomplete at measurement; vrun_v2 resolves them). ' +
      'Book NO_EDGE/n-a — no validated triggers to trade. Full log: reports/vector/design.md.',
  },
  fable: {
    board: 'fable',
    status: 'NO_EDGE',
    window: '2018-01-31 → 2024-12-31, sp500, monthly, discreteSignalOnly, 20bps rt',
    excessVsSPYPp: -73.4,
    excessVsQQQPp: null,
    ic: -0.0173,
    rollingWindowsWon: null,
    runId: 'bt_20260713215334_w80rb8',
    date: '2026-07-14',
    note:
      'FABLE (Claude\'s board) — pre-committed rule applied (reports/fable/design.md): ' +
      'net +34.5% vs SPY +107.9% (−73.4pp) FAIL; IC −0.0173 FAIL; monthly-active t −1.29 FAIL. ' +
      'All three criteria failed ⇒ NO_EDGE. Clean run: 84/84 rebalances, 2,018 trades, ' +
      '0.07% ticker-failure rate, offline SPY cross-check matches the engine to the decimal. ' +
      'FABLE ships as a labelled screener (like Target) — the gate/pillars still describe ' +
      'trend quality; they do not claim validated alpha over buy-and-hold.',
  },

  // -------------------------------------------------------------------------
  // BROKER-1 W1 — the boards a user can actually open.
  //
  // Every one of these is UNMEASURED: no backtest run, no forward record long
  // enough to speak. That is a statement about our evidence, not a claim that
  // the board is bad — which is exactly why the label is "NOT MEASURED"
  // rather than "NO VALIDATED EDGE". They sit below the Unvalidated divider
  // because an unmeasured board is not a validated one, and they render a chip
  // above every Buy button for the same reason.
  //
  // A row here may only change to VALIDATED/NO_EDGE/MIXED when a real run
  // lands and the commit links its runId — the standing discipline at the top
  // of this file.
  // -------------------------------------------------------------------------
  catalyst: {
    board: 'catalyst',
    status: 'UNMEASURED',
    window: 'no backtest run exists',
    excessVsSPYPp: null, excessVsQQQPp: null, ic: null, rollingWindowsWon: null,
    runId: null, date: '2026-08-13',
    note:
      'Never backtested. The board scans intraday and publishes on schedule, but no run has ' +
      'measured whether its ranking beats holding the index, so there is no edge claim to ' +
      'make either way.',
  },
  trident: {
    board: 'trident',
    status: 'UNMEASURED',
    window: 'no backtest run exists',
    excessVsSPYPp: null, excessVsQQQPp: null, ic: null, rollingWindowsWon: null,
    runId: null, date: '2026-08-13',
    note: 'Never backtested. No measurement exists for or against this board.',
  },
  screens: {
    board: 'screens',
    status: 'UNMEASURED',
    window: 'per-screen published evidence; the board itself is unmeasured in-app',
    excessVsSPYPp: null, excessVsQQQPp: null, ic: null, rollingWindowsWon: null,
    runId: null, date: '2026-08-13',
    note:
      'Individual screens carry published external evidence grades, but this app has run no ' +
      'measurement of them on its own universe and costs. External replication is not the ' +
      'same claim as a measured in-app edge.',
  },
  insiders: {
    board: 'insiders',
    status: 'UNMEASURED',
    window: 'no backtest run exists',
    excessVsSPYPp: null, excessVsQQQPp: null, ic: null, rollingWindowsWon: null,
    runId: null, date: '2026-08-13',
    note:
      'Never backtested. Note the shipped board is an UNFILTERED insider screen; the ' +
      'routine/opportunistic split that carries the evidence (Cohen-Malloy-Pomorski) exists ' +
      'as a scoring module but is not yet wired to a board.',
  },
  earnings: {
    board: 'earnings',
    status: 'UNMEASURED',
    window: 'no backtest run exists',
    excessVsSPYPp: null, excessVsQQQPp: null, ic: null, rollingWindowsWon: null,
    runId: null, date: '2026-08-13',
    note: 'Never backtested. Calendar-driven; no measurement of forward return.',
  },
  crosses: {
    board: 'crosses',
    status: 'UNMEASURED',
    window: 'no backtest run exists',
    excessVsSPYPp: null, excessVsQQQPp: null, ic: null, rollingWindowsWon: null,
    runId: null, date: '2026-08-13',
    note: 'Never backtested. Moving-average crosses are descriptive here, not a measured signal.',
  },
  'quiet-strength': {
    board: 'quiet-strength',
    status: 'UNMEASURED',
    window: 'forward record opened 2026-08-11; first cohort of 20 still open',
    excessVsSPYPp: null, excessVsQQQPp: null, ic: null, rollingWindowsWon: null,
    runId: null, date: '2026-08-13',
    note:
      'UNMEASURED in this app, and deliberately so despite the strongest external evidence of ' +
      'any board here: residual momentum is replicated out-of-sample across 48 countries ' +
      '(Blitz/Huij/Martens; Hanauer/Windmuller), and the board ships an evidence banner ' +
      'stating an expected 0.5-1.5pp/yr net of haircut. That is someone ELSE\'S measurement. ' +
      'Ours began 2026-08-11 with a 20-name cohort that has not matured, so the honest ' +
      'in-app verdict is that we have not measured it yet.',
  },
};

/** Signed "+80.9pp" / "−73.4pp" formatting (U+2212 minus for display). */
function pp(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${Math.abs(n)}pp`;
}

/**
 * The chip label, e.g.:
 *   williams → "NO VALIDATED EDGE (−73.4pp vs SPY)"
 *   lynch    → "NO VALIDATED EDGE (IC 0.0011, −1.3pp vs SPY)"
 *   prophet  → "MIXED (+80.9pp vs SPY, −58pp vs QQQ, 4/8 windows)"
 *   target   → "EDGE PENDING VALIDATION"
 */
export function verdictLabel(v: BoardVerdict): string {
  switch (v.status) {
    case 'NO_EDGE': {
      const parts: string[] = [];
      if (v.ic !== null) parts.push(`IC ${v.ic}`);
      if (v.excessVsSPYPp !== null) parts.push(`${pp(v.excessVsSPYPp)} vs SPY`);
      return parts.length > 0
        ? `NO VALIDATED EDGE (${parts.join(', ')})`
        : 'NO VALIDATED EDGE';
    }
    case 'MIXED': {
      const parts: string[] = [];
      if (v.excessVsSPYPp !== null) parts.push(`${pp(v.excessVsSPYPp)} vs SPY`);
      if (v.excessVsQQQPp !== null) parts.push(`${pp(v.excessVsQQQPp)} vs QQQ`);
      if (v.rollingWindowsWon !== null) parts.push(`${v.rollingWindowsWon} windows`);
      return parts.length > 0 ? `MIXED (${parts.join(', ')})` : 'MIXED';
    }
    case 'PENDING':
      return 'EDGE PENDING VALIDATION';
    // No numbers, ever — there are none. "NOT MEASURED (−0.0pp)" would be a
    // measurement claim, which is the precise thing this status denies.
    case 'UNMEASURED':
      return 'NOT MEASURED';
    case 'VALIDATED': {
      const parts: string[] = [];
      if (v.excessVsSPYPp !== null) parts.push(`${pp(v.excessVsSPYPp)} vs SPY`);
      return parts.length > 0 ? `VALIDATED EDGE (${parts.join(', ')})` : 'VALIDATED EDGE';
    }
  }
}

/**
 * Boards demoted out of the default navigation.
 *
 * UNMEASURED counts. An unmeasured board is not a validated one, and the
 * divider's promise to the reader is "everything above this line has been
 * measured and held up" — a board nobody has measured cannot sit above it.
 *
 * NOTE, deliberately unchanged: PENDING and MIXED still return false. Both
 * describe a measurement that EXISTS and is incomplete or split, which is a
 * different claim from absence. Changing them would move boards in the nav on
 * a judgement the brief did not ask for; flagged rather than done.
 */
export function isUnvalidated(board: VerdictBoard): boolean {
  const s = BOARD_VERDICTS[board].status;
  return s === 'NO_EDGE' || s === 'UNMEASURED';
}

/** Type guard for nav ids, which are plain strings at the call site. */
export function isVerdictBoard(id: string): id is VerdictBoard {
  return Object.prototype.hasOwnProperty.call(BOARD_VERDICTS, id);
}
