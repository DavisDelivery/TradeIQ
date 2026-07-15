// VECTOR — pure event logic (no I/O). Backfills and live scans both call
// these; tests pin the semantics. Constants from vector-constants.ts.

import { E1, E2, HYGIENE } from './vector-constants';

// ---------------------------------------------------------------------
// E1 — SUE + agreement trigger
// ---------------------------------------------------------------------

/**
 * SUE = (EPS_q - EPS_{q-4}) / sigma of the last 8 seasonal differences.
 * `eps` is oldest->newest split-adjusted quarterly EPS ending at the
 * quarter being scored. Returns null when history is insufficient
 * (< 12 quarters per hygiene) or the seasonal-diff sigma is degenerate.
 */
export function computeSue(eps: number[]): number | null {
  if (eps.length < HYGIENE.minEpsQuarters) return null;
  const diffs: number[] = [];
  // Seasonal differences: EPS_i - EPS_{i-4}, for the last `seasonalDiffWindow`
  // differences available BEFORE the current quarter's own difference.
  for (let i = 4; i < eps.length; i++) diffs.push(eps[i] - eps[i - 4]);
  if (diffs.length < E1.seasonalDiffWindow) return null;
  const current = diffs[diffs.length - 1];
  const window = diffs.slice(-(E1.seasonalDiffWindow + 1), -1); // 8 diffs prior to current
  if (window.length < E1.seasonalDiffWindow) return null;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
  const sigma = Math.sqrt(variance);
  if (!Number.isFinite(sigma) || sigma < 1e-9) return null; // degenerate: flat history
  return +(current / sigma).toFixed(4);
}

/** Live display trigger ("agreement"): SUE, reaction, volumeShock all fire. */
export function e1Agreement(sue: number | null, reaction: number | null, volumeShock: number | null): boolean {
  return (
    sue != null && sue >= E1.trigger.minSue &&
    reaction != null && reaction >= E1.trigger.minReaction &&
    volumeShock != null && volumeShock >= E1.trigger.minVolumeShock
  );
}

/**
 * Event day d for a report on calendar day c: BMO => c; AMC (or unknown,
 * conservatively treated as AMC) => next trading day. `isTradingDay` lets
 * the caller supply the real calendar.
 */
export function resolveEventDay(
  reportDate: string,
  hour: 'bmo' | 'amc' | 'dmh' | '' | null,
  nextTradingDay: (d: string) => string,
  isTradingDay: (d: string) => boolean,
): string {
  const bmo = hour === 'bmo';
  if (bmo && isTradingDay(reportDate)) return reportDate;
  if (bmo) return nextTradingDay(reportDate);
  // AMC / during-market-hours / unknown => info fully public next session.
  return nextTradingDay(reportDate);
}

// ---------------------------------------------------------------------
// E2 — insider cluster in drawdown
// ---------------------------------------------------------------------

export interface InsiderTx {
  insiderName: string;
  /** 'P' open-market purchase, 'S' sale (others pre-filtered out) */
  code: 'P' | 'S';
  transactionDate: string; // YYYY-MM-DD
  filingDate: string; // YYYY-MM-DD
  dollars: number; // abs value of shares * price
  isOfficerOrDirector: boolean;
}

/** Qualifying purchase per design (>= $25k, P, officer/director, file lag <= 30d). */
export function qualifiesE2(tx: InsiderTx): boolean {
  if (tx.code !== 'P' || !tx.isOfficerOrDirector) return false;
  if (tx.dollars < E2.minPurchaseDollars) return false;
  const lagDays = (Date.parse(tx.filingDate) - Date.parse(tx.transactionDate)) / 86_400_000;
  return lagDays >= 0 && lagDays <= E2.maxFileLagDays;
}

/**
 * Routine screen (Cohen-Malloy-Pomorski): an insider is ROUTINE if they
 * purchased in the same calendar month in >= N consecutive prior years.
 * `history` is the insider's full purchase history (any size).
 * mode 'full' => N = 3; 'reduced' => N = 2 (rate-limit fallback, callers
 * must flag routineScreen:'reduced' on the event).
 */
export function isRoutineInsider(
  purchaseDate: string,
  history: { transactionDate: string }[],
  mode: 'full' | 'reduced' = 'full',
): boolean {
  const need =
    mode === 'full' ? E2.routineScreen.fullConsecutiveYears : E2.routineScreen.reducedConsecutiveYears;
  const [y, m] = purchaseDate.split('-').map(Number);
  const monthsWithBuys = new Set(
    history.map((h) => h.transactionDate.slice(0, 7)), // YYYY-MM
  );
  for (let k = 1; k <= need; k++) {
    const yy = y - k;
    const key = `${yy}-${String(m).padStart(2, '0')}`;
    if (!monthsWithBuys.has(key)) return false;
  }
  return true;
}

export interface ClusterEvent {
  /** filing date the 2nd distinct qualifying buyer appeared */
  date: string;
  buyers: string[];
  aggregateDollars: number;
}

/**
 * Cluster detector: walk qualifying purchases in filing-date order; an
 * event fires on the filing date the 2nd distinct buyer appears within
 * the trailing 90d window. Consecutive firings for the same running
 * cluster are collapsed — a new event needs the window to first drop
 * back below 2 distinct buyers. The drawdown gate (close <= 0.80 x 52w
 * high) is applied by the CALLER, which has the price series.
 */
export function detectClusters(qualifying: InsiderTx[]): ClusterEvent[] {
  const txs = [...qualifying].sort((a, b) => a.filingDate.localeCompare(b.filingDate));
  const events: ClusterEvent[] = [];
  let inCluster = false;
  for (let i = 0; i < txs.length; i++) {
    const t = txs[i];
    const windowStart = Date.parse(t.filingDate) - E2.clusterWindowDays * 86_400_000;
    const window = txs.filter(
      (x) => Date.parse(x.filingDate) >= windowStart && x.filingDate <= t.filingDate,
    );
    const distinct = new Set(window.map((x) => x.insiderName.toLowerCase()));
    if (distinct.size >= E2.minDistinctBuyers) {
      if (!inCluster) {
        events.push({
          date: t.filingDate,
          buyers: [...distinct],
          aggregateDollars: window.reduce((a, x) => a + x.dollars, 0),
        });
        inCluster = true;
      }
    } else {
      inCluster = false;
    }
  }
  return events;
}

/** Sell-cluster context: >= 2 distinct sellers, >= $1M aggregate, trailing 90d of `atDate`. */
export function sellClusterActive(sells: InsiderTx[], atDate: string): boolean {
  const start = Date.parse(atDate) - E2.sellCluster.windowDays * 86_400_000;
  const window = sells.filter(
    (s) => s.code === 'S' && Date.parse(s.filingDate) >= start && s.filingDate <= atDate,
  );
  const distinct = new Set(window.map((s) => s.insiderName.toLowerCase()));
  const agg = window.reduce((a, s) => a + s.dollars, 0);
  return distinct.size >= E2.sellCluster.minDistinctSellers && agg >= E2.sellCluster.minAggregateDollars;
}

// ---------------------------------------------------------------------
// E3 — SC 13D initial filings from EDGAR daily form indexes
// ---------------------------------------------------------------------

export interface Sc13dFiling {
  cik: string; // subject/filer CIK as found (10-digit padded)
  company: string;
  dateFiled: string; // YYYY-MM-DD
  path: string; // edgar archive path
}

/**
 * Parse an EDGAR daily form.idx file, returning INITIAL SC 13D rows only
 * (amendments "SC 13D/A" excluded). The .idx format is fixed-width-ish
 * but reliably splittable on 2+ spaces:
 *   Form Type   Company Name   CIK   Date Filed   File Name
 */
export function parseSc13dIndex(idxText: string): Sc13dFiling[] {
  const out: Sc13dFiling[] = [];
  for (const line of idxText.split('\n')) {
    if (!line.startsWith('SC 13D')) continue;
    const cols = line.trimEnd().split(/\s{2,}/);
    if (cols.length < 5) continue;
    const [form, company, cik, dateFiled, path] = cols;
    if (form.trim() !== 'SC 13D') continue; // excludes SC 13D/A
    const iso = /^\d{8}$/.test(dateFiled)
      ? `${dateFiled.slice(0, 4)}-${dateFiled.slice(4, 6)}-${dateFiled.slice(6, 8)}`
      : dateFiled;
    out.push({
      cik: cik.padStart(10, '0'),
      company: company.trim(),
      dateFiled: iso,
      path: path.trim(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Calendar helpers (month-ends for the PIT universe snapshots)
// ---------------------------------------------------------------------

/** Calendar month-end dates (YYYY-MM-DD) inclusive of both bounds' months. */
export function monthEnds(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m === 12 ? (y++, (m = 1)) : m++) {
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push(`${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`);
  }
  return out;
}
