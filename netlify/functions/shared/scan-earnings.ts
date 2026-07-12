// Shared scan orchestrator for the earnings board.
//
// Both the live endpoint (netlify/functions/earnings-board.ts) and the
// scheduled background scan (netlify/functions/scan-earnings.ts)
// route through this module. Single source of truth for earnings scoring,
// trigger computation, and play categorization.
//
// Universe is calendar-driven (not index-driven): pull earnings calendar
// for the requested look-ahead window, intersect with UNIVERSE, score each.
//
// Scheduled-scan strategy: WIDEST window (30d ahead + 5d back). Snapshot
// stores ALL setups (no composite filter). Live endpoint filters to user's
// requested window + composite threshold at read time. One snapshot covers
// all 4 window variants (3/7/14/30) without 4× the API cost.

import { getEarningsCalendarRangeWithStatus, getDailyBars, getEarningsHistory, getUpcomingEarnings } from './data-provider';
import { CORE_WATCHLIST, UNIVERSE } from './universe';
import type {
  EarningsSetup, EarningsPlayType,
  PlayTriggers, HistoricalEdge, ExecutionStep,
} from './types';
import { classifyEarnings, scoreEarningsComposite, computeDriftLean, annVol, chunksAnnVol, avg } from './earnings-scoring';
import type { Logger } from './logger';

// ====================================================================
// Public API
// ====================================================================

/** Widest scheduled-scan window. Live endpoint filters down at read time. */
export const EARNINGS_SCHEDULED_WINDOW_DAYS = 30;

/** Lookback for already-printed earnings (PEAD/reversal candidates). */
export const POST_PRINT_LOOKBACK_DAYS = 5;

/** Allowed user-facing windows for the live endpoint. */
export const ALLOWED_WINDOWS = [3, 7, 14, 30] as const;
export type EarningsWindow = (typeof ALLOWED_WINDOWS)[number];

export interface RunEarningsScanOpts {
  /** Days ahead to scan for upcoming earnings. Scheduled uses 30 (widest). */
  windowDays: number;
  /** Days back to scan for already-printed (PEAD/reversal). Set to 0 to skip. */
  postPrintLookbackDays?: number;
  /** Wall-clock budget for the entire scan. */
  scanBudgetMs: number;
  /** Per-batch concurrency for the bar+history fetch. */
  concurrency?: number;
  /** Optional logger; if omitted, the scan runs silent. */
  logger?: Logger;
}

export interface RunEarningsScanResult {
  /** Full unfiltered setup list. Filter at read time. */
  setups: EarningsSetup[];
  universeChecked: number;
  scanDurationMs: number;
  warnings: string[];
  budgetExceeded: boolean;
}

export interface EarningsCalendarEntry {
  ticker: string;
  date: string;
  hour?: string;
  epsEstimate?: number;
  revenueEstimate?: number;
}

export interface EarningsScanUniverseResolution {
  /** Calendar entries intersected with UNIVERSE (or the watchlist-probe fallback). */
  entries: EarningsCalendarEntry[];
  warnings: string[];
  /** True when the Finnhub calendar call itself failed (HTTP error /
   *  429-retries exhausted / thrown) AND the watchlist fallback also
   *  produced nothing. A worker seeing this must NOT publish — an empty
   *  snapshot over a failed calendar is the exact hollow-publish bug
   *  FIX-1 W1 closes. */
  calendarFailed: boolean;
}

/**
 * FIX-1 W1 — resolve the calendar-driven earnings scan universe once,
 * with failure visibility. Shared by the single-pass `runEarningsScan`
 * (live fallback path) and the checkpoint-resume background worker
 * (which persists the resolved entries on the run doc so every resumed
 * invocation walks the SAME universe).
 */
export async function resolveEarningsScanUniverse(opts: {
  windowDays: number;
  postPrintLookbackDays?: number;
  logger?: Logger;
}): Promise<EarningsScanUniverseResolution> {
  const log = opts.logger;
  const lookAhead = opts.windowDays;
  const lookBack = opts.postPrintLookbackDays ?? (opts.windowDays >= 7 ? POST_PRINT_LOOKBACK_DAYS : 0);
  const warnings: string[] = [];

  let entries: EarningsCalendarEntry[] = [];
  let calendarCallFailed = false;
  const cal = await getEarningsCalendarRangeWithStatus(lookAhead, lookBack);
  if (!cal.ok) {
    calendarCallFailed = true;
    const detail = cal.errorMessage
      ? cal.errorMessage
      : cal.rateLimitExhausted
        ? `HTTP 429 (retries exhausted)`
        : `HTTP ${cal.httpStatus}`;
    warnings.push(`calendar_range_failed: ${detail}`);
    log?.warn('earnings_calendar_range_failed', {
      httpStatus: cal.httpStatus,
      rateLimitExhausted: cal.rateLimitExhausted,
      err: cal.errorMessage,
    });
  } else {
    const universeTickers = new Set(UNIVERSE.map((u) => u.ticker));
    entries = cal.entries.filter((e) => universeTickers.has(e.ticker));
  }

  // Fallback for plans that gate the calendar range endpoint.
  if (entries.length === 0) {
    log?.info('earnings_calendar_fallback_to_watchlist_probe');
    const probed = await Promise.all(
      CORE_WATCHLIST.map((t) => getUpcomingEarnings(t, lookAhead).catch(() => null)),
    );
    entries = probed.filter((e): e is NonNullable<typeof e> => e !== null);
  }

  return {
    entries,
    warnings,
    calendarFailed: calendarCallFailed && entries.length === 0,
  };
}

export interface RunEarningsScanBatchOpts {
  /** The pre-resolved calendar universe (persisted on the run doc). */
  entries: EarningsCalendarEntry[];
  /** Inclusive start index into `entries`. */
  startIdx: number;
  /** Max entries to consume in this batch. */
  batchSize: number;
  concurrency?: number;
  logger?: Logger;
}

export interface RunEarningsScanBatchResult {
  setups: EarningsSetup[];
  tickersConsumed: number;
  /** Per-ticker scoring failures in this batch (thrown errors, not
   *  legit "no setup" nulls) — feeds the publish guard's error rate. */
  tickersErrored: number;
  warnings: string[];
}

/**
 * FIX-1 W1 — process a contiguous slice of the resolved earnings
 * calendar. Per-entry logic mirrors `runEarningsScan` exactly (same
 * scoreEarningsForTicker call, same 400d bar window). Used by
 * `scan-earnings-background.ts` under the checkpoint-resume machinery
 * (#95/#96/#97 pattern).
 */
export async function runEarningsScanBatch(
  opts: RunEarningsScanBatchOpts,
): Promise<RunEarningsScanBatchResult> {
  const log = opts.logger;
  const concurrency = opts.concurrency ?? 10;
  const slice = opts.entries.slice(opts.startIdx, opts.startIdx + opts.batchSize);
  const warnings: string[] = [];

  if (slice.length === 0) {
    return { setups: [], tickersConsumed: 0, tickersErrored: 0, warnings };
  }

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);

  const setups: EarningsSetup[] = [];
  let tickersErrored = 0;

  for (let i = 0; i < slice.length; i += concurrency) {
    const chunk = slice.slice(i, i + concurrency);
    const batch = await Promise.all(
      chunk.map(async (e) => {
        try {
          return await scoreEarningsForTicker(e, from, to);
        } catch (err: any) {
          tickersErrored += 1;
          log?.warn('earnings_ticker_error', { ticker: e.ticker, err: String(err?.message ?? err) });
          return null;
        }
      }),
    );
    for (const s of batch) if (s) setups.push(s);
  }

  if (tickersErrored > 0) {
    warnings.push(
      `earnings scoring errors on ${tickersErrored}/${slice.length} tickers in batch starting ${opts.startIdx}`,
    );
  }

  return { setups, tickersConsumed: slice.length, tickersErrored, warnings };
}

export async function runEarningsScan(opts: RunEarningsScanOpts): Promise<RunEarningsScanResult> {
  const startedAt = Date.now();
  const log = opts.logger;
  const concurrency = opts.concurrency ?? 10;
  const lookAhead = opts.windowDays;
  const lookBack = opts.postPrintLookbackDays ?? (opts.windowDays >= 7 ? POST_PRINT_LOOKBACK_DAYS : 0);
  const warnings: string[] = [];

  log?.info('earnings_scan_started', { windowDays: lookAhead, postPrintLookbackDays: lookBack, concurrency });

  // ---- Resolve calendar universe (shared with the bg-worker path) ----
  const resolution = await resolveEarningsScanUniverse({
    windowDays: lookAhead,
    postPrintLookbackDays: lookBack,
    logger: log,
  });
  warnings.push(...resolution.warnings);
  const inUniverse: EarningsCalendarEntry[] = resolution.entries;

  log?.info('earnings_universe_resolved', {
    count: inUniverse.length,
    calendarFailed: resolution.calendarFailed,
  });

  // ---- Per-ticker scan ----
  const setups: EarningsSetup[] = [];
  let budgetExceeded = false;

  const to = new Date().toISOString().slice(0, 10);
  // 400d of bars covers ~5 quarterly prints — enough that historicalEdge can
  // score against 3+ prior earnings reactions for the typical ticker.
  const from = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);

  for (let i = 0; i < inUniverse.length; i += concurrency) {
    if (Date.now() - startedAt > opts.scanBudgetMs) {
      budgetExceeded = true;
      warnings.push(`budget_exceeded: scanned ${i}/${inUniverse.length}`);
      log?.warn('earnings_scan_budget_exceeded', { scanned: i, total: inUniverse.length });
      break;
    }
    const chunk = inUniverse.slice(i, i + concurrency);
    const batch = await Promise.all(
      chunk.map(async (e) => {
        try {
          return await scoreEarningsForTicker(e, from, to);
        } catch (err: any) {
          // Per-ticker error is silent at scan time — too chatty otherwise
          return null;
        }
      }),
    );
    for (const s of batch) if (s) setups.push(s);
  }

  const scanDurationMs = Date.now() - startedAt;
  log?.info('earnings_scan_complete', {
    setupsFound: setups.length,
    universeChecked: inUniverse.length,
    scanDurationMs,
    budgetExceeded,
  });

  return {
    setups,
    universeChecked: inUniverse.length,
    scanDurationMs,
    warnings,
    budgetExceeded,
  };
}

/**
 * Filter a setup list down to the user's requested window + standard quality
 * thresholds. Used by the live endpoint when reading from a wide-window
 * snapshot.
 *
 * Rules:
 *   - Pre-print setups: keep if daysUntil ∈ [0, windowDays].
 *   - Post-print setups: always keep (their lookback is a fixed 5 trading days
 *     defined at scan time; window filter doesn't apply once printed).
 *   - composite >= 55, playType !== 'skip'.
 */
export function filterSetupsToWindow(
  allSetups: EarningsSetup[],
  windowDays: number,
): EarningsSetup[] {
  return allSetups
    .filter((s) => {
      if (s.composite < 55) return false;
      if (s.playType === 'skip') return false;
      if (s.postPrint) return true;       // already-printed setups: keep regardless of windowDays
      return s.daysUntil >= 0 && s.daysUntil <= windowDays;
    })
    .sort((a, b) => b.composite - a.composite);
}

// ====================================================================
// Per-ticker scoring (was inline in earnings-board.ts handler loop)
// ====================================================================

async function scoreEarningsForTicker(
  e: { ticker: string; date: string; hour?: string },
  from: string,
  to: string,
): Promise<EarningsSetup | null> {
  const [bars, history] = await Promise.all([
    getDailyBars(e.ticker, from, to).catch(() => []),
    // withAnnounceDates: reaction windows anchor on the ANNOUNCEMENT date
    // (CR-3) — costs one extra Finnhub calendar call per ticker.
    getEarningsHistory(e.ticker, 8, { withAnnounceDates: true }).catch(() => []),
  ]);
  if (bars.length < 30) return null;

  const latest = bars.at(-1)!;
  const reportTs = new Date(e.date).getTime();
  const daysUntil = Math.round((reportTs - Date.now()) / 86400000);
  const postPrint = daysUntil < 0;

  // ---- Volatility metrics ----
  const returns: number[] = [];
  for (let j = 1; j < bars.length; j++) {
    if (bars[j].c > 0 && bars[j - 1].c > 0) {
      returns.push(Math.log(bars[j].c / bars[j - 1].c));
    }
  }
  const rv20 = annVol(returns.slice(-20));
  const chunked = chunksAnnVol(returns, 20).filter((v) => v > 0);
  const rv90Min = chunked.length ? Math.min(...chunked) : 0;
  const rv90Max = chunked.length ? Math.max(...chunked) : 0;
  // REALIZED-vol rank, NOT implied vol (M2): where the current 20d realized
  // vol sits within the range of trailing 20d-chunk realized vols, clamped
  // 0-100. No options data is involved, so recommendations are worded as
  // "RV rank", never "IV". The proper upgrade is real IV from the Polygon
  // options snapshot already used by institutional-flow/ — out of scope here.
  const rvRankRaw = rv90Max > rv90Min
    ? ((rv20 - rv90Min) / (rv90Max - rv90Min)) * 100
    : 50;
  const rvRank = Math.max(0, Math.min(100, Math.round(rvRankRaw)));

  // EVENT-WINDOW expected move (M2), directly comparable to avgPriorMove
  // (a 2-trading-day T-1→T+1 reaction):
  //   annVol() annualizes daily log-return vol with √252 (trading days),
  //   so per-trading-day vol = rv20 / √252, and the 2-trading-day event
  //   window scales by √2:
  //     expectedMove = rv20 / √252 × √2 × 100   (in %)
  // The old formula rv20 × 100 × √(daysUntil/365) (a) mixed √252
  // trading-day annualization with calendar-day scaling, and (b) grew with
  // days UNTIL the report — the waiting-period move, not the event move —
  // so the movesBig/movesContained comparison flipped with event distance
  // (far events skewed short_volatility, imminent ones long_volatility).
  // The event-window form is invariant to daysUntil.
  const expectedMove = (rv20 / Math.sqrt(252)) * Math.sqrt(2) * 100;

  // ---- Prior earnings reactions: T-1 → T+1 close-to-close move ----
  // Windows anchor on the ANNOUNCEMENT date (CR-3): `period` is the fiscal
  // quarter end and lags the print by 2-8 weeks, so windowing on it
  // measured random 2-day moves ~a month from the actual print. Rows whose
  // announcement date didn't resolve are skipped outright — never fall
  // back to period-end.
  const priorMoves: number[] = [];
  const priorMovesSigned: number[] = [];
  let lastMove: number | null = null; // most-recent print's reaction (null if unresolved)
  for (const [k, h] of history.slice(0, 6).entries()) {
    if (!h.announceDate) continue;
    const hd = new Date(h.announceDate).getTime();
    const barIdx = bars.findIndex((b) => Math.abs(b.t - hd) < 3 * 86400000);
    if (barIdx > 0 && barIdx < bars.length - 1) {
      const pre = bars[barIdx - 1].c;
      const post = bars[barIdx + 1].c;
      if (pre > 0) {
        const signed = ((post - pre) / pre) * 100;
        priorMoves.push(Math.abs(signed));
        priorMovesSigned.push(signed);
        if (k === 0) lastMove = signed;
      }
    }
  }
  const avgPriorMove = priorMoves.length > 0 ? avg(priorMoves) : null;
  const moveRatio = (avgPriorMove !== null && expectedMove > 0)
    ? avgPriorMove / expectedMove
    : null;

  // ---- Pre-print drift signal (5d, 20d trend into earnings) ----
  const last5 = bars.slice(-6);
  const last20 = bars.slice(-21);
  const drift5 = last5.length >= 6 && last5[0].c > 0
    ? ((last5.at(-1)!.c - last5[0].c) / last5[0].c) * 100 : 0;
  const drift20 = last20.length >= 21 && last20[0].c > 0
    ? ((last20.at(-1)!.c - last20[0].c) / last20[0].c) * 100 : 0;

  // ---- Volume on most-recent bar vs 20d avg ----
  const recentVol = bars.slice(-5).reduce((a, b) => a + (b.v || 0), 0) / 5;
  const avg20Vol = bars.slice(-25, -5).reduce((a, b) => a + (b.v || 0), 0) / 20;
  const volRatio = avg20Vol > 0 ? recentVol / avg20Vol : 1;

  // ---- Categorize the play ----
  // FIX-2 W1 — classification + composite scoring extracted to the pure,
  // shared `earnings-scoring.ts` (single source for the live scan AND the
  // PIT backtest scorer; W3 re-derives the composite there). Behaviour
  // here is unchanged — the existing scan-earnings tests pin it.
  const { lean: driftLean, signals: driftSignals } = computeDriftLean(drift5, drift20);
  const surprise = (history[0]?.surprisePct ?? null);

  const { playType, bias, strategy, direction } = classifyEarnings({
    postPrint,
    surprise,
    lastMove,
    volRatio,
    rvRank,
    avgPriorMove,
    expectedMove,
    drift20,
    driftLean,
  });

  // ---- Composite score ----
  const composite = scoreEarningsComposite(playType, {
    rvRank,
    drift20,
    surprisePct: history[0]?.surprisePct ?? 0,
    daysUntil,
    postPrint,
  });

  // ---- Triggers, stops, targets ----
  const triggers = computeTriggers(playType, latest.c, expectedMove, bars, e.date, direction);

  // ---- Historical edge ----
  const historicalEdge = computeHistoricalEdge(playType, history, priorMovesSigned);

  // ---- Rationale ----
  const rationale = buildRationale({
    playType, rvRank, expectedMove, avgPriorMove, daysUntil,
    drift20, surprise: history[0]?.surprisePct ?? null, direction,
  });

  return {
    ticker: e.ticker,
    price: +latest.c.toFixed(2),
    reportDate: e.date,
    reportTime: (e.hour as any) ?? 'dmh',
    daysUntil,
    bias,
    strategy,
    composite,
    rvRank,
    // Deprecated alias — the frontend (EarningsView table + journal log)
    // still reads `ivr`. It has always been a realized-vol rank, never
    // implied vol; `rvRank` is the honest name going forward.
    ivr: rvRank,
    direction,
    expectedMove: +expectedMove.toFixed(2),
    avgPriorMove: avgPriorMove !== null ? +avgPriorMove.toFixed(2) : null,
    rationale,
    playType,
    moveRatio: moveRatio !== null ? +moveRatio.toFixed(2) : null,
    triggers,
    historicalEdge,
    prePrintDrift: !postPrint && driftLean !== 'mixed' ? {
      signalCount: driftSignals.length,
      lean: driftLean,
      details: driftSignals,
    } : undefined,
    postPrint,
  };
}

// ====================================================================
// Helpers (moved verbatim from earnings-board.ts)
// ====================================================================

function computeTriggers(
  playType: EarningsPlayType,
  price: number,
  expectedMove: number,
  bars: { o: number; h: number; l: number; c: number; t: number; v?: number }[],
  reportDateIso: string,
  // Fade side for 'reversal' (M3): 'short' fades a gap-up-on-miss,
  // 'long' fades a gap-down-on-beat. Other play types ignore it.
  direction?: 'long' | 'short',
): PlayTriggers {
  const last20 = bars.slice(-20);
  const high20 = last20.length ? Math.max(...last20.map((b) => b.h)) : price;
  const low20 = last20.length ? Math.min(...last20.map((b) => b.l)) : price;
  const emPct = expectedMove / 100;

  let entry = 'See strategy notes';
  let stop: number | null = null;
  let t1: number | null = null;
  let t2: number | null = null;
  let t3: number | null = null;
  let positionSizePct = 0.5;
  let options: PlayTriggers['options'];
  let executionSteps: PlayTriggers['executionSteps'];

  const expiry = nearestPostEarningsExpiry(reportDateIso);

  switch (playType) {
    case 'long_volatility': {
      entry = `Buy ATM straddle 1-3d before print`;
      positionSizePct = 0.5;

      const atmStrike = roundStrike(price);
      const estDebit = +(0.8 * emPct * price).toFixed(2);
      const beUp = +(atmStrike + estDebit).toFixed(2);
      const beDn = +(atmStrike - estDebit).toFixed(2);

      options = {
        structure: 'long_straddle',
        expiry,
        legs: [
          { action: 'buy', optionType: 'call', strike: atmStrike, ratio: 1 },
          { action: 'buy', optionType: 'put', strike: atmStrike, ratio: 1 },
        ],
        estDebitPerContract: estDebit,
        estCreditPerContract: null,
        wingWidth: null,
        maxProfitPerContract: null,
        maxLossPerContract: +(estDebit * 100).toFixed(0),
        breakevens: [beDn, beUp],
        profitTakeAt: 0.5,
      };

      executionSteps = [
        { n: 1, title: 'Confirm timing', detail: `Place this trade 1-2 trading days BEFORE the ${reportDateIso} report. Avoid same-day entries — IV will already be peaking and your fill will be poor.` },
        { n: 2, title: 'Pick expiry', detail: `Use the weekly expiring ${expiry} (the first Friday after the report). This captures the IV crush you're trying to avoid by being long.` },
        { n: 3, title: 'Build the straddle', detail: `In your broker's option chain, buy 1 ATM call AT $${atmStrike.toFixed(2)} strike and 1 ATM put AT $${atmStrike.toFixed(2)} strike, same expiry. Use a single combo/multi-leg ticket if available.` },
        { n: 4, title: 'Order type', detail: `Limit order at the mid (between bid and ask). If not filled in 30s, walk the price up by $0.05 increments. Estimated debit: ~$${estDebit.toFixed(2)} per straddle (= $${(estDebit * 100).toFixed(0)} per contract).` },
        { n: 5, title: 'Size the position', detail: `Risk no more than 0.5% of account on this trade. Max loss per straddle is the debit ($${(estDebit * 100).toFixed(0)}). Number of contracts = floor(account × 0.5% ÷ $${(estDebit * 100).toFixed(0)}).` },
        { n: 6, title: 'Set exits', detail: `Plan A: close at +50% on the debit (sell straddle for ~$${(estDebit * 1.5).toFixed(2)}). Plan B: stop out if either leg loses ≥40% before earnings — that means IV is collapsing without a move, exit fast. Plan C: close 1 day after earnings regardless — you don't want to hold theta decay into the weekend.` },
        { n: 7, title: 'Breakevens', detail: `Stock needs to move outside $${beDn.toFixed(2)} - $${beUp.toFixed(2)} (±$${estDebit.toFixed(2)} from $${atmStrike.toFixed(2)}) at expiry to be in profit. History suggests it will (long vol is the play here because expected move underprices realized).` },
      ];
      break;
    }
    case 'short_volatility': {
      entry = `Sell iron condor at \u00b1${(emPct * 1.2 * 100).toFixed(0)}% strikes, 1d before print`;
      positionSizePct = 0.5;

      const shortPutStrike = roundStrike(price * (1 - emPct * 1.2));
      const shortCallStrike = roundStrike(price * (1 + emPct * 1.2));
      const longPutStrike = roundStrike(price * (1 - emPct * 1.7));
      const longCallStrike = roundStrike(price * (1 + emPct * 1.7));
      const wingWidth = +(shortPutStrike - longPutStrike).toFixed(2);
      const estCredit = +(wingWidth * 0.30).toFixed(2);
      const maxProfit = +(estCredit * 100).toFixed(0);
      const maxLoss = +((wingWidth - estCredit) * 100).toFixed(0);
      const beLow = +(shortPutStrike - estCredit).toFixed(2);
      const beHigh = +(shortCallStrike + estCredit).toFixed(2);

      options = {
        structure: 'iron_condor',
        expiry,
        legs: [
          { action: 'buy', optionType: 'put', strike: longPutStrike, ratio: 1 },
          { action: 'sell', optionType: 'put', strike: shortPutStrike, ratio: 1 },
          { action: 'sell', optionType: 'call', strike: shortCallStrike, ratio: 1 },
          { action: 'buy', optionType: 'call', strike: longCallStrike, ratio: 1 },
        ],
        estDebitPerContract: null,
        estCreditPerContract: estCredit,
        wingWidth,
        maxProfitPerContract: maxProfit,
        maxLossPerContract: maxLoss,
        breakevens: [beLow, beHigh],
        profitTakeAt: 0.5,
      };

      executionSteps = [
        { n: 1, title: 'Confirm timing', detail: `Place this trade 1 trading day BEFORE the ${reportDateIso} report close. IV will be at its peak that afternoon — the credit you collect is what justifies this whole trade.` },
        { n: 2, title: 'Pick expiry', detail: `Use the weekly expiring ${expiry} (the first Friday after the report). The IV crush at open the next day is what generates your profit.` },
        { n: 3, title: 'Build the iron condor (4 legs, single ticket)', detail: `In your broker's option chain, build a 4-leg combo: BUY 1 put $${longPutStrike.toFixed(2)} / SELL 1 put $${shortPutStrike.toFixed(2)} / SELL 1 call $${shortCallStrike.toFixed(2)} / BUY 1 call $${longCallStrike.toFixed(2)}. All same expiry. Most brokers (TastyTrade, IBKR, ToS, Fidelity ATP) have an "Iron Condor" preset.` },
        { n: 4, title: 'Order type & target credit', detail: `Limit order at the mid. Aim for a credit of ~$${estCredit.toFixed(2)} per IC (=$${maxProfit} max profit per contract). Walk the price down by $0.05 if not filled in 30s. Don't accept less than 1/4 of wing width ($${(wingWidth * 0.25).toFixed(2)}) — if IV isn't rich enough to give you that, the trade thesis is invalid.` },
        { n: 5, title: 'Size the position', detail: `Risk no more than 0.5% of account. Max loss per IC = $${maxLoss}. Number of contracts = floor(account × 0.5% ÷ $${maxLoss}). Margin requirement is the max loss × contracts.` },
        { n: 6, title: 'Set exits', detail: `Plan A: close at 50% of max profit (buy back the IC for ~$${(estCredit * 0.5).toFixed(2)} debit) — usually achievable the morning after earnings. Plan B: close immediately if stock breaks $${shortPutStrike.toFixed(2)} or $${shortCallStrike.toFixed(2)} (the short strikes) — don't let it run to your long strikes. Plan C: close at expiry if it's coasting toward zero.` },
        { n: 7, title: 'Breakevens & risk zone', detail: `Profitable if stock stays between $${beLow.toFixed(2)} - $${beHigh.toFixed(2)} at expiry. Max loss ($${maxLoss}) hits if stock closes outside $${longPutStrike.toFixed(2)} - $${longCallStrike.toFixed(2)}. R:R is intentionally lopsided (you risk $${(maxLoss/maxProfit).toFixed(1)}× to make 1×) — the edge is win rate, not payoff size.` },
      ];
      break;
    }
    case 'directional_long': {
      entry = `Buy on close above $${high20.toFixed(2)} (20d high) on volume`;
      stop = +(low20 * 1.005).toFixed(2);
      t1 = +(price * 1.05).toFixed(2);
      t2 = +(price * 1.10).toFixed(2);
      t3 = +(price * 1.18).toFixed(2);
      positionSizePct = 1.0;
      executionSteps = directionalSteps('long', price, stop, t1, t2, t3, high20, reportDateIso);
      break;
    }
    case 'directional_short': {
      entry = `Short on close below $${low20.toFixed(2)} (20d low) on volume`;
      stop = +(high20 * 0.995).toFixed(2);
      t1 = +(price * 0.95).toFixed(2);
      t2 = +(price * 0.90).toFixed(2);
      t3 = +(price * 0.82).toFixed(2);
      positionSizePct = 1.0;
      executionSteps = directionalSteps('short', price, stop, t1, t2, t3, low20, reportDateIso);
      break;
    }
    case 'pead_long': {
      entry = `Buy on pullback to post-print breakout level, hold 30-60d`;
      stop = +(price * 0.94).toFixed(2);
      t1 = +(price * 1.06).toFixed(2);
      t2 = +(price * 1.12).toFixed(2);
      t3 = +(price * 1.20).toFixed(2);
      positionSizePct = 1.0;
      executionSteps = peadSteps('long', price, stop, t1, t2, t3);
      break;
    }
    case 'pead_short': {
      entry = `Short on bounce to post-print breakdown level, hold 30-60d`;
      stop = +(price * 1.06).toFixed(2);
      t1 = +(price * 0.94).toFixed(2);
      t2 = +(price * 0.88).toFixed(2);
      t3 = +(price * 0.80).toFixed(2);
      positionSizePct = 1.0;
      executionSteps = peadSteps('short', price, stop, t1, t2, t3);
      break;
    }
    case 'reversal': {
      // Direction-aware fade (M3). Long fade (gap-down-on-beat) mirrors the
      // short fade's geometry: stop 4% beyond entry against the trade,
      // targets at -3/-6/-10% (short) or +3/+6/+10% (long).
      const side: 'long' | 'short' = direction ?? 'short';
      if (side === 'long') {
        entry = `Fade the gap-down on day 2-3 reversal candle, hold 5-10d`;
        stop = +(price * 0.96).toFixed(2);
        t1 = +(price * 1.03).toFixed(2);
        t2 = +(price * 1.06).toFixed(2);
        t3 = +(price * 1.10).toFixed(2);
      } else {
        entry = `Fade the gap-up on day 2-3 reversal candle, hold 5-10d`;
        stop = +(price * 1.04).toFixed(2);
        t1 = +(price * 0.97).toFixed(2);
        t2 = +(price * 0.94).toFixed(2);
        t3 = +(price * 0.90).toFixed(2);
      }
      positionSizePct = 0.5;
      executionSteps = reversalSteps(side, price, stop, t1, t2, t3);
      break;
    }
    default: {
      entry = 'No actionable setup';
      positionSizePct = 0;
    }
  }

  let riskReward: number | null = null;
  if (!options && stop !== null && t1 !== null && stop !== price) {
    const reward = Math.abs(t1 - price);
    const risk = Math.abs(price - stop);
    riskReward = risk > 0 ? +(reward / risk).toFixed(2) : null;
  }

  return {
    entry,
    stop,
    targets: { t1, t2, t3 },
    riskReward,
    positionSizePct,
    options,
    executionSteps,
  };
}

function roundStrike(price: number): number {
  if (price < 25) return Math.round(price * 2) / 2;
  if (price < 200) return Math.round(price);
  return Math.round(price / 2.5) * 2.5;
}

function nearestPostEarningsExpiry(reportDateIso: string): string {
  try {
    const d = new Date(reportDateIso);
    if (Number.isNaN(d.getTime())) throw new Error('bad date');
    do {
      d.setUTCDate(d.getUTCDate() + 1);
    } while (d.getUTCDay() !== 5);
    return d.toISOString().slice(0, 10);
  } catch {
    const d = new Date(Date.now() + 8 * 86400000);
    return d.toISOString().slice(0, 10);
  }
}

function directionalSteps(
  side: 'long' | 'short',
  price: number,
  stop: number,
  t1: number,
  t2: number,
  t3: number,
  trigger: number,
  reportDateIso: string,
): ExecutionStep[] {
  const verb = side === 'long' ? 'BUY' : 'SHORT';
  const direction = side === 'long' ? 'rises above' : 'breaks below';
  return [
    { n: 1, title: 'Wait for the trigger', detail: `Don't enter pre-emptively. Place a stop-${side === 'long' ? 'buy' : 'sell'} order so you're only filled if the stock ${direction} $${trigger.toFixed(2)} on volume (≥1.3× 20-day average).` },
    { n: 2, title: 'Confirm with volume', detail: `Once the trigger fires, check that the breakout candle has higher volume than the prior 5 sessions. Low-volume breaks fail ~60% of the time.` },
    { n: 3, title: 'Enter the position', detail: `${verb} shares at market or with a tight limit. Earnings is ${reportDateIso} — if the trade fires within 1-2 days of that, also consider buying ATM calls (long) / puts (short) to add convex exposure to the move.` },
    { n: 4, title: 'Size the position', detail: `Risk no more than 1% of account. Max loss per share = $${Math.abs(price - stop).toFixed(2)} (entry to stop). Shares = floor(account × 1% ÷ $${Math.abs(price - stop).toFixed(2)}).` },
    { n: 5, title: 'Set the stop', detail: `Hard stop at $${stop.toFixed(2)} (${side === 'long' ? '20d low' : '20d high'} — beyond this, the breakout thesis is invalid). Use a stop-${side === 'long' ? 'sell' : 'buy'} order, not a mental stop.` },
    { n: 6, title: 'Scale out at targets', detail: `Sell 1/3 at $${t1.toFixed(2)} (T1, +5% / -5%). Sell another 1/3 at $${t2.toFixed(2)} (T2). Trail the final 1/3 with a stop ${side === 'long' ? 'below' : 'above'} the prior swing low/high until it stops out, ideally near $${t3.toFixed(2)}.` },
    { n: 7, title: 'Time horizon', detail: `This is a 5-15 day swing. If the trade hasn't moved 2× ATR by day 5, exit — momentum has stalled and the edge has decayed.` },
  ];
}

function peadSteps(
  side: 'long' | 'short',
  price: number,
  stop: number,
  t1: number,
  t2: number,
  t3: number,
): ExecutionStep[] {
  const verb = side === 'long' ? 'BUY' : 'SHORT';
  return [
    { n: 1, title: 'Wait for the post-print pullback', detail: `Don't chase the gap on day 1. Wait 2-5 trading days for the stock to retest the post-print breakout (long) or breakdown (short) level. PEAD works because the drift is slow and persistent — patience is a feature.` },
    { n: 2, title: 'Confirm the retest holds', detail: `Look for a candle that touches the breakout level and closes ${side === 'long' ? 'above' : 'below'} it on rising volume. That's the entry signal.` },
    { n: 3, title: 'Enter the position', detail: `${verb} shares at market. For larger positions, scale in: 1/2 at the retest, 1/2 on confirmation 1-2 days later. Calls/puts work too but PEAD is a 30-60d trade and theta will eat short-dated options — use 60+ DTE if going options.` },
    { n: 4, title: 'Size the position', detail: `Risk no more than 1% of account. Max loss per share = $${Math.abs(price - stop).toFixed(2)}. Shares = floor(account × 1% ÷ $${Math.abs(price - stop).toFixed(2)}).` },
    { n: 5, title: 'Set the stop', detail: `Hard stop at $${stop.toFixed(2)} (a 6% adverse move is a "the gap was a fake" signal). PEAD that fails, fails fast — don't hold beyond the stop.` },
    { n: 6, title: 'Scale out at targets', detail: `Sell 1/3 at $${t1.toFixed(2)} (≈+/-6%). Sell 1/3 at $${t2.toFixed(2)} (≈+/-12%). Trail the rest with a stop ${side === 'long' ? 'below' : 'above'} the 20d MA.` },
    { n: 7, title: 'Time horizon', detail: `30-60 trading days max. If it hasn't reached T1 in 30 days, the drift signal has decayed — exit and free up the capital.` },
  ];
}

function reversalSteps(
  side: 'long' | 'short',
  price: number,
  stop: number,
  t1: number,
  t2: number,
  t3: number,
): ExecutionStep[] {
  // M3 — direction-aware wording. Short side fades a gap-UP-on-miss;
  // long side fades a gap-DOWN-on-beat.
  const isShort = side === 'short';
  const exhaustion = isShort
    ? `look for a candle that opens at the prior day's close, runs up, then closes weak (long upper wick on a gap-up)`
    : `look for a candle that opens at the prior day's close, sells off, then closes strong (long lower wick on a gap-down)`;
  const enterVerb = isShort
    ? `SHORT shares (or buy short-dated puts at ATM strike, ~5-10 DTE)`
    : `BUY shares (or buy short-dated calls at ATM strike, ~5-10 DTE)`;
  const t1Pct = isShort ? '-3%' : '+3%';
  const t2Pct = isShort ? '-6%' : '+6%';
  return [
    { n: 1, title: 'Wait for day 2-3 reversal candle', detail: `Don't fade day 1 of an earnings gap. Wait for day 2 or 3 — ${exhaustion}. That's the exhaustion signal.` },
    { n: 2, title: 'Enter on confirmation', detail: `${enterVerb} once the reversal candle prints. Don't wait for the next session — gaps fade fastest in the first few days.` },
    { n: 3, title: 'Size the position', detail: `Risk 0.5% of account (smaller than directional plays — reversals are higher-variance). Max loss per share = $${Math.abs(price - stop).toFixed(2)}. Shares = floor(account × 0.5% ÷ $${Math.abs(price - stop).toFixed(2)}).` },
    { n: 4, title: 'Set the stop', detail: `Hard stop at $${stop.toFixed(2)} (4% beyond entry). If the gap continues, the trade is wrong and the bull/bear trap thesis is invalid.` },
    { n: 5, title: 'Scale out aggressively', detail: `Take 1/2 at $${t1.toFixed(2)} (${t1Pct}) — this is the high-probability target. Take 1/4 at $${t2.toFixed(2)} (${t2Pct}). Let the last 1/4 run toward $${t3.toFixed(2)} with a trailing stop. Don't be greedy — gap fades complete in 5-10 days.` },
    { n: 6, title: 'Time horizon', detail: `5-10 trading days. If price hasn't moved toward T1 within 5 days, exit at break-even — the fade thesis has expired.` },
  ];
}

function computeHistoricalEdge(
  playType: EarningsPlayType,
  history: { period: string; surprisePct?: number }[],
  priorMovesSigned: number[],
): HistoricalEdge | null {
  if (history.length < 3 || priorMovesSigned.length < 3) return null;
  const total = priorMovesSigned.length;
  let hits = 0;
  let description = '';

  switch (playType) {
    case 'long_volatility':
      hits = priorMovesSigned.filter((m) => Math.abs(m) > 5).length;
      description = `${hits}/${total} prior prints moved >5% in either direction`;
      break;
    case 'short_volatility':
      hits = priorMovesSigned.filter((m) => Math.abs(m) < 5).length;
      description = `${hits}/${total} prior prints stayed within 5% (premium kept)`;
      break;
    case 'directional_long':
    case 'pead_long':
      hits = priorMovesSigned.filter((m) => m > 2).length;
      description = `${hits}/${total} prior prints closed +2% or more`;
      break;
    case 'directional_short':
    case 'pead_short':
      hits = priorMovesSigned.filter((m) => m < -2).length;
      description = `${hits}/${total} prior prints closed -2% or worse`;
      break;
    case 'reversal':
      hits = priorMovesSigned.filter((m) => Math.abs(m) > 3).length;
      description = `${hits}/${total} prior prints had >3% gap (reversal candidates)`;
      break;
    default:
      return null;
  }

  return {
    hits,
    total,
    ratePct: total > 0 ? Math.round((hits / total) * 100) : 0,
    description,
  };
}

function buildRationale(input: {
  playType: EarningsPlayType;
  rvRank: number;
  expectedMove: number;
  avgPriorMove: number | null;
  daysUntil: number;
  drift20: number;
  surprise: number | null;
  direction?: 'long' | 'short';
}): string {
  const { playType, rvRank, expectedMove, avgPriorMove, daysUntil, drift20, surprise, direction } = input;
  const em = `\u00b1${expectedMove.toFixed(1)}%`;
  const apm = avgPriorMove !== null ? `${avgPriorMove.toFixed(1)}%` : 'unknown';
  const when = daysUntil < 0
    ? `reported ${Math.abs(daysUntil)}d ago`
    : daysUntil === 0 ? 'reports today' : `${daysUntil}d to print`;

  // Wording is deliberately "RV rank", not "IV" (M2): rvRank is a
  // realized-vol rank with zero options data behind it. Premium richness/
  // cheapness is therefore a likelihood, not an observation.
  switch (playType) {
    case 'long_volatility':
      return `RV rank low (${rvRank}) \u2014 premium likely cheap; expected ${em} event move but history avg ${apm}. ${when}.`;
    case 'short_volatility':
      return `RV rank high (${rvRank}) \u2014 premium likely rich; expected ${em} event move vs history avg ${apm}. ${when}.`;
    case 'directional_long':
      return `Pre-earnings drift +${drift20.toFixed(1)}% over 20d, momentum into print. RV rank ${rvRank}, ${when}.`;
    case 'directional_short':
      return `Pre-earnings weakness ${drift20.toFixed(1)}% over 20d, breakdown setup. RV rank ${rvRank}, ${when}.`;
    case 'pead_long':
      return `Beat by ${surprise?.toFixed(1)}%, post-print continuation likely. ${when}.`;
    case 'pead_short':
      return `Miss by ${surprise?.toFixed(1)}%, post-print weakness likely. ${when}.`;
    case 'reversal':
      return direction === 'long'
        ? `Gap-and-fade: gapped DOWN on a beat \u2014 fade the gap LONG. ${when}.`
        : `Gap-and-fade: gapped UP on a miss \u2014 fade the gap SHORT. ${when}.`;
    default:
      return `Mixed data, no clear edge. ${when}.`;
  }
}

// annVol / chunksAnnVol / avg now live in shared/earnings-scoring.ts
// (imported above) so the live scan, the PIT backtest scorer, and the
// FIX-2 event study compute RV rank / expected move identically.
