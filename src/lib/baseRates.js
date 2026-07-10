// DESK-1 W4 — base rates from CLOSED journal trades. Pure functions,
// no React, no I/O.
//
// The whole point of the Desk's right rail: YOUR measured record, by
// setup tag and by board, presented with the same honesty discipline as
// the board verdicts. A trade is CLOSED when it carries a recorded exit
// (exitPrice + exitAt); open positions never contaminate the base rates.
//
// Insufficient-sample gate: below MIN_SAMPLE (5) closed trades a group
// is flagged `insufficientSample: true` and the UI greys it — a 2-trade
// "100% win rate" is noise, never signal.

export const MIN_SAMPLE = 5;

/** A trade is closed when both exit fields are recorded and usable. */
export function isClosed(trade) {
  return !!trade
    && typeof trade.exitPrice === 'number' && Number.isFinite(trade.exitPrice)
    && !!trade.exitAt;
}

/** Entry price for return math — loggedPrice is the journal's entry. */
function entryPrice(trade) {
  const p = trade.loggedPrice ?? trade.entryPrice;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

/** Signed % return of a closed trade, or null when entry is unusable. */
export function tradeReturnPct(trade) {
  const entry = entryPrice(trade);
  if (entry == null || !isClosed(trade)) return null;
  return ((trade.exitPrice - entry) / entry) * 100;
}

/**
 * Compute a base-rate row from a list of CLOSED trades (the caller
 * groups; this measures). Returns null when no trade has usable math.
 *
 *   n            — closed trades with usable entry+exit
 *   winRate      — fraction (0..1) with return > 0
 *   avgWinPct    — mean return of winners (null when no winners)
 *   avgLossPct   — mean return of losers, negative (null when no losers)
 *   expectancy   — winRate*avgWin − lossRate*|avgLoss|  (pp per trade)
 *   lastTen      — 'W'/'L' strip, most recent first
 *   insufficientSample — n < MIN_SAMPLE
 */
export function computeBaseRate(trades) {
  const rets = [];
  for (const t of trades || []) {
    const r = tradeReturnPct(t);
    if (r != null) rets.push({ ret: r, exitAt: t.exitAt });
  }
  if (rets.length === 0) return null;

  const wins = rets.filter((x) => x.ret > 0);
  const losses = rets.filter((x) => x.ret <= 0);
  const n = rets.length;
  const winRate = wins.length / n;
  const lossRate = losses.length / n;
  const avgWinPct = wins.length > 0 ? mean(wins.map((x) => x.ret)) : null;
  const avgLossPct = losses.length > 0 ? mean(losses.map((x) => x.ret)) : null;

  // Expectancy in percentage points per trade. Missing sides contribute 0.
  const expectancy =
    winRate * (avgWinPct ?? 0) - lossRate * Math.abs(avgLossPct ?? 0);

  const lastTen = [...rets]
    .sort((a, b) => String(b.exitAt).localeCompare(String(a.exitAt)))
    .slice(0, 10)
    .map((x) => (x.ret > 0 ? 'W' : 'L'));

  return {
    n,
    winRate: round4(winRate),
    avgWinPct: avgWinPct != null ? round2(avgWinPct) : null,
    avgLossPct: avgLossPct != null ? round2(avgLossPct) : null,
    expectancy: round2(expectancy),
    lastTen,
    insufficientSample: n < MIN_SAMPLE,
  };
}

/** Group closed trades by a key extractor and compute a row per group. */
export function baseRatesBy(trades, keyFn, fallbackKey = '(untagged)') {
  const groups = new Map();
  for (const t of trades || []) {
    if (!isClosed(t)) continue;
    const key = keyFn(t) || fallbackKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const rows = [];
  for (const [key, group] of groups) {
    const rate = computeBaseRate(group);
    if (rate) rows.push({ key, ...rate });
  }
  // Meaningful samples first, then by expectancy.
  rows.sort((a, b) =>
    (a.insufficientSample === b.insufficientSample)
      ? b.expectancy - a.expectancy
      : (a.insufficientSample ? 1 : -1));
  return rows;
}

/** Base rates grouped by setup tag (only closed trades count). */
export function baseRatesBySetup(trades) {
  return baseRatesBy(trades, (t) => (t.setup ? String(t.setup).trim() : null));
}

/** Base rates grouped by board/source. */
export function baseRatesByBoard(trades) {
  return baseRatesBy(trades, (t) => t.source || null, '(unknown)');
}

/**
 * Dossier one-liner: your record on this ticker across closed trades.
 * Returns { n, winRate, netPct } or null when you've never closed a
 * trade on it. netPct is the SUM of per-trade returns (pp) — a simple,
 * honest "am I net up or down on this name".
 */
export function tickerRecord(trades, ticker) {
  const t = String(ticker || '').toUpperCase();
  const closed = (trades || []).filter((x) => x.ticker === t && isClosed(x));
  const rets = closed.map(tradeReturnPct).filter((r) => r != null);
  if (rets.length === 0) return null;
  const wins = rets.filter((r) => r > 0).length;
  return {
    n: rets.length,
    winRate: round4(wins / rets.length),
    netPct: round2(rets.reduce((a, b) => a + b, 0)),
  };
}

/**
 * R-multiple for an OPEN position: (mark − entry) / (entry − stop).
 * Only defined when a stop is recorded below the entry (long-side
 * convention — the journal is long-only today). Null otherwise.
 */
export function rMultiple(entry, stop, mark) {
  if (![entry, stop, mark].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const risk = entry - stop;
  if (risk <= 0) return null;
  return round2((mark - entry) / risk);
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
