// Phase 4f W4 — Institutional-flow shared types.
//
// Output shapes per the brief. All "signal" interfaces are designed
// to be cached in Firestore at
// `institutionalFlow/{universe}/{ticker}/{YYYY-MM-DD}` so the Target
// Board scoring functions can read them without re-fetching Polygon.

export interface DarkPoolSignal {
  ticker: string;
  asOfDate: string;
  darkPoolPct: number; // 0..1, fraction of total volume off-exchange
  darkPoolPct5dAvg: number;
  darkPoolPct30dAvg: number;
  zScore: number; // (today - 30d avg) / 30d stdev
  // Provenance: how many trades + sample window scanned for today's number.
  todayTrades: number;
  todayDarkTrades: number;
}

export interface OptionsFlowSignal {
  ticker: string;
  asOfDate: string;
  bullishPremium: number; // sum premium of bullish trades (calls bought, puts sold)
  bearishPremium: number; // sum premium of bearish trades
  netDirectionalPremium: number; // bullish - bearish
  sweepCount: number;
  blockCount: number;
  oiSpikeStrikes: number; // # of strikes with day-over-day OI increase > 50%
  unusualScore: number; // 0..100 composite
}

export interface BlockTradeSignal {
  ticker: string;
  asOfDate: string;
  blockCount: number;
  blockNotional: number;
  buySideEstimate: number; // notional at-or-above ask
  sellSideEstimate: number; // notional at-or-below bid
  buyMinusSell: number;
}

// --- Raw Polygon-shaped inputs that the pure compute functions consume.
//
// Defined here so the compute layer doesn't depend on the fetch
// implementation; tests can construct synthetic payloads without
// touching Polygon.

export interface PolygonTrade {
  /** Unix-ms timestamp. */
  t: number;
  /** Price. */
  p: number;
  /** Size (shares). */
  s: number;
  /** Exchange ID. TRF reporting venues: 4 (NYSE TRF), 6 (NASDAQ TRF), 7 (FINRA ADF). */
  x?: number;
  /** Condition codes. Off-exchange / dark print codes: 12, 14, 16, 37. */
  c?: number[];
}

export type OptionSide = 'C' | 'P';

export interface PolygonOptionsTrade {
  /** Unix-ms timestamp. */
  t: number;
  /** Premium per contract. */
  p: number;
  /** Number of contracts. */
  s: number;
  /** Bid at time of fill — used to detect at/above-ask aggression. */
  bid?: number;
  /** Ask at time of fill. */
  ask?: number;
  /** Number of distinct exchanges this fill spanned within ~100ms. */
  exchanges?: number;
  side: OptionSide;
  strike: number;
  expiry: string; // YYYY-MM-DD
}

export interface OptionStrikeOI {
  strike: number;
  side: OptionSide;
  expiry: string;
  /** Open interest as of asOfDate. */
  openInterestToday: number;
  /** Open interest 1 trading day prior. */
  openInterestPrev: number;
}

export interface OptionsTickWindow {
  trades: PolygonOptionsTrade[];
  openInterest: OptionStrikeOI[];
}

export interface PolygonTradesByDay {
  /** Map of YYYY-MM-DD → trades on that date. */
  byDate: Record<string, PolygonTrade[]>;
}
