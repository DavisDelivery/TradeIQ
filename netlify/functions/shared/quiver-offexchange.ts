// OFF-EXCHANGE (OTC) VOLUME — the retail-crowding leg, and the only
// social-adjacent Quiver dataset this plan actually pays for.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AT ALL
//
// The Camillo frame needs an INVESTOR-SATURATION gauge: has the retail crowd
// already found this name? WallStreetBets mention counts would be the obvious
// source. Probed 2026-08-04 with the live key: /historical/wallstreetbets and
// /historical/twitter both return 403 — the datasets exist, this plan does not
// include them, and neither appears on any tier Quiver currently publishes.
// (Controls in the same run: lobbying 200, insiders 403 — so the 403s are real
// gates, not a broken key.)
//
// /historical/offexchange DOES return 200 on this plan — 1,209 daily rows back
// to 2021 for CROX. It is the substitute, and in one respect it is a better
// one: it measures what retail money DID, not what retail accounts SAID.
//
//   OTC_Total  — shares printed off-exchange (wholesaler internalisation,
//                ATS/dark pools). Retail marketable flow is overwhelmingly
//                internalised, so a surge in off-exchange volume is a
//                reasonable proxy for a surge in retail participation.
//   OTC_Short  — of that, the share reported short.
//   DPI        — OTC_Short / OTC_Total exactly (verified against the raw
//                fields, CROX 2026-08-03: 334005/470914 = 0.70927).
//
// ---------------------------------------------------------------------------
// WHAT IT IS NOT
//
// DPI is widely read as a bullish gauge on the theory that a wholesaler
// filling a retail BUY books its own side as a short. That inference is folk
// wisdom, not a measured result, and it is contaminated by genuine short
// selling and by hedging flow. This module therefore reports DPI as a
// DESCRIPTIVE number and never as a direction.
//
// The volume z-score is the part that carries information about crowding, and
// even that is UNWEIGHTED here — same treatment as Google Trends, for the same
// reason: this system has not measured an edge from it, and an unmeasured leg
// does not get to move a score. It is context for a human and for the model.
//
// TWO CONFOUNDS MEASURED HERE, 2026-08-04, so nobody rediscovers them the
// expensive way:
//
//   1. DPI LEVEL IS NOT COMPARABLE ACROSS NAMES. Across a 14-name sample the
//      mega-caps sat at 0.29-0.52 (KO 0.29, MSFT 0.40, AAPL 0.49) while the
//      small/mid consumer names sat at 0.58-0.71 (CROX 0.70, GME 0.71,
//      CHWY 0.60). That spread is capitalisation and liquidity, not
//      accumulation. Only the delta against a name's OWN baseline means
//      anything, which is why both numbers are reported together and neither
//      is ever ranked cross-sectionally.
//   2. IT IS NOT A MARKET-WIDE DRIFT EITHER. The first four names checked
//      were all above baseline, which looked like a common factor; widening
//      the sample gave 8/14 above with a mean delta of +0.010. So the delta
//      does carry name-specific variation. That is the reason this module
//      exists rather than being abandoned — but variation is not edge.
//
// If you later want to weight it, run it through the paper tracker first.

import { quiverGetWithStatus } from './quiver-client';
import { logger } from './logger';

const log = logger.child({ mod: 'quiver-offexchange' });

/** Baseline window in trading days. Below this the z-score is null, not 0. */
export const BASELINE_DAYS = 60;
/** Recent window averaged against the baseline. */
export const RECENT_DAYS = 5;
/** Minimum usable rows before any statistic is reported. */
export const MIN_DAYS = RECENT_DAYS + 20;
/** Matches the z-clip used in the scoring work — fat tails, small samples. */
export const Z_CLIP = 2.5;

export interface OffExchangeRow {
  date: string;
  otcShort: number;
  otcTotal: number;
  dpi: number | null;
}

export interface OffExchangeSignal {
  ticker: string;
  available: boolean;
  /** Newest date in the series. */
  asOf: string | null;
  days: number;
  /**
   * z-score of log(OTC volume): mean of the last RECENT_DAYS against the
   * prior BASELINE_DAYS. Null when the history is too short — never 0.
   * UNWEIGHTED. Descriptive only.
   */
  volumeZ: number | null;
  /** Mean OTC_Total over the recent window, shares. */
  recentDailyVolume: number | null;
  /** Recent-window mean DPI, 0-1. Descriptive, NOT directional. */
  dpiRecent: number | null;
  /** Baseline-window mean DPI, 0-1. */
  dpiBase: number | null;
  /** Why unavailable, when it is. Shown verbatim. */
  reason: string | null;
  /** Travels with the payload so a UI refactor cannot drop the caveat. */
  caveat: string;
}

export const OFFEXCHANGE_CAVEAT =
  'Off-exchange volume is a proxy for retail participation (wholesaler internalisation), not a ' +
  'measured signal. DPI is the short share of that volume and is reported descriptively — this ' +
  'system has NOT verified the folk reading that high DPI is bullish. Carries no weight in any score.';

function unavailable(ticker: string, reason: string): OffExchangeSignal {
  return {
    ticker, available: false, asOf: null, days: 0, volumeZ: null,
    recentDailyVolume: null, dpiRecent: null, dpiBase: null,
    reason, caveat: OFFEXCHANGE_CAVEAT,
  };
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Normalise raw Quiver rows. Quiver returns numbers as numbers here but has
 * shipped stringified numerics on other datasets, so both are accepted. Rows
 * missing a date or a total are DROPPED, not zero-filled — a zero-volume day
 * that never happened would deflate the baseline and inflate every z-score
 * after it.
 */
export function normaliseRows(raw: unknown): OffExchangeRow[] {
  if (!Array.isArray(raw)) return [];
  const out: OffExchangeRow[] = [];
  for (const r of raw as any[]) {
    const date = typeof r?.Date === 'string' ? r.Date.slice(0, 10) : null;
    const otcTotal = num(r?.OTC_Total);
    const otcShort = num(r?.OTC_Short);
    if (!date || otcTotal == null || otcTotal <= 0) continue;
    out.push({
      date,
      otcTotal,
      otcShort: otcShort ?? 0,
      // Prefer Quiver's own DPI; recompute only if absent. Never invent one
      // when the short leg is missing.
      dpi: num(r?.DPI) ?? (otcShort == null ? null : otcShort / otcTotal),
    });
  }
  // Quiver returns newest-first, but that is an observation, not a contract.
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

/**
 * Pure compute — every statistic in this module is derived here so the tests
 * never need the network.
 */
export function computeOffExchange(ticker: string, rows: OffExchangeRow[]): OffExchangeSignal {
  if (rows.length < MIN_DAYS) {
    return {
      ...unavailable(ticker, `only ${rows.length} off-exchange days; need ${MIN_DAYS} for a baseline`),
      available: rows.length > 0,
      asOf: rows.length ? rows[rows.length - 1].date : null,
      days: rows.length,
    };
  }

  const recent = rows.slice(-RECENT_DAYS);
  const base = rows.slice(-(RECENT_DAYS + BASELINE_DAYS), -RECENT_DAYS);

  // Volume is lognormal-ish and spans orders of magnitude; z-scoring the raw
  // level makes a single earnings-day print dominate the whole series.
  const baseLog = base.map((r) => Math.log(r.otcTotal));
  const m = mean(baseLog);
  const sd = Math.sqrt(mean(baseLog.map((v) => (v - m) ** 2)));

  let volumeZ: number | null = null;
  if (sd > 1e-9) {
    const raw = (mean(recent.map((r) => Math.log(r.otcTotal))) - m) / sd;
    volumeZ = Math.round(Math.max(-Z_CLIP, Math.min(Z_CLIP, raw)) * 100) / 100;
  }

  const dpisRecent = recent.map((r) => r.dpi).filter((v): v is number => v != null);
  const dpisBase = base.map((r) => r.dpi).filter((v): v is number => v != null);

  return {
    ticker,
    available: true,
    asOf: rows[rows.length - 1].date,
    days: rows.length,
    volumeZ,
    recentDailyVolume: Math.round(mean(recent.map((r) => r.otcTotal))),
    dpiRecent: dpisRecent.length ? Math.round(mean(dpisRecent) * 1000) / 1000 : null,
    dpiBase: dpisBase.length ? Math.round(mean(dpisBase) * 1000) / 1000 : null,
    reason: null,
    caveat: OFFEXCHANGE_CAVEAT,
  };
}

/**
 * Fetch + compute for one ticker.
 *
 * A transport failure (403 gate, 429, network) returns `available: false`
 * with the reason — it is NEVER conflated with "this ticker has no
 * off-exchange volume", which would be a lie about the market.
 */
export async function fetchOffExchange(ticker: string): Promise<OffExchangeSignal> {
  const t = ticker.toUpperCase();
  const { data, ok } = await quiverGetWithStatus<unknown>(
    `/historical/offexchange/${encodeURIComponent(t)}`,
    { ttlMs: 6 * 60 * 60 * 1000 },
  );
  if (!ok) {
    return unavailable(t, 'Quiver off-exchange request failed (gate, rate limit or network) — not a statement about the ticker');
  }
  const rows = normaliseRows(data);
  if (!rows.length) return unavailable(t, `Quiver returned no off-exchange rows for ${t}`);
  const sig = computeOffExchange(t, rows);
  log.info('offexchange', { ticker: t, days: sig.days, volumeZ: sig.volumeZ });
  return sig;
}
