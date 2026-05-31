// Phase 6 W1 — sector-median context for the detail-panel key-metrics panel.
//
// Computes median fundamentals across a sample of sector peers from the
// in-repo universe, so a metric ("P/E 29.4") can be shown against its sector
// median ("sector 26.1"). Cached in-process per sector for ~1h: the first
// detail-panel open for a sector on a warm function instance pays the cost,
// repeats are free. The SPA also session-memoizes the whole /api/stock-detail
// response, so the same ticker re-opened doesn't refetch at all.
//
// **Scope guard (Phase 4w coordination):** this reads ONLY metrics already
// exposed by the existing `getFundamentals` abstraction (P/E via ttmEps +
// price, gross/operating margin, debt-to-equity). It does NOT reach into the
// Polygon Massive Financials VX endpoint for the richer ratios (P/S, EV/EBITDA,
// ROE, …) — that surface belongs to Phase 4w's fundamentals migration. Metrics
// we can't source cheaply are simply absent from the returned map (the caller
// renders them as explicit no-data, never a fabricated zero).

import { UNIVERSE } from './universe';
import { getFundamentals, getPreviousClose } from './data-provider';
import { withTimeout } from './with-timeout';

export type SectorMedianMetric = 'pe' | 'grossMargin' | 'opMargin' | 'debtEquity';

export type SectorMedians = Partial<Record<SectorMedianMetric, number>>;

interface CacheEntry {
  at: number;
  medians: SectorMedians;
  sampleSize: number;
}

const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 60 * 60 * 1000; // 1h
const MAX_PEERS = 16; // bound the per-sector fetch cost
const CONCURRENCY = 4;
// Phase 6 PR-G0 — per-peer hard cap. One slow Massive/Polygon response
// can no longer stall the entire sector-medians fan-out. With CONCURRENCY=4
// and MAX_PEERS=16 we run 4 sequential batches; worst-case wall-clock is
// ~4 × PEER_TIMEOUT_MS = ~16s, which the caller's outer timeout then bounds
// even further (stock-detail caps the whole getSectorMedians call at ~5s).
const PEER_TIMEOUT_MS = 4_000;

export interface SectorMedianResult {
  sector: string;
  medians: SectorMedians;
  sampleSize: number;
  cached: boolean;
}

/**
 * Median fundamentals for `sector`, sampled from the universe. Returns only
 * the metrics that could be computed from the available sample — callers must
 * treat a missing key as "no sector data for this metric".
 */
export async function getSectorMedians(
  sector: string,
  opts: { excludeTicker?: string } = {},
): Promise<SectorMedianResult> {
  const cached = CACHE.get(sector);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { sector, medians: cached.medians, sampleSize: cached.sampleSize, cached: true };
  }

  const peers = UNIVERSE.filter(
    (u) => u.sector === sector && u.ticker !== opts.excludeTicker,
  )
    .slice(0, MAX_PEERS)
    .map((u) => u.ticker);

  if (peers.length === 0) {
    const empty: CacheEntry = { at: Date.now(), medians: {}, sampleSize: 0 };
    CACHE.set(sector, empty);
    return { sector, medians: {}, sampleSize: 0, cached: false };
  }

  const pe: number[] = [];
  const grossMargin: number[] = [];
  const opMargin: number[] = [];
  const debtEquity: number[] = [];

  for (let i = 0; i < peers.length; i += CONCURRENCY) {
    const chunk = peers.slice(i, i + CONCURRENCY);
    // PR-G0: each peer is bounded by PEER_TIMEOUT_MS via withTimeout. A
    // hanging upstream becomes `{fund:null, prev:null}` rather than
    // stalling the batch. The outer Promise.all still resolves in the
    // bounded time of the slowest peer in the batch.
    const rows = await Promise.all(
      chunk.map(async (t) => {
        const [fund, prev] = await Promise.all([
          withTimeout(getFundamentals(t).catch(() => null), PEER_TIMEOUT_MS, null),
          withTimeout(getPreviousClose(t).catch(() => null), PEER_TIMEOUT_MS, null),
        ]);
        return { fund, prev };
      }),
    );
    for (const { fund, prev } of rows) {
      if (!fund) continue;
      if (fund.ttmEps && fund.ttmEps > 0 && prev && prev.c > 0) {
        const peVal = prev.c / fund.ttmEps;
        if (Number.isFinite(peVal) && peVal > 0 && peVal < 1000) pe.push(peVal);
      }
      if (fund.grossMargin !== undefined && Number.isFinite(fund.grossMargin)) {
        grossMargin.push(fund.grossMargin * 100);
      }
      if (fund.operatingMargin !== undefined && Number.isFinite(fund.operatingMargin)) {
        opMargin.push(fund.operatingMargin * 100);
      }
      if (fund.debtToEquity !== undefined && Number.isFinite(fund.debtToEquity)) {
        debtEquity.push(fund.debtToEquity);
      }
    }
  }

  const medians: SectorMedians = {};
  const peMed = median(pe);
  if (peMed !== undefined) medians.pe = round(peMed, 1);
  const gmMed = median(grossMargin);
  if (gmMed !== undefined) medians.grossMargin = round(gmMed, 1);
  const omMed = median(opMargin);
  if (omMed !== undefined) medians.opMargin = round(omMed, 1);
  const deMed = median(debtEquity);
  if (deMed !== undefined) medians.debtEquity = round(deMed, 2);

  const sampleSize = Math.max(pe.length, grossMargin.length, opMargin.length, debtEquity.length);
  const entry: CacheEntry = { at: Date.now(), medians, sampleSize };
  CACHE.set(sector, entry);
  return { sector, medians, sampleSize, cached: false };
}

export function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Test seam — clears the in-process cache. */
export function _clearSectorMedianCache(): void {
  CACHE.clear();
}
