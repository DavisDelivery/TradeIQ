// FVZ-6 — nightly screen snapshots, so the forward-test league can measure
// these strategies on OUR data instead of on their authors' claims.
//
// This is the whole point of shipping other people's screens. Two of the
// thirteen are graded 'anecdotal' (Minervini, Qullamaggie — famous, never
// independently backtested) and one is graded 'contrary' (short squeeze —
// the published literature says high short interest predicts NEGATIVE
// returns). Rendering them in a tab proves nothing. Freezing their top
// names nightly and marking them against SPY over d7/d30/d90/d180/d365
// is what turns a claim into evidence.
//
// SHAPE: one snapshot per screen, written as board 'screens' with the
// SCREEN ID as the universe. That reuses the existing per-(board,universe)
// snapshot machinery untouched, and forward-test.ts picks each screen up as
// its own cohort — so the league ranks screens against each other and
// against our own boards on identical terms.

import { getFinvizUniverseSnapshot, fetchFinvizScreener, FINVIZ_UNIVERSE_FILTERS } from './finviz';
import { SCREENS, applyScreen, type ScreenDef } from './finviz-screens';
import type { FinvizRow } from './finviz';

export interface ScreenScanRow {
  ticker: string;
  sector: string | null;
  price: number | null;
  marketCapM: number | null;
  /** Rank position at capture time, 1-based — the forward test reads order. */
  rank: number;
  changePct: number | null;
  perfYearPct: number | null;
  high52wDistPct: number | null;
  rsi14: number | null;
  pe: number | null;
}

export interface ScreenScanResult {
  screenId: string;
  screenName: string;
  evidence: string;
  universe: string;
  rows: ScreenScanRow[];
  universeChecked: number;
  warnings: string[];
}

const slim = (r: FinvizRow, i: number): ScreenScanRow => ({
  ticker: r.ticker,
  sector: r.sector,
  price: r.price,
  marketCapM: r.marketCapM,
  rank: i + 1,
  changePct: r.changePct,
  perfYearPct: r.perfYearPct,
  high52wDistPct: r.high52wDistPct,
  rsi14: r.rsi14,
  pe: r.pe,
});

/**
 * Run one screen against the universe it is defined over.
 *
 * Returns null on an upstream failure so the caller can SKIP the write:
 * publishing an empty snapshot would enter zero picks for that night and
 * silently corrupt the screen's forward-test record with a phantom "no
 * candidates" day. An empty result from a healthy fetch is different — that
 * IS the answer, and it publishes.
 */
export async function runScreenScan(screen: ScreenDef): Promise<ScreenScanResult | null> {
  const universe = screen.preferredUniverse ?? 'sp500';
  const warnings: string[] = [];

  let rows: FinvizRow[];
  if (screen.filters.length > 0) {
    const res = await fetchFinvizScreener([FINVIZ_UNIVERSE_FILTERS[universe], ...screen.filters]);
    if (res === null) return null;
    rows = res.rows;
    if (res.missingHeaders.length > 0) {
      warnings.push(`finviz schema drift: missing ${res.missingHeaders.join(', ')}`);
    }
  } else {
    const snap = await getFinvizUniverseSnapshot(universe);
    if (snap === null) return null;
    rows = snap.rows;
    if (snap.missingHeaders.length > 0) {
      warnings.push(`finviz schema drift: missing ${snap.missingHeaders.join(', ')}`);
    }
  }

  const result = applyScreen(screen, rows);
  if (result.rows.length === 0) {
    // Legitimate — an oversold screen SHOULD be empty in a melt-up — but
    // worth recording so a screen that goes permanently empty is visible
    // rather than looking like a quiet success.
    warnings.push(`no matches (${result.universeChecked} scanned)`);
  }

  return {
    screenId: screen.id,
    screenName: screen.name,
    evidence: screen.evidence,
    universe,
    rows: result.rows.map(slim),
    universeChecked: result.universeChecked,
    warnings,
  };
}

/** Every screen, run in sequence so the shared Finviz bucket paces them. */
export async function runAllScreenScans(): Promise<{
  results: ScreenScanResult[];
  failed: string[];
}> {
  const results: ScreenScanResult[] = [];
  const failed: string[] = [];
  for (const screen of SCREENS) {
    const res = await runScreenScan(screen).catch(() => null);
    if (res === null) failed.push(screen.id);
    else results.push(res);
  }
  return { results, failed };
}
