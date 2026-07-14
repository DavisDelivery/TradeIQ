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

export type VerdictStatus = 'NO_EDGE' | 'MIXED' | 'PENDING' | 'VALIDATED';

export type VerdictBoard = 'williams' | 'lynch' | 'prophet' | 'target' | 'fable';

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
    window: '2018-01-31 → 2024-12-31, sp500',
    excessVsSPYPp: -1.3,
    excessVsQQQPp: null,
    ic: 0.0011,
    rollingWindowsWon: null,
    runId: 'bt_20260608015737',
    date: '2026-06-08',
    note:
      'IC 0.0011 (indistinguishable from zero) and −1.3 pp vs SPY: the scores carry no ' +
      'measurable ranking information. Restatement caveat applies (pit-audit §8).',
  },
  prophet: {
    board: 'prophet',
    status: 'MIXED',
    window: 'portfolio backtest, full window + 8 rolling windows',
    excessVsSPYPp: 80.9,
    excessVsQQQPp: -58,
    ic: null,
    rollingWindowsWon: '4/8',
    runId: null,
    date: '2026-05-18',
    note:
      '+80.9 pp vs SPY full-window, but beats its benchmark in only 4/8 rolling windows ' +
      'and loses to QQQ by ~58 pp — a flattering full-window number over inconsistent periods.',
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
    case 'VALIDATED': {
      const parts: string[] = [];
      if (v.excessVsSPYPp !== null) parts.push(`${pp(v.excessVsSPYPp)} vs SPY`);
      return parts.length > 0 ? `VALIDATED EDGE (${parts.join(', ')})` : 'VALIDATED EDGE';
    }
  }
}

/** Boards demoted out of the default navigation (no validated edge). */
export function isUnvalidated(board: VerdictBoard): boolean {
  return BOARD_VERDICTS[board].status === 'NO_EDGE';
}
