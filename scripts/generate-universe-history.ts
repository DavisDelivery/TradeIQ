#!/usr/bin/env node
/**
 * One-shot generator for `netlify/functions/shared/universe-history.ts`.
 *
 * Sources are ETF sponsors as vendors of record. Each fund is contractually
 * obligated to track its index for billions in AUM, so its published
 * holdings are the closest thing to authoritative free constituent data:
 *
 *   - SPY  (State Street SSGA)  → S&P 500          [xlsx]
 *   - DIA  (State Street SSGA)  → Dow Jones Indl.  [xlsx, current only]
 *   - QQQ  (Invesco)            → NASDAQ-100       [blocked from this env]
 *   - IWM  (iShares BlackRock)  → Russell 2000     [csv, asOfDate supported]
 *
 * Wikipedia was the prior source. It is not an acceptable source for a
 * trading app — no SLA, anyone can edit, parse fragility, no audit
 * trail, indefensible in compliance review. The Wikipedia code paths
 * have been ripped out and must not be re-added.
 *
 * Historical depth varies per sponsor — current SSGA (SPY/DIA) does
 * NOT honor asOfDate; iShares does. The Dow hand-curated history from
 * documented index changes is preserved as the deep-history source for
 * that index, supplemented by the current SSGA DIA snapshot.
 *
 * Usage:
 *   npx tsx scripts/generate-universe-history.ts
 *
 * Re-run cadence: monthly. Add to the maintenance calendar.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const OUT_FILE = join(REPO_ROOT, 'netlify/functions/shared/universe-history.ts');

// xlsx is a CJS module; load it via createRequire so this script stays ESM.
const require = createRequire(import.meta.url);
const XLSX = require('xlsx') as typeof import('xlsx');

const UA = 'Mozilla/5.0 (TradeIQ/0.12 chad@davisdelivery.com universe-history)';

type Index = 'sp500' | 'ndx' | 'dow' | 'russell2k';

interface Snapshot {
  date: string;            // YYYY-MM-DD month-end
  index: Index;
  tickers: string[];       // sorted alphabetically
}

// ===========================================================================
// Source: iShares IWM — Russell 2000
//
// Real CSV with historical asOfDate support. Verified depth: 2022-01-31
// onwards via asOfDate=YYYYMMDD. Pre-2022 returns no-data wrapper.
// ===========================================================================

const IWM_URL = 'https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/1467271812596.ajax';

async function fetchIwmHoldingsCsv(asOfDate?: string): Promise<string[]> {
  const params = new URLSearchParams({
    fileType: 'csv',
    fileName: 'IWM_holdings',
    dataType: 'fund',
  });
  if (asOfDate) {
    // YYYYMMDD form. iShares silently returns a no-data wrapper for dates
    // before its earliest archive — we detect that case in the parser.
    params.set('asOfDate', asOfDate.replace(/-/g, ''));
  }
  const url = `${IWM_URL}?${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/csv' } });
  if (!res.ok) throw new Error(`iShares IWM ${res.status}`);
  const csv = await res.text();
  return parseIwmCsv(csv);
}

function parseIwmCsv(csv: string): string[] {
  const lines = csv.split(/\r?\n/);
  // First ~10 lines are fund metadata; the holdings header line starts
  // with "Ticker,Name,Sector,...". Find it.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (lines[i].startsWith('Ticker,Name,')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    // No-data wrapper (returned for pre-archive dates).
    return [];
  }
  const tickers: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.startsWith('"')) break;       // end of holdings block
    const m = line.match(/^"([^"]*)"/);
    if (!m) continue;
    const t = m[1].trim();
    if (!t || t === '-') continue;
    if (/[^A-Z0-9.\-]/.test(t)) continue;             // skip cash sleeves etc
    if (t.length > 6) continue;                        // not a plain US equity ticker
    tickers.push(t);
  }
  return tickers;
}

// ===========================================================================
// Source: SSGA SPY — S&P 500 (current only)
// Source: SSGA DIA — Dow Jones Industrial Average (current only)
//
// SSGA's holdings-daily xlsx download silently ignores asOfDate and
// returns current. Verified at audit time. No public historical archive.
// ===========================================================================

const SPY_XLSX = 'https://www.ssga.com/us/en/individual/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx';
const DIA_XLSX = 'https://www.ssga.com/us/en/individual/library-content/products/fund-data/etfs/us/holdings-daily-us-en-dia.xlsx';

async function fetchSsgaHoldingsXlsx(url: string): Promise<{ tickers: string[]; asOfDate: string }> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/octet-stream' } });
  if (!res.ok) throw new Error(`SSGA ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });

  // SSGA format:
  //   row 0:  ["Fund Name:", "...", null, ...]
  //   row 2:  ["Holdings:", "As of 07-May-2026", ...]
  //   row 4:  ["Name", "Ticker", "Identifier", "SEDOL", "Weight", ...]
  //   row 5+: data
  let asOfDate = '';
  for (const r of rows) {
    const cell0 = (r[0] ?? '').toString();
    const cell1 = (r[1] ?? '').toString();
    if (cell0.startsWith('Holdings:')) {
      const m = cell1.match(/As of (\d{2})-([A-Za-z]{3})-(\d{4})/);
      if (m) {
        const months: Record<string, string> = {
          Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
          Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
        };
        asOfDate = `${m[3]}-${months[m[2]]}-${m[1]}`;
      }
      break;
    }
  }
  if (!asOfDate) asOfDate = new Date().toISOString().slice(0, 10);

  let headerIdx = -1;
  let tickerCol = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map((c) => (c ?? '').toString());
    const tc = cells.indexOf('Ticker');
    if (tc >= 0) {
      headerIdx = i;
      tickerCol = tc;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('SSGA xlsx: no Ticker column found');

  const tickers: string[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cell = rows[i][tickerCol];
    if (cell === null || cell === undefined || cell === '') break;
    const t = String(cell).trim();
    if (!t) continue;
    if (/^(CASH|USD|MM_FUND|FUTURE)/i.test(t)) continue;
    if (t.length > 6) continue;
    if (!/^[A-Z][A-Z0-9.\-]*$/.test(t)) continue;
    tickers.push(t);
  }
  return { tickers, asOfDate };
}

async function fetchSpyHoldings(): Promise<{ tickers: string[]; asOfDate: string }> {
  return fetchSsgaHoldingsXlsx(SPY_XLSX);
}

async function fetchDiaHoldings(): Promise<{ tickers: string[]; asOfDate: string }> {
  return fetchSsgaHoldingsXlsx(DIA_XLSX);
}

// ===========================================================================
// Hand-curated Dow history
//
// Documented index changes preserved from the prior universe-history.ts.
// SSGA DIA only provides current; the deep history below comes from
// publicly documented Dow Jones index reconstitutions.
//
//   2024-11-08  NVDA replaces INTC; SHW replaces DOW
//   2024-02-26  AMZN replaces WBA
//   2020-08-31  AMGN, HON, CRM added; XOM, PFE, RTX removed
//   2019-04-02  Dow Inc replaced DowDuPont (DWDP → DOW)
//   2018-06-26  WBA replaces GE
// ===========================================================================

const DOW_SEGMENTS: { from: string; tickers: string[] }[] = [
  {
    from: '2018-01-31',
    tickers: [
      'AAPL','AXP','BA','CAT','CSCO','CVX','DIS','DWDP','GE','GS',
      'HD','IBM','INTC','JNJ','JPM','KO','MCD','MMM','MRK','MSFT',
      'NKE','PFE','PG','RTX','TRV','UNH','V','VZ','WMT','XOM',
    ],
  },
  {
    from: '2018-06-26',
    tickers: [
      'AAPL','AXP','BA','CAT','CSCO','CVX','DIS','DWDP','GS','HD',
      'IBM','INTC','JNJ','JPM','KO','MCD','MMM','MRK','MSFT','NKE',
      'PFE','PG','RTX','TRV','UNH','V','VZ','WBA','WMT','XOM',
    ],
  },
  {
    from: '2019-04-02',
    tickers: [
      'AAPL','AXP','BA','CAT','CSCO','CVX','DIS','DOW','GS','HD',
      'IBM','INTC','JNJ','JPM','KO','MCD','MMM','MRK','MSFT','NKE',
      'PFE','PG','RTX','TRV','UNH','V','VZ','WBA','WMT','XOM',
    ],
  },
  {
    from: '2020-08-31',
    tickers: [
      'AAPL','AMGN','AXP','BA','CAT','CRM','CSCO','CVX','DIS','DOW',
      'GS','HD','HON','IBM','INTC','JNJ','JPM','KO','MCD','MMM',
      'MRK','MSFT','NKE','PG','TRV','UNH','V','VZ','WBA','WMT',
    ],
  },
  {
    from: '2024-02-26',
    tickers: [
      'AAPL','AMGN','AMZN','AXP','BA','CAT','CRM','CSCO','CVX','DIS',
      'DOW','GS','HD','HON','IBM','INTC','JNJ','JPM','KO','MCD',
      'MMM','MRK','MSFT','NKE','PG','TRV','UNH','V','VZ','WMT',
    ],
  },
  {
    from: '2024-11-08',
    tickers: [
      'AAPL','AMGN','AMZN','AXP','BA','CAT','CRM','CSCO','CVX','DIS',
      'GS','HD','HON','IBM','JNJ','JPM','KO','MCD','MMM','MRK',
      'MSFT','NKE','NVDA','PG','SHW','TRV','UNH','V','VZ','WMT',
    ],
  },
];

function generateDowHistory(endDate: string): Snapshot[] {
  const out: Snapshot[] = [];
  const start = new Date('2018-01-31T00:00:00Z');
  const end = new Date(`${endDate}T00:00:00Z`);
  let d = new Date(start);
  while (d <= end) {
    const iso = d.toISOString().slice(0, 10);
    let active = DOW_SEGMENTS[0].tickers;
    for (const seg of DOW_SEGMENTS) if (seg.from <= iso) active = seg.tickers;
    out.push({ date: iso, index: 'dow', tickers: [...active].sort() });
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0));
  }
  return out;
}

// ===========================================================================
// Russell 2000 historical via iShares
// ===========================================================================

function monthEnds(fromYearMonth: string, toYearMonth: string): string[] {
  const out: string[] = [];
  const [fy, fm] = fromYearMonth.split('-').map(Number);
  const [ty, tm] = toYearMonth.split('-').map(Number);
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    const last = new Date(Date.UTC(y, m, 0));
    out.push(last.toISOString().slice(0, 10));
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

async function backfillRussell2kHistory(): Promise<Snapshot[]> {
  const dates = monthEnds('2022-01', '2026-04');
  const out: Snapshot[] = [];
  for (const monthEnd of dates) {
    // iShares only archives on trading days. If the month-end falls on
    // a weekend, roll back day-by-day until iShares returns data.
    let tickers: string[] = [];
    let used = monthEnd;
    for (let rollback = 0; rollback < 5; rollback++) {
      const probe = new Date(`${monthEnd}T00:00:00Z`);
      probe.setUTCDate(probe.getUTCDate() - rollback);
      const probeIso = probe.toISOString().slice(0, 10);
      try {
        const result = await fetchIwmHoldingsCsv(probeIso);
        if (result.length >= 100) {
          tickers = result;
          used = probeIso;
          break;
        }
      } catch (err) {
        console.log(`[iwm ${probeIso}] fetch error: ${(err as Error).message}; continuing`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (tickers.length === 0) {
      console.log(`[iwm ${monthEnd}] no data within 5 trading-day rollback; skipping`);
      continue;
    }
    // Bucket the snapshot at the canonical month-end date so lookups land
    // on the calendar boundary rather than the actual archive date.
    out.push({ date: monthEnd, index: 'russell2k', tickers: tickers.sort() });
    if (used !== monthEnd) {
      console.log(`[iwm ${monthEnd}] ${tickers.length} tickers (from ${used} after rollback)`);
    } else {
      console.log(`[iwm ${monthEnd}] ${tickers.length} tickers`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

// ===========================================================================
// File emission
// ===========================================================================

function emitStaticFile(snapshots: Snapshot[], meta: {
  generatedAt: string;
  spyAsOfDate?: string;
  diaAsOfDate?: string;
  russellMonths: number;
  ndxNote: string;
}): string {
  const indexOrder: Record<Index, number> = { dow: 0, sp500: 1, ndx: 2, russell2k: 3 };
  const sorted = [...snapshots].sort((a, b) => {
    const d = indexOrder[a.index] - indexOrder[b.index];
    return d !== 0 ? d : a.date.localeCompare(b.date);
  });

  return `// netlify/functions/shared/universe-history.ts
//
// Point-in-time historical index membership.
//
// AUTO-GENERATED by scripts/generate-universe-history.ts on ${meta.generatedAt}.
// Re-run the generator monthly to extend forward; do not hand-edit.
//
// Sources (ETF sponsor vendors of record):
//   - SP500     (SSGA SPY xlsx)     current only — SSGA does not expose historical archive
//   - Dow       (SSGA DIA xlsx)     current only + hand-curated history from documented index changes
//   - NDX       (Invesco QQQ)       ${meta.ndxNote}
//   - Russell2k (iShares IWM csv)   historical via asOfDate (${meta.russellMonths} months)
//
// Wikipedia was the prior source. It has been decommissioned — not an
// acceptable data source for a trading app (no SLA, parse fragility, no
// audit trail). Do not re-add Wikipedia code paths to the generator.
//
// SSGA SPY snapshot date: ${meta.spyAsOfDate ?? 'unavailable'}
// SSGA DIA snapshot date: ${meta.diaAsOfDate ?? 'unavailable'}

import { UNIVERSE } from './universe';

export type UniverseIndex = 'sp500' | 'ndx' | 'dow' | 'russell2k';

export interface UniverseSnapshot {
  /** YYYY-MM-DD month-end. */
  date: string;
  index: UniverseIndex;
  /** Sorted alphabetically for deterministic comparison. */
  tickers: string[];
}

// ---------------------------------------------------------------------------
// NDX fallback seed (Invesco QQQ blocked from generator env at last run)
// ---------------------------------------------------------------------------
//
// Until QQQ becomes reachable from the generator env, NDX falls back to
// the tickers tagged 'ndx' in the existing TradeIQ universe.ts working
// set. This is honest about what we have: a curated subset, not the
// authoritative QQQ holdings.

function tickersTaggedWith(tag: UniverseIndex): string[] {
  return [...UNIVERSE.filter((u) => u.indices.includes(tag)).map((u) => u.ticker)].sort();
}

const NDX_SEED_DATE = '${meta.generatedAt}';

// ---------------------------------------------------------------------------
// UNIVERSE_HISTORY — generated from ETF sponsors + hand-curated Dow history
// ---------------------------------------------------------------------------

export const UNIVERSE_HISTORY: UniverseSnapshot[] = [
${sorted.map((s) => `  { date: '${s.date}', index: '${s.index}', tickers: ${JSON.stringify(s.tickers)} },`).join('\n')}
  { date: NDX_SEED_DATE, index: 'ndx', tickers: tickersTaggedWith('ndx') },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Return the constituent set of \`index\` AS OF \`date\` (the latest available
 * month-end snapshot ≤ date). Returns null when no snapshot covers \`date\`.
 */
export function tickersInIndexOnDate(
  index: UniverseIndex,
  date: string,
): string[] | null {
  const candidate = UNIVERSE_HISTORY
    .filter((s) => s.index === index && s.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return candidate ? candidate.tickers : null;
}

/**
 * Was \`ticker\` a member of \`index\` on \`date\`? Returns true / false /
 * null where null means "no snapshot covers this date for this index"
 * (data gap — Phase 4 backtests should exclude from sample rather than
 * treat as not-in-index).
 */
export function wasInIndexOnDate(
  ticker: string,
  index: UniverseIndex,
  date: string,
): boolean | null {
  const set = tickersInIndexOnDate(index, date);
  if (set === null) return null;
  return set.includes(ticker);
}

/** Per-index coverage report. */
export function universeHistoryCoverage(): Record<
  UniverseIndex,
  { firstDate: string | null; lastDate: string | null; snapshotCount: number }
> {
  const out: Record<UniverseIndex, { firstDate: string | null; lastDate: string | null; snapshotCount: number }> = {
    sp500: { firstDate: null, lastDate: null, snapshotCount: 0 },
    ndx: { firstDate: null, lastDate: null, snapshotCount: 0 },
    dow: { firstDate: null, lastDate: null, snapshotCount: 0 },
    russell2k: { firstDate: null, lastDate: null, snapshotCount: 0 },
  };
  for (const snap of UNIVERSE_HISTORY) {
    const c = out[snap.index];
    c.snapshotCount += 1;
    if (c.firstDate === null || snap.date < c.firstDate) c.firstDate = snap.date;
    if (c.lastDate === null || snap.date > c.lastDate) c.lastDate = snap.date;
  }
  return out;
}
`;
}

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
  const snapshots: Snapshot[] = [];
  const today = new Date().toISOString().slice(0, 10);

  let spyAsOfDate: string | undefined;
  let diaAsOfDate: string | undefined;
  let ndxNote = '';

  // 1. SSGA SPY → SP500 current snapshot
  try {
    console.log('[ssga spy] fetching…');
    const spy = await fetchSpyHoldings();
    spyAsOfDate = spy.asOfDate;
    snapshots.push({ date: spy.asOfDate, index: 'sp500', tickers: spy.tickers.sort() });
    console.log(`[ssga spy] ${spy.tickers.length} tickers as of ${spy.asOfDate}`);
  } catch (err) {
    console.log(`[ssga spy] FAILED: ${(err as Error).message}`);
  }

  // 2. SSGA DIA → Dow current snapshot
  try {
    console.log('[ssga dia] fetching…');
    const dia = await fetchDiaHoldings();
    diaAsOfDate = dia.asOfDate;
    snapshots.push({ date: dia.asOfDate, index: 'dow', tickers: dia.tickers.sort() });
    console.log(`[ssga dia] ${dia.tickers.length} tickers as of ${dia.asOfDate}`);
  } catch (err) {
    console.log(`[ssga dia] FAILED: ${(err as Error).message}; relying on hand-curated history only`);
  }

  // 3. Hand-curated Dow history (always emitted regardless of SSGA reachability)
  const dowHistory = generateDowHistory(diaAsOfDate ?? '2026-04-30');
  snapshots.push(...dowHistory);
  console.log(`[dow hand-curated] ${dowHistory.length} monthly snapshots from 2018-01-31`);

  // 4. iShares IWM historical → Russell 2000
  console.log('[iwm] backfilling Russell 2000 historical…');
  const russell = await backfillRussell2kHistory();
  snapshots.push(...russell);

  // 5. NDX — Invesco QQQ blocked from this env; fall back to universe.ts seed
  ndxNote = 'BLOCKED — Invesco SPA-only at last run; falls back to universe.ts seed (curated subset, not authoritative)';
  console.log(`[ndx] ${ndxNote}`);

  // Emit
  const out = emitStaticFile(snapshots, {
    generatedAt: today,
    spyAsOfDate,
    diaAsOfDate,
    russellMonths: russell.length,
    ndxNote,
  });
  writeFileSync(OUT_FILE, out, 'utf8');
  console.log(`\n[gen-universe-history] wrote universe-history.ts`);
  console.log(`  sp500=${snapshots.filter((s) => s.index === 'sp500').length}, ndx=1 (seed), dow=${snapshots.filter((s) => s.index === 'dow').length}, russell2k=${snapshots.filter((s) => s.index === 'russell2k').length}`);
}

main().catch((err) => {
  console.error('[gen-universe-history] FAILED:', err);
  process.exit(1);
});
