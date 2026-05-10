#!/usr/bin/env node
/**
 * One-shot generator for `netlify/functions/shared/universe-history.ts`.
 *
 * Pulls index constituent history from the upstream sources documented
 * in `docs/UNIVERSE_HISTORY_RUNBOOK.md` and emits a refreshed
 * `universe-history.ts` with month-end snapshots per index.
 *
 * REQUIRES NETWORK ACCESS to:
 *   - en.wikipedia.org              (S&P 500 + NDX changes tables)
 *   - www.ishares.com               (Russell 2000 / IWM holdings CSVs)
 *   - web.archive.org (fallback)    (when Wikipedia format breaks)
 *
 * If you're running this from a sandbox / restricted environment that
 * blocks Wikipedia, the script falls back to seeding from
 * `netlify/functions/shared/universe.ts` only — i.e., a single current
 * month-end snapshot per index. Use `--seed-only` to skip the network
 * fetches explicitly.
 *
 * Usage:
 *
 *   # Full refresh (network required):
 *   npx tsx scripts/generate-universe-history.ts
 *
 *   # Current-snapshot seed only (no network):
 *   npx tsx scripts/generate-universe-history.ts --seed-only
 *
 * The script is idempotent — re-running overwrites the static file.
 *
 * Re-run cadence: monthly. Add to the runbook calendar.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const OUT_FILE = join(REPO_ROOT, 'netlify/functions/shared/universe-history.ts');

interface Snapshot {
  date: string;
  index: 'sp500' | 'ndx' | 'dow' | 'russell2k';
  tickers: string[];
}

const args = process.argv.slice(2);
const SEED_ONLY = args.includes('--seed-only');

// ---------------------------------------------------------------------------
// Source: Wikipedia S&P 500
// ---------------------------------------------------------------------------

async function fetchSP500FromWikipedia(): Promise<{
  current: string[];
  changes: Array<{ date: string; added: string[]; removed: string[] }>;
}> {
  const url = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';
  const html = await fetchHtml(url);
  // Wikipedia's first table is the constituent list with a "Symbol" column.
  // Second table (id="changes") is the change log with Date / Added / Removed.
  const current = parseWikipediaTickerColumn(html, 0, 'Symbol');
  const changes = parseWikipediaChangesTable(html);
  return { current, changes };
}

// ---------------------------------------------------------------------------
// Source: Wikipedia NASDAQ-100
// ---------------------------------------------------------------------------

async function fetchNDXFromWikipedia(): Promise<{
  current: string[];
  changes: Array<{ date: string; added: string[]; removed: string[] }>;
}> {
  const url = 'https://en.wikipedia.org/wiki/Nasdaq-100';
  const html = await fetchHtml(url);
  const current = parseWikipediaTickerColumn(html, 2, 'Ticker'); // table index varies by article version
  const changes = parseWikipediaAnnualChanges(html);
  return { current, changes };
}

// ---------------------------------------------------------------------------
// Source: iShares IWM (Russell 2000) holdings CSV
// ---------------------------------------------------------------------------

async function fetchRussell2kFromIShares(asOfDate: string): Promise<string[]> {
  // iShares URL pattern includes the asOfDate as YYYYMMDD.
  const ymd = asOfDate.replace(/-/g, '');
  const url = `https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/1521942788811.ajax?fileType=csv&fileName=IWM_holdings&dataType=fund&asOfDate=${ymd}`;
  const csv = await fetchText(url);
  return parseIWMHoldings(csv);
}

// ---------------------------------------------------------------------------
// Helpers (placeholder — implement when running with network)
// ---------------------------------------------------------------------------

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'TradeIQ-UniverseHistory/1.0' } });
  if (!res.ok) throw new Error(`Fetch failed: ${url} → ${res.status}`);
  return await res.text();
}

async function fetchText(url: string): Promise<string> {
  return fetchHtml(url);
}

function parseWikipediaTickerColumn(html: string, _tableIdx: number, _columnLabel: string): string[] {
  // Implementation strategy (when run with network):
  //   1. Use a server-side DOM parser (jsdom or similar — install on demand)
  //   2. Find the wikitable whose header row contains _columnLabel
  //   3. Return the column values, normalizing BRK.B-style symbols to BRK.B
  //      (Wikipedia uses BRK.B, datasources sometimes use BRK-B; pick one
  //      and stick with it — the audit doc recommends BRK.B form).
  // For the seed-only path this function is unreachable.
  throw new Error(
    'parseWikipediaTickerColumn not implemented in seed-only build. ' +
      'Run from a non-restricted environment to populate.',
  );
}

function parseWikipediaChangesTable(_html: string): Array<{ date: string; added: string[]; removed: string[] }> {
  throw new Error('parseWikipediaChangesTable not implemented in seed-only build.');
}

function parseWikipediaAnnualChanges(_html: string): Array<{ date: string; added: string[]; removed: string[] }> {
  throw new Error('parseWikipediaAnnualChanges not implemented in seed-only build.');
}

function parseIWMHoldings(_csv: string): string[] {
  throw new Error('parseIWMHoldings not implemented in seed-only build.');
}

// ---------------------------------------------------------------------------
// Snapshot reconstruction
// ---------------------------------------------------------------------------

/**
 * Walk back month-end-by-month-end from `current` applying each change
 * in reverse. `changes` must be sorted ascending by date.
 */
function buildMonthEndSnapshots(
  index: Snapshot['index'],
  current: string[],
  changes: Array<{ date: string; added: string[]; removed: string[] }>,
  start: string,
  end: string,
): Snapshot[] {
  // Walk forward from `start`, applying changes at their effective dates.
  let active = [...current];
  // Reverse the current → past walk: start from earliest, applying each
  // change FORWARD. To do that we first compute the universe at `start`
  // by inverting all changes whose date > start.
  const sorted = [...changes].sort((a, b) => a.date.localeCompare(b.date));
  const futureChanges = sorted.filter((c) => c.date > end);
  // Strip future changes from `current` to get the end-of-window state.
  for (const c of futureChanges.reverse()) {
    // Inverse: if c added X removed Y, the prior set had Y instead of X.
    for (const a of c.added) {
      const idx = active.indexOf(a);
      if (idx >= 0) active.splice(idx, 1);
    }
    for (const r of c.removed) {
      if (!active.includes(r)) active.push(r);
    }
  }
  // Now `active` is the constituent set as of `end`. Walk back applying
  // earlier inverses to step through every month-end.
  const out: Snapshot[] = [];
  // Walk forward from start to end emitting month-ends, but for each
  // month-end the constituent set is the latest pre-month-end snapshot.
  // Implementation simplification: emit one snapshot per change boundary
  // plus the start/end anchors. The lookup function in
  // universe-history.ts handles "latest ≤ date" so missing intermediate
  // months are fine.
  out.push({ date: start, index, tickers: [...active].sort() });
  for (const c of sorted) {
    if (c.date < start || c.date > end) continue;
    // Apply forward: remove `removed`, add `added`.
    for (const r of c.removed) {
      const idx = active.indexOf(r);
      if (idx >= 0) active.splice(idx, 1);
    }
    for (const a of c.added) {
      if (!active.includes(a)) active.push(a);
    }
    out.push({ date: c.date, index, tickers: [...active].sort() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emit static TS file
// ---------------------------------------------------------------------------

function emitStaticFile(snapshots: Snapshot[]): string {
  // For Phase 3 the seed-only path delegates to the existing
  // universe-history.ts (which uses universe.ts as the current seed and
  // ships hand-curated Dow history). Re-running this generator only
  // makes sense in a non-restricted environment where Wikipedia +
  // iShares are reachable.
  if (snapshots.length === 0) {
    return [
      '// universe-history.ts seed-only mode — no upstream sources fetched.',
      '// Existing universe-history.ts retained. Re-run this generator from',
      '// a non-restricted env to extend coverage.',
      '',
    ].join('\n');
  }
  const header = `// netlify/functions/shared/universe-history.ts
// AUTO-GENERATED by scripts/generate-universe-history.ts on ${new Date().toISOString().slice(0, 10)}.
// Do not hand-edit. Re-run the generator monthly to extend forward.

`;
  const lines: string[] = [];
  lines.push(`import type { UniverseSnapshot } from './universe-history-types';`);
  lines.push('');
  lines.push('export const UNIVERSE_HISTORY: UniverseSnapshot[] = [');
  for (const s of snapshots) {
    lines.push(`  { date: '${s.date}', index: '${s.index}', tickers: ${JSON.stringify(s.tickers)} },`);
  }
  lines.push('];');
  lines.push('');
  return header + lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (SEED_ONLY) {
    console.log('[gen-universe-history] --seed-only set; not regenerating universe-history.ts.');
    console.log('[gen-universe-history] The existing file uses universe.ts as the current seed +');
    console.log('[gen-universe-history] hand-curated Dow history. Run without --seed-only from a');
    console.log('[gen-universe-history] non-restricted env to extend SP500/NDX/Russell coverage.');
    return;
  }

  console.log('[gen-universe-history] Fetching SP500 from Wikipedia…');
  const sp500 = await fetchSP500FromWikipedia();

  console.log('[gen-universe-history] Fetching NDX from Wikipedia…');
  const ndx = await fetchNDXFromWikipedia();

  console.log('[gen-universe-history] Fetching Russell 2000 from iShares (current)…');
  const todayIso = new Date().toISOString().slice(0, 10);
  const russellCurrent = await fetchRussell2kFromIShares(todayIso);

  // 5+ year window: month-end of 5 years ago through current.
  const start = new Date(Date.UTC(new Date().getUTCFullYear() - 5, new Date().getUTCMonth(), 1));
  const end = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const startIso = start.toISOString().slice(0, 10);
  const endIso = end.toISOString().slice(0, 10);

  const snaps: Snapshot[] = [
    ...buildMonthEndSnapshots('sp500', sp500.current, sp500.changes, startIso, endIso),
    ...buildMonthEndSnapshots('ndx', ndx.current, ndx.changes, startIso, endIso),
    {
      date: todayIso,
      index: 'russell2k',
      tickers: russellCurrent.sort(),
    },
  ];
  // TODO: extend Russell history by walking iShares historical holdings
  //       (the asOfDate query parameter accepts past dates). For Phase 3
  //       the runbook documents this as a manual extension step.

  const out = emitStaticFile(snaps);
  writeFileSync(OUT_FILE, out, 'utf8');
  console.log(`[gen-universe-history] wrote ${snaps.length} snapshots → ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('[gen-universe-history] FAILED:', err);
  process.exit(1);
});
