// FORWARD TEST — the boards' live track record (Chad's call, 2026-07-23:
// "log everything that makes a board's top 20, track it for a year, rank
// the boards by real profitability — forward-test them all").
//
// Design: a COHORT LOG, not a portfolio sim. The night a ticker first
// cracks a board's top-N, we log an entry pinned to that day's OFFICIAL
// close (Polygon grouped daily — same source for every board, so no
// per-board price semantics leak in). From then on the nightly job marks
// every open pick to the latest close and FREEZES its return at fixed
// horizons (1w / 1m / 3m / 6m / 1y), each alongside SPY over the same
// window → alpha. After the 1y horizon freezes, the pick matures and
// stops updating. The league table ranks boards on what their picks
// actually did — a forward test the boards cannot retroactively game,
// because entries are written the day they happen and never edited.
//
// Anti-cheat invariants:
//   - Entry price is the close of the entry day (no intraday hindsight).
//   - An entry doc's identity fields are never rewritten; evaluation only
//     appends marks/frozen horizons.
//   - A ticker re-entering after maturing gets a NEW entry (new date id) —
//     re-listing is a fresh call, and it's scored as one.

import { getAdminDb } from './firebase-admin';
import { getGroupedDaily } from './vector-data';
import { latestSnapshot, type BoardName, type UniverseKey } from './snapshot-store';
import type { Logger } from './logger';

export const FORWARD_COLLECTION = 'forwardPicks';
export const LEAGUE_DOC_ID = '_league';
export const HORIZONS_DAYS = [7, 30, 90, 180, 365] as const;
export type HorizonKey = 'd7' | 'd30' | 'd90' | 'd180' | 'd365';
const HORIZON_KEYS: Record<number, HorizonKey> = { 7: 'd7', 30: 'd30', 90: 'd90', 180: 'd180', 365: 'd365' };
const BENCH = 'SPY';

// Which (board, universe) cohorts we track, and how the top-N is read.
// `filter` drops rows whose implied trade isn't "buy" (a death cross or a
// bearish sentiment row in a top-20 slice would poison a LONG cohort).
export interface ForwardBoardConfig {
  board: BoardName;
  universe: UniverseKey; // the board's primary snapshot key
  take: number;
  filter?: (row: any) => boolean;
}

export const FORWARD_BOARDS: ForwardBoardConfig[] = [
  { board: 'target-board', universe: 'sp500', take: 20 },
  { board: 'prophet', universe: 'largecap', take: 20 },
  { board: 'catalyst', universe: 'sp500', take: 20 },
  { board: 'insider', universe: 'sp500', take: 20 }, // stored buyDollars desc → buyers
  { board: 'williams', universe: 'sp500', take: 20 },
  { board: 'lynch', universe: 'sp500', take: 20 },
  { board: 'earnings', universe: 'all', take: 20 },
  { board: 'fable', universe: 'sp500', take: 20 },
  { board: 'crosses', universe: 'sp500', take: 20, filter: (r) => r?.type === 'golden' },
  { board: 'trident', universe: 'sp500', take: 20 },
  { board: 'sentiment', universe: 'sp500', take: 20, filter: (r) => r?.label === 'bullish' },
];

export interface HorizonReturn {
  pct: number; // pick return over the horizon, percent
  spyPct: number; // SPY over the same window, percent
  alpha: number; // pct - spyPct
  frozenAt: string; // YYYY-MM-DD the horizon was frozen (first close ≥ horizon)
}

export interface ForwardPick {
  board: string;
  universe: string;
  ticker: string;
  entryDate: string; // YYYY-MM-DD (ET trading day)
  entryPrice: number; // official close of entryDate
  spyEntry: number; // SPY close of entryDate
  rankAtEntry: number; // 1-based position in the board's top-N that day
  scoreAtEntry: number | null; // board-native score if the row carries one
  status: 'open' | 'matured';
  daysOnBoard: number; // trading days the ticker stayed in the top-N
  lastSeenDate: string;
  lastPrice: number;
  lastPriceDate: string;
  currentPct: number; // unrealized return since entry, percent
  currentAlpha: number; // vs SPY since entry
  returns: Partial<Record<HorizonKey, HorizonReturn>>;
}

export const pickId = (p: { board: string; universe: string; ticker: string; entryDate: string }) =>
  `${p.board}-${p.universe}-${p.ticker}-${p.entryDate}`;

const pct = (now: number, then: number) => ((now - then) / then) * 100;
const round2 = (v: number) => Math.round(v * 100) / 100;

export const daysBetween = (fromYmd: string, toYmd: string) =>
  Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / 86_400_000);

/** Today's date in America/New_York as YYYY-MM-DD (the trading date the
 *  00:20 UTC run evaluates — still the prior ET evening). */
export function etTradingDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

/** Board-native score, best-effort across the boards' differing row shapes. */
export function extractScore(row: any): number | null {
  for (const k of ['composite', 'percentile', 'score', 'confidence', 'netDollars']) {
    const v = row?.[k];
    if (Number.isFinite(v)) return Number(v);
  }
  return null;
}

/** The top-N buy-side tickers of a snapshot, in stored (ranked) order. */
export function extractTopN(
  results: any[],
  cfg: ForwardBoardConfig,
): Array<{ ticker: string; rank: number; score: number | null }> {
  const out: Array<{ ticker: string; rank: number; score: number | null }> = [];
  const seen = new Set<string>();
  for (const row of results) {
    if (out.length >= cfg.take) break;
    const ticker = typeof row?.ticker === 'string' ? row.ticker.toUpperCase() : null;
    if (!ticker || seen.has(ticker)) continue;
    if (cfg.filter && !cfg.filter(row)) continue;
    seen.add(ticker);
    out.push({ ticker, rank: out.length + 1, score: extractScore(row) });
  }
  return out;
}

/** Pure evaluation step: mark an open pick to today's close and freeze any
 *  horizons that have come due. Returns the updated pick (same object shape;
 *  identity fields untouched) and whether anything changed. */
export function evaluatePick(
  pick: ForwardPick,
  closeByTicker: Map<string, number>,
  spyClose: number,
  evalDate: string,
): { pick: ForwardPick; changed: boolean } {
  const close = closeByTicker.get(pick.ticker);
  if (!Number.isFinite(close) || !Number.isFinite(spyClose)) return { pick, changed: false };
  const elapsed = daysBetween(pick.entryDate, evalDate);
  const next: ForwardPick = {
    ...pick,
    lastPrice: close!,
    lastPriceDate: evalDate,
    currentPct: round2(pct(close!, pick.entryPrice)),
    currentAlpha: round2(pct(close!, pick.entryPrice) - pct(spyClose, pick.spyEntry)),
    returns: { ...pick.returns },
  };
  for (const h of HORIZONS_DAYS) {
    const key = HORIZON_KEYS[h];
    if (next.returns[key]) continue;
    if (elapsed < h) continue;
    const p = pct(close!, pick.entryPrice);
    const s = pct(spyClose, pick.spyEntry);
    next.returns[key] = { pct: round2(p), spyPct: round2(s), alpha: round2(p - s), frozenAt: evalDate };
  }
  if (next.returns.d365) next.status = 'matured';
  return { pick: next, changed: true };
}

// ---------------------------------------------------------------------------
// League table — per-board aggregates over the cohort.
// ---------------------------------------------------------------------------

export interface LeagueHorizonStats {
  n: number;
  winRate: number; // % of picks positive
  avgPct: number;
  medianPct: number;
  avgAlpha: number;
  alphaWinRate: number; // % of picks beating SPY
}

export interface LeagueRow {
  board: string;
  universe: string;
  totalPicks: number;
  openPicks: number;
  maturedPicks: number;
  openAvgPct: number | null;
  openAvgAlpha: number | null;
  horizons: Partial<Record<HorizonKey, LeagueHorizonStats>>;
  /** Ranking basis: avg alpha at the LONGEST horizon with n ≥ 5; falls back
   *  to the open cohort's unrealized alpha (flagged provisional). */
  rankScore: number | null;
  rankBasis: string;
  provisional: boolean;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function buildLeague(picks: ForwardPick[]): LeagueRow[] {
  const byBoard = new Map<string, ForwardPick[]>();
  for (const p of picks) {
    const k = `${p.board}|${p.universe}`;
    const arr = byBoard.get(k) ?? [];
    arr.push(p);
    byBoard.set(k, arr);
  }
  const rows: LeagueRow[] = [];
  for (const [k, ps] of byBoard) {
    const [board, universe] = k.split('|');
    const open = ps.filter((p) => p.status === 'open');
    const horizons: LeagueRow['horizons'] = {};
    for (const h of HORIZONS_DAYS) {
      const key = HORIZON_KEYS[h];
      const done = ps.filter((p) => p.returns[key]);
      if (done.length === 0) continue;
      const rets = done.map((p) => p.returns[key]!.pct);
      const alphas = done.map((p) => p.returns[key]!.alpha);
      horizons[key] = {
        n: done.length,
        winRate: round2((rets.filter((r) => r > 0).length / rets.length) * 100),
        avgPct: round2(mean(rets)),
        medianPct: round2(median(rets)),
        avgAlpha: round2(mean(alphas)),
        alphaWinRate: round2((alphas.filter((a) => a > 0).length / alphas.length) * 100),
      };
    }
    // Rank on the longest matured horizon with a real sample.
    let rankScore: number | null = null;
    let rankBasis = 'insufficient data';
    let provisional = true;
    for (const h of [...HORIZONS_DAYS].reverse()) {
      const key = HORIZON_KEYS[h];
      const st = horizons[key];
      if (st && st.n >= 5) {
        rankScore = st.avgAlpha;
        rankBasis = `avg alpha @ ${h}d (n=${st.n})`;
        provisional = h < 90;
        break;
      }
    }
    if (rankScore === null && open.length > 0) {
      rankScore = round2(mean(open.map((p) => p.currentAlpha)));
      rankBasis = `unrealized alpha, open cohort (n=${open.length})`;
      provisional = true;
    }
    rows.push({
      board,
      universe,
      totalPicks: ps.length,
      openPicks: open.length,
      maturedPicks: ps.filter((p) => p.status === 'matured').length,
      openAvgPct: open.length ? round2(mean(open.map((p) => p.currentPct))) : null,
      openAvgAlpha: open.length ? round2(mean(open.map((p) => p.currentAlpha))) : null,
      horizons,
      rankScore,
      rankBasis,
      provisional,
    });
  }
  rows.sort((a, b) => (b.rankScore ?? -Infinity) - (a.rankScore ?? -Infinity));
  return rows;
}

// ---------------------------------------------------------------------------
// Nightly run: capture new top-N entries + evaluate all open picks.
// ---------------------------------------------------------------------------

export interface ForwardRunReport {
  evalDate: string;
  tradingDay: boolean;
  captured: number;
  seenStillOnBoard: number;
  evaluated: number;
  matured: number;
  skippedNoPrice: string[];
  boardsMissingSnapshot: string[];
  leagueBoards: number;
}

export async function runForwardTestNightly(log: Logger, now = new Date()): Promise<ForwardRunReport> {
  const db = getAdminDb();
  const evalDate = etTradingDate(now);

  // One grouped-daily call covers every ticker AND the SPY benchmark.
  const grouped = await getGroupedDaily(evalDate);
  if (grouped.length === 0) {
    log.info('non_trading_day', { evalDate });
    return {
      evalDate, tradingDay: false, captured: 0, seenStillOnBoard: 0, evaluated: 0,
      matured: 0, skippedNoPrice: [], boardsMissingSnapshot: [], leagueBoards: 0,
    };
  }
  const closeByTicker = new Map<string, number>(grouped.map((r) => [r.T.toUpperCase(), r.c]));
  const spyClose = closeByTicker.get(BENCH);
  if (!Number.isFinite(spyClose)) throw new Error(`benchmark ${BENCH} missing from grouped daily ${evalDate}`);

  // Load every open pick once (capture idempotency + evaluation share it).
  const openSnap = await db.collection(FORWARD_COLLECTION).where('status', '==', 'open').get();
  const openPicks = openSnap.docs
    .filter((d) => d.id !== LEAGUE_DOC_ID)
    .map((d) => d.data() as ForwardPick);
  const openByKey = new Map(openPicks.map((p) => [`${p.board}|${p.universe}|${p.ticker}`, p]));

  const skippedNoPrice: string[] = [];
  const boardsMissingSnapshot: string[] = [];
  let captured = 0;
  let seenStillOnBoard = 0;

  const writer = db.bulkWriter();

  // CAPTURE — read each board's latest snapshot, log new top-N entrants.
  for (const cfg of FORWARD_BOARDS) {
    let snap;
    try {
      snap = await latestSnapshot(cfg.board, cfg.universe);
    } catch {
      snap = null;
    }
    if (!snap || !Array.isArray(snap.results)) {
      boardsMissingSnapshot.push(`${cfg.board}/${cfg.universe}`);
      continue;
    }
    const top = extractTopN(snap.results as any[], cfg);
    for (const t of top) {
      const key = `${cfg.board}|${cfg.universe}|${t.ticker}`;
      const existing = openByKey.get(key);
      if (existing) {
        // Still on the board — bump the conviction counter.
        existing.daysOnBoard += 1;
        existing.lastSeenDate = evalDate;
        seenStillOnBoard += 1;
        continue; // evaluation below persists the updated doc
      }
      const close = closeByTicker.get(t.ticker);
      if (!Number.isFinite(close)) {
        skippedNoPrice.push(`${cfg.board}:${t.ticker}`);
        continue;
      }
      const pick: ForwardPick = {
        board: cfg.board,
        universe: cfg.universe,
        ticker: t.ticker,
        entryDate: evalDate,
        entryPrice: close!,
        spyEntry: spyClose!,
        rankAtEntry: t.rank,
        scoreAtEntry: t.score,
        status: 'open',
        daysOnBoard: 1,
        lastSeenDate: evalDate,
        lastPrice: close!,
        lastPriceDate: evalDate,
        currentPct: 0,
        currentAlpha: 0,
        returns: {},
      };
      writer.set(db.collection(FORWARD_COLLECTION).doc(pickId(pick)), pick);
      openByKey.set(key, pick);
      openPicks.push(pick);
      captured += 1;
    }
  }

  // EVALUATE — mark every open pick, freeze due horizons.
  let evaluated = 0;
  let matured = 0;
  for (const p of openPicks) {
    if (p.entryDate === evalDate && p.daysOnBoard === 1 && p.lastPriceDate === evalDate && p.currentPct === 0) {
      // Brand-new entry captured above — already at today's close.
      continue;
    }
    const { pick: next, changed } = evaluatePick(p, closeByTicker, spyClose!, evalDate);
    if (!changed) continue;
    writer.set(db.collection(FORWARD_COLLECTION).doc(pickId(next)), next, { merge: true });
    evaluated += 1;
    if (next.status === 'matured') matured += 1;
  }

  await writer.close();

  // LEAGUE — recompute over the FULL cohort (open + matured) and store it so
  // the endpoint is a single-doc read.
  const allSnap = await db.collection(FORWARD_COLLECTION).get();
  const allPicks = allSnap.docs
    .filter((d) => d.id !== LEAGUE_DOC_ID)
    .map((d) => d.data() as ForwardPick);
  const league = buildLeague(allPicks);
  await db.collection(FORWARD_COLLECTION).doc(LEAGUE_DOC_ID).set({
    updatedAt: new Date().toISOString(),
    evalDate,
    totalPicks: allPicks.length,
    rows: league,
  });

  const report: ForwardRunReport = {
    evalDate,
    tradingDay: true,
    captured,
    seenStillOnBoard,
    evaluated,
    matured,
    skippedNoPrice: skippedNoPrice.slice(0, 20),
    boardsMissingSnapshot,
    leagueBoards: league.length,
  };
  log.info('forward_test_run_complete', report as any);
  return report;
}
