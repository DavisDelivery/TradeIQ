// Trade log — localStorage-backed journal of tracked trades.
// Each entry is a snapshot of what the user was looking at when they hit "Log Trade",
// so later we can evaluate "did the signal work?" at 5/20/30/60/90-day windows.

const KEY = 'tradeiq.tradeLog.v1';

export function readLog() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeLog(log) {
  try {
    localStorage.setItem(KEY, JSON.stringify(log));
    return true;
  } catch {
    return false;
  }
}

export function logTrade(entry) {
  const log = readLog();
  const enriched = {
    id: `${entry.ticker}-${entry.source}-${Date.now()}`,
    loggedAt: new Date().toISOString(),
    ...entry,
  };
  log.push(enriched);
  writeLog(log);
  return enriched;
}

export function removeTrade(id) {
  const log = readLog().filter((t) => t.id !== id);
  writeLog(log);
  return log;
}

export function isLogged(ticker, source) {
  return readLog().some((t) => t.ticker === ticker && t.source === source);
}

// Compute days between two ISO dates (can be negative if b is before a)
export function daysBetween(aIso, bIso) {
  return Math.round((new Date(bIso).getTime() - new Date(aIso).getTime()) / 86400000);
}

// Given a bars array (each {date, c}) and a log entry, compute forward returns.
// Windows: since logging, 5d, 20d, 30d, 60d, 90d — each returns {days, price, returnPct} or null.
export function computeForwardReturns(bars, loggedAt, loggedPrice) {
  if (!bars?.length || loggedPrice <= 0) return {};
  const windows = { since: null, fwd5: 5, fwd20: 20, fwd30: 30, fwd60: 60, fwd90: 90 };
  const out = {};
  const loggedTs = new Date(loggedAt).getTime();
  // Find index of first bar on-or-after logged date
  const baseIdx = bars.findIndex((b) => new Date(b.date).getTime() >= loggedTs);
  const basePrice = baseIdx >= 0 ? bars[baseIdx].c : loggedPrice;
  const latestBar = bars[bars.length - 1];
  const daysSinceLog = daysBetween(loggedAt, latestBar.date);

  for (const [key, days] of Object.entries(windows)) {
    if (key === 'since') {
      out[key] = {
        days: daysSinceLog,
        price: latestBar.c,
        returnPct: +(((latestBar.c - basePrice) / basePrice) * 100).toFixed(2),
      };
      continue;
    }
    // Find bar that is N trading days after baseIdx
    const targetIdx = baseIdx >= 0 ? baseIdx + days : -1;
    if (targetIdx < 0 || targetIdx >= bars.length) {
      out[key] = null; // not enough bars yet
      continue;
    }
    const targetBar = bars[targetIdx];
    out[key] = {
      days,
      price: targetBar.c,
      returnPct: +(((targetBar.c - basePrice) / basePrice) * 100).toFixed(2),
      date: targetBar.date,
    };
  }
  return out;
}
