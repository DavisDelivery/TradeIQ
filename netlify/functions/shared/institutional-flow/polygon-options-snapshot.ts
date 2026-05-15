// Phase 4f-finish — Minimal Polygon options snapshot fetcher.
//
// Pulls the full options chain for an underlying ticker via
// `/v3/snapshot/options/{ticker}` and shapes it into an
// `OptionsTickWindow` for `computeOptionsFlowSignal`.
//
// This is a deliberate minimum-viable fetcher: open-interest data
// flows immediately (so OI-spike detection works), while per-contract
// tick trades are deferred to a follow-up. Without per-contract trade
// ticks the sweep/block counts stay 0 and the unusual score is
// dominated by OI intensity. Real per-contract tick streaming is a
// separate piece of integration work (per-strike pagination at
// scale), tracked as Phase 4g.
//
// Previous-day OI for the spike comparison is sourced from the
// previous day's cached signal in Firestore at
// `institutionalFlow/largecap/{ticker}/{prev_date}.optionsFlow._oiToday`,
// snapshotted by the scan that day. On first run after deploy this is
// absent and oiSpikeStrikes lands at 0; subsequent days have
// previous-day data and the comparison is meaningful.
//
// All API errors are swallowed into a `warnings` channel matching the
// pattern in `polygon-trades.ts`. A null return means "no signal
// today" — callers should write the field as null and continue.

import type {
  OptionStrikeOI,
  OptionSide,
  OptionsTickWindow,
  PolygonOptionsTrade,
} from './types';

const POLYGON_BASE = 'https://api.polygon.io';
const SNAPSHOT_PAGE_LIMIT = 250;

function polygonKey(): string {
  const k = process.env.POLYGON_API_KEY;
  if (!k) throw new Error('POLYGON_API_KEY not set');
  return k;
}

interface PolygonOptionsSnapshotRow {
  details?: {
    strike_price?: number;
    expiration_date?: string;
    contract_type?: 'call' | 'put';
    ticker?: string;
  };
  open_interest?: number;
  day?: {
    volume?: number;
    vwap?: number;
    close?: number;
    last_updated?: number;
  };
  last_trade?: {
    sip_timestamp?: number;
    price?: number;
    size?: number;
  };
  last_quote?: {
    bid?: number;
    ask?: number;
  };
}

interface PolygonOptionsSnapshotResponse {
  results?: PolygonOptionsSnapshotRow[];
  next_url?: string;
}

export interface OptionsSnapshotResult {
  window: OptionsTickWindow;
  /** Map of `${expiry}|${strike}|${side}` → today's open interest. The
   *  scan writes this to Firestore so the next day's scan can read it
   *  back as the previous-day OI for the spike comparison. */
  oiToday: Record<string, number>;
  pagesFetched: number;
  warnings: string[];
}

function sideOf(contractType?: 'call' | 'put'): OptionSide | null {
  if (contractType === 'call') return 'C';
  if (contractType === 'put') return 'P';
  return null;
}

function oiKey(expiry: string, strike: number, side: OptionSide): string {
  return `${expiry}|${strike}|${side}`;
}

/**
 * Fetch the full options chain snapshot for `underlying` and build an
 * `OptionsTickWindow` consumable by `computeOptionsFlowSignal`.
 *
 * `prevOiByKey` is a map of yesterday's OI keyed by
 * `${expiry}|${strike}|${side}`, sourced from the previous day's
 * cached signal. When absent (first-day bootstrap), previous-day OI
 * defaults to today's OI so no spikes register.
 *
 * `maxPages` bounds Polygon pagination; the chain for a liquid
 * underlying can have ~5000+ strikes. We cap at 5 pages × 250 strikes
 * = 1250 contracts which covers the entire active chain for any
 * normal underlying without unbounded API spend.
 */
export async function getOptionsSnapshot(
  underlying: string,
  prevOiByKey: Record<string, number> = {},
  maxPages = 5,
): Promise<OptionsSnapshotResult> {
  const warnings: string[] = [];
  const oiToday: Record<string, number> = {};
  const oiArr: OptionStrikeOI[] = [];
  const trades: PolygonOptionsTrade[] = [];
  let pagesFetched = 0;
  let url: string | null =
    `${POLYGON_BASE}/v3/snapshot/options/${encodeURIComponent(underlying)}` +
    `?limit=${SNAPSHOT_PAGE_LIMIT}&apiKey=${polygonKey()}`;

  while (url && pagesFetched < maxPages) {
    const res = await fetch(url);
    if (!res.ok) {
      warnings.push(`polygon options snapshot ${underlying}: HTTP ${res.status}`);
      break;
    }
    const body = (await res.json()) as PolygonOptionsSnapshotResponse;
    if (Array.isArray(body.results)) {
      for (const row of body.results) {
        const strike = row.details?.strike_price;
        const expiry = row.details?.expiration_date;
        const side = sideOf(row.details?.contract_type);
        const oi = row.open_interest;
        if (strike == null || !expiry || side == null || oi == null) continue;

        const key = oiKey(expiry, strike, side);
        oiToday[key] = oi;
        oiArr.push({
          strike,
          side,
          expiry,
          openInterestToday: oi,
          openInterestPrev: prevOiByKey[key] ?? oi, // 0 spike on bootstrap
        });

        // Synthesize a single "last trade" per contract if Polygon
        // surfaced one. This is a thin proxy for full tick data — we
        // only see the last print, so sweep/block detection by
        // exchange-spread is impossible (exchanges field absent). The
        // signal layer treats absent `exchanges` as 1 (not a sweep)
        // and a single print at <$500K notional as not a block.
        const lt = row.last_trade;
        const lq = row.last_quote;
        if (lt?.sip_timestamp != null && lt.price != null && lt.size != null) {
          trades.push({
            t: Math.floor(lt.sip_timestamp / 1_000_000),
            p: lt.price,
            s: lt.size,
            bid: lq?.bid,
            ask: lq?.ask,
            // exchanges intentionally omitted — no sweep detection
            // possible from snapshot data
            side,
            strike,
            expiry,
          });
        }
      }
    }
    pagesFetched++;
    if (body.next_url) {
      url = body.next_url.includes('apiKey=')
        ? body.next_url
        : `${body.next_url}&apiKey=${polygonKey()}`;
    } else {
      url = null;
    }
  }

  return {
    window: { trades, openInterest: oiArr },
    oiToday,
    pagesFetched,
    warnings,
  };
}
