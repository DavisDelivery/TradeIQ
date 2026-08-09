// QS-1 (2026-08-09) — Fama-French 3-factor monthly series, from the Ken
// French Data Library.
//
// Free, canonical, and the same series the residual-momentum literature is
// estimated on, so using anything else would make our numbers incomparable
// to the published result we are relying on.
//
// THE PUBLICATION LAG IS A FIRST-CLASS CONSTRAINT, NOT AN EDGE CASE.
// French updates monthly, in arrears. Measured 2026-08-09: the file's last
// monthly row is 202606 while the calendar month is 202608. The scoring
// window ends at t-2, which was 202606 that day — so the board fits inside
// the lag with EXACTLY ZERO SLACK. A late publication, or running on the
// 1st of a month before the update lands, leaves t-2 uncovered.
//
// When that happens the honest outcomes are (a) score against the newest
// month French actually has and say so, or (b) refuse. What must never
// happen is silently regressing on a shorter window and presenting the
// result as the same measurement — so `factorCoverage` below makes the gap
// an explicit, inspectable number that the scan turns into a warning.

import zlib from 'node:zlib';

export const FRENCH_FACTORS_URL =
  'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Research_Data_Factors_CSV.zip';

export interface FactorMonth {
  /** Calendar month as YYYYMM, e.g. 202606. */
  ym: number;
  /** Excess market return, percent. */
  mktRf: number;
  /** Small-minus-big, percent. */
  smb: number;
  /** High-minus-low, percent. */
  hml: number;
  /** Risk-free rate, percent. */
  rf: number;
}

// ---------------------------------------------------------------------------
// YYYYMM arithmetic
// ---------------------------------------------------------------------------

/** Month key for a date, in UTC. */
export function ymOf(d: Date): number {
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}

/** Shift a YYYYMM key by n months (n may be negative). */
export function addMonths(ym: number, n: number): number {
  const y = Math.floor(ym / 100);
  const m = (ym % 100) - 1 + n;
  return (y + Math.floor(m / 12)) * 100 + ((((m % 12) + 12) % 12) + 1);
}

/** Whole months from `a` to `b` (negative when b precedes a). */
export function monthsBetween(a: number, b: number): number {
  return (Math.floor(b / 100) - Math.floor(a / 100)) * 12 + ((b % 100) - (a % 100));
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

/**
 * Extract the single member of a ZIP archive.
 *
 * Reads the CENTRAL DIRECTORY rather than the local file header. The local
 * header is allowed to carry zero sizes and defer them to a trailing data
 * descriptor, in which case a header-only reader has no compressed length to
 * slice — the central directory always has the real values. Verified against
 * the live French archive: 12,860 compressed → 52,413 inflated, exact.
 *
 * Deliberately ~40 lines of `node:zlib` rather than a dependency: this is the
 * only ZIP the app will ever read, and it is a fixed, known-shape file.
 */
export function unzipSingleMember(buf: Buffer): { name: string; data: Buffer } {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record');

  const entries = buf.readUInt16LE(eocd + 10);
  if (entries < 1) throw new Error('zip: archive is empty');
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOff) !== CD_SIG) throw new Error('zip: bad central directory');

  const method = buf.readUInt16LE(cdOff + 10);
  const compSize = buf.readUInt32LE(cdOff + 20);
  const uncompSize = buf.readUInt32LE(cdOff + 24);
  const nameLen = buf.readUInt16LE(cdOff + 28);
  const localOff = buf.readUInt32LE(cdOff + 42);
  const name = buf.subarray(cdOff + 46, cdOff + 46 + nameLen).toString('latin1');

  if (buf.readUInt32LE(localOff) !== LFH_SIG) throw new Error('zip: bad local file header');
  const lNameLen = buf.readUInt16LE(localOff + 26);
  const lExtraLen = buf.readUInt16LE(localOff + 28);
  const start = localOff + 30 + lNameLen + lExtraLen;
  const comp = buf.subarray(start, start + compSize);

  let data: Buffer;
  if (method === 0) data = Buffer.from(comp);
  else if (method === 8) data = zlib.inflateRawSync(comp);
  else throw new Error(`zip: unsupported compression method ${method}`);

  if (data.length !== uncompSize) {
    throw new Error(`zip: size mismatch — got ${data.length}, header says ${uncompSize}`);
  }
  return { name, data };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the MONTHLY block of the French factors CSV.
 *
 * The file is not a plain CSV: three lines of prose, a blank, a header, then
 * ~1200 monthly rows keyed YYYYMM, then a blank, then the line
 * " Annual Factors: January-December ", a second header, and ~99 ANNUAL rows
 * keyed YYYY. Both blocks have identical column headers.
 *
 * A naive `split(',')` over every line therefore ingests annual rows as if
 * they were months — 1927 parses as a perfectly plausible YYYYMM-shaped
 * integer to anything not checking width, and annual magnitudes (Mkt-RF
 * 29.44) would enter a monthly regression as enormous outliers. The 6-digit
 * test below is the whole defence, so it is asserted in the tests directly.
 */
export function parseFrenchMonthlyFactors(text: string): FactorMonth[] {
  const out: FactorMonth[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // Exactly six digits then a comma. Annual rows are four digits and are
    // skipped here; prose and headers match nothing.
    if (!/^\d{6}\s*,/.test(line)) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 5) continue;
    const ym = Number(parts[0]);
    const mktRf = Number(parts[1]);
    const smb = Number(parts[2]);
    const hml = Number(parts[3]);
    const rf = Number(parts[4]);
    const month = ym % 100;
    if (!Number.isFinite(ym) || month < 1 || month > 12) continue;
    if (![mktRf, smb, hml, rf].every(Number.isFinite)) continue;
    // French uses -99.99 / -999 as missing markers.
    if ([mktRf, smb, hml, rf].some((v) => v <= -99.99)) continue;
    out.push({ ym, mktRf, smb, hml, rf });
  }
  out.sort((a, b) => a.ym - b.ym);
  return out;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface FactorCoverage {
  /** Newest month present in the series, or null when empty. */
  latestYm: number | null;
  /** Newest month the caller needs (the scoring window's t-2). */
  requiredYm: number;
  /** Months by which the series falls short. 0 or less means covered. */
  shortfallMonths: number;
  covered: boolean;
  /** Months missing from inside the requested span — a hole, not a lag. */
  gaps: number[];
}

/**
 * Can this series score a window ending at `requiredYm`, over `months` months?
 *
 * Reports a LAG (series ends too early) and HOLES (months missing from the
 * middle) separately, because they warrant different responses: a lag is the
 * expected French publication delay and can be waited out, whereas a hole
 * means the parse dropped rows and the series should not be trusted at all.
 */
export function factorCoverage(
  factors: FactorMonth[],
  requiredYm: number,
  months: number,
): FactorCoverage {
  if (!factors.length) {
    return { latestYm: null, requiredYm, shortfallMonths: months, covered: false, gaps: [] };
  }
  const have = new Set(factors.map((f) => f.ym));
  const latestYm = factors[factors.length - 1].ym;
  const shortfallMonths = monthsBetween(latestYm, requiredYm);

  const gaps: number[] = [];
  const firstNeeded = addMonths(requiredYm, -(months - 1));
  for (let i = 0; i < months; i++) {
    const ym = addMonths(firstNeeded, i);
    if (ym <= latestYm && !have.has(ym)) gaps.push(ym);
  }
  return {
    latestYm,
    requiredYm,
    shortfallMonths,
    covered: shortfallMonths <= 0 && gaps.length === 0,
    gaps,
  };
}

/** The contiguous run of `months` factor months ending at `endYm`, or null. */
export function factorWindow(
  factors: FactorMonth[],
  endYm: number,
  months: number,
): FactorMonth[] | null {
  const byYm = new Map(factors.map((f) => [f.ym, f]));
  const startYm = addMonths(endYm, -(months - 1));
  const out: FactorMonth[] = [];
  for (let i = 0; i < months; i++) {
    const f = byYm.get(addMonths(startYm, i));
    if (!f) return null;
    out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface FetchFactorsResult {
  factors: FactorMonth[];
  /** Source filename inside the archive, for provenance in the snapshot. */
  memberName: string;
  fetchedAt: string;
}

/**
 * Download and parse the live series.
 *
 * Non-OK responses THROW rather than returning an empty series — the same
 * rule vector-data.getGroupedDaily follows ("never cache an error-shaped
 * empty"). An empty factor series would make every stock unscorable and
 * would look identical to a genuine no-candidates night.
 */
export async function fetchFrenchFactors(
  fetchImpl: typeof fetch = fetch,
): Promise<FetchFactorsResult> {
  const res = await fetchImpl(FRENCH_FACTORS_URL);
  if (!res.ok) throw new Error(`french factors: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { name, data } = unzipSingleMember(buf);
  const factors = parseFrenchMonthlyFactors(data.toString('latin1'));
  if (!factors.length) throw new Error('french factors: parsed zero monthly rows');
  return { factors, memberName: name, fetchedAt: new Date().toISOString() };
}
