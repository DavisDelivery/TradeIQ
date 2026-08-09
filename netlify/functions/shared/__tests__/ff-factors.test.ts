// QS-1 — Fama-French factor ingestion.
//
// fixtures-ff3.zip is the REAL archive downloaded from the Ken French Data
// Library on 2026-08-09 (13,052 bytes, 1,200 monthly rows, last month
// 202606). Testing the parser against a hand-written mini-CSV would have
// missed the two things that actually bite: the annual block appended after
// the monthly one, and a ZIP whose sizes live in the central directory.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  unzipSingleMember,
  parseFrenchMonthlyFactors,
  factorCoverage,
  factorWindow,
  addMonths,
  monthsBetween,
  ymOf,
  fetchFrenchFactors,
  FRENCH_FACTORS_URL,
} from '../ff-factors';

const ZIP = readFileSync(join(__dirname, 'fixtures-ff3.zip'));

describe('unzipSingleMember', () => {
  it('extracts the CSV from the real French archive', () => {
    const { name, data } = unzipSingleMember(ZIP);
    expect(name).toBe('F-F_Research_Data_Factors.csv');
    expect(data.length).toBe(52413);
    expect(data.toString('latin1')).toContain('Mkt-RF,SMB,HML,RF');
  });

  it('throws on a buffer that is not a zip', () => {
    expect(() => unzipSingleMember(Buffer.from('not a zip at all, really'))).toThrow(/zip:/);
  });
});

describe('parseFrenchMonthlyFactors', () => {
  const text = unzipSingleMember(ZIP).data.toString('latin1');
  const factors = parseFrenchMonthlyFactors(text);

  it('parses every monthly row and no annual rows', () => {
    // The file carries 1,200 monthly rows and 99 ANNUAL rows with identical
    // column headers. Reading 1,299 here would mean annual data entered the
    // monthly series.
    expect(factors.length).toBe(1200);
    expect(factors[0].ym).toBe(192607);
    expect(factors[factors.length - 1].ym).toBe(202606);
  });

  it('reads the first and last rows exactly', () => {
    expect(factors[0]).toEqual({ ym: 192607, mktRf: 2.89, smb: -2.55, hml: -2.39, rf: 0.22 });
    expect(factors[1199]).toEqual({ ym: 202606, mktRf: -1.07, smb: 3.58, hml: 3.34, rf: 0.29 });
  });

  it('rejects the annual block explicitly', () => {
    // 1927 is a real annual row in this file (Mkt-RF 29.44 — a monthly value
    // of that size would dominate any regression it entered).
    expect(factors.some((f) => f.ym === 1927)).toBe(false);
    expect(factors.every((f) => f.ym >= 100000)).toBe(true);
    expect(factors.every((f) => f.ym % 100 >= 1 && f.ym % 100 <= 12)).toBe(true);
  });

  it('is sorted ascending with no duplicate months', () => {
    const yms = factors.map((f) => f.ym);
    expect([...yms].sort((a, b) => a - b)).toEqual(yms);
    expect(new Set(yms).size).toBe(yms.length);
  });

  it('drops French missing-value markers', () => {
    const parsed = parseFrenchMonthlyFactors(
      ['202401,  1.00,  0.50, -0.20, 0.40', '202402,-99.99,  0.50, -0.20, 0.40'].join('\n'),
    );
    expect(parsed.map((f) => f.ym)).toEqual([202401]);
  });

  it('ignores prose, headers and blank lines', () => {
    expect(parseFrenchMonthlyFactors('hello\n\n,Mkt-RF,SMB,HML,RF\n  \n')).toEqual([]);
  });
});

describe('YYYYMM arithmetic', () => {
  it('adds and subtracts across year boundaries', () => {
    expect(addMonths(202601, -1)).toBe(202512);
    expect(addMonths(202512, 1)).toBe(202601);
    expect(addMonths(202606, -35)).toBe(202307);
    expect(addMonths(202001, -12)).toBe(201901);
    expect(addMonths(201912, 13)).toBe(202101);
  });

  it('measures signed month distance', () => {
    expect(monthsBetween(202601, 202606)).toBe(5);
    expect(monthsBetween(202606, 202601)).toBe(-5);
    expect(monthsBetween(202512, 202601)).toBe(1);
    expect(monthsBetween(202606, 202606)).toBe(0);
  });

  it('derives the month key from a date in UTC', () => {
    expect(ymOf(new Date('2026-08-09T12:00:00Z'))).toBe(202608);
    expect(ymOf(new Date('2026-01-31T23:59:59Z'))).toBe(202601);
  });
});

describe('factorCoverage — the French publication lag', () => {
  const factors = parseFrenchMonthlyFactors(unzipSingleMember(ZIP).data.toString('latin1'));

  it('covers a window ending at the last published month', () => {
    // The live situation on 2026-08-09: calendar month 202608, so the
    // scoring window ends at t-2 = 202606, which is exactly what French had.
    const c = factorCoverage(factors, 202606, 36);
    expect(c.latestYm).toBe(202606);
    expect(c.shortfallMonths).toBe(0);
    expect(c.covered).toBe(true);
    expect(c.gaps).toEqual([]);
  });

  it('reports a shortfall when French has not published yet', () => {
    // One month later with no update: t-2 becomes 202607 and the series is
    // one month short. This must be visible, not absorbed.
    const c = factorCoverage(factors, 202607, 36);
    expect(c.shortfallMonths).toBe(1);
    expect(c.covered).toBe(false);
  });

  it('distinguishes an interior hole from a publication lag', () => {
    const holed = factors.filter((f) => f.ym !== 202601);
    const c = factorCoverage(holed, 202606, 36);
    expect(c.shortfallMonths).toBe(0); // not a lag
    expect(c.gaps).toEqual([202601]);  // a hole
    expect(c.covered).toBe(false);
  });

  it('treats an empty series as uncovered rather than throwing', () => {
    const c = factorCoverage([], 202606, 36);
    expect(c.covered).toBe(false);
    expect(c.latestYm).toBeNull();
  });
});

describe('factorWindow', () => {
  const factors = parseFrenchMonthlyFactors(unzipSingleMember(ZIP).data.toString('latin1'));

  it('returns exactly 36 contiguous months, oldest first', () => {
    const w = factorWindow(factors, 202606, 36);
    expect(w).not.toBeNull();
    expect(w!.length).toBe(36);
    expect(w![0].ym).toBe(202307);
    expect(w![35].ym).toBe(202606);
    for (let i = 1; i < w!.length; i++) {
      expect(monthsBetween(w![i - 1].ym, w![i].ym)).toBe(1);
    }
  });

  it('returns null rather than a short window when a month is missing', () => {
    // Silently returning 35 months would produce a real-looking score from a
    // different measurement than the one advertised.
    const holed = factors.filter((f) => f.ym !== 202501);
    expect(factorWindow(holed, 202606, 36)).toBeNull();
  });
});

describe('fetchFrenchFactors', () => {
  it('fetches, unzips and parses', async () => {
    const fake = (async (url: any) => {
      expect(String(url)).toBe(FRENCH_FACTORS_URL);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => ZIP.buffer.slice(ZIP.byteOffset, ZIP.byteOffset + ZIP.byteLength),
      };
    }) as unknown as typeof fetch;

    const r = await fetchFrenchFactors(fake);
    expect(r.factors.length).toBe(1200);
    expect(r.memberName).toBe('F-F_Research_Data_Factors.csv');
    expect(r.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('throws on a non-OK response instead of returning an empty series', async () => {
    // An empty series makes every stock unscorable, which is indistinguishable
    // from a genuine no-candidates night once it has been written.
    const fake = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(fetchFrenchFactors(fake)).rejects.toThrow(/HTTP 503/);
  });
});
