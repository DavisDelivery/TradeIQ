// TRIDENT Smart Money — live 13D activist watcher (design.md §2 i1, §4 P2).
//
// The best-evidenced institutional signal at our horizon: SC 13D filings
// are public within 5 business days of crossing 5% with intent, and the
// post-filing drift (~+1-2%/1mo, Brav et al.) does not require guessing —
// the event IS the disclosure. This module parses EDGAR's nightly form
// index for SC 13D / SC 13D/A rows, matches filers against a curated
// activist whitelist (name-normalized — filer names are stable across
// filings; CIKs are recorded as discovered), resolves the SUBJECT company
// to a ticker via SEC's canonical company_tickers.json, and stores events
// in Firestore `tridentActivist` keyed by accession (idempotent re-runs).
//
// Exit discipline: a 13D/A is re-scored by recency like a fresh event
// (amendments refresh the clock — design §2), and an amendment whose
// filing we later learn is an exit gets removed when observed. EDGAR
// plumbing (throttle, UA, 403 ladder) is vector-data's edgarFetch —
// battle-tested on this exact WAF.

import { edgarFetch, dailyIndexUrl, getCikTickerMap } from '../vector-data';
import type { Logger } from '../logger';

// ---------------------------------------------------------------------------
// Whitelist — activist funds with documented campaigns and 13D practice.
// Name matching is normalized (case/punctuation-insensitive substring on
// meaningful tokens). Additions are cheap; removals are a design decision.
// ---------------------------------------------------------------------------

export const ACTIVIST_WHITELIST: ReadonlyArray<{ key: string; match: RegExp }> = [
  { key: 'Elliott', match: /elliott (investment|associates|management)/i },
  { key: 'Starboard', match: /starboard value/i },
  { key: 'ValueAct', match: /valueact/i },
  { key: 'Icahn', match: /icahn (carl|capital|enterprises|partners)/i },
  { key: 'Third Point', match: /third point/i },
  { key: 'Pershing Square', match: /pershing square/i },
  { key: 'JANA', match: /jana partners/i },
  { key: 'Engaged Capital', match: /engaged capital/i },
  { key: 'Ancora', match: /ancora (holdings|advisors|alternatives)/i },
  { key: 'Sarissa', match: /sarissa capital/i },
  { key: 'Corvex', match: /corvex management/i },
  { key: 'Trian', match: /trian (fund|partners)/i },
  { key: 'Land & Buildings', match: /land & buildings|land and buildings/i },
  { key: 'Legion', match: /legion partners/i },
  { key: 'Politan', match: /politan capital/i },
  { key: 'Browning West', match: /browning west/i },
  { key: 'Irenic', match: /irenic capital/i },
  { key: 'Impactive', match: /impactive capital/i },
  { key: 'Inclusive Capital', match: /inclusive capital/i },
  { key: 'Sachem Head', match: /sachem head/i },
  { key: 'Soroban', match: /soroban capital/i },
  { key: 'Cevian', match: /cevian capital/i },
  { key: 'Effissimo', match: /effissimo/i },
  { key: 'Blackwells', match: /blackwells capital/i },
  { key: 'Barington', match: /barington (companies|capital)/i },
  { key: 'Mantle Ridge', match: /mantle ridge/i },
  { key: 'ArkHouse', match: /arkhouse/i },
  { key: 'Anson Funds', match: /anson (funds|advisors)/i },
  { key: 'Saddle Point', match: /saddle point/i },
  { key: 'Rubric', match: /rubric capital/i },
];

export function matchActivist(filerName: string): string | null {
  for (const a of ACTIVIST_WHITELIST) {
    if (a.match.test(filerName)) return a.key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// form.idx parsing
// ---------------------------------------------------------------------------

export interface IdxFiling {
  formType: 'SC 13D' | 'SC 13D/A';
  companyName: string; // the FILING entity column of form.idx (filer OR subject depending on row)
  cik: string; // 10-padded
  dateFiled: string; // YYYY-MM-DD
  path: string; // edgar/data/.../accession.txt
}

/** Parse a form.idx body for SC 13D rows. Format: fixed-ish columns
 *  `Form Type   Company Name   CIK   Date Filed   File Name`, whitespace
 *  aligned; rows for a filing appear once per associated entity (both the
 *  subject company and the filer produce rows with the SAME file path). */
export function parseFormIdx(body: string): IdxFiling[] {
  const out: IdxFiling[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^(SC 13D(?:\/A)?)\s{2,}(.+?)\s{2,}(\d+)\s{2,}(\d{4}-?\d{2}-?\d{2})\s{2,}(\S+)\s*$/);
    if (!m) continue;
    const dateRaw = m[4];
    const date = dateRaw.includes('-')
      ? dateRaw
      : `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
    out.push({
      formType: m[1] as IdxFiling['formType'],
      companyName: m[2].trim(),
      cik: m[3].padStart(10, '0'),
      dateFiled: date,
      path: m[5],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event assembly — group idx rows by accession path; a filing whose
// entity rows include a whitelisted FILER yields an event for every
// non-filer entity that maps to a ticker (the subject company).
// ---------------------------------------------------------------------------

export interface ActivistEventDoc {
  accession: string; // derived from path
  ticker: string;
  subjectCik: string;
  filer: string; // whitelist key
  filerRawName: string;
  type: '13D' | '13D/A';
  filedAt: string; // YYYY-MM-DD (daily-index granularity; acceptance is intra-day)
  discoveredAt: string; // ISO
}

export function assembleEvents(
  filings: IdxFiling[],
  cikToTicker: Map<string, string>,
  nowIso: string,
): ActivistEventDoc[] {
  const byPath = new Map<string, IdxFiling[]>();
  for (const f of filings) {
    const arr = byPath.get(f.path) ?? [];
    arr.push(f);
    byPath.set(f.path, arr);
  }
  const out: ActivistEventDoc[] = [];
  for (const [path, rows] of byPath) {
    const filerRow = rows.find((r) => matchActivist(r.companyName));
    if (!filerRow) continue;
    const filerKey = matchActivist(filerRow.companyName)!;
    for (const r of rows) {
      if (r === filerRow) continue;
      const ticker = cikToTicker.get(r.cik);
      if (!ticker) continue;
      const accession = path.split('/').pop()!.replace(/\.txt$/, '');
      out.push({
        accession,
        ticker,
        subjectCik: r.cik,
        filer: filerKey,
        filerRawName: filerRow.companyName,
        type: filerRow.formType === 'SC 13D' ? '13D' : '13D/A',
        filedAt: r.dateFiled,
        discoveredAt: nowIso,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch one day's index (missing file = weekend/holiday → empty).
// ---------------------------------------------------------------------------

export async function fetchDayEvents(
  date: string,
  cikToTicker: Map<string, string>,
  log: Logger,
): Promise<ActivistEventDoc[]> {
  try {
    const res = await edgarFetch(dailyIndexUrl(date));
    const body = await res.text();
    const filings = parseFormIdx(body);
    const events = assembleEvents(filings, cikToTicker, new Date().toISOString());
    if (events.length > 0) log.info('activist_events_found', { date, count: events.length });
    return events;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // Missing daily index (404 on weekends/holidays) is normal.
    if (/HTTP 404/.test(msg)) return [];
    throw err;
  }
}
